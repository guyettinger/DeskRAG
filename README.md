<p align="center">
  <img src="assets/deskrag-ghost.svg" alt="DeskRAG" width="150" height="150">
</p>

<h1 align="center">DeskRAG</h1>

**Local-first, multimodal desktop session memory.** DeskRAG captures what happens on your desktop — screen video, desktop + mic audio, mouse/keyboard input, active window, and the OS accessibility tree — into a searchable "experience memory," then lets you recall past moments by:

- **semantic query** — *"that time I was debugging auth"*
- **visual example** — *"find this screen / this dialog"*
- **behavioral similarity** — *"sessions like what I'm doing now"*

It's inspired by VideoRAG and PixelRAG, with a key advantage over pure-pixel systems: on the desktop we read real UI structure from the **accessibility tree**, giving free, labeled region proposals — grounded bounding boxes and roles that video systems must infer.

**Every model runs on your machine.** There is no cloud provider, no API key, and no network call to anything but a daemon on localhost — the privacy claim is structural, not a matter of how you configured it. TypeScript throughout, strict types, pluggable local providers (Ollama, in-process ONNX, whisper.cpp).

---

## Highlights

- **Dual-store, crash-safe** — SQLite (`better-sqlite3`, WAL) is the relational source of truth + event firehose; LanceDB owns all vectors + scoped ANN. A strict write-order + reconciliation protocol survives crashes between the two engines (proven by a real kill-the-process recovery test).
- **Structural vector discipline** — every embedding is namespaced `view:provider:model:dims`, with one physical LanceDB table per namespace, so incomparable vector spaces *cannot* be mixed in a search.
- **Monotonic timeline** — all correlation is on a monotonic `t_mono` clock, immune to wall-clock/NTP/DST jumps.
- **Six embeddable views** per experience — transcript (local whisper.cpp STT), VLM caption, structured-event digest, behavioral feature vector, whole-frame image, and region image.
- **Coarse-to-fine retrieval** — pHash → segment RRF → frame ANN → region ANN + accessibility-label full-text search → optional cross-encoder rerank — returning **highlights**: the matched region bounding boxes + labels to outline *where* on the recalled frame the match is.
- **The PixelRAG edge, grounded** — region proposals fuse the accessibility tree, interaction hotspots (weighted DBSCAN over clicks/dwell — a signal video RAG can't have), and grid tiling.
- **A desktop app, not just a library** — [DeskRAGApp](#desktop-app--deskragapp) (Electron + React) drives the whole pipeline from a UI: record, auto-index, then search your sessions as a contact sheet of keyframes.

## Architecture

```
 capture/                 segment/            represent/                         retrieve/
 ─────────                ────────            ──────────                         ────────
 uiohook  (input)     ┐   event-driven    ┐   transcript   digest   ┐   Tier0 pHash prefilter
 active-win (focus)   │   boundaries      │   caption      behavior │   Tier1 segment ANN + RRF
 ffmpeg  (screen→JPEG)├─▶ + multi-        ├─▶ frame-image  region-  ├─▶ Tier2 frame ANN  (scoped)
 ax-dump (AX tree)    │   granularity     │   image                 │   Tier3 region ANN + AX-FTS
 (mic/desktop audio)  ┘   overlapping     ┘   (each → a namespaced  ┘   Tier4 rerank (optional)
                          windows              vector space)             → assemble → ranked frames
                                                                            + region highlights
        store/  ──  SQLite (relational truth + event firehose)  ⇄  LanceDB (vectors + scoped ANN)
                    shared ULID keys · SQLite-first writes · one-directional reconciliation
```

## Repo layout

| Path | What it is |
|---|---|
| `src/` | the DeskRAG library — capture, store, represent, retrieve (published as `deskrag`) |
| `app/` | **DeskRAGApp**, the Electron desktop UI over the library (`deskrag-app`, its own install — not a workspace member) |
| `native/` | the macOS accessibility sidecar (`ax-dump.swift`, built with `npm run build:ax`) |
| `test/` | the executable documentation — vitest suite, ~6s, deterministic |
| `assets/` | the brand mark — generated from `scripts/brand/geometry.ts` via `npm run gen:brand` |

## Desktop app — DeskRAGApp

`app/` is a full desktop client for the library: configure providers, grant macOS
permissions, toggle capture signals, record, and search — no code required. See
[app/README.md](./app/README.md) for the detailed setup, permissions, and data notes.

```bash
npm install         # the library (root) — Node-ABI native modules for the test suite
npm run app:install # the app (own node_modules) — postinstall builds better-sqlite3 for Electron
npm run app:dev     # build the library, then launch the app
npm run app:build   # production build into app/out/
```

The app is a separate package with its own `app/node_modules`, so its
Electron-ABI `better-sqlite3` and the library's Node-ABI copy coexist — no more
rebuilding one and breaking the other.

**Three screens.**

- **Record** — a per-signal switchboard (screen, input, active window, microphone, accessibility tree), each with a status LED and an inline note when it's missing a macOS permission (with a Grant / Open Settings link) or a tool like `ffmpeg` or the AX sidecar. Plus an elapsed timecode and a start/stop that reports indexing stage by stage. Closing the window hides to a menu-bar tray that keeps recording and can start/stop from its menu.
- **Search** — a text query, or an image file as a visual example (gated on an image provider being configured). Results come back as a contact sheet of keyframes with score, timecode, wall-clock time, segment digest, and a highlight count; click one for a detail view with the full keyframe, region highlight boxes, the captured accessibility elements, and the segment's digest / caption / transcript.
- **Settings** — four groups of local configuration: models (text embeddings, image model, captions, Tier-4 rerank, model directory), Ollama (host + embedding/caption models), the local Whisper binary + model paths, and capture defaults (frame rate, keyframe max width, audio device, chunk seconds). No keys, because there is nothing to authenticate to.

**How it's wired.** `src/main` is the *only* process that touches the library, the
store, and native modules; `src/preload` is a typed `contextBridge`; `src/renderer`
(React) sees nothing but plain serializable DTOs and calls IPC. Keyframes reach the
UI over a custom `deskrag://` protocol rather than as base64.

**Degrades gracefully.** Text + behavioral search and keyframe thumbnails work with
nothing but Ollama running; every other model is optional, and a missing binary or
native module disables exactly one feature instead of breaking startup. Stopping a
recording auto-runs segment → represent, with the frame/caption/region and
transcript stages included only when their model is configured. Model weights are
downloaded once, verified against a pinned sha256, and then used offline.

**Data** lives under Electron's `<userData>/DeskRAG/` (in dev,
`~/Library/Application Support/deskrag-app/DeskRAG/`) — `app.db` (SQLite),
`lance/` (vectors), `blobs/` (keyframes + audio), `models/` (downloaded weights),
plus `settings.json`.

> **Native ABI note:** Electron ships its own Node ABI, which is why `app/` is not
> an npm workspace member: it keeps its own `app/node_modules` with a
> `better-sqlite3` rebuilt for Electron, while the library's root copy stays
> Node-ABI for `npm test`. Neither rebuild touches the other. `sharp`,
> `@lancedb/lancedb`, `uiohook-napi` and `active-win` are N-API/prebuilt and are
> never rebuilt.

## Requirements

- **Node ≥ 20**, macOS (native capture is macOS-focused today).
- Native npm modules build on install: `better-sqlite3`, `@lancedb/lancedb`, `sharp` (image crops).
- Optional, per feature:
  - **`ffmpeg`** on `PATH` — screen capture → grayscale (pHash) + MJPEG keyframes, and mic/desktop audio chunks.
  - **`uiohook-napi`**, **`active-win`** (optionalDependencies) — mouse/keyboard + focused-window capture.
  - **`swiftc`** (Xcode Command Line Tools) — build the accessibility sidecar: `npm run build:ax`.
  - **`whisper.cpp`** binary + a model file — local transcription of captured audio (set in the app under Settings → Transcription, or wire `WhisperCppTranscription` directly).
  - An **Ollama** daemon — text embeddings and VLM captions, if you'd rather not use the in-process ONNX path. Nothing else needs a network.
- **macOS permissions** for live capture: Screen Recording, Accessibility, and Input Monitoring (granted to the launching process — for the app, that's DeskRAGApp in dev, Electron).

## Install

```bash
npm install
npm run typecheck
npm test
npm run build:ax   # optional: compile the macOS accessibility sidecar (native/ax-dump)
```

To run the desktop app instead of using the library directly, see
[Desktop app — DeskRAGApp](#desktop-app--deskragapp).

## Usage shape

The pipeline composes explicit stages. Retrieval is a single call over the capstone `Retriever`; capture is a `CaptureSession` you attach signal producers to.

```ts
import {
  DualStore, BlobStore,
  CaptureSession, KeyframeGate,
  Segmenter, Representer, FrameRepresenter,
  Retriever, TextViewSearcher, BehaviorViewSearcher,
  FakeEmbeddingProvider, BehaviorFeatureExtractor,
} from "deskrag";

const store = await DualStore.open("meta.sqlite", "lancedb");
const blobs = new BlobStore("blobs");

// --- record ---------------------------------------------------------------
// Real producers are imported from their own paths (native / subprocess):
//   ./capture/producers/uiohook-input, /active-window, /ffmpeg-screen
//   ./capture/ax/swift-ax-source  (+ new StoredAxProvider(store).provide for regions)
const session = new CaptureSession(store, { blobStore: blobs, keyframeGate: new KeyframeGate() });
// session.addProducer(new UiohookInputProducer());
// session.addProducer(new ActiveWindowProducer());
// session.addProducer(new FfmpegScreenProducer({ input: "1", fps: 1 }));
const sessionId = await session.start();
// ... user works ...
await session.stop();

// --- represent ------------------------------------------------------------
const embed = new FakeEmbeddingProvider();            // swap for OllamaTextEmbedding / OnnxTextEmbedding
await new Segmenter(store).segment(sessionId);
await new Representer(store, { digestEmbedder: embed, behavior: new BehaviorFeatureExtractor() }).represent(sessionId);
await new FrameRepresenter(store, { imageEmbedder: embed, blobStore: blobs }).represent(sessionId);

// --- recall ---------------------------------------------------------------
const retriever = new Retriever(store, {
  searchers: [new TextViewSearcher(embed, "digest"), new BehaviorViewSearcher(new BehaviorFeatureExtractor())],
  imageEmbedder: embed,
});
const result = await retriever.retrieve({ text: "debugging the auth dialog" /*, image, behavior */ });
for (const frame of result.frames) {
  console.log(frame.score, frame.segmentId, frame.highlights.map((h) => h.label)); // region bboxes + labels
}
```

The **test suite is the executable documentation** — `test/assemble.test.ts` (full capture→retrieve), `test/tier2.test.ts` / `test/tier3.test.ts` (scoped retrieval + highlights), `test/dual-store.crash.test.ts` (crash recovery), and `test/ax.test.ts` (accessibility pipeline) each demonstrate a slice end to end.

## Providers

Every provider runs on this machine. There is no remote option — not a disabled
one, not a key field left blank. Adapters either talk to a daemon on localhost or
run the model in-process.

| Role | Provider | Model |
|---|---|---|
| Text embedding | Ollama (daemon) | `nomic-embed-text` |
| Text embedding | ONNX (in-process) | `nomic-embed-text-v1.5` (int8) |
| Image, late interaction | ONNX (in-process) | `colSmol-256M-dynamic` — patches *are* the regions, so highlights fall out of the MaxSim argmax |
| Behavioral vector | builtin | `input-dynamics-v1`, 12-dim |
| VLM caption | Ollama (daemon) | any vision model you've pulled, e.g. `qwen3-vl:4b` |
| Transcription (STT) | whisper.cpp (subprocess) | a `ggml-*.bin` on disk |
| Rerank (Tier 4) | ONNX (in-process) | `jina-reranker-v1-turbo-en` |

Weights are fetched once from HuggingFace at a **pinned commit SHA** and verified
against a recorded sha256 — a moving `main` would change the model while the
namespace kept claiming the same one, silently breaking vector comparability.
Acquisition lives in the app, never the library: `deskrag` on npm fetches nothing
at install or runtime.

`ImageEmbeddingProvider` (single-vector `frame_image` + `region_image` → Tier-3
region ANN and AX-label FTS) is a live seam with a deterministic fake behind it;
every provider has one, which is what keeps the test suite offline and
deterministic.

## Development

See [CLAUDE.md](./CLAUDE.md) for the architecture deep-dive and the load-bearing invariants. `npm run typecheck` is the primary gate; the test suite runs in ~6s and is deterministic (live/native tests skip cleanly when their dependency or credential is absent).

The app has its own gate — `npm --prefix app run typecheck` (renderer +
node configs) — and imports the library from `dist/`, so run `npm run build` after
changing `src/` before launching it (`npm run app:dev` does both).

## License

MIT — see [LICENSE](./LICENSE).
