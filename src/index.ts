/**
 * `deskrag` — local-first multimodal desktop session memory.
 *
 * The public surface, grouped by pipeline stage: capture → segment → represent →
 * retrieve, over the dual store. Every stage is explicit and composed by the
 * caller; see docs/library-usage.md for the shape end to end.
 *
 * **Adapters that load a native module or spawn a subprocess are deliberately not
 * re-exported here** — `onnxruntime-node`, `uiohook-napi`, `active-win`, `sharp`,
 * and the ffmpeg/Swift sidecars — so importing this package never force-loads
 * native code. Import those from their own paths; each group below says which.
 */

/**
 * embed/ — the provider interfaces and the namespacing that keeps vector spaces
 * apart. Every vector is namespaced `view:provider:model:dimensions` via
 * `namespaceFor()`, and LanceDB keys one physical table per namespace, so two
 * models physically cannot land in one similarity search.
 *
 * The ONNX adapters (in-process models) live under `./embed/onnx/`.
 */
export * from "./embed/types.js";
export { FakeEmbeddingProvider, FakeMultiVectorProvider } from "./embed/fake.js";
export { OllamaTextEmbedding } from "./embed/ollama.js";

/**
 * store/ — the dual-store seam. SQLite is the relational source of truth and the
 * high-volume event firehose; LanceDB owns all vectors and scoped ANN. `DualStore`
 * is the only place both engines are known, and it enforces the write order
 * (SQLite commits first, then the Lance add) that makes a crash between them
 * recoverable. `BlobStore` is plain files — the store only records where they are.
 */
export * from "./store/types.js";
export { DualStore } from "./store/store.js";
export { BlobStore, type BlobWriteMeta } from "./store/blob-store.js";
export { hamming64, u64ToI64, i64ToU64 } from "./store/sqlite/db.js";

/**
 * timeline/ — the monotonic clock everything correlates on. Signals are stamped
 * with `t_mono`, an offset from a session epoch, never wall-clock: NTP steps and
 * DST would otherwise reorder events against each other.
 */
export { MonotonicClock } from "./timeline/clock.js";
export { RingBuffer } from "./timeline/ring-buffer.js";
export { mergeSortedByTMono, isMonotonic, type Stamped } from "./timeline/sync.js";

/**
 * capture/ — the producer contract and the session that orchestrates producers.
 * A `Producer` emits stamped events; `CaptureSession` batches them into the store
 * and owns blob reservation, so producers never touch the store themselves.
 */
export type { Producer, CaptureContext, EmittedEvent, EventKind, AudioChunk } from "./capture/types.js";
export { CaptureSession, type CaptureSessionOptions } from "./capture/session.js";
export { EventBatcher, type BatcherOptions } from "./capture/batcher.js";
export { SyntheticInputProducer } from "./capture/synthetic.js";

/**
 * Accessibility capture — the sidecar contract, its parser, and a no-op fallback.
 * AX is captured live and stored (`frame_ax`), then read back at represent time via
 * `StoredAxProvider`; it is never queried live during represent, because by then
 * the UI has moved on.
 */
export type { AxSource } from "./capture/ax/types.js";
export { AxCapturer } from "./capture/ax/ax-capturer.js";
export { NoopAxSource } from "./capture/ax/noop.js";
export { SwiftAxSource, type SwiftAxSourceOptions } from "./capture/ax/swift-ax-source.js";
export { parseAxElements, coerceAxElements } from "./capture/ax/parse.js";
export { nestAxElements } from "./capture/ax/tree.js";

/**
 * The frame pipeline (pure) plus the ffmpeg screen producer (`child_process` only,
 * hence barrel-safe). Native producers — uiohook-input, active-window — are
 * intentionally NOT exported here so importing the package never loads their
 * optional native modules; import them directly from `./capture/producers/…`
 * when doing input/window capture.
 */
export { dHash, resizeNearestGray } from "./capture/phash.js";
export { KeyframeGate, type KeyframeGateOptions, type GateDecision } from "./capture/keyframe.js";
export {
  FrameIngestor,
  type SampledFrame,
  type IngestResult,
} from "./capture/frame-ingest.js";
export { FrameChunker } from "./capture/frame-chunker.js";
export { JpegStreamSplitter } from "./capture/jpeg-splitter.js";
export {
  FfmpegScreenProducer,
  type FfmpegScreenOptions,
} from "./capture/producers/ffmpeg-screen.js";

/** Audio capture (`child_process` only, like the screen producer) + a WAV helper. */
export {
  FfmpegAudioProducer,
  type FfmpegAudioOptions,
} from "./capture/producers/ffmpeg-audio.js";
export { encodeWav, type WavFormat } from "./capture/producers/wav.js";

/**
 * segment/ — boundary detection plus multi-granularity overlapping windowing.
 * Boundaries are event-driven (focus change, dwell gap, bookmark); segments are
 * detected after capture, which is why frame↔segment association is set lazily at
 * represent time.
 */
export { Segmenter, type SegmentResult } from "./segment/segmenter.js";
export { computeBoundaries } from "./segment/boundaries.js";
export { windowSegments } from "./segment/windowing.js";
export {
  DEFAULT_GRANULARITIES,
  DEFAULT_DWELL_GAP_MS,
  type Boundary,
  type BoundaryReason,
  type GranularityConfig,
  type SegmenterOptions,
} from "./segment/types.js";

/**
 * represent/ — the embeddable views. `Representer` builds the event-only ones
 * (digest text + behavioral vector); the frame-dependent ones each have their own
 * representer so they can be skipped when their provider is not configured.
 */
export { buildDigest, type DigestEvent } from "./represent/digest.js";
export {
  BehaviorFeatureExtractor,
  BEHAVIOR_MODEL,
  BEHAVIOR_DIMENSIONS,
  type BehaviorEvent,
  type TimeWindow,
} from "./represent/behavior.js";
export {
  Representer,
  type RepresenterOptions,
  type RepresentResult,
} from "./represent/representer.js";
export {
  FrameRepresenter,
  type FrameRepresenterOptions,
  type FrameRepresentResult,
} from "./represent/frame-representer.js";
/**
 * Multi-vector counterpart of `FrameRepresenter` (the `frame_patches` view).
 * Barrel-safe: the provider is injected, so nothing native loads from here.
 */
export {
  FramePatchRepresenter,
  type FramePatchRepresenterOptions,
  type FramePatchRepresentResult,
} from "./represent/frame-patch-representer.js";

/**
 * The region pipeline (Tier 3) — the PixelRAG edge. Three proposal sources fuse via
 * NMS with a cross-source agreement bump: the AX tree (real labeled bboxes),
 * interaction hotspots (weighted DBSCAN over clicks/dwell — the signal video RAG
 * lacks), and grid tiling. `RegionCropper` is an interface; the sharp-backed
 * implementation is native and lives at `./represent/regions/sharp-cropper.js`.
 */
export { axFilter, type AxFilterOptions } from "./represent/regions/ax.js";
export {
  dbscanWeighted,
  eventsToPoints,
  hotspotRegions,
  DEFAULT_EVENT_WEIGHTS,
  type WeightedPoint,
  type HotspotOptions,
} from "./represent/regions/hotspots.js";
export { gridRegions, type GridOptions } from "./represent/regions/grid.js";
export { fuseRegions, type FuseOptions } from "./represent/regions/fuse.js";
export {
  FusedRegionProposer,
  type RegionSignals,
  type FusedProposerOptions,
} from "./represent/regions/proposer.js";
export {
  iou,
  area,
  intersectionArea,
  clampToFrame,
  type Box,
} from "./represent/regions/geometry.js";
export type { RegionCropper } from "./represent/regions/cropper.js";
export {
  RegionRepresenter,
  type RegionRepresenterOptions,
  type RegionRepresentResult,
} from "./represent/regions/region-representer.js";
export { StoredAxProvider } from "./represent/regions/stored-ax-provider.js";

/** The caption view — a local VLM describes each keyframe. */
export {
  CaptionRepresenter,
  type CaptionRepresenterOptions,
  type CaptionRepresentResult,
} from "./represent/caption/caption-representer.js";
export { FakeCaptionProvider } from "./represent/caption/fake.js";
/**
 * Local VLM captioner. Barrel-safe (plain fetch); `listVisionModels` is what the
 * app's model picker must use — see its doc comment for why a hardcoded list is
 * unsafe now that Ollama's library includes cloud-hosted models.
 */
export {
  OllamaCaptionProvider,
  listVisionModels,
  type OllamaCaptionOptions,
} from "./represent/caption/ollama.js";

/**
 * The transcript view (STT). The `FakeTranscription` and the representer are pure;
 * `WhisperCppTranscription` spawns a subprocess, but takes its binary path as
 * configuration rather than loading a native module, so it stays barrel-safe.
 */
export {
  TranscriptRepresenter,
  type TranscriptRepresenterOptions,
  type TranscriptRepresentResult,
} from "./represent/transcript/transcript-representer.js";
export { FakeTranscription } from "./represent/transcript/fake.js";
export {
  WhisperCppTranscription,
  type WhisperCppOptions,
} from "./represent/transcript/whisper-cpp.js";

/**
 * retrieve/ — the coarse-to-fine tiers. Each narrows the scope the next one
 * searches, and retrieval never widens: Tier 1 fuses per-view segment ANN with
 * Reciprocal Rank Fusion (not score averaging — the scales differ), Tier 2 searches
 * frames scoped to those segments, Tier 3 searches regions scoped to those frames,
 * and `Retriever` assembles the result with `highlights` — the matched region boxes
 * and labels that say *where* on the recalled frame the match is.
 */
export {
  reciprocalRankFusion,
  DEFAULT_RRF_K,
  type RankedList,
  type FusedItem,
} from "./retrieve/rrf.js";
export { Tier1Retriever } from "./retrieve/retriever.js";
export { Tier2Retriever, type Tier2Options } from "./retrieve/tier2.js";
export {
  Tier2MultiVectorRetriever,
  type Tier2MultiVectorOptions,
} from "./retrieve/tier2-mv.js";
export { Tier3Retriever, type Tier3Options } from "./retrieve/tier3.js";
export { Retriever, type RetrieverOptions } from "./retrieve/assemble.js";
export { TextViewSearcher, BehaviorViewSearcher } from "./retrieve/searchers.js";
/**
 * Tier-4 rerank. The real reranker is a local ONNX cross-encoder and therefore NOT
 * here — import it from `./retrieve/rerank/onnx.js`.
 */
export type { Reranker, RerankCandidate } from "./retrieve/rerank/types.js";
export { FakeReranker } from "./retrieve/rerank/fake.js";
export type {
  Query,
  ViewSearcher,
  SegmentHit,
  PerViewHit,
  FrameHit,
  RegionHit,
  FrameResult,
  AssembledResult,
  RetrieverWeights,
  RetrievalResult,
  Tier1Options,
} from "./retrieve/types.js";
