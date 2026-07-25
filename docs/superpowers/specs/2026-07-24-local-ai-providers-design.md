# Fully-local AI providers

**Date:** 2026-07-24
**Status:** Approved design, ready for implementation planning

## Goal

Let a user configure every AI touchpoint in DeskRAG to run on their own machine, so
that no captured screen content, audio, or query text leaves the device.

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

## The constraint that shapes everything

Ollama cannot produce image embeddings, and no model can change that. Its
`EmbedRequest` struct (`ollama/api/types.go`) carries exactly six fields —
`Model`, `Input`, `KeepAlive`, `Truncate`, `Dimensions`, `Options`. There is no
image parameter, so `/api/embed` has no way to accept pixels. All twelve models
in Ollama's embedding category are text-only. One community model advertises
itself as multimodal (`DC1LEX/nomic-embed-text-v1.5-multimodal`) but is the text
tower repackaged.

That model's description points at the real answer: *"nomic-embed-vision-v1.5 is
aligned to the embedding space of nomic-embed-text-v1.5."* The two are the text
and image towers of one joint space, and Ollama's `nomic-embed-text:latest`
already resolves to v1.5. Only the image tower is missing, and it publishes ONNX
weights.

## The division of labor

The useful line is not local vs. remote but **discriminative vs. generative**.

| Touchpoint | Shape | Runtime |
|---|---|---|
| Text embed | one forward pass | ONNX |
| Image embed | one forward pass | ONNX — the only option |
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
2. Weights auto-download on first use into the app data dir, verified against a
   pinned SHA-256, with a settings path override for air-gapped machines.
3. No migration path for recordings indexed under a previous provider. Namespace
   divergence is intended behavior.
4. Document/query task prefixes are carried by an optional second argument to
   `embed()`, not by separate provider instances.
5. `jina-reranker-v1-turbo-en` is the reranker (37.8M params, Apache-2.0) rather
   than `bge-reranker-base` (278M) — roughly seven times smaller for a desktop
   app.

All models are Apache-2.0 or MIT. None carry a non-commercial clause.

## Components

### Library

```
src/embed/onnx/
  runtime.ts    OnnxRuntime — lazy onnxruntime-node load, InferenceSession
                cache keyed by weights path, tensor helpers
  text.ts       OnnxTextEmbedding    nomic-embed-text-v1.5    768-dim
  vision.ts     OnnxImageEmbedding   nomic-embed-vision-v1.5  768-dim,
                                     sharedTextSpace: true
src/retrieve/rerank/onnx.ts        OnnxCrossEncoderReranker
src/represent/caption/ollama.ts    OllamaCaptionProvider
```

Each adapter sits next to the interface it implements, matching the existing
layout. The embedders take a subdirectory rather than a flat `src/embed/onnx.ts`
because ONNX carries real preprocessing weight — tokenization, image resize and
normalization — that would push one file well past what `voyage.ts` carries.

### Barrel placement

`OllamaCaptionProvider` is plain `fetch` and exports from `src/index.ts`
alongside the other captioners.

All four ONNX modules load native code — `onnxruntime-node` in every case, plus
`sharp` in `vision.ts` for preprocessing. They are **not** re-exported from the
barrel, and are imported from their own paths, matching `SharpRegionCropper` and
`uiohook-input`, so `import "deskrag"` still never force-loads a native module.

Consequence: `DeskRagService.buildProviders()` (`app/src/main/deskrag-service.ts:145`)
becomes `async`, because ONNX adapters arrive via
`await import(/* @vite-ignore */ …)` inside try/catch, as `loadCropper()` already
does. Both call sites — `index()` and `search()` — are already async.

### Dependencies

Added to **both** `package.json` files, per the dual-install invariant:

- `onnxruntime-node` — N-API, so no Electron rebuild and no interaction with the
  `better-sqlite3` rebuild path. It does run a `postinstall` that fetches
  platform binaries, which is a new network step at install time.
- `@huggingface/tokenizers` — pure JS/TS, zero dependencies, no postinstall.

Explicitly **not** `@huggingface/transformers`, which depends on `sharp ^0.34.5`.
That range does not overlap the project's `^0.35.3` pin, which exists because
0.34.x carried libvips CVEs, so npm would nest a vulnerable duplicate copy.

## Namespaces

`namespaceFor()` rejects `:` in a model string (`src/embed/types.ts:139`), so
Ollama's tag form cannot pass through verbatim:

```
digest:onnx:nomic-embed-text-v1.5:768
frame_image:onnx:nomic-embed-vision-v1.5:768
region_image:onnx:nomic-embed-vision-v1.5:768
```

Same provider id, same dimensionality, genuinely the same space — so
`sharedTextSpace: true` on the vision adapter is an honest claim, and Tier-2 and
Tier-3 text-into-image search work as the retrieval code already assumes.

## Interface change: task prefixes

nomic-embed-v1.5 requires `search_document: ` on stored text and `search_query: `
on query text. Omitting them raises no error; retrieval quality just degrades
silently. `EmbeddingProvider.embed(inputs)` has no notion of the distinction, and
one instance serves both roles today — `TextViewSearcher` receives the same
provider the representers use.

```ts
embed(inputs: string[], opts?: { role?: "document" | "query" }): Promise<Float32Array[]>
```

Additive and backward-compatible; providers that do not care ignore it. Chosen
over a constructor option because the constructor variant fails silently when
mis-wired, and silent quality loss is precisely what the namespace discipline
exists to prevent elsewhere in this codebase.

`TextViewSearcher` passes `role: "query"`; representers pass `role: "document"`.
The prefix is not part of the namespace — both roles write to and read from the
same space, which is the point.

## Weight acquisition

### Manifest

```ts
interface ModelSpec {
  id: string;        // "nomic-embed-text-v1.5"
  repo: string;      // "nomic-ai/nomic-embed-text-v1.5"
  revision: string;  // a commit SHA — never "main"
  files: { path: string; sha256: string; bytes: number }[];
}
```

`revision` pins a commit SHA. If `main` moves, the weights change while the
namespace keeps claiming `nomic-embed-text-v1.5:768`, and vectors silently stop
being comparable to those already in that Lance table. Pinning is what keeps the
namespace's promise true over time.

The manifest lives in `app/src/main/models.ts`, not the library. Library adapters
take explicit `modelPath` and `tokenizerPath` arguments, exactly as
`WhisperCppTranscription` takes `binaryPath` and `modelPath`, so the library
never fetches anything and the app owns all acquisition policy.

### ModelStore

New `app/src/main/model-store.ts`:

```ts
ensure(spec: ModelSpec): Promise<string>   // → local directory
```

Files live at `<userData>/DeskRAG/models/<id>/<file>`, alongside the existing
`blobs/` and `lance/`.

Downloads stream from `https://huggingface.co/<repo>/resolve/<revision>/<path>`
to `<file>.partial`, verify SHA-256, then rename atomically. A partial file never
looks complete, so an interrupted download cannot poison a namespace — the same
discipline as `reserveBlob`/`commitBlob`.

**On checksum mismatch: delete and throw.** Never fall back to an unverified
file. Wrong weights produce vectors that are silently wrong while sitting in a
table claiming otherwise.

When `providers.localModels.dir` is set, `ModelStore` reads from that directory
and skips both download and verification. Air-gapped users curate their own files
and accept responsibility for them.

### Sizes and quantization

| Model | Params | int8 | fp32 |
|---|---|---|---|
| nomic-embed-text-v1.5 | 137M | ~137MB | ~547MB |
| nomic-embed-vision-v1.5 | 93M | ~93MB | ~372MB |
| jina-reranker-v1-turbo-en | 37.8M | ~38MB | ~151MB |
| **total** | | **~268MB** | ~1.07GB |

Default all three to `model_int8.onnx`, with quantization level as a manifest
field so changing it is a one-line edit.

int8 is well established for rerankers, where only score *ordering* matters. For
the two embedders it is less obviously safe: quantization noise perturbs cosine
similarity directly, and here across a shared space whose two towers must stay
mutually calibrated. This is unvalidated — see Open Items.

fp16 is deliberately not the middle option. ORT's CPU provider has thin fp16
kernel coverage and tends to insert casts to fp32, saving disk without saving
time.

### Session lifecycle

`buildProviders()` runs on every `index()` and every `search()`. An
`InferenceSession` costs hundreds of milliseconds to construct and holds weights
resident, so rebuilding one per search would be badly wrong. `OnnxRuntime` caches
sessions by absolute weights path for the process lifetime; `buildProviders()`
returns cheap wrappers around cached sessions. Resident cost is roughly on-disk
size, ~268MB at int8 with all three loaded.

The reranker loads lazily on first Tier-4 use, since Tier 4 is optional and many
queries never reach it.

### Download timing

Lazily, on first need: `buildProviders()` awaits `ensure()` before constructing
each adapter. The first local search or index after enabling local providers pays
the download.

This needs a new IPC event rather than reusing `IndexingProgress`, because a
download can now begin from `search()`:

```ts
// shared/types.ts
interface ModelDownloadProgress {
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
}
```

## App wiring

### Settings shape

```ts
providers: {
  ollamaHost: string;
  ollamaModel: string;              // embeddings (existing)
  ollamaCaptionModel: string;       // NEW — the VLM, separate from the embedder
  textProvider:    "ollama" | "onnx";                          // NEW
  imageProvider:   "none" | "onnx" | "voyage" | "gemini";      // + onnx
  captionProvider: "none" | "ollama" | "anthropic" | "gemini"; // + ollama
  rerankProvider:  "none" | "onnx" | "anthropic";              // replaces rerank
  localModels: { dir: string };     // NEW — "" means managed downloads
  whisper: { binaryPath: string; modelPath: string };
  keys: { voyage: boolean; gemini: boolean; anthropic: boolean };
}
```

`textProvider` is new because the text embedder was never a choice —
`buildProviders()` hardcodes `new OllamaTextEmbedding(...)` at
`deskrag-service.ts:148`.

### Settings migration

`rerank: boolean` becoming `rerankProvider` is the one breaking change on disk.
`SettingsStore.load()` spreads `{...DEFAULTS.providers, ...raw.providers}`, which
would leave a stale `rerank: true` inert and silently disable a user's
reranking. Explicit handling required: when `raw.providers.rerank === true` and
`rerankProvider` is absent, map to `"anthropic"`; when `false`, map to `"none"`.

### The cloud-model hazard

Ollama's library now includes cloud-hosted models — `gemini-3-flash-preview` and
the `kimi-k2.*` family among them. A hardcoded list of vision models would let a
user select one, routing screenshots off the machine through the very setting
meant to keep them on it, with no visible indication.

The caption-model dropdown is therefore populated from `GET /api/tags`, which
returns only models resident on disk, each with a `capabilities` array. Filter to
entries whose capabilities include vision. A model that is not pulled locally
cannot be selected, making accidental cloud routing structurally impossible
rather than a matter of user care.

When no vision model is present, the field shows the pull command
(`ollama pull qwen3-vl`) instead of an empty dropdown. Auto-pulling via
`/api/pull` is out of scope for this pass — it is multiple gigabytes and Ollama's
CLI does it better.

### capabilities()

`Capabilities` keeps its four booleans and its synchronous shape. Semantics stay
what they already are: *configured intent*, not live reachability. Today
`imageSearch` reports "Voyage selected and a key present," not "Voyage
responded."

```ts
imageSearch: p.imageProvider === "onnx"
          || (p.imageProvider === "voyage" && p.keys.voyage)
          || (p.imageProvider === "gemini" && p.keys.gemini)
caption:     p.captionProvider === "ollama"
          || (p.captionProvider === "anthropic" && p.keys.anthropic)
          || (p.captionProvider === "gemini" && p.keys.gemini)
rerank:      p.rerankProvider === "onnx"
          || (p.rerankProvider === "anthropic" && p.keys.anthropic)
transcript:  Boolean(p.whisper.modelPath)
```

Download state is carried by `ModelDownloadProgress`, not folded into
capabilities.

### Local profile

Settings gains a **"Use local models for everything"** action:

```
textProvider    → onnx
imageProvider   → onnx
captionProvider → ollama   (disabled, with pull hint, if no local vision model)
rerankProvider  → onnx
```

Alongside it, a **"Fully local"** badge that lights when every selected provider
is local. The badge is derived state, not a toggle, so it cannot drift from
reality.

Transcription already satisfies this through whisper.cpp, and behavior vectors
never left the machine. With those four settings, all six views plus Tier 4 run
locally.

### Empty-search refinement

There is no migration path, by decision. Recordings indexed under a previous
provider keep their vectors in their original namespace and are not searchable
under a new one.

The one guard: when `buildRetriever()` finds zero registered text namespaces for
the current provider, `search()` returns a distinguishable empty result rather
than a bare `[]`, so the UI can say "these recordings were indexed with a
different provider" instead of rendering "no results" over a full library. Today
`buildRetriever()` attaches only `TextViewSearcher`s whose namespace is
registered, so after a provider switch it would attach none and search would
silently return nothing.

## Error handling

### Governing rule

The existing native-module pattern — missing module disables one signal — is
right for producers and wrong for embedders.

**An embedder failure must never fall back to a different embedder.**
Substituting an embedder substitutes a vector space. If ONNX fails to load and
the code quietly reverts to Ollama, vectors land in
`digest:ollama:nomic-embed-text:768` while the user believes they are in
`digest:onnx:nomic-embed-text-v1.5:768` — incomparable spaces, no error,
permanently degraded results.

Embedder failures are loud and disabling. Everything downstream of an embedding
degrades normally.

### Matrix

| Failure | Behavior |
|---|---|
| `onnxruntime-node` will not load | Loud. Provider disabled, capability false, error surfaced in Settings. No fallback. |
| Weights download fails | Throw, surface, leave nothing on disk. Retried next attempt. |
| Checksum mismatch | Delete the file and throw. |
| Ollama daemon down (`ECONNREFUSED`) | Caption stage skipped with a logged warning; indexing continues. |
| Vision model deleted after selection | `/api/chat` 404 → caption stage skipped. |
| Tier-4 reranker throws | Fall back to input order, matching `LLMReranker` at `src/retrieve/rerank/llm.ts:63`. |
| Text exceeds model context | Truncate explicitly before tokenizing. |

The asymmetry is deliberate. A missing caption means one of six views lacks a
vector for one segment, which `reconcileAndReembed()`
(`src/store/types.ts:342`) already exists to fill in later. A missing embedder
means the entire text retrieval path has no coherent space to search.

### Two quiet hazards

**Truncation.** Ollama's `/api/embed` defaults `truncate: true`, so the current
adapter has never needed to think about long input. nomic-embed-text-v1.5 has a
2K context, and digests or transcripts can exceed it. On the ONNX path an
over-length sequence is a tensor shape error, not a graceful clamp, so truncation
becomes explicit at the tokenizer.

**Image preprocessing is the highest-risk silent failure in this design.**
nomic-embed-vision-v1.5 expects a specific 224×224 resize and specific
normalization constants. Get either subtly wrong and nothing throws — the result
is plausible-looking 768-dim vectors that do not align with the text tower,
defeating the entire reason for choosing this model pair. Cosine similarities
stay in a believable range, so it passes every smell test.

Mitigated by the golden-vector test below, plus a rule: **if preprocessing is
corrected after release, the model id in the namespace must change too** —
`nomic-embed-vision-v1.5` → `nomic-embed-vision-v1.5-r2`. Fixed preprocessing
produces a different vector space, and the namespace must say so.

## Testing

Following the existing convention: live and native tests skip cleanly, and CI
stays green with no weights, no daemon, and no network.

### CI-safe, always run

- **Namespace strings** — `namespaceFor()` output for both new embedders; no
  `:` leaks through, dimensions match. Pure, no weights. The reranker and
  captioner have no namespace: neither is a `NamespacedProvider`, and captions
  are embedded by the text embedder.
- **Tokenizer truncation** — over-length input clamps correctly. Needs
  `tokenizer.json` but no ONNX weights or runtime, since the tokenizer is pure JS.
- **Settings migration** — legacy `{ rerank: true }` becomes
  `rerankProvider: "anthropic"`; `{ rerank: false }` becomes `"none"`.
- **`ModelStore`** against a fixture server: checksum mismatch deletes and throws;
  a `.partial` file is never promoted on interrupt; `localModels.dir` skips
  download and verification.
- **`capabilities()` truth table** across the new provider combinations.
- **Empty-search refinement** — a retriever with zero registered text namespaces
  returns the distinguishable result, not a bare `[]`.

### Gated on weights (`ONNX_SMOKE=1`)

- **Golden vectors** — fixed string and fixed PNG against reference embeddings,
  within tolerance. This is what catches the preprocessing hazard.
- **Cross-modal alignment** — the most important assertion in the design:

  ```
  cos(embed_text("search_query: a login form"), embed_image(login_screenshot))
    >  cos(embed_text("search_query: a login form"), embed_image(unrelated_screenshot))
  ```

  If this fails, `sharedTextSpace: true` is a lie and Tier-2/Tier-3
  text-into-image search is quietly broken. Nothing else in the suite catches it.
- **Reranker ordering** — a relevant candidate outranks an irrelevant one.

### Gated on the daemon (`OLLAMA_VLM_SMOKE=1`)

- `OllamaCaptionProvider` returns non-empty text for a fixture screenshot, and
  returns empty rather than throwing when the daemon is down.

### One-off script, not a CI test

The int8-versus-fp32 recall comparison. It needs both weight sets, so it lives
under `scripts/`, is run once to pick the default, and its result is recorded
here.

## Out of scope

- Migration or re-indexing of recordings indexed under a previous provider.
- Auto-pulling Ollama vision models via `/api/pull`.
- Replacing whisper.cpp for STT; it is already local and works.
- Removing the cloud providers. Voyage, Gemini, and Anthropic remain selectable.
- GPU execution providers (CoreML, CUDA). CPU only in this pass.

## Open items

1. **int8 versus fp32 recall for the two embedders.** Unvalidated. Resolved by
   the one-off script above; if int8 costs meaningful recall, the fix is one
   manifest field. This is the only decision in the design made without evidence.
2. **Pinned revision SHAs and per-file checksums** for the three models must be
   captured at implementation time and recorded in `app/src/main/models.ts`.

## Build order

Following the dependency direction in `CLAUDE.md`:

1. `src/embed/onnx/runtime.ts` + `text.ts`, with the `embed()` opts change and
   namespace tests.
2. `src/embed/onnx/vision.ts` with golden-vector and cross-modal tests — the
   riskiest component, proven earliest.
3. `src/retrieve/rerank/onnx.ts`.
4. `src/represent/caption/ollama.ts`.
5. `app/src/main/models.ts` + `model-store.ts`, with fixture-server tests.
6. `DeskRagService` wiring: async `buildProviders()`, `capabilities()`,
   `buildRetriever()` empty-search guard.
7. `shared/types.ts` DTO and IPC additions, then Settings UI and the local
   profile action.
