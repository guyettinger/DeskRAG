# Fully-local AI providers

**Date:** 2026-07-24
**Status:** Approved design, ready for implementation planning

## Goal

Let a user configure every AI touchpoint in DeskRAG to run on their own machine,
so that no captured screen content, audio, or query text leaves the device.

## Current state

Six touchpoints. Three are already local, three are not.

| Touchpoint | Implementation | Local today |
|---|---|---|
| Text embed (digest, caption, transcript) | `src/embed/ollama.ts` | Yes — Ollama, already the default |
| Behavior vector | `BehaviorFeatureExtractor` | Yes — builtin, no network |
| Transcript (STT) | `src/represent/transcript/whisper-cpp.ts` | Yes — whisper.cpp |
| Image embed (frame, region) | `src/embed/voyage.ts`, `gemini.ts` | No |
| Caption (VLM) | `src/represent/caption/{anthropic,gemini}.ts` | No |
| Rerank (Tier 4) | `src/retrieve/rerank/llm.ts` | No |

**There is no existing recorded data.** No migration, compatibility, or
re-indexing concern applies anywhere in this document.

## The constraint that shapes everything

Ollama cannot produce image embeddings, and no model can change that. Its
`EmbedRequest` struct (`ollama/api/types.go`) carries exactly six fields —
`Model`, `Input`, `KeepAlive`, `Truncate`, `Dimensions`, `Options`. There is no
image parameter, so `/api/embed` has no way to accept pixels. All twelve models
in Ollama's embedding category are text-only.

Local image embedding therefore requires an in-process ONNX runtime. That is the
only hard constraint; everything else below is a choice.

## The division of labor

The useful line is not local vs. remote but **discriminative vs. generative**.

| Touchpoint | Shape | Runtime |
|---|---|---|
| Text embed | one forward pass | ONNX |
| Image embed | one forward pass, multi-vector | ONNX — the only option |
| Rerank | one forward pass, as a cross-encoder | ONNX |
| Caption | autoregressive multimodal | Ollama |
| STT | — | whisper.cpp, unchanged |

Reranking moves to ONNX because it is generative only by accident of the current
implementation, which asks Claude to emit a ranked list. A cross-encoder scores
each (query, candidate) pair in a single pass and fits the existing
`rerank(query, candidates) => string[]` signature unchanged.

Captioning stays on Ollama. Driving a VLM through `onnxruntime-node` means a
hand-written autoregressive loop, KV-cache management, a multi-part graph, and
multi-gigabyte weights with no Metal path comparable to llama.cpp.

Ollama therefore remains required for exactly one touchpoint. The gain is not
eliminating a runtime but demoting Ollama from "required for search to work at
all" to "optional, enriches one of six views" — and moving the core retrieval
path in-process, where no daemon can be down.

## Decisions

1. ONNX for text embed, image embed, and rerank; Ollama for captions.
2. **The local image path is multi-vector late interaction (ColSmol-256M), not
   single-vector.** See Model Selection.
3. Weights auto-download on first use into the app data dir, verified against a
   pinned SHA-256, with a settings path override for air-gapped machines.
4. No migration path. There is no data; namespace divergence is intended.
5. Document/query task prefixes ride on an optional second argument to `embed()`.
6. `jina-reranker-v1-turbo-en` is the reranker (37.8M, Apache-2.0). Its v2 and m0
   successors are non-commercial; see Model Selection.
7. The local profile also enables AX capture, because AX labels are the exact-text
   path that no embedding replaces.

## Model selection

Researched 2026-07-24. Recording the reasoning because several choices look wrong
without it.

### Vision: multi-vector late interaction

Single-vector CLIP-style embedders are weak on text-dense images, and DeskRAG's
frames are text-dense by nature. The stronger architecture is multi-vector late
interaction — matching at query-token to image-patch granularity rather than
whole-image.

Two assumptions initially ruled this out. Both are false:

- **"The store can't do MaxSim."** It can. `@lancedb/lancedb@0.24.1` — the
  version already installed — exposes `MultiVector` in its type definitions
  (`dist/arrow.d.ts:39`) and accepts it in `vectorSearch()` and `search()`
  (`dist/table.d.ts:295,303`). Multivector columns and MaxSim scoring are native,
  in JS, at the installed version.
- **"Late-interaction models are 3B."** The frontier ones are.
  `vidore/colSmol-256M` is **256M**, MIT-licensed, built on SmolVLM-256M, with an
  ONNX export at `onnx-community/colSmol-256M-ONNX`, and reported to rival models
  ten times its size on ViDoRe.

### Patches replace regions

This is the reason to prefer it, beyond retrieval quality.

`represent/regions/` currently reconstructs by hand — via AX, interaction
hotspots, grid tiling, NMS, and a budget cut — what a late-interaction model
produces natively. The patches *are* the regions, and the per-query-token MaxSim
argmax yields the matched patch, which is exactly the `highlights` bbox that
`assemble.ts` returns today.

So the region *image*-embedding pass disappears on the local path. AX regions
remain, because exact role and label text in FTS5 is something no embedding
replaces.

### Cost

Geometry from `vidore/colSmol-256M/config.json`: `image_size: 512`,
`patch_size: 16` → 1024 patches per tile; `pixel_shuffle_factor: 4` → ÷16 → **64
tokens per 512×512 tile**. The preprocessor tiles to `longest_edge: 512` under a
2048 cap.

At the default `imageMaxWidth: 1280` a frame is ~1280×800 → a 3×2 tiling plus a
global view = 7 tiles → **~448 vectors per frame** at 128 dims.

| | per frame | per 10-min session (600 frames) |
|---|---|---|
| Multivector, f32 | 229 KB | 137 MB |
| **Multivector, f16** | **115 KB** | **69 MB** |
| Single-vector frames + ~12k regions | — | ~39 MB |

About 1.8× the vector storage, against an H.264 session blob that is already
larger than either. **Store patches as float16** — LanceDB supports f16, f32, and
f64 for multivector.

Compute moves in the favourable direction but less dramatically than storage
suggests: ~4,200 vision passes per session (600 frames × 7 tiles) plus 600
decoder passes, against ~12,600 single-vector passes today for frames plus
regions. Roughly **2–3× less inference**, not the order of magnitude a naive
per-frame comparison implies.

### Text embedder: no longer forced

With the vision tower no longer part of a nomic shared space, the alignment
constraint that previously forced `nomic-embed-text-v1.5` is gone. ColSmol embeds
its own queries for image search, so the text embedder is now free.

It stays `nomic-embed-text-v1.5` anyway — 137M, Apache-2.0, ONNX, fast, and
adequate for digest, caption, and transcript text. `Qwen3-Embedding-0.6B`
(Apache-2.0, ONNX) is the documented upgrade if quality proves limiting; changing
it is one manifest field.

Note that `onnx:nomic-embed-text-v1.5` and `ollama:nomic-embed-text` are distinct
namespaces even though the weights match, because provider id is part of the
namespace and two runtimes may differ numerically. That is correct, not a defect.

### Reranker: a licensing trap

Only `jina-reranker-v1-turbo-en` is Apache-2.0. Both
`jina-reranker-v2-base-multilingual` and `jina-reranker-m0` are
**CC-BY-NC-4.0**. "Upgrade to the newer Jina reranker" would silently take on a
non-commercial license.

`jina-reranker-v3` (0.6B) is meaningfully better — 61.94 vs 56.51 nDCG@10 on BEIR
against `bge-reranker-v2-m3` — but 16× larger. The latency budget is looser than
it appears, since Tier 4 today calls `claude-opus-4-8` and already costs seconds.
`Qwen3-Reranker-0.6B` is Apache-2.0 with ONNX and is the documented quality tier.

### Caption model

`qwen3-vl` ships at 2b/4b/8b/30b/32b/235b. ScreenSpot GUI grounding is 92.9% at
4B against 94.4% at 8B — a small gap for double the memory. **`qwen3-vl:4b` is
the default**, `qwen3-vl:2b` for low-memory machines, `minicpm-v4.6` a
comparable-OCR alternative.

### Rejected

| Candidate | Why |
|---|---|
| `nomic-embed-vision-v1.5` (92M) | Single-vector; weak on text-dense frames. Superseded by ColSmol. |
| `colnomic-embed-multimodal-3b` | 3B — infeasible per-frame on CPU. |
| `jina-embeddings-v4` (3.8B) | Same. |
| `nomic-embed-multimodal-3b` | 3B, and no ONNX export. |
| `jina-clip-v2` (865M) | **CC-BY-NC-4.0**. |
| `siglip2-base` (375M) | Single-vector; ONNX only via a mirror with unstated license. |

## Components

### Library

```
src/embed/onnx/
  runtime.ts    OnnxRuntime — lazy onnxruntime-node load, InferenceSession
                cache keyed by weights path, tensor helpers
  text.ts       OnnxTextEmbedding      nomic-embed-text-v1.5   768-dim
  colsmol.ts    ColSmolMultiVector     colSmol-256M            128-dim × ~448
src/retrieve/rerank/onnx.ts        OnnxCrossEncoderReranker
src/represent/caption/ollama.ts    OllamaCaptionProvider
```

### Barrel placement

`OllamaCaptionProvider` is plain `fetch` and exports from `src/index.ts`.

All four ONNX modules load native code — `onnxruntime-node` in every case, plus
`sharp` in `colsmol.ts` for tiling and normalization. They are **not**
re-exported from the barrel and are imported from their own paths, matching
`SharpRegionCropper` and `uiohook-input`.

Consequence: `DeskRagService.buildProviders()`
(`app/src/main/deskrag-service.ts:145`) becomes `async`. Both call sites are
already async.

### Dependencies

Added to **both** `package.json` files, per the dual-install invariant:

- `onnxruntime-node` — N-API, no Electron rebuild, no interaction with the
  `better-sqlite3` rebuild path. Runs a `postinstall` that fetches platform
  binaries.
- `@huggingface/tokenizers` — pure JS/TS, zero dependencies, no postinstall.

Explicitly **not** `@huggingface/transformers`, which depends on `sharp ^0.34.5`
against the project's `^0.35.3` CVE pin, and would nest a vulnerable duplicate.

## The multi-vector seam

### New provider interface

```ts
export interface MultiVectorProvider extends NamespacedProvider {
  readonly multiVector: true;
  /** Per image: N vectors of `dimensions` each. */
  embedImages(images: Uint8Array[]): Promise<Float32Array[][]>;
  /** Per query: M vectors of `dimensions` each. */
  embedQueries(texts: string[]): Promise<Float32Array[][]>;
}
```

One model serves both sides, so there is no alignment question to get wrong.
`dimensions` is the per-vector width (128), not the total.

### New view and namespace

`frame_patches` joins the `View` union. The view name is what marks a namespace
as multi-vector — `MULTIVECTOR_VIEWS` is a `Set<View>` consulted by the store,
so `parseNamespace` keeps its four-part shape unchanged.

```
frame_patches:onnx:colsmol-256m:128
```

`region_image` remains in the union, used only by the cloud path.

### Store additions

`store/lance/tables.ts` gains a multivector table shape — a
`List(FixedSizeList(float16, 128))` column instead of a bare `FixedSizeList` —
plus:

```ts
putFramePatches(rows: { id, sessionId, segmentIds, patches: Float32Array[] }[])
searchFramePatches(query: Float32Array[], scope: FrameScope, k: number)
```

Write order is unchanged and non-negotiable: SQLite transaction commits first,
then the Lance add, serialized through the existing `Mutex`.

### Verified against `@lancedb/lancedb@0.24.1`

Checked empirically 2026-07-24 against a temp LanceDB, not inferred from docs.

**MaxSim is genuine.** With query `[q1, q2]`, a row containing both `q1` and `q2`
scored −1.0000 against 0.6187 for a row containing only `q1`. With a
single-vector query `[q1]`, those two rows tie at 0.0000. Scores therefore
aggregate a per-query-token maximum — real late interaction, not
first-vector-only or mean-pooling.

**`.where()` pre-filters, with and without an index.** The plan pushes the
predicate into `LanceRead` as `full_filter` / `refine_filter`, below the ANN
stage. Asking for `limit: 100` against a set where one row in three is in scope
returned 100 in-scope rows; a post-filter would have returned ~33.

**Variable patch counts per row are fine** — 2, 7, and 448 patches coexisted in
one table. This matters because tile count varies with frame aspect ratio.

**Latency**: 3,000 rows × 8 patches, IVF-PQ indexed, filtered top-50 query — 4ms.

**Cosine is mandatory, and the default is a trap.** Index build with `l2` fails:

```
LanceError(Index): Build Vector Index: multivector type supports only cosine distance
```

But *brute-force* search silently defaults to `metric=l2` and still returns
plausible ordering. So a multivector path developed without an index appears to
work, then fails at index creation. The store must therefore set cosine in **both**
places:

```ts
Index.ivfPq({ distanceType: "cosine", numPartitions, numSubVectors })
tbl.vectorSearch(queryVectors).distanceType("cosine")
```

Float16 storage was verified working for the patch column.

### Patch-to-bbox mapping

Highlights come from the MaxSim argmax. Token index → tile index → position in
the tile's 8×8 token grid (1024 patches ÷ pixel-shuffle 16 = 64 tokens = 8×8),
so each token covers a 64×64 px area of its 512 px tile. Tile origin plus grid
position gives frame-space coordinates, scaled back to the stored keyframe's
dimensions.

Granularity is therefore ~64 px boxes — comparable to the region boxes it
replaces.

### Retrieval

| Tier | Cloud path (unchanged) | Local path |
|---|---|---|
| 0 | pHash | pHash |
| 1 | segment RRF over text views | same |
| 2 | frame ANN, single-vector | **frame patch MaxSim**, scoped to Tier-1 segments |
| 3 | region ANN + AX-label FTS | **patch argmax → highlights** + AX-label FTS |
| 4 | LLM rerank | ONNX cross-encoder rerank |

**This is two Tier-2/Tier-3 code paths, and that is the main complexity cost of
this design.** The alternative — dropping Voyage and Gemini image embedding
entirely — would remove a whole branch from `retrieve/`, but it deletes working
functionality that was not in scope to remove. The paths are selected by which
namespace is registered, so they never run simultaneously.

## Weight acquisition

### Manifest

```ts
interface ModelSpec {
  id: string;        // "colSmol-256M"
  repo: string;      // "onnx-community/colSmol-256M-ONNX"
  revision: string;  // a commit SHA — never "main"
  files: { path: string; sha256: string; bytes: number }[];
}
```

`revision` pins a commit SHA. If `main` moves, weights change while the namespace
keeps claiming `colsmol-256m:128`, and vectors silently stop being comparable.

The manifest lives in `app/src/main/models.ts`. Library adapters take explicit
`modelPath` and `tokenizerPath` arguments, as `WhisperCppTranscription` takes
`binaryPath` and `modelPath`, so the library never fetches anything.

ColSmol additionally needs `preprocessor_config.json` for tiling parameters —
read at load time rather than hardcoded, so a model swap cannot silently change
geometry while the code assumes 7 tiles.

### ModelStore

New `app/src/main/model-store.ts`:

```ts
ensure(spec: ModelSpec): Promise<string>   // → local directory
```

Files live at `<userData>/DeskRAG/models/<id>/<file>`, alongside `blobs/` and
`lance/`.

Downloads stream from `https://huggingface.co/<repo>/resolve/<revision>/<path>`
to `<file>.partial`, verify SHA-256, then rename atomically. A partial file never
looks complete, so an interrupted download cannot poison a namespace — the same
discipline as `reserveBlob`/`commitBlob`.

**On checksum mismatch: delete and throw.** Never fall back to an unverified
file.

When `providers.localModels.dir` is set, `ModelStore` reads from there and skips
download and verification entirely.

### Sizes

| Model | Params | int8 | fp32 |
|---|---|---|---|
| nomic-embed-text-v1.5 | 137M | ~137MB | ~547MB |
| colSmol-256M | 256M | ~256MB | ~1.0GB |
| jina-reranker-v1-turbo-en | 37.8M | ~38MB | ~151MB |
| **total** | | **~431MB** | ~1.7GB |

Default all three to int8, with quantization level as a manifest field.

int8 is well established for rerankers, where only score ordering matters. It is
less obviously safe for the embedders, and **least obviously safe for ColSmol**:
MaxSim sums per-token maxima, so quantization error accumulates across ~448
tokens rather than affecting one cosine. See Open Items.

fp16 is deliberately not the middle option for weights — ORT's CPU provider has
thin fp16 kernel coverage and tends to insert casts to fp32. This is unrelated to
storing *patch vectors* as f16, which is recommended.

### Session lifecycle

`buildProviders()` runs on every `index()` and every `search()`. An
`InferenceSession` costs hundreds of milliseconds to construct and holds weights
resident, so `OnnxRuntime` caches sessions by absolute weights path for the
process lifetime; `buildProviders()` returns cheap wrappers.

The reranker loads lazily on first Tier-4 use.

### Download timing

Lazily, on first need. This requires a new IPC event rather than reusing
`IndexingProgress`, because a download can now begin from `search()`:

```ts
interface ModelDownloadProgress {
  modelId: string; receivedBytes: number; totalBytes: number; done: boolean;
}
```

## App wiring

### Settings shape

```ts
providers: {
  ollamaHost: string;
  ollamaModel: string;              // embeddings (existing)
  ollamaCaptionModel: string;       // NEW — the VLM
  textProvider:    "ollama" | "onnx";                          // NEW
  imageProvider:   "none" | "colsmol" | "voyage" | "gemini";   // + colsmol
  captionProvider: "none" | "ollama" | "anthropic" | "gemini"; // + ollama
  rerankProvider:  "none" | "onnx" | "anthropic";              // replaces rerank
  localModels: { dir: string };     // NEW — "" means managed downloads
  whisper: { binaryPath: string; modelPath: string };
  keys: { voyage: boolean; gemini: boolean; anthropic: boolean };
}
```

`rerank: boolean` → `rerankProvider` needs explicit handling in
`SettingsStore.load()`, which currently spreads defaults and would leave a stale
`rerank: true` inert: map `true` → `"anthropic"`, `false` → `"none"`.

### The cloud-model hazard

Ollama's library now includes cloud-hosted models — `gemini-3-flash-preview` and
the `kimi-k2.*` family. A hardcoded vision-model list would let a user select one,
routing screenshots off the machine through the setting meant to keep them on it.

The caption-model dropdown is populated from `GET /api/tags`, which returns only
models resident on disk, each with a `capabilities` array. Filter to entries whose
capabilities include vision. A model that is not pulled locally cannot be
selected, making accidental cloud routing structurally impossible.

With no vision model present, the field shows `ollama pull qwen3-vl:4b` instead of
an empty dropdown. Auto-pulling via `/api/pull` is out of scope.

### capabilities()

Keeps its four booleans and synchronous shape. Semantics remain *configured
intent*, not live reachability:

```ts
imageSearch: p.imageProvider === "colsmol"
          || (p.imageProvider === "voyage" && p.keys.voyage)
          || (p.imageProvider === "gemini" && p.keys.gemini)
caption:     p.captionProvider === "ollama"
          || (p.captionProvider === "anthropic" && p.keys.anthropic)
          || (p.captionProvider === "gemini" && p.keys.gemini)
rerank:      p.rerankProvider === "onnx"
          || (p.rerankProvider === "anthropic" && p.keys.anthropic)
transcript:  Boolean(p.whisper.modelPath)
```

### Local profile

```
textProvider       → onnx
imageProvider      → colsmol
captionProvider    → ollama   (disabled, with pull hint, if no local vision model)
rerankProvider     → onnx
signals.ax.enabled → true
```

AX is part of the profile for a substantive reason. Patch-level matching improves
text-dense retrieval but does not read text exactly; AX labels in FTS5 are the
exact-match path, and they currently default off
(`app/src/main/settings.ts:38`). The UI surfaces this as a capture-behavior
change rather than flipping it silently, since AX capture needs macOS
accessibility permission.

A **"Fully local"** badge lights when every selected provider is local. It is
derived state, not a toggle, so it cannot drift from reality.

### Empty-search guard

When `buildRetriever()` finds zero registered text namespaces for the current
provider, `search()` returns a distinguishable empty result rather than a bare
`[]`, so the UI can explain rather than render "no results" over a full library.

## Error handling

### Governing rule

**An embedder failure must never fall back to a different embedder.**
Substituting an embedder substitutes a vector space. A silent revert from ONNX to
Ollama would write into `digest:ollama:nomic-embed-text:768` while the user
believes they are in `digest:onnx:nomic-embed-text-v1.5:768` — incomparable
spaces, no error, permanently degraded results.

Embedder failures are loud and disabling. Everything downstream degrades
normally.

| Failure | Behavior |
|---|---|
| `onnxruntime-node` will not load | Loud. Provider disabled, capability false, error surfaced. No fallback. |
| Weights download fails | Throw, surface, leave nothing on disk. Retried next attempt. |
| Checksum mismatch | Delete the file and throw. |
| Ollama daemon down (`ECONNREFUSED`) | Caption stage skipped with a warning; indexing continues. |
| Vision model deleted after selection | `/api/chat` 404 → caption stage skipped. |
| Tier-4 reranker throws | Fall back to input order, matching `src/retrieve/rerank/llm.ts:63`. |
| Text exceeds model context | Truncate explicitly before tokenizing. |
| Frame produces zero patches | Skip the frame, log; do not write an empty multivector row. |

A missing caption means one of six views lacks a vector for one segment, which
`reconcileAndReembed()` (`src/store/types.ts:342`) exists to fill later. A missing
embedder means the retrieval path has no coherent space to search.

### Quiet hazards

**Truncation.** Ollama's `/api/embed` defaults `truncate: true`, so the current
adapter never had to think about long input. On the ONNX path an over-length
sequence is a tensor shape error, so truncation becomes explicit at the tokenizer.

**Tiling geometry.** ColSmol's patch-to-bbox mapping depends on tile count, tile
size, and pixel-shuffle factor. Get any of them wrong and highlights land on the
wrong part of the frame while retrieval scores stay plausible. Read the geometry
from `preprocessor_config.json` and `config.json` rather than hardcoding, and
assert the token count matches the computed tiling at load.

**Reconciliation.** `reconcileAndReembed()` assumes one vector per row. It must
either learn multivector rows or explicitly skip `MULTIVECTOR_VIEWS`. Silently
treating a patch set as a missing single vector would corrupt the table.

## Testing

### CI-safe, always run

- **Namespace strings** — `namespaceFor()` for both new embedders; no `:` leaks,
  dimensions correct. The reranker and captioner have no namespace: neither is a
  `NamespacedProvider`, and captions are embedded by the text embedder.
- **`MULTIVECTOR_VIEWS`** — `frame_patches` is marked multi-vector; the
  single-vector views are not.
- **Multivector store round-trip** against a temp LanceDB: write N patch sets,
  read back, confirm shape and f16 storage.
- **`.where()` composition** — a multivector search with an
  `array_has_any(segment_ids, [...])` pre-filter returns only in-scope frames,
  and returns a full `limit` worth rather than a post-filtered remnant. This is
  what makes Tier-2 scoping exact; it is verified but must stay verified.
- **Cosine is set on both the index and the query.** Assert that a table built
  without `distanceType: "cosine"` fails loudly rather than silently searching
  under `l2`.
- **Patch-to-bbox mapping** — synthetic geometry in, known pixel boxes out,
  including the non-square and global-view tiles.
- **Tokenizer truncation** — pure JS, no weights needed.
- **Settings migration** — legacy `{ rerank: true }` → `"anthropic"`.
- **`ModelStore`** against a fixture server: checksum mismatch deletes and throws;
  `.partial` never promoted; `localModels.dir` skips download.
- **`capabilities()` truth table.**
- **Empty-search guard.**
- **Reconciliation** skips or correctly handles multivector namespaces.

### Gated on weights (`ONNX_SMOKE=1`)

- **Token count** — a 1280×800 fixture yields the tiling the geometry predicts.
- **MaxSim ordering** — a query matching a fixture screenshot outranks an
  unrelated one. The core assertion; if it fails, the local image path is broken.
- **Highlight plausibility** — a query for known on-screen text argmaxes to a
  patch overlapping that text's actual location.
- **Golden vectors** for the text embedder.
- **Reranker ordering.**

### Gated on the daemon (`OLLAMA_VLM_SMOKE=1`)

- `OllamaCaptionProvider` returns non-empty text for a fixture screenshot, and
  returns empty rather than throwing when the daemon is down.

### One-off scripts

- int8 vs fp32 recall, run once per model to pick defaults.
- Per-session storage measured against the 69 MB estimate.

## Out of scope

- Auto-pulling Ollama vision models via `/api/pull`.
- Replacing whisper.cpp for STT.
- Removing the cloud providers. Voyage, Gemini, and Anthropic remain selectable,
  which is what forces the dual Tier-2/3 path.
- GPU execution providers (CoreML, CUDA). CPU only in this pass.
- Multi-vector embedding of *regions*. Patches supersede it on the local path.

## Open items

1. ~~`.where()` pre-filter composition with multivector search.~~ **Resolved
   2026-07-24** — verified empirically; see "Verified against
   `@lancedb/lancedb@0.24.1`". Pre-filtering composes with and without an index,
   MaxSim is genuine, and variable patch counts are supported. The one surprise
   was that cosine is mandatory while brute-force search silently defaults to
   `l2`, which is now a design requirement rather than an open question.
2. **The ColSmol projection dimension.** Assumed 128 from ColVision convention;
   `config.json` does not state it directly. Confirm from the ONNX output shape.
3. **int8 quality for ColSmol specifically.** MaxSim sums per-token maxima, so
   quantization error accumulates across ~448 tokens rather than perturbing one
   cosine. Higher risk than for the single-vector models.
4. **The `onnx-community/colSmol-256M-ONNX` export is community-produced**, a
   single merged `model.onnx`. Validate outputs against the PyTorch reference
   before pinning.
5. **Pinned revision SHAs and per-file checksums**, captured at implementation
   time into `app/src/main/models.ts`.

## Build order

1. `src/embed/onnx/runtime.ts` + `text.ts`, with the `embed()` opts change.
2. Store multivector table shape (cosine index), `putFramePatches`,
   `searchFramePatches`, and the reconciliation guard.
3. `src/embed/onnx/colsmol.ts` + patch-to-bbox mapping, with geometry tests.
4. Tier-2/Tier-3 local path in `retrieve/`, and `assemble.ts` highlights.
5. `src/retrieve/rerank/onnx.ts`.
6. `src/represent/caption/ollama.ts`.
7. `app/src/main/models.ts` + `model-store.ts`.
8. `DeskRagService` wiring: async `buildProviders()`, `capabilities()`,
   `buildRetriever()` dispatch between single- and multi-vector paths.
9. `shared/types.ts` DTO and IPC additions, Settings UI, local profile action.
