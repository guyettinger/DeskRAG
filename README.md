# Experience RAG

**Local-first, multimodal desktop session memory.** Experience RAG captures what happens on your desktop — screen video, desktop + mic audio, mouse/keyboard input, active window, and the OS accessibility tree — into a searchable "experience memory," then lets you recall past moments by:

- **semantic query** — *"that time I was debugging auth"*
- **visual example** — *"find this screen / this dialog"*
- **behavioral similarity** — *"sessions like what I'm doing now"*

It's inspired by VideoRAG and PixelRAG, with a key advantage over pure-pixel systems: on the desktop we read real UI structure from the **accessibility tree**, giving free, labeled region proposals — grounded bounding boxes and roles that video systems must infer.

Everything runs locally. TypeScript throughout, strict types, pluggable AI providers (local Ollama / ONNX, or remote Voyage / Gemini / Anthropic).

---

## Highlights

- **Dual-store, crash-safe** — SQLite (`better-sqlite3`, WAL) is the relational source of truth + event firehose; LanceDB owns all vectors + scoped ANN. A strict write-order + reconciliation protocol survives crashes between the two engines (proven by a real kill-the-process recovery test).
- **Structural vector discipline** — every embedding is namespaced `view:provider:model:dims`, with one physical LanceDB table per namespace, so incomparable vector spaces *cannot* be mixed in a search.
- **Monotonic timeline** — all correlation is on a monotonic `t_mono` clock, immune to wall-clock/NTP/DST jumps.
- **Six embeddable views** per experience — transcript, VLM caption, structured-event digest, behavioral feature vector, whole-frame image, and region image.
- **Coarse-to-fine retrieval** — pHash → segment RRF → frame ANN → region ANN + accessibility-label full-text search → optional LLM rerank — returning **highlights**: the matched region bounding boxes + labels to outline *where* on the recalled frame the match is.
- **The PixelRAG edge, grounded** — region proposals fuse the accessibility tree, interaction hotspots (weighted DBSCAN over clicks/dwell — a signal video RAG can't have), and grid tiling.

## Architecture

```
 capture/                 segment/            represent/                         retrieve/
 ─────────                ────────            ──────────                         ────────
 uiohook  (input)     ┐   event-driven    ┐   transcript*  digest   ┐   Tier0 pHash prefilter
 active-win (focus)   │   boundaries      │   caption      behavior │   Tier1 segment ANN + RRF
 ffmpeg  (screen→JPEG)├─▶ + multi-        ├─▶ frame-image  region-  ├─▶ Tier2 frame ANN  (scoped)
 ax-dump (AX tree)    │   granularity     │   image                 │   Tier3 region ANN + AX-FTS
 (mic/desktop audio)  ┘   overlapping     ┘   (each → a namespaced  ┘   Tier4 LLM rerank (optional)
                          windows              vector space)             → assemble → ranked frames
                                                                            + region highlights
        store/  ──  SQLite (relational truth + event firehose)  ⇄  LanceDB (vectors + scoped ANN)
                    shared ULID keys · SQLite-first writes · one-directional reconciliation
```
*Transcript view: schema + interfaces are in place; the STT producer is future work.*

## Requirements

- **Node ≥ 20**, macOS (native capture is macOS-focused today).
- Native npm modules build on install: `better-sqlite3`, `@lancedb/lancedb`, `sharp` (image crops).
- Optional, per feature:
  - **`ffmpeg`** on `PATH` — screen capture → grayscale (pHash) + MJPEG keyframes.
  - **`uiohook-napi`**, **`active-win`** (optionalDependencies) — mouse/keyboard + focused-window capture.
  - **`swiftc`** (Xcode Command Line Tools) — build the accessibility sidecar: `npm run build:ax`.
  - Provider keys for remote embedders/captioners: `VOYAGE_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`; or a local Ollama daemon.
- **macOS permissions** for live capture: Screen Recording, Accessibility, and Input Monitoring (granted to the launching process).

## Install

```bash
npm install
npm run typecheck
npm test
npm run build:ax   # optional: compile the macOS accessibility sidecar (native/ax-dump)
```

## Usage shape

The pipeline composes explicit stages. Retrieval is a single call over the capstone `Retriever`; capture is a `CaptureSession` you attach signal producers to.

```ts
import {
  DualStore, BlobStore,
  CaptureSession, KeyframeGate,
  Segmenter, Representer, FrameRepresenter,
  Retriever, TextViewSearcher, BehaviorViewSearcher,
  FakeEmbeddingProvider, BehaviorFeatureExtractor,
} from "experience-rag";

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
const embed = new FakeEmbeddingProvider();            // swap for Voyage / Gemini / Ollama
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

| Role | Local | Remote |
|---|---|---|
| Text embedding | Ollama (`nomic-embed-text`) | Voyage (`voyage-3`), Gemini (`gemini-embedding-2`) |
| Image embedding | — | Voyage (`voyage-multimodal-3`), Gemini (`gemini-embedding-2`) — shared text/image space |
| Behavioral vector | builtin (`input-dynamics-v1`, 12-dim) | — |
| VLM caption | — | Anthropic (`claude-opus-4-8`), Gemini |
| LLM rerank | — | Anthropic (`claude-opus-4-8`) |

Anthropic has no embeddings endpoint — pair it (captioning/rerank) with a local embedder or Voyage/Gemini for vectors. Every provider has a deterministic **fake** used in tests.

## Development

See [CLAUDE.md](./CLAUDE.md) for the architecture deep-dive and the load-bearing invariants. `npm run typecheck` is the primary gate; the test suite runs in ~6s and is deterministic (live/native tests skip cleanly when their dependency or credential is absent).

## License

MIT — see [LICENSE](./LICENSE).
