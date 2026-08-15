/**
 * Live smoke tests against REAL model weights. Skipped unless both are set:
 *
 *   ONNX_SMOKE=1
 *   DESKRAG_MODELS_DIR=/path/to/models
 *
 * expecting subdirectories:
 *   nomic-embed-text-v1.5/    model_int8.onnx tokenizer.json tokenizer_config.json
 *   colmodernvbert-250m/      model.onnx tokenizer.json tokenizer_config.json
 *                             preprocessor_config.json config.json
 *   jina-reranker-v1-turbo-en/model_int8.onnx tokenizer.json tokenizer_config.json
 *
 * These are slow — a late-interaction forward pass is seconds per image on CPU —
 * so the timeouts are generous and the whole file is opt-in.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OnnxTextEmbedding } from "../src/embed/onnx/text.js";
import { ColModernVBertMultiVector } from "../src/embed/onnx/colmodernvbert.js";
import {
  MV_TOK,
  QUERY_BUFFER_TOKENS,
  buildImagePrompt,
  buildQueryPrompt,
  tileMarker,
} from "../src/embed/onnx/colmodernvbert-prompt.js";
import { loadTokenizer } from "../src/embed/onnx/tokenizer.js";
import { OnnxCrossEncoderReranker } from "../src/retrieve/rerank/onnx.js";
import {
  computeTileGeometry,
  expectedTokenCount,
  patchIndexToBox,
} from "../src/embed/onnx/geometry.js";

const MODELS = process.env.DESKRAG_MODELS_DIR ?? "";
const ENABLED = process.env.ONNX_SMOKE === "1" && MODELS.length > 0;
const d = ENABLED ? describe : describe.skip;

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const login = (): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, "login.png")));
const terminal = (): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, "terminal.png")));

const textDir = join(MODELS, "nomic-embed-text-v1.5");
const colmodernDir = join(MODELS, "colmodernvbert-250m");
const rerankDir = join(MODELS, "jina-reranker-v1-turbo-en");

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

/** MaxSim: for each query vector, the best-matching doc vector, summed. */
function maxSim(query: Float32Array[], doc: Float32Array[]): number {
  let total = 0;
  for (const q of query) {
    let best = -Infinity;
    for (const p of doc) {
      const s = cosine(q, p);
      if (s > best) best = s;
    }
    total += best;
  }
  return total / query.length;
}

d("OnnxTextEmbedding (live)", () => {
  const embedder = (): OnnxTextEmbedding =>
    new OnnxTextEmbedding({
      modelPath: join(textDir, "model_int8.onnx"),
      tokenizerPath: join(textDir, "tokenizer.json"),
    });

  it("produces 768-dim unit vectors", { timeout: 120_000 }, async () => {
    expect(existsSync(join(textDir, "model_int8.onnx"))).toBe(true);
    const [v] = await embedder().embed(["a login form with a sign in button"]);
    expect(v!.length).toBe(768);
    expect(Math.sqrt(Array.from(v!).reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 4);
  });

  it("is deterministic for the same input", { timeout: 120_000 }, async () => {
    const e = embedder();
    const [a] = await e.embed(["hello world"]);
    const [b] = await e.embed(["hello world"]);
    expect(cosine(a!, b!)).toBeCloseTo(1, 6);
  });

  it("separates related from unrelated text", { timeout: 120_000 }, async () => {
    const e = embedder();
    const [q] = await e.embed(["how do I reset my password"], { role: "query" });
    const [near, far] = await e.embed(
      ["a login screen asking for email and password", "a chart of quarterly revenue"],
      { role: "document" },
    );
    expect(cosine(q!, near!)).toBeGreaterThan(cosine(q!, far!));
  });

  it("query and document roles produce DIFFERENT vectors", { timeout: 120_000 }, async () => {
    // If the prefixes were dropped these would be identical, and retrieval would
    // silently degrade with nothing to show for it.
    const e = embedder();
    const [asDoc] = await e.embed(["a login form"], { role: "document" });
    const [asQuery] = await e.embed(["a login form"], { role: "query" });
    expect(cosine(asDoc!, asQuery!)).toBeLessThan(0.999);
  });
});

d("ColModernVBertMultiVector (live)", () => {
  const provider = (): ColModernVBertMultiVector =>
    new ColModernVBertMultiVector({
      modelPath: join(colmodernDir, "model.onnx"),
      tokenizerPath: join(colmodernDir, "tokenizer.json"),
    });

  const tokenizer = () =>
    loadTokenizer(join(colmodernDir, "tokenizer.json"), join(colmodernDir, "tokenizer_config.json"));

  /**
   * The prompt string fastembed's colmodernvbert.py builds, reconstructed here
   * so the pure builder can be compared against the tokenizer's own encoding of
   * it. This is the check that actually pins the constants in MV_TOK: a wrong id
   * or a missed BPE merge shifts the sequence while every score stays plausible.
   */
  const IMAGE_SEQ_LEN = 64;
  const fastembedString = (rows: number, cols: number): string => {
    let split = "";
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        split +=
          "<fake_token_around_image>" +
          `<row_${r + 1}_col_${c + 1}>` +
          "<image>".repeat(IMAGE_SEQ_LEN);
      }
      split += "\n";
    }
    split +=
      "\n<fake_token_around_image><global-img>" +
      "<image>".repeat(IMAGE_SEQ_LEN) +
      "<fake_token_around_image>";
    return "<|begin_of_text|>User:<image>Describe the image.<end_of_utterance>\nAssistant:".replace(
      "<image>",
      split,
    );
  };

  it("measured token ids still match the real tokenizer", { timeout: 120_000 }, async () => {
    expect(existsSync(join(colmodernDir, "model.onnx"))).toBe(true);
    const tok = await tokenizer();
    // Every encode is wrapped by a TemplateProcessing post-processor, so a
    // single special token comes back as [CLS] x [SEP]. That wrapper IS the
    // thing most likely to be forgotten, so it is asserted rather than stripped.
    const enc = (s: string): number[] => tok.encode(s).ids;
    expect(enc("<image>")).toEqual([MV_TOK.cls, MV_TOK.image, MV_TOK.sep]);
    expect(enc("<global-img>")).toEqual([MV_TOK.cls, MV_TOK.globalImg, MV_TOK.sep]);
    expect(enc("<fake_token_around_image>")).toEqual([MV_TOK.cls, MV_TOK.fake, MV_TOK.sep]);
    expect(enc("<end_of_utterance>")).toEqual([MV_TOK.cls, MV_TOK.endOfUtterance, MV_TOK.sep]);
    expect(enc("<row_1_col_1>")).toEqual([MV_TOK.cls, MV_TOK.row1col1, MV_TOK.sep]);
    expect(enc("<row_2_col_1>")).toEqual([MV_TOK.cls, tileMarker(2, 1), MV_TOK.sep]);
    expect(enc("\n\n")).toEqual([MV_TOK.cls, MV_TOK.doubleNewline, MV_TOK.sep]);
  });

  it(
    "buildImagePrompt equals the tokenizer's encoding of fastembed's string",
    { timeout: 120_000 },
    async () => {
      const tok = await tokenizer();
      for (const [w, h] of [
        [1280, 800],
        [2560, 1600],
        [512, 512],
      ] as const) {
        const g = computeTileGeometry(w, h);
        expect(buildImagePrompt(g)).toEqual(tok.encode(fastembedString(g.rows, g.cols)).ids);
      }
    },
  );

  it("buildQueryPrompt equals fastembed's augmented query", { timeout: 120_000 }, async () => {
    const tok = await tokenizer();
    const text = "a terminal showing a build error";
    // fastembed augments the STRING then encodes, which is why the buffer must
    // land inside the [CLS] ... [SEP] wrapper rather than after it.
    expect(buildQueryPrompt(tok.encode(text).ids)).toEqual(
      tok.encode(text + "<end_of_utterance>".repeat(10)).ids,
    );
  });

  it("emits exactly the token count the geometry predicts", { timeout: 600_000 }, async () => {
    const [patches] = await provider().embedImages([login()]);
    const geo = computeTileGeometry(2560, 1600);
    expect(patches!.length).toBe(expectedTokenCount(geo));
    expect(patches![0]!.length).toBe(128);
  });

  it(
    "CROSS-MODAL: a text query scores higher on the matching screenshot",
    { timeout: 900_000 },
    async () => {
      const p = provider();
      const [loginPatches, terminalPatches] = await p.embedImages([login(), terminal()]);
      const [q] = await p.embedQueries(["a login form with a sign in button"]);

      const onLogin = maxSim(q!.vectors, loginPatches!);
      const onTerminal = maxSim(q!.vectors, terminalPatches!);
      console.log(`  MaxSim login=${onLogin.toFixed(4)} terminal=${onTerminal.toFixed(4)}`);
      expect(onLogin).toBeGreaterThan(onTerminal);
    },
  );

  it(
    "CROSS-MODAL: the reverse query prefers the other screenshot",
    { timeout: 900_000 },
    async () => {
      // Guards against a degenerate model that simply scores one image higher
      // regardless of the query.
      const p = provider();
      const [loginPatches, terminalPatches] = await p.embedImages([login(), terminal()]);
      const [q] = await p.embedQueries(["a terminal showing a typescript build error"]);

      const onLogin = maxSim(q!.vectors, loginPatches!);
      const onTerminal = maxSim(q!.vectors, terminalPatches!);
      console.log(`  MaxSim login=${onLogin.toFixed(4)} terminal=${onTerminal.toFixed(4)}`);
      expect(onTerminal).toBeGreaterThan(onLogin);
    },
  );

  it(
    "names the query's own token positions, inside the wrapper",
    { timeout: 600_000 },
    async () => {
      const p = provider();
      const [q] = await p.embedQueries(["sign in button"]);
      // [CLS] + tokens + 10 buffer + [SEP]: content is everything between the
      // wrapper and the buffer run, and never the first or last position.
      expect(q!.contentIndices.length).toBe(q!.vectors.length - QUERY_BUFFER_TOKENS - 2);
      expect(q!.contentIndices[0]).toBe(1);
      expect(q!.contentIndices.at(-1)).toBe(q!.vectors.length - QUERY_BUFFER_TOKENS - 2);
    },
  );

  it("argmax highlights land inside the frame", { timeout: 600_000 }, async () => {
    const p = provider();
    const [patches] = await p.embedImages([login()]);
    const [q] = await p.embedQueries(["sign in button"]);
    const geo = computeTileGeometry(2560, 1600);

    for (const qv of q!.vectors) {
      let argmax = -1;
      let top = -Infinity;
      for (let i = 0; i < patches!.length; i++) {
        const s = cosine(qv, patches![i]!);
        if (s > top) {
          top = s;
          argmax = i;
        }
      }
      const box = patchIndexToBox(argmax, geo);
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.w).toBeLessThanOrEqual(2560 + 1e-6);
      expect(box!.y + box!.h).toBeLessThanOrEqual(1600 + 1e-6);
    }
  });
});

d("OnnxCrossEncoderReranker (live)", () => {
  it("ranks the relevant candidate first", { timeout: 300_000 }, async () => {
    const r = new OnnxCrossEncoderReranker({
      modelPath: join(rerankDir, "model_int8.onnx"),
      tokenizerPath: join(rerankDir, "tokenizer.json"),
    });
    const order = await r.rerank("how do I sign in to my account", [
      { id: "revenue", text: "quarterly revenue chart for the finance team" },
      { id: "login", text: "a sign in screen with email and password fields" },
      { id: "build", text: "terminal output from a failed typescript build" },
    ]);
    console.log(`  rerank order: ${order.join(" > ")}`);
    expect(order[0]).toBe("login");
  });
});
