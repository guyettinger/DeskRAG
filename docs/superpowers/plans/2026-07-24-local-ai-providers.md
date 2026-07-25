# Fully-Local AI Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user run every AI touchpoint in DeskRAG locally — text embedding, image retrieval, reranking, captioning, transcription — so no captured screen content, audio, or query text leaves the machine.

**Architecture:** Discriminative work (text embed, image embed, rerank) runs in-process via `onnxruntime-node`; generative work (VLM captions) runs on Ollama. The local image path is multi-vector late interaction (ColSmol-256M) stored in a LanceDB multivector column and scored by MaxSim, which replaces the region *image*-embedding pass — patches are the regions. AX regions remain for exact-text FTS.

**Tech Stack:** TypeScript (strict, ESM), `onnxruntime-node`, `@huggingface/tokenizers`, `@lancedb/lancedb@0.24.1`, `apache-arrow@18.1.0`, `sharp@^0.35.3`, vitest, Electron.

**Spec:** `docs/superpowers/specs/2026-07-24-local-ai-providers-design.md`

## Global Constraints

- **Write order is non-negotiable:** SQLite transaction commits FIRST, then Lance add. All writes serialize through the existing `Mutex` in `src/store/store.ts`.
- **Multivector requires cosine.** Set `distanceType: "cosine"` on BOTH `Index.ivfPq({...})` and `vectorSearch(...).distanceType("cosine")`. Index build with `l2` fails; brute-force search silently defaults to `l2` and still looks plausible.
- **Never fall back between embedders.** A failed embedder disables its capability loudly. Substituting one silently writes into a different vector space.
- **Barrel rule:** anything loading `onnxruntime-node` or `sharp` is NOT exported from `src/index.ts`. Import from its own path.
- **Native version pins live in BOTH `package.json` and `app/package.json`** and must stay in sync.
- `apache-arrow` pinned `18.1.0`. `sharp` pinned `^0.35.3` (0.34.x had libvips CVEs). Do not use `@huggingface/transformers` — it depends on `sharp ^0.34.5`.
- **Model ids in namespaces must not contain `:`** — `namespaceFor()` throws. Use `nomic-embed-text-v1.5`, not `nomic-embed-text:v1.5`.
- **There is no existing recorded data.** No migration, compatibility, or re-index concern applies.
- Primary gate: `npm run typecheck`. Test: `npx vitest run <file>`. App gate: `npm --prefix app run typecheck`.
- Commit style: `feat(scope): …`, `fix(scope): …`, `test(scope): …`.

## File Structure

**Library — create:**
| File | Responsibility |
|---|---|
| `src/embed/onnx/runtime.ts` | Lazy `onnxruntime-node` load, `InferenceSession` cache by weights path |
| `src/embed/onnx/pooling.ts` | Pure math: mean pooling, L2 normalize, int8→f32 |
| `src/embed/onnx/text.ts` | `OnnxTextEmbedding` (nomic-embed-text-v1.5, 768) |
| `src/embed/onnx/geometry.ts` | Pure: tile layout + patch-index→bbox mapping |
| `src/embed/onnx/colsmol.ts` | `ColSmolMultiVector` (multi-vector image + query embed) |
| `src/retrieve/tier2-mv.ts` | `Tier2MultiVectorRetriever` + highlights from MaxSim |
| `src/retrieve/rerank/onnx.ts` | `OnnxCrossEncoderReranker` |
| `src/represent/caption/ollama.ts` | `OllamaCaptionProvider` |
| `src/represent/frame-patch-representer.ts` | Writes `frame_patches` vectors for a session |

**Library — modify:**
| File | Change |
|---|---|
| `src/embed/types.ts` | `embed()` opts, `frame_patches` view, `MULTIVECTOR_VIEWS`, `MultiVectorProvider` |
| `src/embed/fake.ts` | Accept and ignore `opts`; add `FakeMultiVectorProvider` |
| `src/store/lance/tables.ts` | `frame_patches` table kind, multivector schema, cosine index, patch search |
| `src/store/types.ts` | `FramePatchInsert`, `putFramePatches`, `searchFramePatches` |
| `src/store/store.ts` | Implement the above; guard reconcile against multivector views |
| `src/index.ts` | Export the non-native additions only |

**App — create:** `app/src/main/models.ts`, `app/src/main/model-store.ts`
**App — modify:** `app/src/shared/types.ts`, `app/src/main/settings.ts`, `app/src/main/deskrag-service.ts`, `app/src/main/ipc.ts`, `app/src/preload/index.ts`, Settings UI

---

### Task 1: Provider contract — embed roles, multivector view, provider interface

**Files:**
- Modify: `src/embed/types.ts`
- Modify: `src/embed/fake.ts`
- Test: `test/namespace.test.ts` (extend)

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `View` gains `"frame_patches"`; `VIEWS` includes it
  - `MULTIVECTOR_VIEWS: ReadonlySet<View>`
  - `EmbedOptions = { role?: "document" | "query" }`
  - `EmbeddingProvider.embed(inputs: string[], opts?: EmbedOptions): Promise<Float32Array[]>`
  - `MultiVectorProvider` with `multiVector: true`, `embedImages(images: Uint8Array[]): Promise<Float32Array[][]>`, `embedQueries(texts: string[]): Promise<Float32Array[][]>`
  - `FakeMultiVectorProvider` (deterministic, for tests)

- [ ] **Step 1: Write the failing test**

Append to `test/namespace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MULTIVECTOR_VIEWS,
  VIEWS,
  namespaceFor,
  parseNamespace,
} from "../src/embed/types.js";
import { FakeEmbeddingProvider, FakeMultiVectorProvider } from "../src/embed/fake.js";

describe("multivector views", () => {
  it("registers frame_patches as a known view", () => {
    expect(VIEWS).toContain("frame_patches");
    expect(parseNamespace("frame_patches:onnx:colsmol-256m:128").view).toBe("frame_patches");
  });

  it("marks only frame_patches as multivector", () => {
    expect(MULTIVECTOR_VIEWS.has("frame_patches")).toBe(true);
    for (const v of ["digest", "caption", "transcript", "behavior", "frame_image", "region_image"] as const) {
      expect(MULTIVECTOR_VIEWS.has(v)).toBe(false);
    }
  });

  it("namespaces a multivector provider by its per-vector width", () => {
    const p = new FakeMultiVectorProvider(128, 4);
    expect(namespaceFor("frame_patches", p)).toBe("frame_patches:fake:fake-mv:128");
  });
});

describe("embed roles", () => {
  it("accepts an optional role without changing output for providers that ignore it", async () => {
    const f = new FakeEmbeddingProvider(8);
    const [a] = await f.embed(["hello"]);
    const [b] = await f.embed(["hello"], { role: "query" });
    expect(Array.from(a!)).toEqual(Array.from(b!));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/namespace.test.ts`
Expected: FAIL — `MULTIVECTOR_VIEWS` is not exported, `FakeMultiVectorProvider` is not exported.

- [ ] **Step 3: Extend `src/embed/types.ts`**

Change the `View` union and `VIEWS` array, then add the new exports:

```ts
export type View =
  | "caption"
  | "digest"
  | "transcript"
  | "behavior"
  | "frame_image"
  | "region_image"
  | "frame_patches"; // multi-vector late-interaction frame patches

export const VIEWS: readonly View[] = [
  "caption",
  "digest",
  "transcript",
  "behavior",
  "frame_image",
  "region_image",
  "frame_patches",
] as const;

/**
 * Views whose Lance table holds MANY vectors per row (late interaction), not one.
 * The store consults this instead of widening `parseNamespace`, which keeps its
 * four-part shape.
 */
export const MULTIVECTOR_VIEWS: ReadonlySet<View> = new Set<View>(["frame_patches"]);

/**
 * Asymmetric embedding role. nomic-embed-v1.5 requires `search_document: ` on
 * stored text and `search_query: ` on queries; omitting them raises no error and
 * silently degrades retrieval. Providers that do not care ignore this.
 */
export interface EmbedOptions {
  role?: "document" | "query";
}
```

Change the `EmbeddingProvider` signature:

```ts
export interface EmbeddingProvider extends NamespacedProvider {
  embed(inputs: string[], opts?: EmbedOptions): Promise<Float32Array[]>;
}
```

Add the multivector provider interface after `ImageEmbeddingProvider`:

```ts
/**
 * Late-interaction provider: one model embeds both images and queries into the
 * same space, emitting MANY vectors each. `dimensions` is the PER-VECTOR width
 * (e.g. 128), not the total, so `namespaceFor` stays meaningful.
 */
export interface MultiVectorProvider extends NamespacedProvider {
  readonly multiVector: true;
  /** Per image: N vectors of `dimensions` each. */
  embedImages(images: Uint8Array[]): Promise<Float32Array[][]>;
  /** Per query: M vectors of `dimensions` each. */
  embedQueries(texts: string[]): Promise<Float32Array[][]>;
}
```

- [ ] **Step 4: Extend `src/embed/fake.ts`**

Add `opts` to the existing `FakeEmbeddingProvider.embed` signature (ignored — the fake stays a pure function of input so tests can place exact matches), and append:

```ts
import type { MultiVectorProvider } from "./types.js";

/**
 * Deterministic multivector fake. Emits `count` vectors per input, each a stable
 * function of the input bytes and the vector index, so a query built from the
 * same bytes MaxSim-matches exactly.
 */
export class FakeMultiVectorProvider implements MultiVectorProvider {
  readonly id = "fake";
  readonly model = "fake-mv";
  readonly multiVector = true as const;
  constructor(
    readonly dimensions = 128,
    private readonly count = 4,
  ) {}

  private one(seed: number, k: number): Float32Array {
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      v[i] = Math.sin(seed * 0.37 + k * 1.7 + i * 0.11);
    }
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }

  private setFor(seed: number): Float32Array[] {
    return Array.from({ length: this.count }, (_, k) => this.one(seed, k));
  }

  async embedImages(images: Uint8Array[]): Promise<Float32Array[][]> {
    return images.map((img) => this.setFor(img.reduce((n, b) => n + b, 0)));
  }

  async embedQueries(texts: string[]): Promise<Float32Array[][]> {
    return texts.map((t) =>
      this.setFor([...t].reduce((n, c) => n + c.charCodeAt(0), 0)),
    );
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/namespace.test.ts && npm run typecheck`
Expected: PASS. `typecheck` confirms no existing `embed()` caller broke — `opts` is optional, so none should.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. The `View` union widened, so any exhaustive `switch` over views will surface here.

- [ ] **Step 7: Export from the barrel and commit**

`src/index.ts` — `export * from "./embed/types.js"` already covers the new types. Add the fake:

```ts
export { FakeEmbeddingProvider, FakeMultiVectorProvider } from "./embed/fake.js";
```

```bash
git add src/embed/types.ts src/embed/fake.ts src/index.ts test/namespace.test.ts
git commit -m "feat(embed): add frame_patches view, embed roles, and MultiVectorProvider"
```

---

### Task 2: Pure ONNX helpers — pooling and normalization

**Files:**
- Create: `src/embed/onnx/pooling.ts`
- Test: `test/onnx.pooling.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `meanPool(hidden: Float32Array, mask: number[], seqLen: number, dims: number): Float32Array`
  - `l2Normalize(v: Float32Array): Float32Array` (in place, returns same array)
  - `sliceRows(flat: Float32Array, rows: number, dims: number): Float32Array[]`

- [ ] **Step 1: Write the failing test**

Create `test/onnx.pooling.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { l2Normalize, meanPool, sliceRows } from "../src/embed/onnx/pooling.js";

describe("meanPool", () => {
  it("averages only unmasked positions", () => {
    // seqLen 3, dims 2; third token masked out
    const hidden = Float32Array.from([1, 1, 3, 3, 100, 100]);
    const out = meanPool(hidden, [1, 1, 0], 3, 2);
    expect(Array.from(out)).toEqual([2, 2]);
  });

  it("returns zeros when everything is masked", () => {
    const hidden = Float32Array.from([5, 5, 7, 7]);
    const out = meanPool(hidden, [0, 0], 2, 2);
    expect(Array.from(out)).toEqual([0, 0]);
  });
});

describe("l2Normalize", () => {
  it("scales to unit length", () => {
    const v = l2Normalize(Float32Array.from([3, 4]));
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });

  it("leaves a zero vector alone rather than dividing by zero", () => {
    const v = l2Normalize(Float32Array.from([0, 0]));
    expect(Array.from(v)).toEqual([0, 0]);
  });
});

describe("sliceRows", () => {
  it("splits a flat [rows*dims] buffer into per-row vectors", () => {
    const rows = sliceRows(Float32Array.from([1, 2, 3, 4, 5, 6]), 3, 2);
    expect(rows.length).toBe(3);
    expect(Array.from(rows[1]!)).toEqual([3, 4]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onnx.pooling.test.ts`
Expected: FAIL — cannot resolve `../src/embed/onnx/pooling.js`.

- [ ] **Step 3: Write the implementation**

Create `src/embed/onnx/pooling.ts`:

```ts
/**
 * Pure tensor post-processing for the ONNX adapters. Kept separate from
 * `runtime.ts` so the maths is unit-testable without loading a native module or
 * any model weights.
 */

/**
 * Mean-pool a `[seqLen, dims]` hidden state over unmasked positions.
 * Returns zeros when the mask is empty rather than dividing by zero.
 */
export function meanPool(
  hidden: Float32Array,
  mask: number[],
  seqLen: number,
  dims: number,
): Float32Array {
  const out = new Float32Array(dims);
  let n = 0;
  for (let t = 0; t < seqLen; t++) {
    if (!mask[t]) continue;
    n++;
    const base = t * dims;
    for (let d = 0; d < dims; d++) out[d]! += hidden[base + d]!;
  }
  if (n === 0) return out;
  for (let d = 0; d < dims; d++) out[d]! /= n;
  return out;
}

/** L2-normalize in place. A zero vector is returned unchanged. */
export function l2Normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

/** Split a flat `[rows, dims]` buffer into one Float32Array per row. */
export function sliceRows(flat: Float32Array, rows: number, dims: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let r = 0; r < rows; r++) {
    out.push(flat.slice(r * dims, (r + 1) * dims));
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/onnx.pooling.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/embed/onnx/pooling.ts test/onnx.pooling.test.ts
git commit -m "feat(embed): pure pooling helpers for the ONNX adapters"
```

---

### Task 3: ONNX runtime — lazy load and session cache

**Files:**
- Create: `src/embed/onnx/runtime.ts`
- Modify: `package.json`, `app/package.json`
- Test: `test/onnx.runtime.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `OnnxTensor { data: Float32Array | BigInt64Array; dims: number[] }`
  - `OnnxSession { run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>> }`
  - `OnnxRuntime.session(weightsPath: string): Promise<OnnxSession>` — cached by absolute path for the process lifetime
  - `OnnxRuntime.reset(): void` — test hook, clears the cache
  - `makeTensor(kind: "float32" | "int64", data, dims): OnnxTensor`

**Why a session cache:** `buildProviders()` runs on every `index()` AND every `search()`. Constructing an `InferenceSession` costs hundreds of ms and holds the weights resident. Rebuilding per search would be badly wrong.

- [ ] **Step 1: Add the dependencies**

Add to BOTH `package.json` and `app/package.json` under `dependencies`, keeping versions identical:

```json
"onnxruntime-node": "1.27.0",
"@huggingface/tokenizers": "0.1.3"
```

Run: `npm install && npm --prefix app install`

Note: `onnxruntime-node` has a `postinstall` that downloads platform binaries — expect a network step. It is N-API, so it needs no Electron rebuild and does not interact with the `better-sqlite3` rebuild.

- [ ] **Step 2: Write the failing test**

Create `test/onnx.runtime.test.ts`. This runs in CI without weights by asserting on caching and error behaviour, not on inference:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { OnnxRuntime, makeTensor } from "../src/embed/onnx/runtime.js";

afterEach(() => OnnxRuntime.reset());

describe("makeTensor", () => {
  it("builds a float32 tensor with the given dims", () => {
    const t = makeTensor("float32", Float32Array.from([1, 2, 3, 4]), [2, 2]);
    expect(t.dims).toEqual([2, 2]);
    expect(Array.from(t.data as Float32Array)).toEqual([1, 2, 3, 4]);
  });
});

describe("OnnxRuntime.session", () => {
  it("rejects with a clear message when the weights file is missing", async () => {
    await expect(OnnxRuntime.session("/definitely/not/here/model.onnx")).rejects.toThrow(
      /ONNX weights not found/,
    );
  });

  it("returns the same promise for the same path (session cache)", () => {
    const a = OnnxRuntime.session("/definitely/not/here/model.onnx");
    const b = OnnxRuntime.session("/definitely/not/here/model.onnx");
    expect(a).toBe(b);
    return Promise.allSettled([a, b]);
  });

  it("reset() clears the cache", () => {
    const a = OnnxRuntime.session("/definitely/not/here/model.onnx");
    OnnxRuntime.reset();
    const b = OnnxRuntime.session("/definitely/not/here/model.onnx");
    expect(a).not.toBe(b);
    return Promise.allSettled([a, b]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/onnx.runtime.test.ts`
Expected: FAIL — cannot resolve `../src/embed/onnx/runtime.js`.

- [ ] **Step 4: Write the implementation**

Create `src/embed/onnx/runtime.ts`:

```ts
/**
 * Lazy onnxruntime-node loader + InferenceSession cache.
 *
 * NOT exported from the package barrel: this loads a native module, so importing
 * "deskrag" must never reach it. Import from this path directly.
 *
 * Sessions are cached by absolute weights path for the process lifetime because
 * DeskRagService rebuilds providers on every index() and every search(), and an
 * InferenceSession is expensive to construct and holds the weights resident.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface OnnxTensor {
  data: Float32Array | BigInt64Array;
  dims: number[];
}

/** The slice of an InferenceSession the adapters use. Injectable for tests. */
export interface OnnxSession {
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
}

type OrtModule = {
  Tensor: new (type: string, data: unknown, dims: number[]) => OnnxTensor;
  InferenceSession: {
    create(path: string, opts?: Record<string, unknown>): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensor>>;
    }>;
  };
};

let ortPromise: Promise<OrtModule> | undefined;

async function ort(): Promise<OrtModule> {
  ortPromise ??= import(/* @vite-ignore */ "onnxruntime-node") as Promise<OrtModule>;
  return ortPromise;
}

/** Build a tensor without the caller importing onnxruntime-node itself. */
export function makeTensor(
  kind: "float32" | "int64",
  data: Float32Array | BigInt64Array,
  dims: number[],
): OnnxTensor {
  return { data, dims };
}

const cache = new Map<string, Promise<OnnxSession>>();

export const OnnxRuntime = {
  /** Cached session for `weightsPath`. Throws a clear error if the file is absent. */
  session(weightsPath: string): Promise<OnnxSession> {
    const key = resolve(weightsPath);
    let s = cache.get(key);
    if (s) return s;
    s = (async () => {
      if (!existsSync(key)) {
        throw new Error(`ONNX weights not found at ${key}`);
      }
      const { InferenceSession, Tensor } = await ort();
      const sess = await InferenceSession.create(key, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      });
      return {
        async run(feeds: Record<string, OnnxTensor>) {
          const wrapped: Record<string, unknown> = {};
          for (const [k, t] of Object.entries(feeds)) {
            const type = t.data instanceof BigInt64Array ? "int64" : "float32";
            wrapped[k] = new Tensor(type, t.data, t.dims);
          }
          return sess.run(wrapped);
        },
      };
    })();
    cache.set(key, s);
    return s;
  },

  /** Drop all cached sessions. Test hook; not used in production. */
  reset(): void {
    cache.clear();
  },
};
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/onnx.runtime.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Verify the barrel does NOT export it**

Run: `grep -n "onnx" src/index.ts`
Expected: no output. If anything matches, remove it — the barrel must not pull in native code.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json app/package.json app/package-lock.json src/embed/onnx/runtime.ts test/onnx.runtime.test.ts
git commit -m "feat(embed): lazy onnxruntime-node loader with a process-lifetime session cache"
```

---

### Task 4: OnnxTextEmbedding

**Files:**
- Create: `src/embed/onnx/text.ts`
- Test: `test/onnx.text.test.ts`

**Interfaces:**
- Consumes: `OnnxSession`, `makeTensor`, `OnnxRuntime` (Task 3); `meanPool`, `l2Normalize` (Task 2); `EmbedOptions` (Task 1)
- Produces:
  - `OnnxTextEmbedding implements EmbeddingProvider`
  - `id = "onnx"`, `model = "nomic-embed-text-v1.5"`, `dimensions = 768`
  - Constructor: `new OnnxTextEmbedding({ modelPath, tokenizerPath, model?, dimensions?, maxTokens?, session? })`
  - `NOMIC_PREFIX: Record<"document" | "query", string>`

**Correctness note:** nomic-embed-v1.5 needs `search_document: ` on stored text and `search_query: ` on queries. Default role is `"document"` — representers embed documents, and `TextViewSearcher` will pass `role: "query"` in Task 11.

- [ ] **Step 1: Write the failing test**

Create `test/onnx.text.test.ts`. A stub session keeps this CI-safe — no weights, no native module:

```ts
import { describe, expect, it } from "vitest";
import { NOMIC_PREFIX, OnnxTextEmbedding } from "../src/embed/onnx/text.js";
import type { OnnxSession, OnnxTensor } from "../src/embed/onnx/runtime.js";

/** Records feeds and returns a hidden state of all-ones so pooling is predictable. */
function stubSession(seen: Record<string, OnnxTensor>[]): OnnxSession {
  return {
    async run(feeds) {
      seen.push(feeds);
      const [batch, seq] = feeds.input_ids!.dims as [number, number];
      const dims = 4;
      return {
        last_hidden_state: {
          data: Float32Array.from({ length: batch * seq * dims }, () => 1),
          dims: [batch, seq, dims],
        },
      };
    },
  };
}

const opts = (session: OnnxSession) => ({
  modelPath: "/unused",
  tokenizerPath: "/unused",
  dimensions: 4,
  session,
  // deterministic stand-in for the real tokenizer
  tokenize: (text: string) => ({
    ids: [...text].slice(0, 6).map((c) => c.charCodeAt(0)),
  }),
});

describe("OnnxTextEmbedding", () => {
  it("namespaces without a colon in the model id", () => {
    const e = new OnnxTextEmbedding(opts(stubSession([])));
    expect(e.id).toBe("onnx");
    expect(e.model).toBe("nomic-embed-text-v1.5");
    expect(e.model).not.toContain(":");
  });

  it("prefixes documents by default and queries when asked", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const texts: string[] = [];
    const e = new OnnxTextEmbedding({
      ...opts(stubSession(seen)),
      tokenize: (text: string) => {
        texts.push(text);
        return { ids: [1, 2, 3] };
      },
    });
    await e.embed(["hello"]);
    await e.embed(["hello"], { role: "query" });
    expect(texts[0]).toBe(`${NOMIC_PREFIX.document}hello`);
    expect(texts[1]).toBe(`${NOMIC_PREFIX.query}hello`);
  });

  it("returns one unit-length vector per input", async () => {
    const e = new OnnxTextEmbedding(opts(stubSession([])));
    const out = await e.embed(["a", "bb"]);
    expect(out.length).toBe(2);
    for (const v of out) {
      expect(v.length).toBe(4);
      const norm = Math.sqrt(Array.from(v).reduce((n, x) => n + x * x, 0));
      expect(norm).toBeCloseTo(1, 5);
    }
  });

  it("truncates input beyond maxTokens instead of throwing", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const e = new OnnxTextEmbedding({
      ...opts(stubSession(seen)),
      maxTokens: 3,
      tokenize: () => ({ ids: [1, 2, 3, 4, 5, 6, 7, 8] }),
    });
    await e.embed(["anything long"]);
    expect(seen[0]!.input_ids!.dims).toEqual([1, 3]);
  });

  it("returns [] for no inputs without touching the session", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const e = new OnnxTextEmbedding(opts(stubSession(seen)));
    expect(await e.embed([])).toEqual([]);
    expect(seen.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onnx.text.test.ts`
Expected: FAIL — cannot resolve `../src/embed/onnx/text.js`.

- [ ] **Step 3: Write the implementation**

Create `src/embed/onnx/text.ts`:

```ts
/**
 * nomic-embed-text-v1.5 via onnxruntime-node.
 *
 * NOT in the package barrel — loads a native module. Import from this path.
 *
 * Task prefixes are load-bearing: nomic-embed-v1.5 expects `search_document: `
 * on stored text and `search_query: ` on queries. Omitting them raises no error,
 * it just quietly degrades retrieval, so the role rides on `embed()`'s opts.
 */

import type { EmbeddingProvider, EmbedOptions } from "../types.js";
import { l2Normalize, meanPool } from "./pooling.js";
import { OnnxRuntime, makeTensor, type OnnxSession } from "./runtime.js";

export const NOMIC_PREFIX = {
  document: "search_document: ",
  query: "search_query: ",
} as const;

export interface TokenizeResult {
  ids: number[];
}

export interface OnnxTextOptions {
  /** Absolute path to model.onnx. */
  modelPath: string;
  /** Absolute path to tokenizer.json. */
  tokenizerPath: string;
  model?: string;
  dimensions?: number;
  maxTokens?: number;
  /** Injected session (tests). Defaults to the cached runtime session. */
  session?: OnnxSession;
  /** Injected tokenizer (tests). Defaults to @huggingface/tokenizers. */
  tokenize?: (text: string) => TokenizeResult;
}

export class OnnxTextEmbedding implements EmbeddingProvider {
  readonly id = "onnx";
  readonly model: string;
  readonly dimensions: number;
  private readonly modelPath: string;
  private readonly tokenizerPath: string;
  private readonly maxTokens: number;
  private readonly injectedSession: OnnxSession | undefined;
  private readonly injectedTokenize: ((t: string) => TokenizeResult) | undefined;
  private tokenizer: Promise<(t: string) => TokenizeResult> | undefined;

  constructor(opts: OnnxTextOptions) {
    this.model = opts.model ?? "nomic-embed-text-v1.5";
    this.dimensions = opts.dimensions ?? 768;
    this.modelPath = opts.modelPath;
    this.tokenizerPath = opts.tokenizerPath;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.injectedSession = opts.session;
    this.injectedTokenize = opts.tokenize;
  }

  private async tokenize(): Promise<(t: string) => TokenizeResult> {
    if (this.injectedTokenize) return this.injectedTokenize;
    this.tokenizer ??= (async () => {
      const { Tokenizer } = (await import(
        /* @vite-ignore */ "@huggingface/tokenizers"
      )) as { Tokenizer: { fromFile(p: string): Promise<{ encode(t: string): { ids: number[] } }> } };
      const tok = await Tokenizer.fromFile(this.tokenizerPath);
      return (t: string) => tok.encode(t);
    })();
    return this.tokenizer;
  }

  private session(): Promise<OnnxSession> {
    return this.injectedSession
      ? Promise.resolve(this.injectedSession)
      : OnnxRuntime.session(this.modelPath);
  }

  async embed(inputs: string[], opts?: EmbedOptions): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    const prefix = NOMIC_PREFIX[opts?.role ?? "document"];
    const tokenize = await this.tokenize();

    // Truncate explicitly: an over-length sequence is a tensor shape error on the
    // ONNX path, not the graceful clamp Ollama's `truncate: true` gave us.
    const encoded = inputs.map((t) => tokenize(`${prefix}${t}`).ids.slice(0, this.maxTokens));
    const seq = Math.max(1, ...encoded.map((e) => e.length));
    const batch = encoded.length;

    const ids = new BigInt64Array(batch * seq);
    const mask = new BigInt64Array(batch * seq);
    const masks: number[][] = [];
    for (let b = 0; b < batch; b++) {
      const row = encoded[b]!;
      const m: number[] = [];
      for (let t = 0; t < seq; t++) {
        const present = t < row.length;
        ids[b * seq + t] = BigInt(present ? row[t]! : 0);
        mask[b * seq + t] = BigInt(present ? 1 : 0);
        m.push(present ? 1 : 0);
      }
      masks.push(m);
    }

    const sess = await this.session();
    const out = await sess.run({
      input_ids: makeTensor("int64", ids, [batch, seq]),
      attention_mask: makeTensor("int64", mask, [batch, seq]),
    });

    const hidden = (out.last_hidden_state ?? Object.values(out)[0]!) as {
      data: Float32Array;
      dims: number[];
    };
    const dims = hidden.dims[2] ?? this.dimensions;
    const vectors: Float32Array[] = [];
    for (let b = 0; b < batch; b++) {
      const slice = hidden.data.slice(b * seq * dims, (b + 1) * seq * dims);
      vectors.push(l2Normalize(meanPool(slice, masks[b]!, seq, dims)));
    }
    return vectors;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/onnx.text.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/embed/onnx/text.ts test/onnx.text.test.ts
git commit -m "feat(embed): OnnxTextEmbedding with nomic task prefixes and explicit truncation"
```


---

### Task 5: Lance multivector table — schema, cosine index, MaxSim search

**Files:**
- Modify: `src/store/lance/tables.ts`
- Test: `test/lance.multivector.test.ts`

**Interfaces:**
- Consumes: `MULTIVECTOR_VIEWS`, `parseNamespace` (Task 1)
- Produces (all on `VectorSide` and `LanceStore`):
  - `TableKind` gains `"frame_patches"`
  - `FramePatchRow { id: string; session_id: string; segment_ids: string[]; patches: number[][] }`
  - `addPatches(namespace: string, rows: FramePatchRow[]): Promise<void>`
  - `searchFramePatches(namespace: string, query: Float32Array[], k: number, scope?: { segmentIds?: string[]; frameIds?: string[] }): Promise<SearchResult[]>`
  - `ensurePatchIndex(namespace: string, minRows?: number): Promise<boolean>` — returns whether an index now exists

**Critical:** IVF-PQ cannot train on an empty or tiny table, so the index is created lazily once enough rows exist. Until then LanceDB brute-forces — and **brute-force silently defaults to `metric=l2`, which multivector does not support for indexing**. Every query therefore passes `.distanceType("cosine")` unconditionally, indexed or not.

- [ ] **Step 1: Write the failing test**

Create `test/lance.multivector.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanceStore } from "../src/store/lance/tables.js";

const NS = "frame_patches:fake:fake-mv:16";
const D = 16;

/** Deterministic unit vector; `k` picks an axis so sets are separable. */
function vec(k: number): number[] {
  const v = Array.from({ length: D }, (_, i) => (i === k % D ? 1 : 0.01));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

let dir: string;
let store: LanceStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mv-"));
  store = await LanceStore.open(dir);
  await store.ensureTable(NS);
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("multivector table", () => {
  it("round-trips rows with DIFFERENT patch counts", async () => {
    await store.addPatches(NS, [
      { id: "f1", session_id: "s", segment_ids: ["segA"], patches: [vec(0), vec(1)] },
      { id: "f2", session_id: "s", segment_ids: ["segA"], patches: [vec(2), vec(3), vec(4), vec(5), vec(6)] },
      { id: "f3", session_id: "s", segment_ids: ["segB"], patches: Array.from({ length: 40 }, (_, i) => vec(i + 7)) },
    ]);
    const ids = (await store.searchFramePatches(NS, [Float32Array.from(vec(0))], 10)).map((r) => r.id);
    expect(ids).toContain("f1");
    expect(ids.length).toBe(3);
  });

  it("scores by MaxSim, not by the first query vector alone", async () => {
    await store.addPatches(NS, [
      { id: "onlyA", session_id: "s", segment_ids: ["x"], patches: [vec(0), vec(9)] },
      { id: "bothAB", session_id: "s", segment_ids: ["x"], patches: [vec(0), vec(1)] },
      { id: "onlyB", session_id: "s", segment_ids: ["x"], patches: [vec(8), vec(1)] },
    ]);
    // Query carries both axes. Under MaxSim `bothAB` must win outright;
    // under first-vector-only it would tie with `onlyA`.
    const two = await store.searchFramePatches(
      NS,
      [Float32Array.from(vec(0)), Float32Array.from(vec(1))],
      3,
    );
    expect(two[0]!.id).toBe("bothAB");
    expect(two[0]!.distance).toBeLessThan(two[1]!.distance);
  });

  it("pre-filters by segment scope and still fills the limit", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `f${i}`,
      session_id: "s",
      segment_ids: i % 3 === 0 ? ["segA"] : ["segB"],
      patches: [vec(i), vec(i + 1)],
    }));
    await store.addPatches(NS, rows);
    const hits = await store.searchFramePatches(NS, [Float32Array.from(vec(0))], 10, {
      segmentIds: ["segA"],
    });
    // 10 of 30 rows are segA. A post-filter would return ~3 here.
    expect(hits.length).toBe(10);
    expect(hits.every((h) => Number(h.id.slice(1)) % 3 === 0)).toBe(true);
  });

  it("scopes by frame id", async () => {
    await store.addPatches(NS, [
      { id: "a", session_id: "s", segment_ids: ["x"], patches: [vec(0)] },
      { id: "b", session_id: "s", segment_ids: ["x"], patches: [vec(1)] },
    ]);
    const hits = await store.searchFramePatches(NS, [Float32Array.from(vec(0))], 5, {
      frameIds: ["b"],
    });
    expect(hits.map((h) => h.id)).toEqual(["b"]);
  });

  it("returns [] for an empty frame scope rather than searching everything", async () => {
    await store.addPatches(NS, [
      { id: "a", session_id: "s", segment_ids: ["x"], patches: [vec(0)] },
    ]);
    expect(await store.searchFramePatches(NS, [Float32Array.from(vec(0))], 5, { frameIds: [] })).toEqual([]);
  });

  it("builds a cosine index once there are enough rows, and search still works", async () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      id: `f${i}`,
      session_id: "s",
      segment_ids: ["segA"],
      patches: [vec(i), vec(i + 1), vec(i + 2)],
    }));
    await store.addPatches(NS, rows);
    expect(await store.ensurePatchIndex(NS, 256)).toBe(true);
    const hits = await store.searchFramePatches(NS, [Float32Array.from(vec(5))], 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("declines to index a table too small to train, without throwing", async () => {
    await store.addPatches(NS, [
      { id: "a", session_id: "s", segment_ids: ["x"], patches: [vec(0)] },
    ]);
    expect(await store.ensurePatchIndex(NS, 256)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lance.multivector.test.ts`
Expected: FAIL — `store.addPatches is not a function`.

- [ ] **Step 3: Add the schema to `src/store/lance/tables.ts`**

Extend the imports and `TableKind`, then add the multivector schema:

```ts
import { Field, FixedSizeList, Float16, Float32, List, Schema, Utf8 } from "apache-arrow";

export type TableKind = "segment" | "frame" | "region" | "frame_patches";

export function kindForView(view: string): TableKind {
  switch (view) {
    case "frame_image":
      return "frame";
    case "region_image":
      return "region";
    case "frame_patches":
      return "frame_patches";
    default:
      return "segment"; // caption | digest | transcript | behavior
  }
}
```

Add the patch column builder next to `vectorField`:

```ts
/**
 * Multivector column: a variable-length list of fixed-width vectors, one per
 * image patch. Stored as float16 — half the bytes of f32 for ~448 vectors per
 * frame, and LanceDB scores multivector in f16/f32/f64 alike.
 */
function patchesField(dims: number): Field {
  return new Field(
    "patches",
    new List(
      new Field("item", new FixedSizeList(dims, new Field("item", new Float16(), true)), true),
    ),
    true,
  );
}
```

Add the `frame_patches` case to `schemaFor`:

```ts
    case "frame_patches":
      return new Schema([
        new Field("id", utf8(), false),
        new Field("session_id", utf8(), false),
        new Field("segment_ids", new List(new Field("item", utf8(), true)), true),
        patchesField(dims),
      ]);
```

Add the row type beside the other row payloads:

```ts
export interface FramePatchRow {
  id: string;
  session_id: string;
  segment_ids: string[];
  /** One vector per patch; row counts may differ between frames. */
  patches: number[][];
}
```

- [ ] **Step 4: Extend the `VectorSide` interface**

Add to `interface VectorSide`:

```ts
  addPatches(namespace: string, rows: FramePatchRow[]): Promise<void>;
  searchFramePatches(
    namespace: string,
    query: Float32Array[],
    k: number,
    scope?: { segmentIds?: string[]; frameIds?: string[] },
  ): Promise<SearchResult[]>;
  ensurePatchIndex(namespace: string, minRows?: number): Promise<boolean>;
```

- [ ] **Step 5: Implement on `LanceStore`**

Add these methods to the `LanceStore` class. Factor the scope predicate out of `searchFrame` first so both paths share it:

```ts
  /** Shared scope predicate for frame-shaped tables (single- and multi-vector). */
  private frameFilter(scope?: { segmentIds?: string[]; frameIds?: string[] }): string | undefined {
    const clauses: string[] = [];
    if (scope?.frameIds && scope.frameIds.length > 0) {
      clauses.push(idInClause("id", scope.frameIds));
    }
    if (scope?.segmentIds && scope.segmentIds.length > 0) {
      const list = scope.segmentIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
      clauses.push(`array_has_any(segment_ids, [${list}])`);
    }
    return clauses.length ? clauses.join(" AND ") : undefined;
  }

  async addPatches(namespace: string, rows: FramePatchRow[]): Promise<void> {
    if (rows.length === 0) return;
    const tbl = await this.open(namespace);
    await tbl.add(rows as unknown as Record<string, unknown>[]);
  }

  /**
   * Late-interaction frame search. `query` is one vector per query token; LanceDB
   * scores by MaxSim.
   *
   * `.distanceType("cosine")` is mandatory and unconditional: multivector supports
   * ONLY cosine, but an unindexed table silently brute-forces with metric=l2 and
   * still returns plausible ordering — so omitting it fails quietly in dev and
   * loudly later at index build.
   */
  async searchFramePatches(
    namespace: string,
    query: Float32Array[],
    k: number,
    scope?: { segmentIds?: string[]; frameIds?: string[] },
  ): Promise<SearchResult[]> {
    if (query.length === 0) return [];
    if (scope?.frameIds && scope.frameIds.length === 0) return [];
    const tbl = await this.open(namespace);
    let q = tbl
      .vectorSearch(query.map((v) => Array.from(v)))
      .distanceType("cosine")
      .limit(k);
    const filter = this.frameFilter(scope);
    if (filter) q = q.where(filter); // prefilter is the default in the JS SDK
    const rows = (await q.toArray()) as Array<{ id: string; _distance: number }>;
    return rows.map((r) => ({ id: r.id, distance: r._distance }));
  }

  /**
   * Build the cosine IVF-PQ index once the table is big enough to train one.
   * Returns false (without throwing) when there are too few rows — brute-force
   * search remains correct, just slower.
   */
  async ensurePatchIndex(namespace: string, minRows = 256): Promise<boolean> {
    const tbl = await this.open(namespace);
    if ((await tbl.countRows()) < minRows) return false;
    const existing = await tbl.listIndices();
    if (existing.some((i) => i.columns.includes("patches"))) return true;
    try {
      await tbl.createIndex("patches", {
        config: lancedb.Index.ivfPq({
          distanceType: "cosine", // multivector supports only cosine
          numPartitions: 16,
          numSubVectors: 8,
        }),
      });
      return true;
    } catch {
      return false; // not enough distinct vectors to train yet
    }
  }
```

Then simplify `searchFrame` to reuse `frameFilter`:

```ts
  async searchFrame(
    namespace: string,
    vector: Float32Array,
    k: number,
    scope?: { segmentIds?: string[]; frameIds?: string[] },
  ): Promise<SearchResult[]> {
    return this.search(namespace, vector, k, this.frameFilter(scope));
  }
```

- [ ] **Step 6: Run the multivector test**

Run: `npx vitest run test/lance.multivector.test.ts`
Expected: PASS, all 7 cases. The MaxSim case is the one that matters — if `bothAB` does not win outright, `vectorSearch` is not scoring late-interaction and the whole local image path is invalid.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. `TableKind` widened, so any exhaustive switch over it surfaces here. `test/scoped-ann.test.ts` and `test/dual-store.crash.test.ts` exercise the refactored `searchFrame` — they must still pass.

- [ ] **Step 8: Commit**

```bash
git add src/store/lance/tables.ts test/lance.multivector.test.ts
git commit -m "feat(store): multivector frame_patches table with cosine MaxSim search"
```

---

### Task 6: DualStore patch API and reconciliation guard

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/store.ts`
- Test: `test/dual-store.patches.test.ts`

**Interfaces:**
- Consumes: `addPatches`, `searchFramePatches`, `ensurePatchIndex`, `FramePatchRow` (Task 5); `MULTIVECTOR_VIEWS` (Task 1)
- Produces (on `Store` and `DualStore`):
  - `FramePatchInsert { frameId: string; sessionId: string; segmentIds: string[]; namespace: string; patches: Float32Array[] }`
  - `putFramePatches(rows: FramePatchInsert[]): Promise<void>`
  - `searchFramePatches(namespace: string, query: Float32Array[], k: number, scope?: FrameScope): Promise<SearchHit[]>`

**Two invariants this task must not break:** the SQLite-commit-then-Lance-add order, serialized through the existing `Mutex`; and `reconcileAndReembed`, which assumes one vector per row and would treat a patch set as a missing single vector.

- [ ] **Step 1: Write the failing test**

Create `test/dual-store.patches.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { FakeMultiVectorProvider } from "../src/embed/fake.js";
import { namespaceFor } from "../src/embed/types.js";

const provider = new FakeMultiVectorProvider(16, 3);
const NS = namespaceFor("frame_patches", provider);

let dir: string;
let store: DualStore;
let sessionId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dsp-"));
  store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
  await store.registerVectorSpace({
    namespace: NS,
    view: "frame_patches",
    providerId: provider.id,
    model: provider.model,
    dimensions: provider.dimensions,
    sharedTextSpace: true,
  });
  sessionId = ulid();
  await store.putSession({ id: sessionId, startedAt: Date.now() });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function addFrame(id: string, tMono: number): Promise<void> {
  await store.putFrames([
    { id, sessionId, tMono, width: 1280, height: 800, phash: 0n, blobId: null },
  ]);
}

describe("DualStore frame patches", () => {
  it("writes and searches patch vectors", async () => {
    await addFrame("f1", 100);
    await addFrame("f2", 200);
    const [pa, pb] = await provider.embedImages([
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([9, 9, 9]),
    ]);
    await store.putFramePatches([
      { frameId: "f1", sessionId, segmentIds: ["segA"], namespace: NS, patches: pa! },
      { frameId: "f2", sessionId, segmentIds: ["segB"], namespace: NS, patches: pb! },
    ]);
    const [q] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    const hits = await store.searchFramePatches(NS, q!, 5);
    expect(hits[0]!.id).toBe("f1");
  });

  it("scopes patch search to Tier-1 segments", async () => {
    await addFrame("f1", 100);
    await addFrame("f2", 200);
    const [pa, pb] = await provider.embedImages([
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([9, 9, 9]),
    ]);
    await store.putFramePatches([
      { frameId: "f1", sessionId, segmentIds: ["segA"], namespace: NS, patches: pa! },
      { frameId: "f2", sessionId, segmentIds: ["segB"], namespace: NS, patches: pb! },
    ]);
    const [q] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    const hits = await store.searchFramePatches(NS, q!, 5, { segmentIds: ["segB"] });
    expect(hits.map((h) => h.id)).toEqual(["f2"]);
  });

  it("does not report multivector rows as missing during reconciliation", async () => {
    await addFrame("f1", 100);
    const [pa] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    await store.putFramePatches([
      { frameId: "f1", sessionId, segmentIds: ["segA"], namespace: NS, patches: pa! },
    ]);
    const res = await store.reconcile();
    expect(res.missing.filter((m) => m.namespace === NS)).toEqual([]);
    expect(res.orphansPruned).toBe(0);
  });

  it("deletes patch rows with the session", async () => {
    await addFrame("f1", 100);
    const [pa] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    await store.putFramePatches([
      { frameId: "f1", sessionId, segmentIds: ["segA"], namespace: NS, patches: pa! },
    ]);
    await store.deleteSession(sessionId);
    const [q] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    expect(await store.searchFramePatches(NS, q!, 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dual-store.patches.test.ts`
Expected: FAIL — `store.putFramePatches is not a function`.

- [ ] **Step 3: Add the types to `src/store/types.ts`**

Beside `FrameVectorInsert`:

```ts
/** A frame's late-interaction patch set. Many vectors, one row. */
export interface FramePatchInsert {
  frameId: string;
  sessionId: string;
  segmentIds: string[];
  namespace: string;
  patches: Float32Array[];
}
```

And on `interface Store`, next to `putFrameVectors`:

```ts
  putFramePatches(rows: FramePatchInsert[]): Promise<void>;
```

Next to `searchFrames`:

```ts
  searchFramePatches(
    namespace: string,
    query: Float32Array[],
    k: number,
    scope?: FrameScope,
  ): Promise<SearchHit[]>;
```

- [ ] **Step 4: Implement on `DualStore`**

Follow `putFrameVectors` exactly — same `Mutex`, same SQLite-first ordering:

```ts
  /**
   * Patch vectors for frames. Association (SQLite) commits first, then the Lance
   * add — a crash between leaves a detectable gap, never an orphan vector.
   */
  async putFramePatches(rows: FramePatchInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      this.db.transaction(() => {
        for (const r of rows) this.associateFrameSegmentsSync(r.frameId, r.segmentIds);
      })();
      const byNamespace = new Map<string, FramePatchRow[]>();
      for (const r of rows) {
        const list = byNamespace.get(r.namespace) ?? [];
        list.push({
          id: r.frameId,
          session_id: r.sessionId,
          segment_ids: r.segmentIds,
          patches: r.patches.map((v) => Array.from(v)),
        });
        byNamespace.set(r.namespace, list);
      }
      for (const [ns, batch] of byNamespace) {
        await this.lance.addPatches(ns, batch);
        await this.lance.ensurePatchIndex(ns);
      }
    });
  }

  async searchFramePatches(
    namespace: string,
    query: Float32Array[],
    k: number,
    scope?: FrameScope,
  ): Promise<SearchHit[]> {
    this.assertNamespaceRegistered(namespace);
    return this.lance.searchFramePatches(namespace, query, k, scope);
  }
```

If `associateFrameSegments` is currently only available as an async method, extract its synchronous body into a private `associateFrameSegmentsSync(frameId, segmentIds)` and have both callers use it. Reuse whatever registered-namespace assertion `searchSegments` already performs; if it is inline, extract it to `assertNamespaceRegistered`.

- [ ] **Step 5: Guard reconciliation**

In the method that walks registered namespaces looking for missing vectors, skip multivector views — `allIds()` returns one id per row for them, but the "missing" computation assumes a single vector per entity and would mis-file patch rows:

```ts
import { MULTIVECTOR_VIEWS } from "../embed/types.js";

// inside the namespace loop, before computing `missing`:
      if (MULTIVECTOR_VIEWS.has(space.view)) {
        // Patch sets are re-embedded wholesale by the representer, not row-by-row.
        // Still prune orphans — that comparison is id-based and shape-agnostic.
        continue;
      }
```

Place the `continue` **after** orphan pruning so orphan removal still runs, and only the `missing` computation is skipped.

- [ ] **Step 6: Confirm delete covers the new table**

`deleteSession` gathers ids from SQLite then deletes from Lance per namespace. Because patch rows are keyed by `frame_id` exactly like `frame_image` rows, the existing frame-id delete path covers them — but verify the namespace loop iterates **all** registered spaces including `frame_patches`, not a hardcoded view list.

Run: `npx vitest run test/dual-store.patches.test.ts -t "deletes patch rows"`
Expected: PASS.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, including `test/dual-store.crash.test.ts` and `test/dual-store.reconcile.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/store/types.ts src/store/store.ts test/dual-store.patches.test.ts
git commit -m "feat(store): putFramePatches/searchFramePatches with a reconcile guard for multivector views"
```

---

### Task 7: ColSmol tile geometry and patch→bbox mapping

**Files:**
- Create: `src/embed/onnx/geometry.ts`
- Test: `test/onnx.geometry.test.ts`

**Interfaces:**
- Consumes: `Box` from `src/represent/regions/geometry.js`
- Produces:
  - `TileConfig { maxEdge: number; tileSize: number; patchSize: number; shuffleFactor: number; globalTile: boolean }`
  - `DEFAULT_TILE_CONFIG: TileConfig` — `{ maxEdge: 2048, tileSize: 512, patchSize: 16, shuffleFactor: 4, globalTile: true }`
  - `TileGeometry { srcWidth, srcHeight, scale, cols, rows, tokensPerTile, tokenGrid, hasGlobalTile, tileSize }`
  - `computeTileGeometry(srcWidth: number, srcHeight: number, cfg?: TileConfig): TileGeometry`
  - `expectedTokenCount(g: TileGeometry): number`
  - `patchIndexToBox(index: number, g: TileGeometry): Box | null`

**Why this is pure and separate:** this is the highest-risk silent failure in the design. Wrong geometry puts highlights on the wrong part of the frame while retrieval scores stay plausible. Isolating it makes it exhaustively testable without weights.

Derivation, from `vidore/colSmol-256M/config.json`: `image_size: 512`, `patch_size: 16` → 1024 patches per tile; `pixel_shuffle_factor: 4` → ÷16 → **64 tokens per tile**, an 8×8 grid, each token covering 64×64 px of its tile.

- [ ] **Step 1: Write the failing test**

Create `test/onnx.geometry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TILE_CONFIG,
  computeTileGeometry,
  expectedTokenCount,
  patchIndexToBox,
} from "../src/embed/onnx/geometry.js";

describe("computeTileGeometry", () => {
  it("derives 64 tokens per tile in an 8x8 grid from the ColSmol config", () => {
    const g = computeTileGeometry(1280, 800);
    expect(g.tokensPerTile).toBe(64);
    expect(g.tokenGrid).toBe(8);
  });

  it("tiles a 1280x800 frame into 3x2 plus a global view", () => {
    const g = computeTileGeometry(1280, 800);
    expect(g.scale).toBe(1); // under the 2048 cap
    expect([g.cols, g.rows]).toEqual([3, 2]);
    expect(g.hasGlobalTile).toBe(true);
    expect(expectedTokenCount(g)).toBe((3 * 2 + 1) * 64); // 448
  });

  it("downscales past the 2048 long-edge cap before tiling", () => {
    const g = computeTileGeometry(4096, 2048);
    expect(g.scale).toBe(0.5);
    expect([g.cols, g.rows]).toEqual([4, 2]);
  });

  it("omits the global tile when the image is a single tile", () => {
    const g = computeTileGeometry(400, 300);
    expect([g.cols, g.rows]).toEqual([1, 1]);
    expect(g.hasGlobalTile).toBe(false);
    expect(expectedTokenCount(g)).toBe(64);
  });
});

describe("patchIndexToBox", () => {
  const g = computeTileGeometry(1280, 800);

  it("maps token 0 to the top-left 64px cell", () => {
    expect(patchIndexToBox(0, g)).toEqual({ x: 0, y: 0, w: 64, h: 64 });
  });

  it("maps within-tile position by an 8x8 grid", () => {
    // token 9 = row 1, col 1 of tile 0
    expect(patchIndexToBox(9, g)).toEqual({ x: 64, y: 64, w: 64, h: 64 });
  });

  it("offsets by tile column and row", () => {
    // tile 1 is the second column: x starts at 512
    expect(patchIndexToBox(64, g)).toEqual({ x: 512, y: 0, w: 64, h: 64 });
    // tile 3 is row 1, col 0: y starts at 512
    expect(patchIndexToBox(3 * 64, g)).toEqual({ x: 0, y: 512, w: 64, h: 64 });
  });

  it("clamps the last row and column to the frame", () => {
    // tile 4 (row 1, col 1) bottom row: y 512+448=960 exceeds height 800
    const box = patchIndexToBox(4 * 64 + 56, g)!;
    expect(box.y + box.h).toBeLessThanOrEqual(800);
    expect(box.x + box.w).toBeLessThanOrEqual(1280);
  });

  it("maps a global-tile token to the whole frame", () => {
    const box = patchIndexToBox(6 * 64, g); // tile index 6 == cols*rows
    expect(box).toEqual({ x: 0, y: 0, w: 1280, h: 800 });
  });

  it("returns null past the end", () => {
    expect(patchIndexToBox(expectedTokenCount(g), g)).toBeNull();
    expect(patchIndexToBox(-1, g)).toBeNull();
  });

  it("rescales back to source pixels when the image was downscaled", () => {
    const big = computeTileGeometry(4096, 2048); // scale 0.5
    // token 0 covers 64px in resized space -> 128px in source space
    expect(patchIndexToBox(0, big)).toEqual({ x: 0, y: 0, w: 128, h: 128 });
  });

  it("uses the config it was given", () => {
    expect(DEFAULT_TILE_CONFIG.tileSize).toBe(512);
    const g2 = computeTileGeometry(256, 256, { ...DEFAULT_TILE_CONFIG, tileSize: 256 });
    expect(g2.tokensPerTile).toBe(64);
    expect(patchIndexToBox(0, g2)).toEqual({ x: 0, y: 0, w: 32, h: 32 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/onnx.geometry.test.ts`
Expected: FAIL — cannot resolve `../src/embed/onnx/geometry.js`.

- [ ] **Step 3: Write the implementation**

Create `src/embed/onnx/geometry.ts`:

```ts
/**
 * ColSmol tile layout and the patch-index -> frame-bbox mapping that turns a
 * MaxSim argmax into a highlight box.
 *
 * Pure — no weights, no native modules — because this is the design's highest-risk
 * silent failure: wrong geometry puts highlights on the wrong part of the frame
 * while retrieval scores stay entirely plausible.
 *
 * Numbers come from vidore/colSmol-256M: image_size 512, patch_size 16 -> 1024
 * patches per tile; pixel_shuffle_factor 4 -> divide by 16 -> 64 tokens per tile,
 * an 8x8 grid where each token covers 64x64 px of its tile.
 */

import type { Box } from "../../represent/regions/geometry.js";

export interface TileConfig {
  /** Longest edge the source is resized to before tiling. */
  maxEdge: number;
  /** Square tile edge. */
  tileSize: number;
  /** ViT patch edge. */
  patchSize: number;
  /** Pixel-shuffle factor; token count is divided by its square. */
  shuffleFactor: number;
  /** Whether a whole-image thumbnail tile is appended after the grid. */
  globalTile: boolean;
}

export const DEFAULT_TILE_CONFIG: TileConfig = {
  maxEdge: 2048,
  tileSize: 512,
  patchSize: 16,
  shuffleFactor: 4,
  globalTile: true,
};

export interface TileGeometry {
  srcWidth: number;
  srcHeight: number;
  /** Resize factor applied before tiling (<= 1). */
  scale: number;
  cols: number;
  rows: number;
  tokensPerTile: number;
  /** sqrt(tokensPerTile) — the token grid edge within a tile. */
  tokenGrid: number;
  hasGlobalTile: boolean;
  tileSize: number;
}

export function computeTileGeometry(
  srcWidth: number,
  srcHeight: number,
  cfg: TileConfig = DEFAULT_TILE_CONFIG,
): TileGeometry {
  const scale = Math.min(1, cfg.maxEdge / Math.max(srcWidth, srcHeight));
  const w = Math.round(srcWidth * scale);
  const h = Math.round(srcHeight * scale);
  const cols = Math.max(1, Math.ceil(w / cfg.tileSize));
  const rows = Math.max(1, Math.ceil(h / cfg.tileSize));
  const perTile = (cfg.tileSize / cfg.patchSize) ** 2 / cfg.shuffleFactor ** 2;
  return {
    srcWidth,
    srcHeight,
    scale,
    cols,
    rows,
    tokensPerTile: perTile,
    tokenGrid: Math.round(Math.sqrt(perTile)),
    // A single-tile image is already its own global view.
    hasGlobalTile: cfg.globalTile && cols * rows > 1,
    tileSize: cfg.tileSize,
  };
}

/** How many image tokens the model should emit for this geometry. */
export function expectedTokenCount(g: TileGeometry): number {
  return (g.cols * g.rows + (g.hasGlobalTile ? 1 : 0)) * g.tokensPerTile;
}

/**
 * Frame-space bbox for one image token, or null if the index is out of range.
 * A global-tile token maps to the whole frame.
 */
export function patchIndexToBox(index: number, g: TileGeometry): Box | null {
  if (!Number.isInteger(index) || index < 0 || index >= expectedTokenCount(g)) return null;

  const tileIndex = Math.floor(index / g.tokensPerTile);
  const gridTiles = g.cols * g.rows;
  if (g.hasGlobalTile && tileIndex === gridTiles) {
    return { x: 0, y: 0, w: g.srcWidth, h: g.srcHeight };
  }

  const within = index % g.tokensPerTile;
  const tileCol = tileIndex % g.cols;
  const tileRow = Math.floor(tileIndex / g.cols);
  const cell = g.tileSize / g.tokenGrid;
  const gx = within % g.tokenGrid;
  const gy = Math.floor(within / g.tokenGrid);

  // Resized space -> source space.
  const inv = 1 / g.scale;
  const x = (tileCol * g.tileSize + gx * cell) * inv;
  const y = (tileRow * g.tileSize + gy * cell) * inv;
  const size = cell * inv;

  const x0 = Math.min(x, g.srcWidth);
  const y0 = Math.min(y, g.srcHeight);
  return {
    x: x0,
    y: y0,
    w: Math.max(0, Math.min(size, g.srcWidth - x0)),
    h: Math.max(0, Math.min(size, g.srcHeight - y0)),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/onnx.geometry.test.ts && npm run typecheck`
Expected: PASS, all 12 cases.

- [ ] **Step 5: Commit**

```bash
git add src/embed/onnx/geometry.ts test/onnx.geometry.test.ts
git commit -m "feat(embed): ColSmol tile geometry and patch-index to bbox mapping"
```

---

### Task 8: ColSmolMultiVector adapter

**Files:**
- Create: `src/embed/onnx/colsmol.ts`
- Create: `scripts/inspect-onnx.mjs`
- Test: `test/onnx.colsmol.test.ts`

**Interfaces:**
- Consumes: `OnnxRuntime`, `OnnxSession`, `makeTensor` (Task 3); `l2Normalize`, `sliceRows` (Task 2); `computeTileGeometry`, `expectedTokenCount`, `DEFAULT_TILE_CONFIG` (Task 7); `MultiVectorProvider` (Task 1)
- Produces:
  - `ColSmolMultiVector implements MultiVectorProvider`
  - `id = "onnx"`, `model = "colsmol-256m"`, `dimensions = 128`, `multiVector = true`
  - Constructor: `new ColSmolMultiVector({ modelPath, tokenizerPath, preprocessorPath?, dimensions?, tileConfig?, session?, tokenize?, tileImage? })`
  - `readTileConfig(preprocessorPath: string, configPath: string): Promise<TileConfig>`

**This task starts with discovery, not code.** The ONNX export is community-produced (`onnx-community/colSmol-256M-ONNX`, a single merged `model.onnx`), so its input and output names are not documented. Writing against guessed names would produce a plausible adapter that fails only at runtime.

- [ ] **Step 1: Write the inspection script**

Create `scripts/inspect-onnx.mjs`:

```js
/** Print an ONNX model's input/output names, types, and dims. */
import ort from "onnxruntime-node";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/inspect-onnx.mjs <model.onnx>");
  process.exit(1);
}
const s = await ort.InferenceSession.create(path);
console.log("INPUTS:");
for (const n of s.inputNames) console.log("  ", n, JSON.stringify(s.inputMetadata?.[n] ?? {}));
console.log("OUTPUTS:");
for (const n of s.outputNames) console.log("  ", n, JSON.stringify(s.outputMetadata?.[n] ?? {}));
```

- [ ] **Step 2: Download the weights and inspect**

```bash
mkdir -p /tmp/colsmol && cd /tmp/colsmol
curl -sL -o model.onnx https://huggingface.co/onnx-community/colSmol-256M-ONNX/resolve/main/onnx/model.onnx
curl -sL -o tokenizer.json https://huggingface.co/onnx-community/colSmol-256M-ONNX/resolve/main/tokenizer.json
curl -sL -o preprocessor_config.json https://huggingface.co/onnx-community/colSmol-256M-ONNX/resolve/main/preprocessor_config.json
cd - && node scripts/inspect-onnx.mjs /tmp/colsmol/model.onnx
```

**Record the actual names in a comment at the top of `colsmol.ts`.** Expect something like `input_ids`, `attention_mask`, `pixel_values`, `pixel_attention_mask`; the output is the projected multi-vector embedding. Confirm the last output dimension — the plan assumes **128**, which is ColVision convention but is not stated in `config.json`. If it differs, use the real value everywhere (it becomes part of the namespace).

If the export cannot be driven in one pass, stop and report — that invalidates the single-session assumption and needs a design decision, not a workaround.

- [ ] **Step 3: Write the failing test**

Create `test/onnx.colsmol.test.ts`. A stub session and stub tiler keep this CI-safe:

```ts
import { describe, expect, it } from "vitest";
import { ColSmolMultiVector } from "../src/embed/onnx/colsmol.js";
import { computeTileGeometry, expectedTokenCount } from "../src/embed/onnx/geometry.js";
import type { OnnxSession } from "../src/embed/onnx/runtime.js";

const D = 128;

/** Emits `tokens` rows of `D` dims, each row a constant equal to its index. */
function stubSession(tokens: number): OnnxSession {
  return {
    async run() {
      const data = new Float32Array(tokens * D);
      for (let t = 0; t < tokens; t++) {
        for (let d = 0; d < D; d++) data[t * D + d] = t + 1;
      }
      return { embeddings: { data, dims: [1, tokens, D] } };
    },
  };
}

const base = (tokens: number) => ({
  modelPath: "/unused",
  tokenizerPath: "/unused",
  session: stubSession(tokens),
  tokenize: () => ({ ids: [1, 2, 3] }),
  // stub tiler: reports geometry without loading sharp
  tileImage: async () => ({
    tiles: [] as Float32Array[],
    width: 1280,
    height: 800,
  }),
});

describe("ColSmolMultiVector", () => {
  it("namespaces as a 128-dim multivector provider", () => {
    const p = new ColSmolMultiVector(base(448));
    expect(p.id).toBe("onnx");
    expect(p.model).toBe("colsmol-256m");
    expect(p.dimensions).toBe(128);
    expect(p.multiVector).toBe(true);
    expect(p.model).not.toContain(":");
  });

  it("returns one unit-length vector per image token", async () => {
    const g = computeTileGeometry(1280, 800);
    const p = new ColSmolMultiVector(base(expectedTokenCount(g)));
    const [set] = await p.embedImages([Uint8Array.from([1, 2, 3])]);
    expect(set!.length).toBe(448);
    for (const v of set!) {
      expect(v.length).toBe(D);
      const norm = Math.sqrt(Array.from(v).reduce((n, x) => n + x * x, 0));
      expect(norm).toBeCloseTo(1, 5);
    }
  });

  it("throws when the token count disagrees with the computed tiling", async () => {
    // geometry predicts 448; the session returns 100
    const p = new ColSmolMultiVector(base(100));
    await expect(p.embedImages([Uint8Array.from([1, 2, 3])])).rejects.toThrow(
      /token count/i,
    );
  });

  it("embeds queries as a multi-vector set", async () => {
    const p = new ColSmolMultiVector(base(3));
    const [q] = await p.embedQueries(["a login form"]);
    expect(q!.length).toBe(3);
    expect(q![0]!.length).toBe(D);
  });

  it("returns [] for empty input without touching the session", async () => {
    const p = new ColSmolMultiVector(base(448));
    expect(await p.embedImages([])).toEqual([]);
    expect(await p.embedQueries([])).toEqual([]);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/onnx.colsmol.test.ts`
Expected: FAIL — cannot resolve `../src/embed/onnx/colsmol.js`.

- [ ] **Step 5: Write the implementation**

Create `src/embed/onnx/colsmol.ts`. Replace the input/output names in `run()` with the ones recorded in Step 2:

```ts
/**
 * ColSmol-256M late-interaction embeddings via onnxruntime-node.
 *
 * NOT in the package barrel — loads onnxruntime-node AND sharp. Import directly.
 *
 * ONNX I/O names for onnx-community/colSmol-256M-ONNX (verified with
 * scripts/inspect-onnx.mjs):
 *   inputs:  <RECORD ACTUAL NAMES IN STEP 2>
 *   outputs: <RECORD ACTUAL NAME IN STEP 2>
 *
 * Tiling geometry is READ from preprocessor_config.json / config.json rather than
 * hardcoded, so swapping the model cannot silently change the layout while the
 * patch->bbox mapping keeps assuming the old one.
 */

import { readFile } from "node:fs/promises";
import type { MultiVectorProvider } from "../types.js";
import { l2Normalize, sliceRows } from "./pooling.js";
import {
  DEFAULT_TILE_CONFIG,
  computeTileGeometry,
  expectedTokenCount,
  type TileConfig,
} from "./geometry.js";
import { OnnxRuntime, makeTensor, type OnnxSession } from "./runtime.js";

export interface TiledImage {
  /** One normalized CHW tile buffer per tile, grid order then global. */
  tiles: Float32Array[];
  width: number;
  height: number;
}

export interface ColSmolOptions {
  modelPath: string;
  tokenizerPath: string;
  /** preprocessor_config.json; when given, tile config is read from it. */
  preprocessorPath?: string;
  model?: string;
  dimensions?: number;
  tileConfig?: TileConfig;
  session?: OnnxSession;
  tokenize?: (text: string) => { ids: number[] };
  tileImage?: (image: Uint8Array, cfg: TileConfig) => Promise<TiledImage>;
}

/** Read tiling parameters from the model's own config files. */
export async function readTileConfig(
  preprocessorPath: string,
  configPath: string,
): Promise<TileConfig> {
  const pre = JSON.parse(await readFile(preprocessorPath, "utf8")) as {
    size?: { longest_edge?: number };
    max_image_size?: { longest_edge?: number };
  };
  const cfg = JSON.parse(await readFile(configPath, "utf8")) as {
    vision_config?: { patch_size?: number };
    text_config?: { pixel_shuffle_factor?: number };
  };
  return {
    maxEdge: pre.size?.longest_edge ?? DEFAULT_TILE_CONFIG.maxEdge,
    tileSize: pre.max_image_size?.longest_edge ?? DEFAULT_TILE_CONFIG.tileSize,
    patchSize: cfg.vision_config?.patch_size ?? DEFAULT_TILE_CONFIG.patchSize,
    shuffleFactor:
      cfg.text_config?.pixel_shuffle_factor ?? DEFAULT_TILE_CONFIG.shuffleFactor,
    globalTile: true,
  };
}

export class ColSmolMultiVector implements MultiVectorProvider {
  readonly id = "onnx";
  readonly model: string;
  readonly dimensions: number;
  readonly multiVector = true as const;
  readonly tileConfig: TileConfig;
  private readonly modelPath: string;
  private readonly tokenizerPath: string;
  private readonly injectedSession: OnnxSession | undefined;
  private readonly injectedTokenize: ((t: string) => { ids: number[] }) | undefined;
  private readonly injectedTiler: ColSmolOptions["tileImage"];

  constructor(opts: ColSmolOptions) {
    this.model = opts.model ?? "colsmol-256m";
    this.dimensions = opts.dimensions ?? 128;
    this.tileConfig = opts.tileConfig ?? DEFAULT_TILE_CONFIG;
    this.modelPath = opts.modelPath;
    this.tokenizerPath = opts.tokenizerPath;
    this.injectedSession = opts.session;
    this.injectedTokenize = opts.tokenize;
    this.injectedTiler = opts.tileImage;
  }

  private session(): Promise<OnnxSession> {
    return this.injectedSession
      ? Promise.resolve(this.injectedSession)
      : OnnxRuntime.session(this.modelPath);
  }

  /** sharp-backed tiling. Lazy so tests can inject and skip the native load. */
  private async tile(image: Uint8Array): Promise<TiledImage> {
    if (this.injectedTiler) return this.injectedTiler(image, this.tileConfig);
    const { tileImageWithSharp } = await import(/* @vite-ignore */ "./colsmol-tiler.js");
    return tileImageWithSharp(image, this.tileConfig);
  }

  private rows(out: Record<string, { data: Float32Array; dims: number[] }>): Float32Array[] {
    const t = out.embeddings ?? Object.values(out)[0]!;
    const dims = t.dims[t.dims.length - 1]!;
    const count = t.data.length / dims;
    return sliceRows(t.data, count, dims).map((v) => l2Normalize(v));
  }

  async embedImages(images: Uint8Array[]): Promise<Float32Array[][]> {
    if (images.length === 0) return [];
    const sess = await this.session();
    const out: Float32Array[][] = [];
    // One image per run: token count varies with aspect ratio, so batching would
    // require padding and a mask over patch positions.
    for (const image of images) {
      const tiled = await this.tile(image);
      const geo = computeTileGeometry(tiled.width, tiled.height, this.tileConfig);
      const expected = expectedTokenCount(geo);
      const pixels = new Float32Array(tiled.tiles.reduce((n, t) => n + t.length, 0));
      let off = 0;
      for (const t of tiled.tiles) {
        pixels.set(t, off);
        off += t.length;
      }
      const res = (await sess.run({
        pixel_values: makeTensor("float32", pixels, [1, tiled.tiles.length, -1]),
      })) as Record<string, { data: Float32Array; dims: number[] }>;
      const vectors = this.rows(res);
      if (vectors.length !== expected) {
        throw new Error(
          `ColSmol token count mismatch: model returned ${vectors.length}, ` +
            `geometry predicts ${expected} for ${tiled.width}x${tiled.height} ` +
            `(${geo.cols}x${geo.rows} tiles${geo.hasGlobalTile ? " + global" : ""}). ` +
            `Tiling config and the model are out of sync.`,
        );
      }
      out.push(vectors);
    }
    return out;
  }

  async embedQueries(texts: string[]): Promise<Float32Array[][]> {
    if (texts.length === 0) return [];
    const tokenize = this.injectedTokenize ?? (await this.tokenizer());
    const sess = await this.session();
    const out: Float32Array[][] = [];
    for (const text of texts) {
      const ids = tokenize(text).ids;
      const buf = BigInt64Array.from(ids.map((n) => BigInt(n)));
      const res = (await sess.run({
        input_ids: makeTensor("int64", buf, [1, ids.length]),
        attention_mask: makeTensor(
          "int64",
          BigInt64Array.from(ids.map(() => 1n)),
          [1, ids.length],
        ),
      })) as Record<string, { data: Float32Array; dims: number[] }>;
      out.push(this.rows(res));
    }
    return out;
  }

  private async tokenizer(): Promise<(t: string) => { ids: number[] }> {
    const { Tokenizer } = (await import(
      /* @vite-ignore */ "@huggingface/tokenizers"
    )) as { Tokenizer: { fromFile(p: string): Promise<{ encode(t: string): { ids: number[] } }> } };
    const tok = await Tokenizer.fromFile(this.tokenizerPath);
    return (t: string) => tok.encode(t);
  }
}
```

- [ ] **Step 6: Write the sharp tiler**

Create `src/embed/onnx/colsmol-tiler.ts` — split so `colsmol.ts` can be imported in tests without loading sharp:

```ts
/** sharp-backed tiling + CLIP-style normalization for ColSmol. Loads sharp. */
import type { TileConfig, TiledImage } from "./geometry.js";

const MEAN = [0.5, 0.5, 0.5];
const STD = [0.5, 0.5, 0.5];

export async function tileImageWithSharp(
  image: Uint8Array,
  cfg: TileConfig,
): Promise<TiledImage> {
  const sharp = (await import(/* @vite-ignore */ "sharp")).default;
  const meta = await sharp(Buffer.from(image)).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  const scale = Math.min(1, cfg.maxEdge / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const cols = Math.max(1, Math.ceil(w / cfg.tileSize));
  const rows = Math.max(1, Math.ceil(h / cfg.tileSize));

  const resized = sharp(Buffer.from(image)).resize(w, h, { fit: "fill" });
  const tiles: Float32Array[] = [];

  const toCHW = async (buf: Buffer): Promise<Float32Array> => {
    const { data } = await sharp(buf)
      .resize(cfg.tileSize, cfg.tileSize, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const n = cfg.tileSize * cfg.tileSize;
    const out = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        out[c * n + i] = (data[i * 3 + c]! / 255 - MEAN[c]!) / STD[c]!;
      }
    }
    return out;
  };

  const full = await resized.png().toBuffer();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const left = c * cfg.tileSize;
      const top = r * cfg.tileSize;
      const tw = Math.min(cfg.tileSize, w - left);
      const th = Math.min(cfg.tileSize, h - top);
      const crop = await sharp(full)
        .extract({ left, top, width: tw, height: th })
        .png()
        .toBuffer();
      tiles.push(await toCHW(crop));
    }
  }
  if (cols * rows > 1) tiles.push(await toCHW(full)); // global view, appended last

  return { tiles, width: srcW, height: srcH };
}
```

Move the `TiledImage` interface into `geometry.ts` so both files can import it without a cycle.

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run test/onnx.colsmol.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Verify the barrel still excludes native code**

Run: `grep -nE "colsmol|onnx" src/index.ts`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add src/embed/onnx/colsmol.ts src/embed/onnx/colsmol-tiler.ts src/embed/onnx/geometry.ts scripts/inspect-onnx.mjs test/onnx.colsmol.test.ts
git commit -m "feat(embed): ColSmolMultiVector adapter with config-driven tiling"
```

---

### Task 9: FramePatchRepresenter — write patch vectors for a session

**Files:**
- Create: `src/represent/frame-patch-representer.ts`
- Modify: `src/index.ts`
- Test: `test/frame-patches.test.ts`

**Interfaces:**
- Consumes: `MultiVectorProvider` (Task 1), `putFramePatches` (Task 6), `BlobStore`
- Produces:
  - `FramePatchRepresenterOptions { patchEmbedder: MultiVectorProvider; blobStore: BlobStore }`
  - `FramePatchRepresentResult { frameCount: number; embeddedCount: number; namespace: string }`
  - `class FramePatchRepresenter { constructor(store: Store, opts); represent(sessionId: string): Promise<FramePatchRepresentResult> }`

Mirrors `FrameRepresenter` (`src/represent/frame-representer.ts`) — same constructor shape, same result shape, same lazy segment association — but writes a multi-vector row per keyframe instead of one vector. It is barrel-safe: the provider is injected, so this file loads no native code.

- [ ] **Step 1: Write the failing test**

Create `test/frame-patches.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { FramePatchRepresenter } from "../src/represent/frame-patch-representer.js";
import { FakeMultiVectorProvider } from "../src/embed/fake.js";
import { namespaceFor } from "../src/embed/types.js";

const provider = new FakeMultiVectorProvider(16, 3);
const NS = namespaceFor("frame_patches", provider);

let dir: string;
let store: DualStore;
let blobs: BlobStore;
let sessionId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "fpr-"));
  store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
  blobs = new BlobStore(join(dir, "blobs"));
  sessionId = ulid();
  await store.putSession({ id: sessionId, startedAt: Date.now() });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function frameWithBlob(id: string, tMono: number, bytes: number[]): Promise<void> {
  const blob = await blobs.write(sessionId, "keyframe", "jpeg", Uint8Array.from(bytes));
  await store.putBlobs([blob.row]);
  await store.putFrames([
    { id, sessionId, tMono, width: 1280, height: 800, phash: 0n, blobId: blob.row.id },
  ]);
}

describe("FramePatchRepresenter", () => {
  it("registers the namespace and embeds every keyframe with a blob", async () => {
    await frameWithBlob("f1", 100, [1, 2, 3]);
    await frameWithBlob("f2", 200, [4, 5, 6]);
    const res = await new FramePatchRepresenter(store, {
      patchEmbedder: provider,
      blobStore: blobs,
    }).represent(sessionId);

    expect(res.namespace).toBe(NS);
    expect(res.frameCount).toBe(2);
    expect(res.embeddedCount).toBe(2);
    expect(store.listVectorSpaces().map((s) => s.namespace)).toContain(NS);
  });

  it("makes each frame retrievable by its own bytes", async () => {
    await frameWithBlob("f1", 100, [1, 2, 3]);
    await frameWithBlob("f2", 200, [9, 9, 9]);
    await new FramePatchRepresenter(store, {
      patchEmbedder: provider,
      blobStore: blobs,
    }).represent(sessionId);

    const [q] = await provider.embedImages([Uint8Array.from([9, 9, 9])]);
    const hits = await store.searchFramePatches(NS, q!, 5);
    expect(hits[0]!.id).toBe("f2");
  });

  it("skips frames with no keyframe blob rather than failing the pass", async () => {
    await frameWithBlob("f1", 100, [1, 2, 3]);
    await store.putFrames([
      { id: "f2", sessionId, tMono: 200, width: 1280, height: 800, phash: 0n, blobId: null },
    ]);
    const res = await new FramePatchRepresenter(store, {
      patchEmbedder: provider,
      blobStore: blobs,
    }).represent(sessionId);
    expect(res.frameCount).toBe(2);
    expect(res.embeddedCount).toBe(1);
  });

  it("is idempotent — a second pass does not duplicate rows", async () => {
    await frameWithBlob("f1", 100, [1, 2, 3]);
    const r = new FramePatchRepresenter(store, { patchEmbedder: provider, blobStore: blobs });
    await r.represent(sessionId);
    await r.represent(sessionId);
    const [q] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    const hits = await store.searchFramePatches(NS, q!, 10);
    expect(hits.filter((h) => h.id === "f1").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/frame-patches.test.ts`
Expected: FAIL — cannot resolve `../src/represent/frame-patch-representer.js`.

- [ ] **Step 3: Write the implementation**

Create `src/represent/frame-patch-representer.ts`:

```ts
/**
 * Writes the `frame_patches` view: one late-interaction patch set per keyframe.
 *
 * The multi-vector counterpart to FrameRepresenter. Segment association is set
 * lazily here, at represent time, because segments are detected after capture —
 * the denormalized segment_ids column is what lets Tier 2 pre-filter its scope
 * without a cross-engine round-trip mid-search.
 *
 * Barrel-safe: the provider is injected, so this file loads no native code.
 */

import type { MultiVectorProvider } from "../embed/types.js";
import { namespaceFor } from "../embed/types.js";
import type { BlobStore } from "../store/blob-store.js";
import type { FramePatchInsert, Store } from "../store/types.js";

export interface FramePatchRepresenterOptions {
  patchEmbedder: MultiVectorProvider;
  blobStore: BlobStore;
}

export interface FramePatchRepresentResult {
  frameCount: number;
  embeddedCount: number;
  namespace: string;
}

export class FramePatchRepresenter {
  private readonly patchEmbedder: MultiVectorProvider;
  private readonly blobStore: BlobStore;
  readonly namespace: string;

  constructor(
    private readonly store: Store,
    opts: FramePatchRepresenterOptions,
  ) {
    this.patchEmbedder = opts.patchEmbedder;
    this.blobStore = opts.blobStore;
    this.namespace = namespaceFor("frame_patches", this.patchEmbedder);
  }

  async represent(sessionId: string): Promise<FramePatchRepresentResult> {
    await this.store.registerVectorSpace({
      namespace: this.namespace,
      view: "frame_patches",
      providerId: this.patchEmbedder.id,
      model: this.patchEmbedder.model,
      dimensions: this.patchEmbedder.dimensions,
      sharedTextSpace: true, // one model embeds both images and queries
    });

    const frames = this.store.getFramesBySession(sessionId);
    const segments = this.store.getSegmentsBySession(sessionId);
    const rows: FramePatchInsert[] = [];

    for (const frame of frames) {
      if (!frame.blobId) continue; // no keyframe bytes — nothing to embed
      const blob = this.store.getBlob(frame.blobId);
      if (!blob) continue;
      const bytes = await this.blobStore.read(blob);
      const [patches] = await this.patchEmbedder.embedImages([bytes]);
      if (!patches || patches.length === 0) continue; // never write an empty row

      const segmentIds = segments
        .filter((s) => frame.tMono >= s.tMonoStart && frame.tMono <= s.tMonoEnd)
        .map((s) => s.id);

      rows.push({
        frameId: frame.id,
        sessionId,
        segmentIds,
        namespace: this.namespace,
        patches,
      });
    }

    if (rows.length > 0) await this.store.putFramePatches(rows);
    return {
      frameCount: frames.length,
      embeddedCount: rows.length,
      namespace: this.namespace,
    };
  }
}
```

- [ ] **Step 4: Make the write idempotent**

`putFramePatches` appends, so a second pass would duplicate. In `DualStore.putFramePatches`, delete existing rows for the incoming ids before adding:

```ts
      for (const [ns, batch] of byNamespace) {
        await this.lance.deleteByIds(ns, batch.map((r) => r.id));
        await this.lance.addPatches(ns, batch);
        await this.lance.ensurePatchIndex(ns);
      }
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/frame-patches.test.ts test/dual-store.patches.test.ts && npm run typecheck`
Expected: PASS, all four new cases including idempotency.

- [ ] **Step 6: Export from the barrel and commit**

Add to `src/index.ts` beside the other representers (no native code, so it belongs in the barrel):

```ts
export {
  FramePatchRepresenter,
  type FramePatchRepresenterOptions,
  type FramePatchRepresentResult,
} from "./represent/frame-patch-representer.js";
```

```bash
git add src/represent/frame-patch-representer.ts src/store/store.ts src/index.ts test/frame-patches.test.ts
git commit -m "feat(represent): FramePatchRepresenter writes the frame_patches view"
```

---

### Task 10: Tier-2 multivector retrieval and MaxSim highlights

**Files:**
- Create: `src/retrieve/tier2-mv.ts`
- Modify: `src/retrieve/assemble.ts`
- Modify: `src/index.ts`
- Test: `test/tier2-mv.test.ts`

**Interfaces:**
- Consumes: `MultiVectorProvider` (Task 1), `searchFramePatches` (Task 6), `patchIndexToBox`/`computeTileGeometry` (Task 7)
- Produces:
  - `Tier2MultiVectorOptions { topN?: number; hydrate?: boolean; maxHighlights?: number }`
  - `class Tier2MultiVectorRetriever` with `readonly namespace`, `retrieveFrames(query, segmentIds): Promise<FrameHit[]>`, `retrieveFramesUnscoped(query): Promise<FrameHit[]>`, `highlightsFor(frameId, queryVectors, patches, width, height): RegionHit[]`
  - `RetrieverOptions` gains `patchEmbedder?: MultiVectorProvider`

**Behaviour difference from Tier 2 single-vector:** this path serves **text** queries as well as image queries, because ColSmol embeds both into one space. `Tier2Retriever` only fires on `query.image`.

Highlights come from the MaxSim argmax: for each query vector, the best-matching patch index maps through `patchIndexToBox` to a frame-space box. `matchedBy` is `["ann"]`, `regionId` is synthetic (`<frameId>#p<index>`) since no `regions` row backs it, and `role`/`label` are null — AX-label FTS still supplies real labels alongside.

- [ ] **Step 1: Write the failing test**

Create `test/tier2-mv.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { Tier2MultiVectorRetriever } from "../src/retrieve/tier2-mv.js";
import { FakeMultiVectorProvider } from "../src/embed/fake.js";
import { computeTileGeometry } from "../src/embed/onnx/geometry.js";

const provider = new FakeMultiVectorProvider(16, 3);

let dir: string;
let store: DualStore;
let sessionId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "t2mv-"));
  store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
  sessionId = ulid();
  await store.putSession({ id: sessionId, startedAt: Date.now() });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seed(): Promise<Tier2MultiVectorRetriever> {
  const t2 = new Tier2MultiVectorRetriever(store, provider, { topN: 10 });
  await store.registerVectorSpace({
    namespace: t2.namespace,
    view: "frame_patches",
    providerId: provider.id,
    model: provider.model,
    dimensions: provider.dimensions,
    sharedTextSpace: true,
  });
  await store.putFrames([
    { id: "f1", sessionId, tMono: 100, width: 1280, height: 800, phash: 0n, blobId: null },
    { id: "f2", sessionId, tMono: 200, width: 1280, height: 800, phash: 0n, blobId: null },
  ]);
  const [pa, pb] = await provider.embedImages([
    Uint8Array.from([1, 2, 3]),
    Uint8Array.from([9, 9, 9]),
  ]);
  await store.putFramePatches([
    { frameId: "f1", sessionId, segmentIds: ["segA"], namespace: t2.namespace, patches: pa! },
    { frameId: "f2", sessionId, segmentIds: ["segB"], namespace: t2.namespace, patches: pb! },
  ]);
  return t2;
}

describe("Tier2MultiVectorRetriever", () => {
  it("serves an IMAGE query", async () => {
    const t2 = await seed();
    const hits = await t2.retrieveFramesUnscoped({ image: Uint8Array.from([9, 9, 9]) });
    expect(hits[0]!.frameId).toBe("f2");
  });

  it("serves a TEXT query — the single-vector tier cannot", async () => {
    const t2 = await seed();
    const hits = await t2.retrieveFramesUnscoped({ text: "anything" });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("scopes to the Tier-1 segments", async () => {
    const t2 = await seed();
    const hits = await t2.retrieveFrames({ image: Uint8Array.from([9, 9, 9]) }, ["segA"]);
    expect(hits.map((h) => h.frameId)).toEqual(["f1"]);
  });

  it("returns [] for a query with neither text nor image", async () => {
    const t2 = await seed();
    expect(await t2.retrieveFramesUnscoped({})).toEqual([]);
  });

  it("returns [] for an empty scope rather than widening", async () => {
    const t2 = await seed();
    expect(await t2.retrieveFrames({ image: Uint8Array.from([1]) }, [])).toEqual([]);
  });

  it("derives one highlight per query vector from the MaxSim argmax", async () => {
    const t2 = await seed();
    const [patches] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    const [q] = await provider.embedQueries(["x"]);
    const hl = t2.highlightsFor("f1", q!, patches!, 1280, 800);
    expect(hl.length).toBeGreaterThan(0);
    expect(hl.length).toBeLessThanOrEqual(q!.length);
    for (const h of hl) {
      expect(h.frameId).toBe("f1");
      expect(h.matchedBy).toEqual(["ann"]);
      expect(h.regionId).toMatch(/^f1#p\d+$/);
      expect(h.bbox.x + h.bbox.w).toBeLessThanOrEqual(1280);
      expect(h.bbox.y + h.bbox.h).toBeLessThanOrEqual(800);
    }
  });

  it("dedupes highlights when several query vectors hit the same patch", async () => {
    const t2 = await seed();
    const [patches] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    const q = [patches![0]!, patches![0]!, patches![0]!]; // all argmax to patch 0
    const hl = t2.highlightsFor("f1", q, patches!, 1280, 800);
    expect(hl.length).toBe(1);
  });

  it("caps highlights at maxHighlights", async () => {
    const t2 = new Tier2MultiVectorRetriever(store, provider, { maxHighlights: 1 });
    const geo = computeTileGeometry(1280, 800);
    expect(geo.tokensPerTile).toBe(64); // guards the geometry assumption
    const [patches] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    const [q] = await provider.embedQueries(["x"]);
    expect(t2.highlightsFor("f1", q!, patches!, 1280, 800).length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tier2-mv.test.ts`
Expected: FAIL — cannot resolve `../src/retrieve/tier2-mv.js`.

- [ ] **Step 3: Write the implementation**

Create `src/retrieve/tier2-mv.ts`:

```ts
/**
 * Tier-2 over the late-interaction `frame_patches` space.
 *
 * Differs from Tier2Retriever in two ways that matter:
 *  - it serves TEXT queries as well as image queries, because ColSmol embeds both
 *    into one space, so a text query reaches frames directly;
 *  - highlights fall out of the MaxSim argmax instead of a separate region ANN —
 *    the patches ARE the regions.
 *
 * Barrel-safe: the provider is injected, so no native module loads here.
 */

import type { MultiVectorProvider } from "../embed/types.js";
import { namespaceFor } from "../embed/types.js";
import { computeTileGeometry, patchIndexToBox } from "../embed/onnx/geometry.js";
import type { Store } from "../store/types.js";
import type { FrameHit, Query, RegionHit } from "./types.js";

export interface Tier2MultiVectorOptions {
  topN?: number;
  hydrate?: boolean;
  /** Upper bound on highlight boxes per frame. */
  maxHighlights?: number;
}

export class Tier2MultiVectorRetriever {
  readonly namespace: string;
  private readonly topN: number;
  private readonly hydrate: boolean;
  private readonly maxHighlights: number;

  constructor(
    private readonly store: Store,
    private readonly provider: MultiVectorProvider,
    opts: Tier2MultiVectorOptions = {},
  ) {
    this.namespace = namespaceFor("frame_patches", provider);
    this.topN = opts.topN ?? 30;
    this.hydrate = opts.hydrate ?? true;
    this.maxHighlights = opts.maxHighlights ?? 8;
  }

  /** Query vectors for either modality, or null when the query carries neither. */
  private async queryVectors(q: Query): Promise<Float32Array[] | null> {
    if (q.image) {
      const [v] = await this.provider.embedImages([q.image]);
      return v ?? null;
    }
    if (q.text && q.text.length > 0) {
      const [v] = await this.provider.embedQueries([q.text]);
      return v ?? null;
    }
    return null;
  }

  async retrieveFrames(query: Query, segmentIds: string[]): Promise<FrameHit[]> {
    if (segmentIds.length === 0) return [];
    const vecs = await this.queryVectors(query);
    if (!vecs) return [];
    const hits = await this.store.searchFramePatches(this.namespace, vecs, this.topN, {
      segmentIds,
    });
    return this.hydrateHits(hits);
  }

  async retrieveFramesUnscoped(query: Query): Promise<FrameHit[]> {
    const vecs = await this.queryVectors(query);
    if (!vecs) return [];
    const hits = await this.store.searchFramePatches(this.namespace, vecs, this.topN);
    return this.hydrateHits(hits);
  }

  /**
   * Highlight boxes from the MaxSim argmax: for each query vector, the
   * best-matching patch, mapped to frame coordinates. Deduped by patch index and
   * capped, ordered best-first.
   */
  highlightsFor(
    frameId: string,
    queryVectors: Float32Array[],
    patches: Float32Array[],
    width: number,
    height: number,
  ): RegionHit[] {
    const geo = computeTileGeometry(width, height);
    const best = new Map<number, number>(); // patch index -> best similarity

    for (const q of queryVectors) {
      let argmax = -1;
      let top = -Infinity;
      for (let p = 0; p < patches.length; p++) {
        const sim = dot(q, patches[p]!);
        if (sim > top) {
          top = sim;
          argmax = p;
        }
      }
      if (argmax < 0) continue;
      const prev = best.get(argmax);
      if (prev === undefined || top > prev) best.set(argmax, top);
    }

    return [...best.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.maxHighlights)
      .flatMap(([index, sim]) => {
        const bbox = patchIndexToBox(index, geo);
        if (!bbox) return [];
        return [
          {
            // Synthetic: no `regions` row backs a patch. AX-label FTS still
            // contributes real, labelled regions alongside these.
            regionId: `${frameId}#p${index}`,
            frameId,
            bbox,
            role: null,
            label: null,
            matchedBy: ["ann"] as ("ann" | "fts")[],
            distance: 1 - sim,
          } satisfies RegionHit,
        ];
      });
  }

  private hydrateHits(hits: { id: string; distance: number }[]): FrameHit[] {
    return hits.map((h) => {
      const frame = this.hydrate ? this.store.getFrame(h.id) : undefined;
      return { frameId: h.id, distance: h.distance, ...(frame ? { frame } : {}) };
    });
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let n = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) n += a[i]! * b[i]!;
  return n;
}
```

- [ ] **Step 4: Run the tier-2 tests**

Run: `npx vitest run test/tier2-mv.test.ts && npm run typecheck`
Expected: PASS, all eight cases.

- [ ] **Step 5: Dispatch from `assemble.ts`**

Add `patchEmbedder?: MultiVectorProvider` to `RetrieverOptions`. In the `Retriever` constructor, build a `Tier2MultiVectorRetriever` when it is present and prefer it over the single-vector `Tier2Retriever`; keep the existing path otherwise. The two never run together — selection is by which provider was configured.

Where the existing flow calls Tier 2 then Tier 3, the multivector branch calls `retrieveFrames`/`retrieveFramesUnscoped` and derives highlights from `highlightsFor`, then merges them with the AX-label FTS hits exactly as the single-vector branch merges ANN and FTS region hits. Do **not** run the region-image tier on the multivector branch — there is no `region_image` space in a local-only configuration.

Because `highlightsFor` needs the frame's stored patch vectors, add a store read for them, or recompute by re-embedding the frame's keyframe. Prefer reading: add `getFramePatches(namespace, frameId): Promise<Float32Array[] | null>` to `LanceStore`/`DualStore` (a `query().where("id = '<id>'").select(["patches"])`), so a search never re-runs the model.

- [ ] **Step 6: Extend `test/assemble.test.ts`**

Add a case building a `Retriever` with `patchEmbedder: new FakeMultiVectorProvider(16, 3)` and no `imageEmbedder`, asserting that a text query returns frames with non-empty `highlights` whose `regionId` matches `/#p\d+$/`.

Run: `npx vitest run test/assemble.test.ts`
Expected: PASS.

- [ ] **Step 7: Export and commit**

```ts
export {
  Tier2MultiVectorRetriever,
  type Tier2MultiVectorOptions,
} from "./retrieve/tier2-mv.js";
```

```bash
git add src/retrieve/tier2-mv.ts src/retrieve/assemble.ts src/store/store.ts src/store/lance/tables.ts src/index.ts test/tier2-mv.test.ts test/assemble.test.ts
git commit -m "feat(retrieve): Tier-2 multivector retrieval with MaxSim-derived highlights"
```

---

### Task 11: TextViewSearcher passes the query role

**Files:**
- Modify: `src/retrieve/searchers.ts`
- Test: `test/retrieve.test.ts` (extend)

**Interfaces:**
- Consumes: `EmbedOptions` (Task 1)
- Produces: no signature change — `TextViewSearcher.queryVector` now calls `embed(text, { role: "query" })`

This is small but load-bearing: with the prefix on documents only, every query would land in a subtly different region of the space and retrieval would degrade silently.

- [ ] **Step 1: Write the failing test**

Append to `test/retrieve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TextViewSearcher } from "../src/retrieve/searchers.js";
import type { EmbedOptions, EmbeddingProvider } from "../src/embed/types.js";

describe("TextViewSearcher role", () => {
  it("embeds the query with role=query, not the document default", async () => {
    const seen: (EmbedOptions | undefined)[] = [];
    const probe: EmbeddingProvider = {
      id: "probe",
      model: "probe",
      dimensions: 4,
      async embed(inputs, opts) {
        seen.push(opts);
        return inputs.map(() => Float32Array.from([1, 0, 0, 0]));
      },
    };
    await new TextViewSearcher(probe, "digest").queryVector({ text: "hello" });
    expect(seen[0]).toEqual({ role: "query" });
  });

  it("does not embed at all for an empty query", async () => {
    const seen: unknown[] = [];
    const probe: EmbeddingProvider = {
      id: "probe",
      model: "probe",
      dimensions: 4,
      async embed(inputs) {
        seen.push(inputs);
        return [];
      },
    };
    expect(await new TextViewSearcher(probe, "digest").queryVector({})).toBeNull();
    expect(seen.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/retrieve.test.ts -t "role=query"`
Expected: FAIL — `seen[0]` is `undefined`.

- [ ] **Step 3: Make the change**

In `src/retrieve/searchers.ts`:

```ts
  async queryVector(q: Query): Promise<Float32Array | null> {
    if (q.text === undefined || q.text.length === 0) return null;
    // Asymmetric embedding: documents were embedded with role "document", so a
    // query must say so or it lands in a different part of the space.
    const [vec] = await this.embedder.embed([q.text], { role: "query" });
    return vec ?? null;
  }
```

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS. The fake embedder ignores `opts`, so the exact-match placements the existing retrieval tests rely on are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/retrieve/searchers.ts test/retrieve.test.ts
git commit -m "feat(retrieve): TextViewSearcher embeds with role=query"
```

---

### Task 12: OnnxCrossEncoderReranker

**Files:**
- Create: `src/retrieve/rerank/onnx.ts`
- Test: `test/rerank.onnx.test.ts`

**Interfaces:**
- Consumes: `OnnxRuntime`, `OnnxSession`, `makeTensor` (Task 3); `Reranker`, `RerankCandidate` (existing)
- Produces:
  - `OnnxCrossEncoderReranker implements Reranker`
  - Constructor: `new OnnxCrossEncoderReranker({ modelPath, tokenizerPath, maxTokens?, batchSize?, session?, tokenizePair? })`

A cross-encoder scores each `(query, candidate)` pair in one forward pass and sorts by score. It fits the existing `rerank(query, candidates) => string[]` signature with no interface change. Default model is `jina-reranker-v1-turbo-en` (37.8M, Apache-2.0) — note that its v2 and m0 successors are **CC-BY-NC-4.0**, so do not "upgrade" without re-checking the licence.

Failure must degrade, not throw: Tier 4 is a refinement, so any error falls back to input order exactly as `LLMReranker` does at `src/retrieve/rerank/llm.ts:63`.

- [ ] **Step 1: Write the failing test**

Create `test/rerank.onnx.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OnnxCrossEncoderReranker } from "../src/retrieve/rerank/onnx.js";
import type { OnnxSession } from "../src/embed/onnx/runtime.js";

/** Scores each pair by a caller-supplied table, in batch order. */
function stubSession(scores: number[]): OnnxSession {
  let cursor = 0;
  return {
    async run(feeds) {
      const [batch] = feeds.input_ids!.dims as [number, number];
      const out = scores.slice(cursor, cursor + batch);
      cursor += batch;
      return { logits: { data: Float32Array.from(out), dims: [batch, 1] } };
    },
  };
}

const opts = (session: OnnxSession) => ({
  modelPath: "/unused",
  tokenizerPath: "/unused",
  session,
  tokenizePair: (q: string, d: string) => ({ ids: [q.length, d.length], typeIds: [0, 1] }),
});

const candidates = [
  { id: "a", text: "unrelated" },
  { id: "b", text: "the login form" },
  { id: "c", text: "also unrelated" },
];

describe("OnnxCrossEncoderReranker", () => {
  it("orders by descending score", async () => {
    const r = new OnnxCrossEncoderReranker(opts(stubSession([0.1, 0.9, 0.2])));
    expect(await r.rerank("login", candidates)).toEqual(["b", "c", "a"]);
  });

  it("returns [] for no candidates without touching the session", async () => {
    let ran = false;
    const r = new OnnxCrossEncoderReranker(
      opts({ async run() { ran = true; return {}; } }),
    );
    expect(await r.rerank("q", [])).toEqual([]);
    expect(ran).toBe(false);
  });

  it("returns every id exactly once", async () => {
    const r = new OnnxCrossEncoderReranker(opts(stubSession([0.5, 0.5, 0.5])));
    const out = await r.rerank("q", candidates);
    expect([...out].sort()).toEqual(["a", "b", "c"]);
  });

  it("falls back to input order when the session throws", async () => {
    const r = new OnnxCrossEncoderReranker(
      opts({ async run() { throw new Error("boom"); } }),
    );
    expect(await r.rerank("q", candidates)).toEqual(["a", "b", "c"]);
  });

  it("batches without losing or reordering candidates", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, text: `t${i}` }));
    // ascending scores -> reversed output
    const r = new OnnxCrossEncoderReranker({
      ...opts(stubSession(many.map((_, i) => i))),
      batchSize: 3,
    });
    const out = await r.rerank("q", many);
    expect(out[0]).toBe("c9");
    expect(out.length).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rerank.onnx.test.ts`
Expected: FAIL — cannot resolve `../src/retrieve/rerank/onnx.js`.

- [ ] **Step 3: Write the implementation**

Create `src/retrieve/rerank/onnx.ts`:

```ts
/**
 * Local Tier-4 reranker: a cross-encoder scoring each (query, candidate) pair in
 * one forward pass. Replaces the Claude call with a 37.8M-param model.
 *
 * NOT in the package barrel — loads onnxruntime-node. Import from this path.
 *
 * Default weights: jina-reranker-v1-turbo-en (Apache-2.0). Its v2 and m0
 * successors are CC-BY-NC-4.0 — do not "upgrade" without re-checking.
 *
 * Tier 4 is a refinement, never load-bearing, so every failure path returns the
 * input order rather than throwing — matching LLMReranker.
 */

import { makeTensor, OnnxRuntime, type OnnxSession } from "../../embed/onnx/runtime.js";
import type { Reranker, RerankCandidate } from "./types.js";

export interface TokenizedPair {
  ids: number[];
  typeIds: number[];
}

export interface OnnxRerankerOptions {
  modelPath: string;
  tokenizerPath: string;
  maxTokens?: number;
  batchSize?: number;
  session?: OnnxSession;
  tokenizePair?: (query: string, doc: string) => TokenizedPair;
}

export class OnnxCrossEncoderReranker implements Reranker {
  private readonly modelPath: string;
  private readonly tokenizerPath: string;
  private readonly maxTokens: number;
  private readonly batchSize: number;
  private readonly injectedSession: OnnxSession | undefined;
  private readonly injectedTokenize: OnnxRerankerOptions["tokenizePair"];
  private tokenizer: Promise<(q: string, d: string) => TokenizedPair> | undefined;

  constructor(opts: OnnxRerankerOptions) {
    this.modelPath = opts.modelPath;
    this.tokenizerPath = opts.tokenizerPath;
    this.maxTokens = opts.maxTokens ?? 512;
    this.batchSize = opts.batchSize ?? 16;
    this.injectedSession = opts.session;
    this.injectedTokenize = opts.tokenizePair;
  }

  private session(): Promise<OnnxSession> {
    return this.injectedSession
      ? Promise.resolve(this.injectedSession)
      : OnnxRuntime.session(this.modelPath);
  }

  private async tokenize(): Promise<(q: string, d: string) => TokenizedPair> {
    if (this.injectedTokenize) return this.injectedTokenize;
    this.tokenizer ??= (async () => {
      const { Tokenizer } = (await import(
        /* @vite-ignore */ "@huggingface/tokenizers"
      )) as {
        Tokenizer: {
          fromFile(p: string): Promise<{
            encode(a: string, b?: string): { ids: number[]; typeIds?: number[] };
          }>;
        };
      };
      const tok = await Tokenizer.fromFile(this.tokenizerPath);
      return (q: string, d: string) => {
        const e = tok.encode(q, d);
        return { ids: e.ids, typeIds: e.typeIds ?? e.ids.map(() => 0) };
      };
    })();
    return this.tokenizer;
  }

  async rerank(query: string, candidates: RerankCandidate[]): Promise<string[]> {
    if (candidates.length === 0) return [];
    try {
      const tokenize = await this.tokenize();
      const sess = await this.session();
      const scores: number[] = [];

      for (let start = 0; start < candidates.length; start += this.batchSize) {
        const slice = candidates.slice(start, start + this.batchSize);
        const encoded = slice.map((c) => {
          const e = tokenize(query, c.text);
          return {
            ids: e.ids.slice(0, this.maxTokens),
            typeIds: e.typeIds.slice(0, this.maxTokens),
          };
        });
        const seq = Math.max(1, ...encoded.map((e) => e.ids.length));
        const batch = encoded.length;
        const ids = new BigInt64Array(batch * seq);
        const mask = new BigInt64Array(batch * seq);
        const types = new BigInt64Array(batch * seq);
        for (let b = 0; b < batch; b++) {
          const e = encoded[b]!;
          for (let t = 0; t < seq; t++) {
            const present = t < e.ids.length;
            ids[b * seq + t] = BigInt(present ? e.ids[t]! : 0);
            mask[b * seq + t] = BigInt(present ? 1 : 0);
            types[b * seq + t] = BigInt(present ? e.typeIds[t]! : 0);
          }
        }
        const out = await sess.run({
          input_ids: makeTensor("int64", ids, [batch, seq]),
          attention_mask: makeTensor("int64", mask, [batch, seq]),
          token_type_ids: makeTensor("int64", types, [batch, seq]),
        });
        const logits = (out.logits ?? Object.values(out)[0]!) as { data: Float32Array };
        for (let b = 0; b < batch; b++) scores.push(logits.data[b] ?? 0);
      }

      return candidates
        .map((c, i) => ({ id: c.id, score: scores[i] ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.id);
    } catch {
      return candidates.map((c) => c.id); // fall back to input order
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/rerank.onnx.test.ts test/rerank.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Confirm the barrel excludes it**

Run: `grep -n "rerank/onnx" src/index.ts`
Expected: no output — it loads `onnxruntime-node`.

- [ ] **Step 6: Commit**

```bash
git add src/retrieve/rerank/onnx.ts test/rerank.onnx.test.ts
git commit -m "feat(retrieve): local ONNX cross-encoder reranker for Tier 4"
```

---

### Task 13: OllamaCaptionProvider

**Files:**
- Create: `src/represent/caption/ollama.ts`
- Modify: `src/index.ts`
- Test: `test/caption.ollama.test.ts`

**Interfaces:**
- Consumes: `CaptionProvider` (existing), `CAPTION_SYSTEM`/`captionPrompt` from `src/represent/caption/prompt.js`
- Produces:
  - `OllamaCaptionProvider implements CaptionProvider`
  - Constructor: `new OllamaCaptionProvider({ host?, model?, fetchImpl? })`
  - `listVisionModels(host: string, fetchImpl?): Promise<string[]>` — local, vision-capable models from `/api/tags`

**This one IS barrel-safe** — plain `fetch`, no native module — so it exports from `src/index.ts` alongside the Anthropic and Gemini captioners.

**Security-relevant:** `listVisionModels` reads `/api/tags`, which returns only models resident on disk. That is deliberate. Ollama's *library* now includes cloud-hosted models (`gemini-3-flash-preview`, the `kimi-k2.*` family); a hardcoded list would let a user select one and route screenshots off the machine through the setting meant to keep them on it.

Captions must degrade, not throw: a missing caption is one view lacking a vector for one segment, which `reconcileAndReembed` can fill later.

- [ ] **Step 1: Write the failing test**

Create `test/caption.ollama.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OllamaCaptionProvider, listVisionModels } from "../src/represent/caption/ollama.js";

type FetchImpl = typeof globalThis.fetch;

const ok = (body: unknown): FetchImpl =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as FetchImpl;

describe("OllamaCaptionProvider", () => {
  it("posts base64 images to /api/chat and returns the message content", async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ message: { content: "  a login screen  " } }), {
        status: 200,
      });
    }) as FetchImpl;

    const p = new OllamaCaptionProvider({ host: "http://h:1", model: "qwen3-vl:4b", fetchImpl });
    const out = await p.caption([Uint8Array.from([1, 2, 3])], "context");

    expect(out).toBe("a login screen");
    expect(seen!.url).toBe("http://h:1/api/chat");
    expect(seen!.body.model).toBe("qwen3-vl:4b");
    expect(seen!.body.stream).toBe(false);
    const messages = seen!.body.messages as { role: string; images?: string[] }[];
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.images).toEqual([Buffer.from([1, 2, 3]).toString("base64")]);
  });

  it("returns empty string when the daemon is down, rather than throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as FetchImpl;
    const p = new OllamaCaptionProvider({ fetchImpl });
    expect(await p.caption([Uint8Array.from([1])])).toBe("");
  });

  it("returns empty string on a non-200, e.g. a deleted model", async () => {
    const fetchImpl = (async () => new Response("model not found", { status: 404 })) as FetchImpl;
    const p = new OllamaCaptionProvider({ fetchImpl });
    expect(await p.caption([Uint8Array.from([1])])).toBe("");
  });

  it("returns empty string for no frames without calling the daemon", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as FetchImpl;
    expect(await new OllamaCaptionProvider({ fetchImpl }).caption([])).toBe("");
    expect(called).toBe(false);
  });
});

describe("listVisionModels", () => {
  it("returns only locally-resident vision-capable models", async () => {
    const fetchImpl = ok({
      models: [
        { name: "nomic-embed-text:latest", capabilities: ["embedding"] },
        { name: "qwen3-vl:4b", capabilities: ["completion", "vision"] },
        { name: "llama3:8b", capabilities: ["completion"] },
        { name: "minicpm-v4.6:latest", capabilities: ["vision"] },
      ],
    });
    expect(await listVisionModels("http://h:1", fetchImpl)).toEqual([
      "qwen3-vl:4b",
      "minicpm-v4.6:latest",
    ]);
  });

  it("returns [] when the daemon is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as FetchImpl;
    expect(await listVisionModels("http://h:1", fetchImpl)).toEqual([]);
  });

  it("tolerates entries with no capabilities array", async () => {
    const fetchImpl = ok({ models: [{ name: "mystery" }] });
    expect(await listVisionModels("http://h:1", fetchImpl)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/caption.ollama.test.ts`
Expected: FAIL — cannot resolve `../src/represent/caption/ollama.js`.

- [ ] **Step 3: Write the implementation**

Create `src/represent/caption/ollama.ts`:

```ts
/**
 * Local VLM captioning through Ollama's /api/chat, which accepts base64 images.
 *
 * Barrel-safe: plain fetch, no native module, so this DOES export from the
 * package barrel alongside the Anthropic and Gemini captioners.
 *
 * Best-effort by contract: a caption failure means one view lacks a vector for
 * one segment, which reconcileAndReembed can fill later. It must never fail the
 * represent pass, so every error path returns "".
 */

import type { CaptionProvider } from "../../embed/types.js";
import { CAPTION_SYSTEM, captionPrompt } from "./prompt.js";

export interface OllamaCaptionOptions {
  host?: string;
  model?: string;
  /** Injected fetch (tests). */
  fetchImpl?: typeof globalThis.fetch;
}

interface TagsResponse {
  models?: { name?: string; capabilities?: string[] }[];
}

/**
 * Locally-resident, vision-capable model names.
 *
 * Deliberately sourced from /api/tags rather than a hardcoded list: Ollama's
 * library now includes CLOUD-hosted models, and offering one in a "local"
 * settings dropdown would route screenshots off the machine invisibly. A model
 * that is not pulled locally cannot appear here.
 */
export async function listVisionModels(
  host: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[]> {
  try {
    const res = await fetchImpl(`${host}/api/tags`);
    if (!res.ok) return [];
    const json = (await res.json()) as TagsResponse;
    return (json.models ?? [])
      .filter((m) => Array.isArray(m.capabilities) && m.capabilities.includes("vision"))
      .map((m) => m.name ?? "")
      .filter((n) => n.length > 0);
  } catch {
    return [];
  }
}

export class OllamaCaptionProvider implements CaptionProvider {
  private readonly host: string;
  private readonly model: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OllamaCaptionOptions = {}) {
    this.host = opts.host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
    this.model = opts.model ?? "qwen3-vl:4b";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async caption(frames: Uint8Array[], context?: string): Promise<string> {
    if (frames.length === 0) return "";
    try {
      const res = await this.fetchImpl(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: "system", content: CAPTION_SYSTEM },
            {
              role: "user",
              content: captionPrompt(context),
              images: frames.map((f) => Buffer.from(f).toString("base64")),
            },
          ],
        }),
      });
      if (!res.ok) return "";
      const json = (await res.json()) as { message?: { content?: string } };
      return (json.message?.content ?? "").trim();
    } catch {
      return ""; // daemon down, model deleted, malformed response
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/caption.ollama.test.ts test/caption.test.ts && npm run typecheck`
Expected: PASS, all seven cases.

- [ ] **Step 5: Export from the barrel**

Add to `src/index.ts` beside the other captioners:

```ts
export {
  OllamaCaptionProvider,
  listVisionModels,
  type OllamaCaptionOptions,
} from "./represent/caption/ollama.js";
```

- [ ] **Step 6: Commit**

```bash
git add src/represent/caption/ollama.ts src/index.ts test/caption.ollama.test.ts
git commit -m "feat(caption): local Ollama VLM captioner with local-only model discovery"
```

---

### Task 14: App test harness, model manifest, and ModelStore

**Files:**
- Create: `app/vitest.config.ts`
- Create: `app/test/model-store.test.ts`
- Create: `app/src/main/models.ts`
- Create: `app/src/main/model-store.ts`
- Modify: `app/package.json`

**Interfaces:**
- Consumes: nothing from earlier tasks (app-side infrastructure)
- Produces:
  - `ModelSpec { id: string; repo: string; revision: string; files: { path: string; sha256: string; bytes: number }[] }`
  - `MODELS: Record<"text" | "colsmol" | "reranker", ModelSpec>`
  - `class ModelStore { constructor(dir: string, opts?: { overrideDir?: string; fetchImpl?; onProgress? }); ensure(spec: ModelSpec): Promise<string> }`
  - `ModelDownloadProgress { modelId: string; receivedBytes: number; totalBytes: number; done: boolean }`

**The app currently has no test runner.** The spec requires CI-safe `ModelStore` tests, so this task adds vitest to `app/` as well as the code.

- [ ] **Step 1: Add vitest to the app**

Add to `app/package.json` `devDependencies`: `"vitest": "^3.2.4"` (match the root's version — check with `node -p "require('./package.json').devDependencies.vitest"`).

Add to `app/package.json` `scripts`:

```json
"test": "vitest run"
```

Create `app/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      // Main-process modules import electron; stub it so pure logic is testable.
      electron: resolve(__dirname, "test/stubs/electron.ts"),
    },
  },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
```

Create `app/test/stubs/electron.ts`:

```ts
/** Minimal electron stub so main-process modules can be unit-tested under Node. */
let encryptionAvailable = true;
export const safeStorage = {
  isEncryptionAvailable: () => encryptionAvailable,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
};
export const app = { getPath: () => "/tmp/deskrag-test" };
/** Test hook: simulate a machine with no keychain. */
export function __setEncryptionAvailable(v: boolean): void {
  encryptionAvailable = v;
}
```

Run: `npm --prefix app install`

- [ ] **Step 2: Write the failing test**

Create `app/test/model-store.test.ts`:

```ts
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelStore } from "../src/main/model-store.js";
import type { ModelSpec } from "../src/main/models.js";

const BODY = Buffer.from("weights-bytes");
const SHA = createHash("sha256").update(BODY).digest("hex");

let server: Server;
let base: string;
let dir: string;
let served = 0;

beforeEach(async () => {
  served = 0;
  dir = mkdtempSync(join(tmpdir(), "ms-"));
  server = createServer((req, res) => {
    served++;
    if (req.url?.includes("missing")) {
      res.writeHead(404).end("nope");
      return;
    }
    res.writeHead(200, { "content-length": String(BODY.length) }).end(BODY);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const spec = (sha = SHA, path = "onnx/model.onnx"): ModelSpec => ({
  id: "test-model",
  repo: "org/repo",
  revision: "abc123",
  files: [{ path, sha256: sha, bytes: BODY.length }],
});

describe("ModelStore.ensure", () => {
  it("downloads, verifies, and returns the local directory", async () => {
    const store = new ModelStore(dir, { baseUrl: base });
    const out = await store.ensure(spec());
    expect(out).toBe(join(dir, "test-model"));
    expect(readFileSync(join(out, "model.onnx")).toString()).toBe(BODY.toString());
  });

  it("does not re-download when the file is already present", async () => {
    const store = new ModelStore(dir, { baseUrl: base });
    await store.ensure(spec());
    const after = served;
    await store.ensure(spec());
    expect(served).toBe(after);
  });

  it("deletes the file and throws on a checksum mismatch", async () => {
    const store = new ModelStore(dir, { baseUrl: base });
    await expect(store.ensure(spec("0".repeat(64)))).rejects.toThrow(/checksum/i);
    expect(existsSync(join(dir, "test-model", "model.onnx"))).toBe(false);
  });

  it("leaves no .partial file behind after a failed download", async () => {
    const store = new ModelStore(dir, { baseUrl: base });
    await expect(store.ensure(spec(SHA, "missing.onnx"))).rejects.toThrow();
    expect(existsSync(join(dir, "test-model", "missing.onnx.partial"))).toBe(false);
    expect(existsSync(join(dir, "test-model", "missing.onnx"))).toBe(false);
  });

  it("uses overrideDir and skips download and verification entirely", async () => {
    const over = mkdtempSync(join(tmpdir(), "over-"));
    mkdirSync(join(over, "test-model"), { recursive: true });
    writeFileSync(join(over, "test-model", "model.onnx"), "hand-curated");
    const store = new ModelStore(dir, { baseUrl: base, overrideDir: over });
    const out = await store.ensure(spec("0".repeat(64))); // wrong sha, ignored
    expect(out).toBe(join(over, "test-model"));
    expect(served).toBe(0);
    rmSync(over, { recursive: true, force: true });
  });

  it("reports progress and a final done event", async () => {
    const events: { modelId: string; receivedBytes: number; done: boolean }[] = [];
    const store = new ModelStore(dir, { baseUrl: base, onProgress: (p) => events.push(p) });
    await store.ensure(spec());
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)!.done).toBe(true);
    expect(events.at(-1)!.modelId).toBe("test-model");
  });

  it("builds the pinned-revision URL, never a branch", async () => {
    const urls: string[] = [];
    const store = new ModelStore(dir, {
      baseUrl: base,
      fetchImpl: (async (u: string) => {
        urls.push(String(u));
        return new Response(BODY, { status: 200 });
      }) as typeof fetch,
    });
    await store.ensure(spec());
    expect(urls[0]).toContain("/org/repo/resolve/abc123/onnx/model.onnx");
    expect(urls[0]).not.toContain("/main/");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix app test`
Expected: FAIL — cannot resolve `../src/main/model-store.js`.

- [ ] **Step 4: Write the manifest**

Create `app/src/main/models.ts`:

```ts
/**
 * Pinned model manifest. Acquisition policy lives in the app, never the library —
 * `deskrag` is published to npm and must not fetch anything.
 *
 * `revision` is a commit SHA, never a branch. If `main` moved, the weights would
 * change while the namespace kept claiming the same model, and vectors would
 * silently stop being comparable to those already in that Lance table.
 *
 * TO FILL AT IMPLEMENTATION TIME — capture with:
 *   curl -sI https://huggingface.co/<repo>/resolve/main/<file> | grep -i etag
 *   curl -sL <url> | shasum -a 256
 * Record the resolved commit SHA from the HF API:
 *   curl -s https://huggingface.co/api/models/<repo> | python3 -c "import sys,json;print(json.load(sys.stdin)['sha'])"
 */

export interface ModelSpec {
  id: string;
  repo: string;
  /** Commit SHA — never "main". */
  revision: string;
  files: { path: string; sha256: string; bytes: number }[];
}

export const MODELS = {
  text: {
    id: "nomic-embed-text-v1.5",
    repo: "nomic-ai/nomic-embed-text-v1.5",
    revision: "<COMMIT_SHA>",
    files: [
      { path: "onnx/model_int8.onnx", sha256: "<SHA256>", bytes: 0 },
      { path: "tokenizer.json", sha256: "<SHA256>", bytes: 0 },
    ],
  },
  colsmol: {
    id: "colSmol-256M",
    repo: "onnx-community/colSmol-256M-ONNX",
    revision: "<COMMIT_SHA>",
    files: [
      { path: "onnx/model.onnx", sha256: "<SHA256>", bytes: 0 },
      { path: "tokenizer.json", sha256: "<SHA256>", bytes: 0 },
      { path: "preprocessor_config.json", sha256: "<SHA256>", bytes: 0 },
      { path: "config.json", sha256: "<SHA256>", bytes: 0 },
    ],
  },
  reranker: {
    id: "jina-reranker-v1-turbo-en",
    repo: "jinaai/jina-reranker-v1-turbo-en",
    revision: "<COMMIT_SHA>",
    files: [
      { path: "onnx/model_int8.onnx", sha256: "<SHA256>", bytes: 0 },
      { path: "tokenizer.json", sha256: "<SHA256>", bytes: 0 },
    ],
  },
} satisfies Record<string, ModelSpec>;
```

The `<COMMIT_SHA>` and `<SHA256>` placeholders are the **only** ones in this plan, and they are unavoidable: they must be captured against the live repos at implementation time. Fill them in this step before proceeding — do not leave them.

- [ ] **Step 5: Write ModelStore**

Create `app/src/main/model-store.ts`:

```ts
/**
 * Downloads and verifies model weights into <userData>/DeskRAG/models/<id>/.
 *
 * Streams to <file>.partial, verifies SHA-256, then renames atomically — a
 * partial file never looks complete, so an interrupted download cannot poison a
 * namespace. Same discipline as reserveBlob/commitBlob in the library.
 *
 * On checksum mismatch it DELETES and THROWS. There is no fallback to an
 * unverified file: wrong weights produce vectors that are silently wrong while
 * sitting in a table claiming otherwise.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSpec } from "./models.js";

export interface ModelDownloadProgress {
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
}

export interface ModelStoreOptions {
  /** Air-gapped escape hatch: read from here, skip download AND verification. */
  overrideDir?: string;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  onProgress?: (p: ModelDownloadProgress) => void;
}

export class ModelStore {
  private readonly overrideDir: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly onProgress: ((p: ModelDownloadProgress) => void) | undefined;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly dir: string,
    opts: ModelStoreOptions = {},
  ) {
    this.overrideDir = opts.overrideDir && opts.overrideDir.length > 0 ? opts.overrideDir : undefined;
    this.baseUrl = opts.baseUrl ?? "https://huggingface.co";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.onProgress = opts.onProgress;
  }

  /** Local directory holding the spec's files, downloading them if needed. */
  ensure(spec: ModelSpec): Promise<string> {
    let p = this.inflight.get(spec.id);
    if (p) return p; // never two concurrent downloads of the same model
    p = this.ensureOnce(spec).finally(() => this.inflight.delete(spec.id));
    this.inflight.set(spec.id, p);
    return p;
  }

  private async ensureOnce(spec: ModelSpec): Promise<string> {
    if (this.overrideDir) return join(this.overrideDir, spec.id);

    const target = join(this.dir, spec.id);
    mkdirSync(target, { recursive: true });
    const total = spec.files.reduce((n, f) => n + f.bytes, 0);
    let received = 0;

    for (const file of spec.files) {
      const name = file.path.split("/").pop()!;
      const dest = join(target, name);
      if (existsSync(dest)) {
        received += file.bytes;
        this.onProgress?.({ modelId: spec.id, receivedBytes: received, totalBytes: total, done: false });
        continue;
      }
      const partial = `${dest}.partial`;
      const url = `${this.baseUrl}/${spec.repo}/resolve/${spec.revision}/${file.path}`;
      try {
        const res = await this.fetchImpl(url);
        if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        writeFileSync(partial, bytes);

        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== file.sha256) {
          rmSync(partial, { force: true });
          throw new Error(
            `checksum mismatch for ${spec.id}/${file.path}: expected ${file.sha256}, got ${actual}`,
          );
        }
        renameSync(partial, dest); // atomic: only now does it look complete
        received += bytes.length;
        this.onProgress?.({ modelId: spec.id, receivedBytes: received, totalBytes: total, done: false });
      } catch (err) {
        rmSync(partial, { force: true });
        throw err;
      }
    }

    this.onProgress?.({ modelId: spec.id, receivedBytes: total, totalBytes: total, done: true });
    return target;
  }

  /** Absolute path to one of a spec's files, by basename. */
  static file(dir: string, name: string): string {
    return join(dir, name);
  }
}
```

- [ ] **Step 6: Run the app tests**

Run: `npm --prefix app test`
Expected: PASS, all seven cases.

- [ ] **Step 7: Typecheck both packages**

Run: `npm run typecheck && npm --prefix app run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/package.json app/package-lock.json app/vitest.config.ts app/test/ app/src/main/models.ts app/src/main/model-store.ts
git commit -m "feat(app): pinned model manifest and verifying ModelStore, with app test harness"
```

---

### Task 15: Settings shape and rerank migration

**Files:**
- Modify: `app/src/shared/types.ts`
- Modify: `app/src/main/settings.ts`
- Create: `app/test/settings.test.ts`

**Interfaces:**
- Consumes: app test harness (Task 14)
- Produces:
  - `TextProvider = "ollama" | "onnx"`
  - `ImageProvider = "none" | "colsmol" | "voyage" | "gemini"`
  - `CaptionProvider = "none" | "ollama" | "anthropic" | "gemini"`
  - `RerankProvider = "none" | "onnx" | "anthropic"`
  - `ProviderSettingsView` gains `ollamaCaptionModel`, `textProvider`, `rerankProvider`, `localModels: { dir: string }`; loses `rerank: boolean`

**The one breaking on-disk change.** `SettingsStore.load()` spreads `{...DEFAULTS.providers, ...raw.providers}`, so a stale `rerank: true` would sit inert and silently disable a user's reranking. Migration must be explicit.

- [ ] **Step 1: Write the failing test**

Create `app/test/settings.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../src/main/settings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "set-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(providers: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ providers }), "utf8");
}

describe("SettingsStore defaults", () => {
  it("defaults to local-capable but not local-forced", () => {
    const p = new SettingsStore(dir).view().providers;
    expect(p.textProvider).toBe("ollama");
    expect(p.imageProvider).toBe("none");
    expect(p.captionProvider).toBe("none");
    expect(p.rerankProvider).toBe("none");
    expect(p.ollamaCaptionModel).toBe("qwen3-vl:4b");
    expect(p.localModels.dir).toBe("");
  });
});

describe("rerank -> rerankProvider migration", () => {
  it("maps legacy rerank:true to anthropic", () => {
    seed({ rerank: true });
    expect(new SettingsStore(dir).view().providers.rerankProvider).toBe("anthropic");
  });

  it("maps legacy rerank:false to none", () => {
    seed({ rerank: false });
    expect(new SettingsStore(dir).view().providers.rerankProvider).toBe("none");
  });

  it("prefers an explicit rerankProvider over the legacy flag", () => {
    seed({ rerank: true, rerankProvider: "onnx" });
    expect(new SettingsStore(dir).view().providers.rerankProvider).toBe("onnx");
  });

  it("drops the legacy key on the next persist", () => {
    seed({ rerank: true });
    const s = new SettingsStore(dir);
    s.apply({ providers: { textProvider: "onnx" } });
    const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as {
      providers: Record<string, unknown>;
    };
    expect(raw.providers.rerank).toBeUndefined();
    expect(raw.providers.rerankProvider).toBe("anthropic");
  });

  it("does not expose raw keys to the renderer view", () => {
    const v = new SettingsStore(dir).view();
    expect(v.providers.keys).toEqual({ voyage: false, gemini: false, anthropic: false });
  });
});

describe("apply", () => {
  it("round-trips the new provider fields", () => {
    const s = new SettingsStore(dir);
    const v = s.apply({
      providers: {
        textProvider: "onnx",
        imageProvider: "colsmol",
        captionProvider: "ollama",
        rerankProvider: "onnx",
        localModels: { dir: "/models" },
      },
    });
    expect(v.providers.textProvider).toBe("onnx");
    expect(v.providers.imageProvider).toBe("colsmol");
    expect(v.providers.localModels.dir).toBe("/models");
    // and survives a reload
    expect(new SettingsStore(dir).view().providers.imageProvider).toBe("colsmol");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix app test -- settings`
Expected: FAIL — `textProvider` is undefined.

- [ ] **Step 3: Update `app/src/shared/types.ts`**

```ts
export type TextProvider = "ollama" | "onnx";
export type ImageProvider = "none" | "colsmol" | "voyage" | "gemini";
export type CaptionProvider = "none" | "ollama" | "anthropic" | "gemini";
export type RerankProvider = "none" | "onnx" | "anthropic";

export interface ProviderSettingsView {
  ollamaHost: string;
  ollamaModel: string;
  /** The VLM used for captions — distinct from the embedding model. */
  ollamaCaptionModel: string;
  textProvider: TextProvider;
  imageProvider: ImageProvider;
  captionProvider: CaptionProvider;
  rerankProvider: RerankProvider;
  /** "" means managed downloads under the app data dir. */
  localModels: { dir: string };
  whisper: { binaryPath: string; modelPath: string };
  /** Presence only — raw API keys never cross to the renderer. */
  keys: { voyage: boolean; gemini: boolean; anthropic: boolean };
}
```

Update `SettingsPatch` so its `providers` member omits `keys`, `whisper`, and `localModels` from the flat spread and adds them as optional partials, mirroring how `whisper` is already handled.

- [ ] **Step 4: Update `app/src/main/settings.ts`**

Extend `DEFAULTS.providers`:

```ts
  providers: {
    ollamaHost: "http://localhost:11434",
    ollamaModel: "nomic-embed-text",
    ollamaCaptionModel: "qwen3-vl:4b",
    textProvider: "ollama",
    imageProvider: "none",
    captionProvider: "none",
    rerankProvider: "none",
    localModels: { dir: "" },
    whisper: { binaryPath: "whisper-cli", modelPath: "" },
  },
```

Add explicit migration inside `load()`, before the spread merge:

```ts
  private load(): PersistedSettings {
    if (!existsSync(this.settingsPath)) return structuredClone(DEFAULTS);
    try {
      const raw = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Partial<PersistedSettings> & {
        providers?: Partial<PersistedSettings["providers"]> & { rerank?: boolean };
      };

      // Legacy `rerank: boolean` -> `rerankProvider`. A plain spread would leave
      // the stale key inert and silently disable a user's reranking.
      const legacy = raw.providers?.rerank;
      const rerankProvider =
        raw.providers?.rerankProvider ??
        (legacy === true ? "anthropic" : legacy === false ? "none" : DEFAULTS.providers.rerankProvider);

      const { rerank: _dropped, ...providers } = raw.providers ?? {};
      return {
        providers: {
          ...DEFAULTS.providers,
          ...providers,
          rerankProvider,
          whisper: { ...DEFAULTS.providers.whisper, ...raw.providers?.whisper },
          localModels: { ...DEFAULTS.providers.localModels, ...raw.providers?.localModels },
        },
        signals: {
          screen: { ...DEFAULTS.signals.screen, ...raw.signals?.screen },
          input: { ...DEFAULTS.signals.input, ...raw.signals?.input },
          activeWin: { ...DEFAULTS.signals.activeWin, ...raw.signals?.activeWin },
          audio: { ...DEFAULTS.signals.audio, ...raw.signals?.audio },
          ax: { ...DEFAULTS.signals.ax, ...raw.signals?.ax },
        },
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }
```

Update `apply()` to destructure `localModels` alongside `whisper` so a partial patch merges rather than replaces.

- [ ] **Step 5: Run tests**

Run: `npm --prefix app test && npm --prefix app run typecheck`
Expected: PASS. The typecheck will flag every place `providers.rerank` was read — Task 16 fixes those in `deskrag-service.ts`; if it blocks now, leave a `rerankProvider !== "none"` expression in place.

- [ ] **Step 6: Commit**

```bash
git add app/src/shared/types.ts app/src/main/settings.ts app/test/settings.test.ts
git commit -m "feat(app): provider settings for local models with rerank->rerankProvider migration"
```
