/**
 * Live smoke tests against REAL model weights. Skipped unless both are set:
 *
 *   ONNX_SMOKE=1
 *   DESKRAG_MODELS_DIR=/path/to/models
 *
 * expecting subdirectories:
 *   nomic-embed-text-v1.5/    model_int8.onnx tokenizer.json tokenizer_config.json
 *   colSmol-256M-dynamic/     model.onnx tokenizer.json tokenizer_config.json
 *                             preprocessor_config.json config.json
 *   jina-reranker-v1-turbo-en/model_int8.onnx tokenizer.json tokenizer_config.json
 *
 * The ColSmol entry must be a DYNAMIC export (scripts/export-colsmol.py); the
 * published one is traced at 13 tiles and rejects other counts.
 *
 * These are slow — ColSmol is seconds per image on CPU — so the timeouts are
 * generous and the whole file is opt-in.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OnnxTextEmbedding } from "../src/embed/onnx/text.js";
import { ColSmolMultiVector } from "../src/embed/onnx/colsmol.js";
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
const colsmolDir = join(MODELS, "colSmol-256M-dynamic");
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

d("ColSmolMultiVector (live)", () => {
  const provider = (): ColSmolMultiVector =>
    new ColSmolMultiVector({
      modelPath: join(colsmolDir, "model.onnx"),
      tokenizerPath: join(colsmolDir, "tokenizer.json"),
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
      // The single most important assertion in the design. If this fails,
      // sharedTextSpace is a lie and text-into-image search is broken — and
      // nothing else in the suite would catch it.
      const p = provider();
      const [loginPatches, terminalPatches] = await p.embedImages([login(), terminal()]);
      const [q] = await p.embedQueries(["a login form with a sign in button"]);

      const onLogin = maxSim(q!, loginPatches!);
      const onTerminal = maxSim(q!, terminalPatches!);
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

      const onLogin = maxSim(q!, loginPatches!);
      const onTerminal = maxSim(q!, terminalPatches!);
      console.log(`  MaxSim login=${onLogin.toFixed(4)} terminal=${onTerminal.toFixed(4)}`);
      expect(onTerminal).toBeGreaterThan(onLogin);
    },
  );

  it("argmax highlights land inside the frame", { timeout: 600_000 }, async () => {
    const p = provider();
    const [patches] = await p.embedImages([login()]);
    const [q] = await p.embedQueries(["sign in button"]);
    const geo = computeTileGeometry(2560, 1600);

    for (const qv of q!) {
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
