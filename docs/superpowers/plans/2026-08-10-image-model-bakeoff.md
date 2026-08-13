# Image Model Bake-Off Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, on real recordings, which single local image model should become DeskRAG's only image path — so the follow-on simplification spec deletes a provider on evidence rather than on argument.

**Architecture:** Three candidates are scored side by side against a frozen known-answer query set. One of them (ColModernVBERT) has no adapter yet, so this plan builds it first — an adapter that reuses the existing Idefics3 tiler and geometry verbatim, because ColModernVBERT's `preprocessor_config.json` is byte-for-byte equivalent to ColSmol's on every field `TileConfig` reads. The bake-off then indexes every candidate into a **copy** of the real store; `namespaceFor` gives each model its own Lance table, so they coexist without collision and one probe run scores them all.

**Tech Stack:** TypeScript strict ESM, vitest, onnxruntime-node (CPU), sharp, `@huggingface/tokenizers`, better-sqlite3 + LanceDB via `DualStore`.

## Global Constraints

- **This plan changes no default and deletes no provider.** Its only deliverable is a new adapter plus a finding document. The simplification is a separate spec written after the numbers exist.
- **The probe is read-only against real user data.** It copies `app.db` and `lance/` to a scratch dir and opens `blobs/` read-only. It never writes to `~/Library/Application Support/deskrag-app/DeskRAG/`.
- **`npm run typecheck` is the primary gate** and must pass at every commit. `npm test` must stay green and must stay offline — every new unit test uses an injected session and an injected tiler, never weights.
- **Real-weights tests are opt-in**, gated on `ONNX_SMOKE=1` + `DESKRAG_MODELS_DIR`, matching `test/onnx.smoke.test.ts`.
- **Weights are pinned to a commit SHA and verified by sha256** (`app/src/main/models.ts` rules). Never `main`.
- **`grep` needs `-a` on `src/store/store.ts`** — it contains deliberate NUL bytes and silently matches nothing without the text flag.
- The library never fetches weights. Anything downloaded in this plan is downloaded by hand or by the app's existing manifest path.
- Candidate model ids for `namespaceFor`: `nomic-embed-vision-v1.5` (768), `colsmol-256m` (128), `colmodernvbert-250m` (128). Do not reuse an existing model id for new weights — that is exactly the namespace collision the discipline exists to prevent.

---

## Background: three facts that shape the measurement

Established before writing this plan; an implementer should not re-derive them.

1. **`OnnxImageEmbedding.sharedTextSpace` is `false`** (`src/embed/onnx/image.ts:82`), documented at lines 36–44: nomic-embed-vision-v1.5 *could* share a space with nomic-embed-text-v1.5, but only if the text side applied `F.layer_norm` before normalizing, which `OnnxTextEmbedding` does not do. And `Tier2Retriever.retrieveFrames` returns `[]` unless `query.image` is set (`src/retrieve/tier2.ts:41`). **So today a text query never reaches a nomic frame vector at all.** The nomic lane answers visual-example queries only.
2. **`Tier2MultiVectorRetriever` serves text directly** (`src/retrieve/tier2-mv.ts`), because one model embeds both modalities into one space. This is the capability difference between the two paths, and it is much larger than the "fast vs slow" framing in `docs/providers.md`.
3. **ColModernVBERT's preprocessing is identical to ColSmol's** on every field the tiler reads — `Idefics3ImageProcessor`, `size.longest_edge: 2048`, `max_image_size.longest_edge: 512`, `patch_size: 16`, `pixel_shuffle_factor: 4`, mean/std 0.5, global tile last, `image_seq_len: 64`, `projection_dim: 128`. So `src/embed/onnx/geometry.ts` and `src/embed/onnx/colsmol-tiler.ts` are reused **unchanged**; only the prompt tokens and the ONNX feed differ.

Consequences for the query set: because the nomic lane cannot answer text, a text-only bake-off would score it 0 and look like a bug. The probe therefore runs **two query modes** — text and visual-example — and reports each candidate on both, marking "not supported" rather than "0".

## File Structure

**Created:**
- `src/embed/onnx/colmodernvbert-prompt.ts` — pure prompt construction (token ids, image-token positions). Mirrors `colsmol-prompt.ts`; no weights, no native modules, exhaustively testable.
- `src/embed/onnx/colmodernvbert.ts` — the `MultiVectorProvider` adapter. Not in the barrel (loads onnxruntime-node).
- `scripts/dump-colmodernvbert-tokens.mjs` — one-shot: prints the special-token ids from the real `tokenizer.json`, so the constants in the prompt module are *measured* rather than guessed.
- `scripts/imagelane-probe.mjs` — the bake-off harness. Read-only against real data.
- `test/onnx.colmodernvbert-prompt.test.ts` — prompt shape and token positions.
- `test/onnx.colmodernvbert.test.ts` — adapter behaviour with an injected session and tiler.
- `test/fixtures/imagelane-queries.json` — the frozen known-answer query set.
- `docs/superpowers/findings/2026-08-10-image-lane-measurement.md` — the finding the spec is built on.

**Modified:**
- `app/src/main/models.ts` — a `colmodernvbert` manifest entry (weights only; no provider wiring in this plan).
- `test/onnx.smoke.test.ts` — a real-weights case for the new adapter.

**Deliberately untouched:** `src/embed/onnx/geometry.ts`, `src/embed/onnx/colsmol-tiler.ts`, `src/retrieve/*`, `app/src/shared/types.ts`, `app/src/main/settings.ts`, `app/src/main/deskrag-service.ts`.

---

### Task 1: Pin the ColModernVBERT ONNX I/O contract

Nothing can be written against this export until its real input names and shapes are known. Guessing produces a plausible adapter that only fails at runtime — the reason `scripts/inspect-onnx.mjs` exists.

**Files:**
- Modify: `app/src/main/models.ts` (add a `colmodernvbert` entry to `MODELS`)
- Create: `docs/superpowers/findings/2026-08-10-image-lane-measurement.md` (started here, appended to by later tasks)

**Interfaces:**
- Consumes: nothing.
- Produces: weights on disk at `$DESKRAG_MODELS_DIR/colmodernvbert-250m/{model.onnx,tokenizer.json,tokenizer_config.json,preprocessor_config.json,config.json,processor_config.json}`; a recorded I/O contract (input names, dtypes, dim symbols) that Task 3 codes against.

- [x] **Step 1: Download the weights by hand into the models dir**

The repo's own rule: the library fetches nothing. Download once, manually.

```bash
MODELS="${DESKRAG_MODELS_DIR:?set DESKRAG_MODELS_DIR}"
REV=$(git ls-remote https://huggingface.co/Qdrant/colmodernvbert HEAD | cut -f1)
echo "revision $REV"
mkdir -p "$MODELS/colmodernvbert-250m"
for f in model.onnx tokenizer.json tokenizer_config.json preprocessor_config.json config.json processor_config.json special_tokens_map.json; do
  curl -sL -o "$MODELS/colmodernvbert-250m/$f" \
    "https://huggingface.co/Qdrant/colmodernvbert/resolve/$REV/$f"
done
ls -la "$MODELS/colmodernvbert-250m"
shasum -a 256 "$MODELS/colmodernvbert-250m/"*
```

Expected: `model.onnx` ≈ 1.01 GB, `tokenizer.json` ≈ 3.6 MB. Record `$REV` and every sha256 — they go into the manifest in Step 4.

- [x] **Step 2: Inspect the graph**

```bash
node scripts/inspect-onnx.mjs "$DESKRAG_MODELS_DIR/colmodernvbert-250m/model.onnx"
```

Expected, from reading `fastembed/late_interaction_multimodal/colmodernvbert.py`: inputs `input_ids`, `attention_mask`, `pixel_values`; **no `pixel_attention_mask`** (this is the difference from ColSmol, whose adapter feeds four inputs). `pixel_values` rank 5 — `(batch, num_patches, 3, 512, 512)`. One output, last dim 128.

Write the exact printed output into the finding doc under a heading `## ColModernVBERT ONNX contract`. If the names or the rank differ from the above, **stop and report** — Task 3's feed construction is written against this and nothing downstream is salvageable if it is wrong.

- [x] **Step 3: Measure the query-path pixel tensor**

fastembed's text path allocates `pixel_values` of shape `(batch, seq_length, 3, 512, 512)` — for a 30-token query that is ~1.4 GB of zeros per call, which would make query latency meaningless. DeskRAG's ColSmol adapter instead feeds ONE zero tile (`colsmol.ts`, `embedQueries`). Find out whether this export accepts the same.

```bash
node -e '
const ort = require("onnxruntime-node");
const p = process.env.DESKRAG_MODELS_DIR + "/colmodernvbert-250m/model.onnx";
(async () => {
  const s = await ort.InferenceSession.create(p, { executionProviders: ["cpu"] });
  const seq = 8, tiles = 1, side = 512;
  const t = (type, data, dims) => new ort.Tensor(type, data, dims);
  const out = await s.run({
    input_ids: t("int64", BigInt64Array.from(Array(seq).fill(1n)), [1, seq]),
    attention_mask: t("int64", BigInt64Array.from(Array(seq).fill(1n)), [1, seq]),
    pixel_values: t("float32", new Float32Array(tiles*3*side*side), [1, tiles, 3, side, side]),
  });
  const k = Object.keys(out)[0];
  console.log("OK", k, out[k].dims);
})().catch(e => { console.error("REJECTED:", e.message); process.exit(1); });
'
```

Expected: `OK <name> [ 1, 8, 128 ]`. Record the result in the finding doc either way — if it is rejected, the adapter must pad the dummy to `seq` tiles and query latency becomes a real cost the bake-off has to report.

- [x] **Step 4: Add the manifest entry**

In `app/src/main/models.ts`, add after the `colsmol` entry, using the SHA and hashes recorded in Step 1:

```ts
  colmodernvbert: {
    id: "colmodernvbert-250m",
    source: "download",
    repo: "Qdrant/colmodernvbert",
    revision: "<REV from Step 1>",
    files: [
      { path: "model.onnx", sha256: "<...>", bytes: <...> },
      { path: "tokenizer.json", sha256: "<...>", bytes: <...> },
      { path: "tokenizer_config.json", sha256: "<...>", bytes: <...> },
      { path: "preprocessor_config.json", sha256: "<...>", bytes: <...> },
      { path: "config.json", sha256: "<...>", bytes: <...> },
      { path: "processor_config.json", sha256: "<...>", bytes: <...> },
    ],
  },
```

Also extend the file's header comment, which currently explains why ColSmol is a re-export. Add:

```
 * ColModernVBERT is the UPSTREAM export, not a re-export: Qdrant's ONNX
 * (Qdrant/colmodernvbert, MIT) already builds input_ids from the actual patch
 * count, so it takes any tile count and needs no re-trace. That is the whole
 * reason scripts/export-colsmol.py has no counterpart here.
```

- [x] **Step 5: Verify the app still typechecks and commit**

```bash
npm run typecheck && npm --prefix app run typecheck
git add app/src/main/models.ts docs/superpowers/findings/2026-08-10-image-lane-measurement.md
git commit -m "chore(models): pin ColModernVBERT ONNX weights and record its I/O contract"
```

---

### Task 2: The prompt builder

ColPali-family models do not take pixels alone — patches are placeholder tokens inside a templated sequence, and a wrongly-shaped prompt yields vectors that are plausible but wrong, with scores staying in a believable range. This module is pure so it can be tested exhaustively without weights.

**Files:**
- Create: `scripts/dump-colmodernvbert-tokens.mjs`
- Create: `src/embed/onnx/colmodernvbert-prompt.ts`
- Test: `test/onnx.colmodernvbert-prompt.test.ts`

**Interfaces:**
- Consumes: `TileGeometry` from `src/embed/onnx/geometry.ts` (fields `rows`, `cols`, `tokensPerTile`, `hasGlobalTile`).
- Produces: `MV_TOK` (token id constants), `QUERY_BUFFER_TOKENS: number`, `buildImagePrompt(g: TileGeometry): number[]`, `buildQueryPrompt(queryTokenIds: number[]): number[]`, `imageTokenPositions(ids: number[]): number[]`, `tileMarker(row: number, col: number): number`.

- [x] **Step 1: Dump the real token ids**

The ids differ from ColSmol's — this is a ModernBERT tokenizer (vocab 50368 + 40 additional), not SmolLM2's. Measure them; do not reuse `colsmol-prompt.ts`'s `TOK`.

Create `scripts/dump-colmodernvbert-tokens.mjs`:

```js
/**
 * Print ColModernVBERT's special-token ids from the real tokenizer.
 *
 * The prompt builder hardcodes these so it stays pure and weight-free; this is
 * how they are MEASURED rather than guessed, and test/onnx.smoke.test.ts
 * re-derives them against the same tokenizer to catch drift.
 *
 *   node scripts/dump-colmodernvbert-tokens.mjs <modelsDir>/colmodernvbert-250m
 */
import { join } from "node:path";
import { loadTokenizer, defaultConfigPath } from "../dist/embed/onnx/tokenizer.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/dump-colmodernvbert-tokens.mjs <modelDir>");
  process.exit(1);
}
const tokenizerPath = join(dir, "tokenizer.json");
const tok = await loadTokenizer(tokenizerPath, defaultConfigPath(tokenizerPath));

const singles = [
  "<|begin_of_text|>", "<fake_token_around_image>", "<global-img>",
  "<image>", "<end_of_utterance>",
];
for (const s of singles) {
  console.log(`${s.padEnd(28)} ${JSON.stringify(tok.encode(s).ids)}`);
}
for (const r of [1, 2]) {
  for (const c of [1, 2, 3]) {
    console.log(`<row_${r}_col_${c}>`.padEnd(28) + JSON.stringify(tok.encode(`<row_${r}_col_${c}>`).ids));
  }
}
for (const s of ["User:", "Describe the image.", "\nAssistant:", "\n", "\n\n"]) {
  console.log(`${JSON.stringify(s).padEnd(28)} ${JSON.stringify(tok.encode(s).ids)}`);
}
```

Run it (needs `npm run build` first, like every script that imports `dist/`):

```bash
npm run build
node scripts/dump-colmodernvbert-tokens.mjs "$DESKRAG_MODELS_DIR/colmodernvbert-250m"
```

Record the output in the finding doc. Note the row/col stride: ColSmol's is 6 per row (`ROW_STRIDE`); read this one off the `<row_1_col_*>` and `<row_2_col_1>` ids rather than assuming it matches.

- [x] **Step 2: Write the failing test**

Create `test/onnx.colmodernvbert-prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeTileGeometry, expectedTokenCount } from "../src/embed/onnx/geometry.js";
import {
  MV_TOK,
  QUERY_BUFFER_TOKENS,
  buildImagePrompt,
  buildQueryPrompt,
  imageTokenPositions,
  tileMarker,
} from "../src/embed/onnx/colmodernvbert-prompt.js";

describe("colmodernvbert prompt", () => {
  it("emits exactly one image token per patch the geometry predicts", () => {
    for (const [w, h] of [
      [1280, 800],
      [2560, 1600],
      [1512, 982],
      [512, 512],
    ] as const) {
      const g = computeTileGeometry(w, h);
      const ids = buildImagePrompt(g);
      expect(imageTokenPositions(ids).length).toBe(expectedTokenCount(g));
    }
  });

  it("wraps every grid tile in fake + marker, in row-major order", () => {
    const g = computeTileGeometry(1280, 800);
    const ids = buildImagePrompt(g);
    const markers = ids.filter((id) => id !== MV_TOK.image && id >= MV_TOK.row1col1);
    const expected: number[] = [];
    for (let r = 1; r <= g.rows; r++) {
      for (let c = 1; c <= g.cols; c++) expected.push(tileMarker(r, c));
    }
    expect(markers.slice(0, expected.length)).toEqual(expected);
  });

  it("puts the global tile after the grid and the instruction tail after that", () => {
    const g = computeTileGeometry(1280, 800);
    const ids = buildImagePrompt(g);
    const globalAt = ids.indexOf(MV_TOK.globalImg);
    const lastMarker = ids.lastIndexOf(tileMarker(g.rows, g.cols));
    expect(globalAt).toBeGreaterThan(lastMarker);
    expect(ids.lastIndexOf(MV_TOK.image)).toBeGreaterThan(globalAt);
    expect(ids.indexOf(MV_TOK.endOfUtterance)).toBeGreaterThan(ids.lastIndexOf(MV_TOK.image));
  });

  it("starts with the visual prompt prefix", () => {
    const ids = buildImagePrompt(computeTileGeometry(1280, 800));
    expect(ids.slice(0, MV_TOK.prefix.length)).toEqual([...MV_TOK.prefix]);
  });

  it("appends exactly ten end-of-utterance buffer tokens to a query", () => {
    const ids = buildQueryPrompt([7, 8, 9]);
    expect(QUERY_BUFFER_TOKENS).toBe(10);
    expect(ids.slice(0, 3)).toEqual([7, 8, 9]);
    expect(ids.slice(3)).toEqual(new Array(10).fill(MV_TOK.endOfUtterance));
  });

  it("puts no image token in a query prompt", () => {
    expect(imageTokenPositions(buildQueryPrompt([7, 8, 9]))).toEqual([]);
  });
});
```

- [x] **Step 3: Run it to make sure it fails**

```bash
npx vitest run test/onnx.colmodernvbert-prompt.test.ts
```

Expected: FAIL — cannot resolve `../src/embed/onnx/colmodernvbert-prompt.js`.

- [x] **Step 4: Write the prompt module**

Create `src/embed/onnx/colmodernvbert-prompt.ts`. Replace every `0` placeholder with the id measured in Step 1; `ROW_STRIDE` likewise.

```ts
/**
 * ColModernVBERT prompt construction.
 *
 * Same shape as colsmol-prompt.ts and for the same reason — a ColPali-family
 * model embeds patches as placeholder tokens inside a templated sequence, and a
 * differently-shaped prompt yields vectors that are plausible but wrong. The
 * TOKEN IDS differ because this is a ModernBERT tokenizer, not SmolLM2's, so
 * they are measured with scripts/dump-colmodernvbert-tokens.mjs rather than
 * shared with the ColSmol module.
 *
 * Template, from Qdrant's ONNX wrapper (fastembed colmodernvbert.py):
 *   "<|begin_of_text|>User:" + <image-block> + "Describe the image."
 *   + <end_of_utterance> + "\nAssistant:"
 * where <image-block> is, per grid row, each tile as
 *   <fake_token_around_image><row_r_col_c> + 64x<image>
 * then "\n" after each row, then
 *   "\n<fake_token_around_image><global-img>" + 64x<image>
 *   + <fake_token_around_image>
 *
 * Pure and weight-free, so it is exhaustively testable.
 */

import type { TileGeometry } from "./geometry.js";

/** Token ids, measured from the real tokenizer — not guessed. */
export const MV_TOK = {
  /** "<|begin_of_text|>User:" as tokenized, in order. */
  prefix: [0 /* <|begin_of_text|> */, 0 /* User */, 0 /* : */] as const,
  fake: 0,
  globalImg: 0,
  /** <row_1_col_1>; ids advance by 1 per column and by ROW_STRIDE per row. */
  row1col1: 0,
  image: 0,
  newline: 0,
  /** "Describe the image." */
  describe: [0, 0, 0, 0] as const,
  endOfUtterance: 0,
  /** "\nAssistant:" */
  assistant: [0, 0, 0] as const,
} as const;

/** Stride between <row_r_col_1> and <row_r+1_col_1>; measured, not assumed. */
const ROW_STRIDE = 0;

/** Queries are padded with this many <end_of_utterance> tokens, always. */
export const QUERY_BUFFER_TOKENS = 10;

/** Marker id for a 1-based (row, col) tile position. */
export function tileMarker(row: number, col: number): number {
  return MV_TOK.row1col1 + (row - 1) * ROW_STRIDE + (col - 1);
}

/** The full `input_ids` for embedding one image. */
export function buildImagePrompt(g: TileGeometry): number[] {
  const ids: number[] = [...MV_TOK.prefix];

  for (let row = 1; row <= g.rows; row++) {
    for (let col = 1; col <= g.cols; col++) {
      ids.push(MV_TOK.fake, tileMarker(row, col));
      for (let i = 0; i < g.tokensPerTile; i++) ids.push(MV_TOK.image);
    }
    ids.push(MV_TOK.newline);
  }

  if (g.hasGlobalTile) {
    ids.push(MV_TOK.newline, MV_TOK.fake, MV_TOK.globalImg);
    for (let i = 0; i < g.tokensPerTile; i++) ids.push(MV_TOK.image);
    ids.push(MV_TOK.fake);
  }

  ids.push(...MV_TOK.describe, MV_TOK.endOfUtterance, ...MV_TOK.assistant);
  return ids;
}

/** Query `input_ids`: the tokenized query then a fixed run of buffer tokens. */
export function buildQueryPrompt(queryTokenIds: number[]): number[] {
  const ids = [...queryTokenIds];
  for (let i = 0; i < QUERY_BUFFER_TOKENS; i++) ids.push(MV_TOK.endOfUtterance);
  return ids;
}

/**
 * Sequence positions holding an image token, in order. The model emits one
 * vector per position, most of which are text; the n-th entry here is the n-th
 * patch, which is what makes `patchIndexToBox` applicable to the selection.
 */
export function imageTokenPositions(ids: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === MV_TOK.image) out.push(i);
  }
  return out;
}
```

- [x] **Step 5: Run the tests and make sure they pass**

```bash
npx vitest run test/onnx.colmodernvbert-prompt.test.ts && npm run typecheck
```

Expected: PASS, 6 tests.

- [x] **Step 6: Commit**

```bash
git add src/embed/onnx/colmodernvbert-prompt.ts test/onnx.colmodernvbert-prompt.test.ts scripts/dump-colmodernvbert-tokens.mjs
git commit -m "feat(embed): ColModernVBERT prompt construction from measured token ids"
```

---

### Task 3: The ColModernVBERT adapter

**Files:**
- Create: `src/embed/onnx/colmodernvbert.ts`
- Test: `test/onnx.colmodernvbert.test.ts`

**Interfaces:**
- Consumes: `MV_TOK`, `buildImagePrompt`, `buildQueryPrompt`, `imageTokenPositions` (Task 2); `DEFAULT_TILE_CONFIG`, `computeTileGeometry`, `expectedTokenCount`, `TileConfig`, `TiledImage` from `geometry.ts`; `tileImageWithSharp` from `colsmol-tiler.ts`; `OnnxRuntime`, `makeTensor`, `OnnxSession` from `runtime.ts`; `loadTokenizer`, `defaultConfigPath` from `tokenizer.ts`; `l2Normalize` from `pooling.ts`.
- Produces: `class ColModernVBertMultiVector implements MultiVectorProvider` with `id = "onnx"`, `model` defaulting to `"colmodernvbert-250m"`, `dimensions` defaulting to `128`, `multiVector = true`, `readonly tileConfig: TileConfig`, and constructor options `ColModernVBertOptions` = `{ modelPath, tokenizerPath, tokenizerConfigPath?, model?, dimensions?, tileConfig?, session?, tokenize?, tileImage? }`.

- [x] **Step 1: Write the failing test**

Create `test/onnx.colmodernvbert.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ColModernVBertMultiVector } from "../src/embed/onnx/colmodernvbert.js";
import { computeTileGeometry, expectedTokenCount } from "../src/embed/onnx/geometry.js";
import { QUERY_BUFFER_TOKENS } from "../src/embed/onnx/colmodernvbert-prompt.js";
import type { OnnxSession, OnnxTensor } from "../src/embed/onnx/runtime.js";

const D = 128;
const SIDE = 512;

/**
 * One-hot per sequence position at (p % D). One-hot survives L2 normalisation,
 * so a caller can recover WHICH positions were selected — the thing most likely
 * to be wrong, since the model emits a vector for every position and only the
 * <image> ones are patches.
 */
function stubSession(seen: Record<string, OnnxTensor>[]): OnnxSession {
  return {
    async run(feeds) {
      seen.push(feeds);
      const [, seq] = feeds.input_ids!.dims as [number, number];
      const data = new Float32Array(seq * D);
      for (let p = 0; p < seq; p++) data[p * D + (p % D)] = 1;
      return { embeddings: { data, dims: [1, seq, D] } };
    },
  };
}

function hotIndex(v: Float32Array): number {
  return v.findIndex((x) => x > 0.5);
}

const fakeTiler = (w = 1280, h = 800) => {
  const g = computeTileGeometry(w, h);
  const n = g.cols * g.rows + (g.hasGlobalTile ? 1 : 0);
  return async () => ({
    tiles: Array.from({ length: n }, () => new Float32Array(3 * SIDE * SIDE)),
    width: w,
    height: h,
  });
};

const opts = (session: OnnxSession, tiler = fakeTiler()) => ({
  modelPath: "/unused",
  tokenizerPath: "/unused",
  session,
  tileImage: tiler,
  tokenize: (t: string) => ({ ids: [...t].map((c) => c.charCodeAt(0)) }),
});

describe("ColModernVBertMultiVector", () => {
  it("returns one vector per patch the geometry predicts", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    const [patches] = await p.embedImages([new Uint8Array([1])]);
    expect(patches!.length).toBe(expectedTokenCount(computeTileGeometry(1280, 800)));
  });

  it("selects the IMAGE positions, not the leading positions", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    const [patches] = await p.embedImages([new Uint8Array([1])]);
    // The prefix is text, so the first patch cannot be at position 0.
    expect(hotIndex(patches![0]!)).toBeGreaterThan(0);
    // Positions are strictly increasing modulo D wraparound: check the first two.
    expect(hotIndex(patches![1]!)).toBe((hotIndex(patches![0]!) + 1) % D);
  });

  it("feeds three inputs and NO pixel_attention_mask", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    await p.embedImages([new Uint8Array([1])]);
    expect(Object.keys(seen[0]!).sort()).toEqual([
      "attention_mask",
      "input_ids",
      "pixel_values",
    ]);
  });

  it("feeds pixel_values as (1, tiles, 3, side, side)", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    await p.embedImages([new Uint8Array([1])]);
    const g = computeTileGeometry(1280, 800);
    const tiles = g.cols * g.rows + 1;
    expect(seen[0]!.pixel_values!.dims).toEqual([1, tiles, 3, SIDE, SIDE]);
  });

  it("throws when the tiler disagrees with the geometry", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const badTiler = async () => ({
      tiles: [new Float32Array(3 * SIDE * SIDE)],
      width: 1280,
      height: 800,
    });
    const p = new ColModernVBertMultiVector(opts(stubSession(seen), badTiler));
    await expect(p.embedImages([new Uint8Array([1])])).rejects.toThrow(/tiling mismatch/);
  });

  it("keeps every query position, buffer tokens included", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    const [q] = await p.embedQueries(["abc"]);
    expect(q!.length).toBe(3 + QUERY_BUFFER_TOKENS);
  });

  it("feeds exactly one dummy tile for a query", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    await p.embedQueries(["abc"]);
    expect(seen[0]!.pixel_values!.dims).toEqual([1, 1, 3, SIDE, SIDE]);
  });

  it("returns L2-normalised vectors", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    const [patches] = await p.embedImages([new Uint8Array([1])]);
    const norm = Math.hypot(...patches![0]!);
    expect(norm).toBeCloseTo(1, 5);
  });

  it("namespaces itself apart from ColSmol", () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    expect(p.model).toBe("colmodernvbert-250m");
    expect(p.dimensions).toBe(128);
    expect(p.multiVector).toBe(true);
  });
});
```

- [x] **Step 2: Run it to make sure it fails**

```bash
npx vitest run test/onnx.colmodernvbert.test.ts
```

Expected: FAIL — cannot resolve `../src/embed/onnx/colmodernvbert.js`.

- [x] **Step 3: Write the adapter**

Create `src/embed/onnx/colmodernvbert.ts`:

```ts
/**
 * ColModernVBERT-250M late-interaction embeddings via onnxruntime-node.
 *
 * NOT in the package barrel — loads onnxruntime-node and (via the tiler) sharp.
 * Import from this path directly.
 *
 * ONNX I/O contract, verified with scripts/inspect-onnx.mjs:
 *   inputs : input_ids, attention_mask, pixel_values
 *   output : [batch, seq, 128]
 *
 * Differs from colsmol.ts in exactly two places, and shares everything else:
 *
 *   1. THREE inputs, not four — this export has no `pixel_attention_mask`,
 *      because Qdrant's wrapper builds input_ids from the actual patch count
 *      instead of masking a padded batch.
 *   2. A different tokenizer, hence a different prompt module.
 *
 * The TILER AND GEOMETRY ARE SHARED VERBATIM with ColSmol, which is a fact about
 * the models rather than a convenience: ColModernVBERT's preprocessor_config.json
 * matches ColSmol's on every field TileConfig reads (Idefics3ImageProcessor,
 * longest_edge 2048, tiles of 512, patch 16, pixel_shuffle 4, mean/std 0.5,
 * global tile last, 64 tokens per tile). So the >= 2048px capture rule in
 * colsmol-tiler.ts applies here IDENTICALLY — below it, the preprocessor
 * upscales and patch vectors drift with scores still looking sane.
 */

import type { MultiVectorProvider } from "../types.js";
import { l2Normalize } from "./pooling.js";
import {
  DEFAULT_TILE_CONFIG,
  computeTileGeometry,
  expectedTokenCount,
  type TileConfig,
  type TiledImage,
} from "./geometry.js";
import {
  buildImagePrompt,
  buildQueryPrompt,
  imageTokenPositions,
} from "./colmodernvbert-prompt.js";
import { OnnxRuntime, makeTensor, type OnnxSession } from "./runtime.js";
import { defaultConfigPath, loadTokenizer } from "./tokenizer.js";

export interface ColModernVBertOptions {
  modelPath: string;
  tokenizerPath: string;
  tokenizerConfigPath?: string;
  model?: string;
  dimensions?: number;
  tileConfig?: TileConfig;
  /** Injected session (tests). */
  session?: OnnxSession;
  /** Injected tokenizer (tests). */
  tokenize?: (text: string) => { ids: number[] };
  /** Injected tiler (tests) — avoids loading sharp. */
  tileImage?: (image: Uint8Array, cfg: TileConfig) => Promise<TiledImage>;
}

export class ColModernVBertMultiVector implements MultiVectorProvider {
  readonly id = "onnx";
  readonly model: string;
  readonly dimensions: number;
  readonly multiVector = true as const;
  readonly tileConfig: TileConfig;

  private readonly modelPath: string;
  private readonly tokenizerPath: string;
  private readonly tokenizerConfigPath: string;
  private readonly injectedSession: OnnxSession | undefined;
  private readonly injectedTokenize: ((t: string) => { ids: number[] }) | undefined;
  private readonly injectedTiler: ColModernVBertOptions["tileImage"];
  private loadedTokenizer: Promise<(t: string) => { ids: number[] }> | undefined;

  constructor(opts: ColModernVBertOptions) {
    this.model = opts.model ?? "colmodernvbert-250m";
    this.dimensions = opts.dimensions ?? 128;
    this.tileConfig = opts.tileConfig ?? DEFAULT_TILE_CONFIG;
    this.modelPath = opts.modelPath;
    this.tokenizerPath = opts.tokenizerPath;
    this.tokenizerConfigPath =
      opts.tokenizerConfigPath ?? defaultConfigPath(opts.tokenizerPath);
    this.injectedSession = opts.session;
    this.injectedTokenize = opts.tokenize;
    this.injectedTiler = opts.tileImage;
  }

  private session(): Promise<OnnxSession> {
    return this.injectedSession
      ? Promise.resolve(this.injectedSession)
      : OnnxRuntime.session(this.modelPath);
  }

  private async tokenizer(): Promise<(t: string) => { ids: number[] }> {
    if (this.injectedTokenize) return this.injectedTokenize;
    this.loadedTokenizer ??= (async () => {
      const tok = await loadTokenizer(this.tokenizerPath, this.tokenizerConfigPath);
      return (t: string) => ({ ids: tok.encode(t).ids });
    })();
    return this.loadedTokenizer;
  }

  private async tile(image: Uint8Array): Promise<TiledImage> {
    if (this.injectedTiler) return this.injectedTiler(image, this.tileConfig);
    const { tileImageWithSharp } = await import(/* @vite-ignore */ "./colsmol-tiler.js");
    return tileImageWithSharp(image, this.tileConfig);
  }

  /** Run one sequence and return the per-position vectors at `positions`. */
  private async runAndSelect(
    ids: number[],
    pixels: Float32Array,
    tileCount: number,
    positions: number[] | null,
  ): Promise<Float32Array[]> {
    const seq = ids.length;
    const side = this.tileConfig.tileSize;
    const sess = await this.session();

    const out = await sess.run({
      input_ids: makeTensor("int64", BigInt64Array.from(ids.map((n) => BigInt(n))), [1, seq]),
      attention_mask: makeTensor(
        "int64",
        BigInt64Array.from(new Array<bigint>(seq).fill(1n)),
        [1, seq],
      ),
      pixel_values: makeTensor("float32", pixels, [1, tileCount, 3, side, side]),
    });

    const emb = (out.embeddings ?? Object.values(out)[0]!) as {
      data: Float32Array;
      dims: number[];
    };
    const dims = emb.dims[emb.dims.length - 1]!;
    const take = positions ?? Array.from({ length: seq }, (_, i) => i);
    return take.map((p) => l2Normalize(emb.data.slice(p * dims, (p + 1) * dims)));
  }

  async embedImages(images: Uint8Array[]): Promise<Float32Array[][]> {
    if (images.length === 0) return [];
    const side = this.tileConfig.tileSize;
    const results: Float32Array[][] = [];

    // One image per run: tile count varies with aspect ratio, so batching would
    // need padding plus a mask over patch positions.
    for (const image of images) {
      const tiled = await this.tile(image);
      const geo = computeTileGeometry(tiled.width, tiled.height, this.tileConfig);
      const expectedTiles = geo.cols * geo.rows + (geo.hasGlobalTile ? 1 : 0);
      if (tiled.tiles.length !== expectedTiles) {
        throw new Error(
          `ColModernVBERT tiling mismatch: tiler produced ${tiled.tiles.length} tiles, ` +
            `geometry predicts ${expectedTiles} for ${tiled.width}x${tiled.height} ` +
            `(${geo.cols}x${geo.rows}${geo.hasGlobalTile ? " + global" : ""}).`,
        );
      }

      const pixels = new Float32Array(tiled.tiles.length * 3 * side * side);
      tiled.tiles.forEach((t, i) => pixels.set(t, i * 3 * side * side));

      const ids = buildImagePrompt(geo);
      const positions = imageTokenPositions(ids);
      const expectedTokens = expectedTokenCount(geo);
      if (positions.length !== expectedTokens) {
        throw new Error(
          `ColModernVBERT prompt mismatch: ${positions.length} image tokens, ` +
            `geometry predicts ${expectedTokens}.`,
        );
      }

      results.push(await this.runAndSelect(ids, pixels, tiled.tiles.length, positions));
    }
    return results;
  }

  async embedQueries(texts: string[]): Promise<Float32Array[][]> {
    if (texts.length === 0) return [];
    const tokenize = await this.tokenizer();
    const side = this.tileConfig.tileSize;
    // The graph declares pixel inputs as required, but a query carries no image.
    // One zero tile satisfies the signature; with no <image> tokens in the
    // prompt its vision output is never merged into the sequence. Verified
    // against the real export in Task 1 Step 3 — fastembed pads to seq_length
    // instead, which would allocate ~1.4GB of zeros per query.
    const dummy = new Float32Array(3 * side * side);

    const results: Float32Array[][] = [];
    for (const text of texts) {
      const ids = buildQueryPrompt(tokenize(text).ids);
      // Every query position is kept, buffer tokens included: those are the
      // learned expansion slots late interaction relies on.
      results.push(await this.runAndSelect(ids, dummy, 1, null));
    }
    return results;
  }
}
```

If Task 1 Step 3 found the one-tile dummy REJECTED, change `embedQueries` to build `new Float32Array(ids.length * 3 * side * side)` and pass `ids.length` as the tile count, and update the two query tests to expect `[1, seq, 3, 512, 512]`.

- [x] **Step 4: Run the tests and make sure they pass**

```bash
npx vitest run test/onnx.colmodernvbert.test.ts && npm run typecheck && npm test
```

Expected: the new file PASSES 9 tests; the full suite stays green.

- [x] **Step 5: Commit**

```bash
git add src/embed/onnx/colmodernvbert.ts test/onnx.colmodernvbert.test.ts
git commit -m "feat(embed): ColModernVBERT multi-vector adapter over the shared Idefics3 tiler"
```

---

### Task 4: Real-weights smoke

The unit tests above prove plumbing against a stub. They cannot prove the adapter produces vectors that mean anything — which is the failure mode this repo has paid for twice (the AX role prefix, the stale sidecar).

**Files:**
- Modify: `test/onnx.smoke.test.ts`

**Interfaces:**
- Consumes: `ColModernVBertMultiVector` (Task 3).
- Produces: confidence that the adapter is measurable; no exported symbols.

- [x] **Step 1: Write the failing test**

Append to `test/onnx.smoke.test.ts`, inside the existing gated describe block (match the file's existing `existsSync` guard style, and extend its header comment to list `colmodernvbert-250m/` alongside the other expected subdirectories):

```ts
  it(
    "colmodernvbert ranks the matching screenshot above the other",
    async () => {
      const dir = join(MODELS_DIR, "colmodernvbert-250m");
      const p = new ColModernVBertMultiVector({
        modelPath: join(dir, "model.onnx"),
        tokenizerPath: join(dir, "tokenizer.json"),
      });

      const login = new Uint8Array(readFileSync(join(FIXTURES, "login.png")));
      const term = new Uint8Array(readFileSync(join(FIXTURES, "terminal.png")));
      const [loginPatches, termPatches] = await p.embedImages([login, term]);
      const [q] = await p.embedQueries(["a terminal showing a build error"]);

      // MaxSim: for each query vector, the best patch; summed.
      const maxSim = (patches: Float32Array[]) =>
        q!.reduce((acc, qv) => {
          let best = -Infinity;
          for (const pv of patches) {
            let dot = 0;
            for (let i = 0; i < qv.length; i++) dot += qv[i]! * pv[i]!;
            if (dot > best) best = dot;
          }
          return acc + best;
        }, 0);

      expect(loginPatches!.length).toBeGreaterThan(100);
      expect(maxSim(termPatches!)).toBeGreaterThan(maxSim(loginPatches!));
    },
    600_000,
  );

  it("colmodernvbert's measured token ids still match the real tokenizer", async () => {
    const dir = join(MODELS_DIR, "colmodernvbert-250m");
    const tok = await loadTokenizer(
      join(dir, "tokenizer.json"),
      join(dir, "tokenizer_config.json"),
    );
    expect(tok.encode("<image>").ids).toEqual([MV_TOK.image]);
    expect(tok.encode("<global-img>").ids).toEqual([MV_TOK.globalImg]);
    expect(tok.encode("<fake_token_around_image>").ids).toEqual([MV_TOK.fake]);
    expect(tok.encode("<end_of_utterance>").ids).toEqual([MV_TOK.endOfUtterance]);
    expect(tok.encode("<row_1_col_1>").ids).toEqual([MV_TOK.row1col1]);
    expect(tok.encode("<row_2_col_1>").ids).toEqual([tileMarker(2, 1)]);
  });
```

Add the imports at the top of the file: `ColModernVBertMultiVector` from `../src/embed/onnx/colmodernvbert.js`, `MV_TOK`/`tileMarker` from `../src/embed/onnx/colmodernvbert-prompt.js`, and `loadTokenizer` from `../src/embed/onnx/tokenizer.js` if not already imported.

- [x] **Step 2: Run it**

```bash
ONNX_SMOKE=1 DESKRAG_MODELS_DIR="$DESKRAG_MODELS_DIR" npx vitest run test/onnx.smoke.test.ts -t colmodernvbert
```

Expected: PASS. The tokenizer test is the one that catches a wrong constant in Task 2 — if it fails, the ids in `MV_TOK` are wrong and every vector produced so far is meaningless.

- [x] **Step 3: Verify the suite still skips cleanly without weights**

```bash
npm test
```

Expected: green, with the smoke file skipped.

- [x] **Step 4: Commit**

```bash
git add test/onnx.smoke.test.ts
git commit -m "test(onnx): real-weights smoke for ColModernVBERT, including token-id drift"
```

---

### Task 5: Build and freeze the known-answer query set

A bake-off is only as good as its ground truth. This builds candidate queries **from the recordings themselves** — AX labels and typed-text runs are literally rendered on screen, so they are evidence of what a frame shows that is independent of any image model — and then requires a human pass, because auto-generated ground truth agrees with whatever generated it.

**Files:**
- Create: `test/fixtures/imagelane-queries.json`
- Create: `scripts/imagelane-probe.mjs` (the `--propose` mode only; scoring comes in Task 6)

**Interfaces:**
- Consumes: `DualStore` (`listSessions`, `getFramesBySession`, `getFrameAx`, `getBlob`), `BlobStore.read`.
- Produces: `test/fixtures/imagelane-queries.json`, shape:
  ```json
  {
    "note": "human-reviewed; each query names ONE frame, described from what is visible",
    "queries": [
      { "text": "the settings screen showing the image provider picker", "frameId": "01J...", "sessionId": "01J..." }
    ]
  }
  ```

- [ ] **Step 1: Write the proposal mode**

Create `scripts/imagelane-probe.mjs` with only `--propose` implemented for now:

```js
/**
 * Image-lane bake-off harness.
 *
 * READ-ONLY against real user data: it copies app.db and lance/ into a scratch
 * dir and opens blobs/ without writing. Nothing here touches the live store —
 * the same principle as scripts/replay-probe.mjs wrapping its Actuator.
 *
 *   node scripts/imagelane-probe.mjs --propose            # draft ground truth
 *   node scripts/imagelane-probe.mjs --run <models-dir>   # score every candidate
 *
 * Requires `npm run build` first (imports dist/).
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DualStore } from "../dist/store/store.js";
import { BlobStore } from "../dist/store/blob-store.js";

export const DATA_DIR =
  process.env.DESKRAG_DATA_DIR ??
  join(homedir(), "Library", "Application Support", "deskrag-app", "DeskRAG");

/** Copy the relational + vector stores so the real ones are never written. */
export function openScratchCopy() {
  const dir = mkdtempSync(join(tmpdir(), "deskrag-bakeoff-"));
  cpSync(join(DATA_DIR, "app.db"), join(dir, "app.db"));
  for (const suffix of ["-wal", "-shm"]) {
    try {
      cpSync(join(DATA_DIR, `app.db${suffix}`), join(dir, `app.db${suffix}`));
    } catch {
      /* absent when the app is closed — normal */
    }
  }
  cpSync(join(DATA_DIR, "lance"), join(dir, "lance"), { recursive: true });
  return dir;
}

async function propose() {
  const dir = openScratchCopy();
  const store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
  const out = [];
  for (const s of store.listSessions()) {
    for (const frame of store.getFramesBySession(s.id)) {
      const labels = store
        .getFrameAx(frame.id)
        .map((e) => (e.label ?? "").trim())
        .filter((l) => l.length >= 4 && l.length <= 60);
      const uniq = [...new Set(labels)].slice(0, 3);
      if (uniq.length === 0) continue;
      out.push({
        text: `the screen showing ${uniq.join(", ")}`,
        frameId: frame.id,
        sessionId: s.id,
        _evidence: uniq,
        _tMono: frame.tMono,
      });
    }
  }
  store.close();
  writeFileSync(
    "test/fixtures/imagelane-queries.draft.json",
    JSON.stringify({ note: "DRAFT — review by hand, see Task 5", queries: out }, null, 2),
  );
  console.log(`proposed ${out.length} queries across ${new Set(out.map((q) => q.sessionId)).size} sessions`);
}

if (process.argv.includes("--propose")) await propose();
```

- [ ] **Step 2: Run it against the real library**

```bash
npm run build
node scripts/imagelane-probe.mjs --propose
```

Expected: a draft file with one candidate per frame that has AX labels. If it proposes fewer than ~40 queries, there are not enough recordings to measure anything — record more before continuing (see Task 7 Step 1).

- [ ] **Step 3: Review the draft by hand — this step cannot be automated**

Open the draft and, for each entry, look at the frame it names (`deskrag://frame/` is not available from a script; use the app's Library, or extract the keyframe with the `_tMono` value). Then:

- **Rewrite the text** as a description a person would actually type — the auto-generated `the screen showing X, Y, Z` is a seed, not a query.
- **Delete any query whose answer is ambiguous.** If two frames in the library would both be correct, it is not known-answer.
- **Keep the distribution honest**: do not keep only text-heavy frames, or the measurement will flatter late interaction by construction.
- **Strip `_evidence` and `_tMono`.**

Target ≥40 reviewed queries spanning ≥4 recordings. Save as `test/fixtures/imagelane-queries.json` and delete the draft.

- [ ] **Step 4: Add the visual-example arm**

The nomic lane serves image queries only (Background fact 1), so the set needs a second section. For each of 10 reviewed entries, pick a DIFFERENT frame of the same UI state as the query image. Append to the fixture:

```json
  "visualQueries": [
    { "queryFrameId": "01J...", "expectFrameId": "01J...", "sessionId": "01J..." }
  ]
```

If no recording contains two frames of the same state, note that in the finding doc and leave `visualQueries` empty — the visual arm is then unmeasurable on this library, which is itself a result worth writing down.

- [ ] **Step 5: Commit**

```bash
git add scripts/imagelane-probe.mjs test/fixtures/imagelane-queries.json
git commit -m "test(fixtures): frozen known-answer query set for the image-lane bake-off"
```

---

### Task 6: The bake-off harness

**Files:**
- Modify: `scripts/imagelane-probe.mjs` (add `--run`)

**Interfaces:**
- Consumes: `openScratchCopy` (Task 5), `ColModernVBertMultiVector` (Task 3), `ColSmolMultiVector`, `OnnxImageEmbedding`, `FrameRepresenter`, `FramePatchRepresenter`, `Tier2Retriever`, `Tier2MultiVectorRetriever`, all from `dist/`.
- Produces: a printed table plus `imagelane-results.json` in the scratch dir; no exported symbols.

- [ ] **Step 1: Add the candidate table and indexing pass**

Append to `scripts/imagelane-probe.mjs`:

```js
import { FrameRepresenter } from "../dist/represent/frame-representer.js";
import { FramePatchRepresenter } from "../dist/represent/frame-patch-representer.js";
import { Tier2Retriever } from "../dist/retrieve/tier2.js";
import { Tier2MultiVectorRetriever } from "../dist/retrieve/tier2-mv.js";
import { OnnxImageEmbedding } from "../dist/embed/onnx/image.js";
import { ColSmolMultiVector } from "../dist/embed/onnx/colsmol.js";
import { ColModernVBertMultiVector } from "../dist/embed/onnx/colmodernvbert.js";

/**
 * Each candidate owns its own namespace via namespaceFor, so all three index
 * into ONE scratch store without colliding — that is what makes a single run
 * comparable rather than three runs with different scopes.
 */
function candidates(models) {
  return [
    {
      name: "nomic-embed-vision-v1.5",
      kind: "single",
      make: () =>
        new OnnxImageEmbedding({
          modelPath: join(models, "nomic-embed-vision-v1.5", "model_int8.onnx"),
          preprocessorPath: join(models, "nomic-embed-vision-v1.5", "preprocessor_config.json"),
        }),
    },
    {
      name: "colsmol-256m",
      kind: "multi",
      make: () =>
        new ColSmolMultiVector({
          modelPath: join(models, "colSmol-256M-dynamic", "model.onnx"),
          tokenizerPath: join(models, "colSmol-256M-dynamic", "tokenizer.json"),
        }),
    },
    {
      name: "colmodernvbert-250m",
      kind: "multi",
      make: () =>
        new ColModernVBertMultiVector({
          modelPath: join(models, "colmodernvbert-250m", "model.onnx"),
          tokenizerPath: join(models, "colmodernvbert-250m", "tokenizer.json"),
        }),
    },
  ];
}

async function indexCandidate(store, blobs, c) {
  const embedder = c.make();
  const t0 = Date.now();
  let frames = 0;
  let vectors = 0;
  for (const s of store.listSessions()) {
    if (c.kind === "single") {
      const r = new FrameRepresenter(store, { imageEmbedder: embedder, blobStore: blobs });
      await r.ensureSpace();
      const res = await r.represent(s.id);
      frames += res.frameCount;
      vectors += res.embeddedCount;
    } else {
      const r = new FramePatchRepresenter(store, { patchEmbedder: embedder, blobStore: blobs });
      await r.ensureSpace();
      const res = await r.represent(s.id);
      frames += res.frameCount;
      vectors += res.embeddedCount;
    }
  }
  const ms = Date.now() - t0;
  return { embedder, frames, vectors, msPerFrame: frames ? ms / frames : 0 };
}
```

Check the exact `represent()` signature of both representers before running — read `src/represent/frame-representer.ts` and `src/represent/frame-patch-representer.ts` and pass whatever they actually take (they need the session's segments, so the call may require more than a session id). Adjust rather than guessing.

- [ ] **Step 2: Add scoring**

```js
const rankOf = (hits, expected) => {
  const i = hits.findIndex((h) => h.frameId === expected);
  return i < 0 ? Infinity : i + 1;
};
const summarise = (ranks) => {
  const finite = ranks.filter((r) => Number.isFinite(r));
  return {
    n: ranks.length,
    "recall@1": ranks.filter((r) => r <= 1).length / ranks.length,
    "recall@5": ranks.filter((r) => r <= 5).length / ranks.length,
    mrr: ranks.reduce((a, r) => a + (Number.isFinite(r) ? 1 / r : 0), 0) / ranks.length,
    meanRank: finite.length ? finite.reduce((a, r) => a + r, 0) / finite.length : null,
    missed: ranks.length - finite.length,
  };
};

async function scoreText(store, c, indexed, queries) {
  if (c.kind === "single") return { supported: false, why: "text never reaches a nomic frame vector: sharedTextSpace is false and Tier2Retriever requires query.image" };
  const t2 = new Tier2MultiVectorRetriever(store, indexed.embedder, { topN: 50 });
  const ranks = [];
  let totalMs = 0;
  for (const q of queries) {
    const t0 = Date.now();
    const qv = await t2.embedQuery({ text: q.text });
    const hits = qv ? await t2.retrieveFrames({ text: q.text }, qv) : [];
    totalMs += Date.now() - t0;
    ranks.push(rankOf(hits, q.frameId));
  }
  return { supported: true, ...summarise(ranks), msPerQuery: totalMs / queries.length };
}

async function scoreVisual(store, blobs, c, indexed, visualQueries) {
  if (visualQueries.length === 0) return { supported: true, n: 0, note: "no visual pairs in this library" };
  const ranks = [];
  let totalMs = 0;
  for (const q of visualQueries) {
    const frame = store.getFrame(q.queryFrameId);
    const blob = frame?.blobId ? store.getBlob(frame.blobId) : undefined;
    if (!blob) continue;
    const bytes = await blobs.read(blob);
    const t0 = Date.now();
    let hits;
    if (c.kind === "single") {
      const t2 = new Tier2Retriever(store, indexed.embedder, { topN: 50 });
      hits = await t2.retrieveFramesUnscoped({ image: bytes });
    } else {
      const t2 = new Tier2MultiVectorRetriever(store, indexed.embedder, { topN: 50 });
      const qv = await t2.embedQuery({ image: bytes });
      hits = qv ? await t2.retrieveFrames({ image: bytes }, qv) : [];
    }
    totalMs += Date.now() - t0;
    ranks.push(rankOf(hits.filter((h) => h.frameId !== q.queryFrameId), q.expectFrameId));
  }
  return { supported: true, ...summarise(ranks), msPerQuery: totalMs / Math.max(1, ranks.length) };
}
```

Check `retrieveFrames`' real signature on `Tier2MultiVectorRetriever` before running (`src/retrieve/tier2-mv.ts`) — the module's header says query embedding is explicit and the vectors are passed in, so the argument order above is the expectation, not a verified fact.

- [ ] **Step 3: Add the baseline arm and the driver**

The honest baseline is **no image lane at all**: what the free lanes already return. Score the same text queries through `LexicalSegmentSearcher` + Tier-3's FTS half by running the retriever with no image embedder, and report frame rank the same way.

```js
async function run(models) {
  const dir = openScratchCopy();
  const store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
  const blobs = new BlobStore(join(DATA_DIR, "blobs"));
  const fixture = JSON.parse(readFileSync("test/fixtures/imagelane-queries.json", "utf8"));
  const results = [];

  for (const c of candidates(models)) {
    console.log(`\n=== ${c.name} ===`);
    const indexed = await indexCandidate(store, blobs, c);
    console.log(`indexed ${indexed.vectors}/${indexed.frames} frames, ${indexed.msPerFrame.toFixed(0)}ms/frame`);
    const text = await scoreText(store, c, indexed, fixture.queries);
    const visual = await scoreVisual(store, blobs, c, indexed, fixture.visualQueries ?? []);
    console.log("text  ", JSON.stringify(text));
    console.log("visual", JSON.stringify(visual));
    results.push({ candidate: c.name, indexed: { frames: indexed.frames, vectors: indexed.vectors, msPerFrame: indexed.msPerFrame }, text, visual });
  }

  writeFileSync(join(dir, "imagelane-results.json"), JSON.stringify(results, null, 2));
  console.log(`\nresults: ${join(dir, "imagelane-results.json")}`);
  store.close();
}

const runAt = process.argv.indexOf("--run");
if (runAt >= 0) await run(process.argv[runAt + 1] ?? process.env.DESKRAG_MODELS_DIR);
```

Add a fourth entry to the printed table by running the full `Retriever` with neither `imageEmbedder` nor `patchEmbedder` over the same queries, labelled `none (lexical + AX FTS only)`.

- [ ] **Step 4: Verify it is read-only**

```bash
shasum -a 256 "$DESKRAG_DATA_DIR/app.db" > /tmp/before.txt 2>/dev/null || \
  shasum -a 256 "$HOME/Library/Application Support/deskrag-app/DeskRAG/app.db" > /tmp/before.txt
node scripts/imagelane-probe.mjs --run "$DESKRAG_MODELS_DIR"
shasum -a 256 "$HOME/Library/Application Support/deskrag-app/DeskRAG/app.db" > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "REAL STORE UNTOUCHED"
```

Expected: `REAL STORE UNTOUCHED`. Quit the app first so no WAL write races the copy.

- [ ] **Step 5: Commit**

```bash
git add scripts/imagelane-probe.mjs
git commit -m "feat(scripts): read-only image-lane bake-off harness"
```

---

### Task 7: Run the sweep at both capture widths and write the finding

**Files:**
- Modify: `docs/superpowers/findings/2026-08-10-image-lane-measurement.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the document the simplification spec is written from.

- [ ] **Step 1: Record fresh sessions at 2560px**

Stored keyframes are at whatever width they were captured — the 1280-vs-2048 question **cannot** be answered by re-processing old recordings. It needs new ones.

Set `imageMaxWidth` to 2560 in Settings, then record 3 sessions of ~30s each covering the same kinds of work as the existing library (a text-heavy app, a browser, and DeskRAG itself). Per the decimation note in CLAUDE.md, **close the Recorder window to the tray** while recording — its millisecond timer defeats mpdecimate and would give you 20+ near-identical keyframes.

Then set it back to 1280 and record 3 more of the same activities. Note the session ids of both groups.

- [ ] **Step 2: Extend the query set to cover the new recordings**

```bash
npm run build
node scripts/imagelane-probe.mjs --propose
```

Review as in Task 5 Step 3 and merge the new entries into `test/fixtures/imagelane-queries.json`, tagging each with `"width": 1280` or `"width": 2560`.

- [ ] **Step 3: Run the sweep**

```bash
node scripts/imagelane-probe.mjs --run "$DESKRAG_MODELS_DIR" | tee /tmp/bakeoff.log
```

Expect this to be slow — the two multi-vector candidates are seconds per frame, so a library of ~100 frames is tens of minutes per candidate.

- [ ] **Step 4: Write the finding**

Fill in `docs/superpowers/findings/2026-08-10-image-lane-measurement.md` with:

- The ONNX contract and query-tensor result from Task 1.
- The measured token ids from Task 2.
- A table, one row per candidate × capture width:

  | candidate | width | recall@1 (text) | recall@5 (text) | MRR | recall@5 (visual) | ms/frame | vectors/frame | bytes/frame |
  |---|---|---|---|---|---|---|---|---|

  with `none (lexical + AX FTS only)` as the first row.
- **The three questions the spec needs answered, each with a number:**
  1. Does any image lane beat `none` on text queries, and by how much?
  2. Does ColModernVBERT beat ColSmol at the same capture width?
  3. What does going 1280 → 2560 cost (blob bytes, ms/frame) and buy (recall)?
- **What the measurement could not settle**, stated plainly — e.g. an empty `visualQueries` arm, or too few recordings to separate two candidates.

Follow the house style: every claim carries its number, and a number that came from one application is provisional.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/findings/2026-08-10-image-lane-measurement.md test/fixtures/imagelane-queries.json
git commit -m "measure: image-lane bake-off across three candidates and two capture widths"
```

- [ ] **Step 6: Hand off to the spec**

The finding is the input to a separate design doc, `docs/superpowers/specs/2026-08-1X-single-image-provider-design.md`, which decides which candidate becomes the only image path and plans the deletion of the others (`ImageProvider` union in `app/src/shared/types.ts`, the mutually-exclusive branch in `Retriever` and `DeskRagService`, the settings migration for users whose persisted provider is being removed, and the `imageMaxWidth` default if the winner needs 2048). **Do not start that work inside this plan.**

---

## Self-Review

**Spec coverage.** The user's requirement was "measure first, find the best model that runs on this system, then produce a spec to simplify". Tasks 1–4 make the third candidate measurable at all; Tasks 5–6 build the measurement; Task 7 runs it and produces the finding the spec needs. The simplification itself is explicitly out of scope and is handed off in Task 7 Step 6.

**Known soft spots, called out rather than hidden.** Three code blocks depend on signatures that were not read line-by-line while writing this plan, and each carries an instruction to check before running rather than a pretence of certainty: `FrameRepresenter.represent`/`FramePatchRepresenter.represent` arguments (Task 6 Step 1), `Tier2MultiVectorRetriever.retrieveFrames` argument order (Task 6 Step 2), and the exact `existsSync` guard style in `test/onnx.smoke.test.ts` (Task 4 Step 1). The `MV_TOK` constants are deliberately zero-filled — they are *measured* in Task 2 Step 1, and Task 4's tokenizer test fails loudly if they are wrong.

**Type consistency.** `ColModernVBertMultiVector` / `ColModernVBertOptions` / `MV_TOK` / `QUERY_BUFFER_TOKENS` / `buildImagePrompt` / `buildQueryPrompt` / `imageTokenPositions` / `tileMarker` are named identically in Tasks 2, 3, 4 and 6. The model id `colmodernvbert-250m` is the same in the manifest (Task 1), the adapter default (Task 3), the smoke path (Task 4) and the probe (Task 6) — it is the namespace key, so a mismatch would silently index into two tables.
