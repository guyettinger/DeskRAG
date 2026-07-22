// embed/ — provider interfaces, namespacing, adapters
export * from "./embed/types.js";
export { FakeEmbeddingProvider } from "./embed/fake.js";
export { OllamaTextEmbedding } from "./embed/ollama.js";
export { VoyageTextEmbedding, VoyageImageEmbedding } from "./embed/voyage.js";
export { GeminiEmbedding } from "./embed/gemini.js";

// store/ — the dual-store seam
export * from "./store/types.js";
export { DualStore } from "./store/store.js";
export { BlobStore, type BlobWriteMeta } from "./store/blob-store.js";
export { hamming64, u64ToI64, i64ToU64 } from "./store/sqlite/db.js";

// timeline/ — monotonic clock, ring buffer, stream sync
export { MonotonicClock } from "./timeline/clock.js";
export { RingBuffer } from "./timeline/ring-buffer.js";
export { mergeSortedByTMono, isMonotonic, type Stamped } from "./timeline/sync.js";

// capture/ — producer contract + session orchestration
export type { Producer, CaptureContext, EmittedEvent, EventKind } from "./capture/types.js";
export { CaptureSession, type CaptureSessionOptions } from "./capture/session.js";
export { EventBatcher, type BatcherOptions } from "./capture/batcher.js";
export { SyntheticInputProducer } from "./capture/synthetic.js";
// accessibility capture (AX tree) — sidecar contract + no-op fallback
export type { AxSource } from "./capture/ax/types.js";
export { AxCapturer } from "./capture/ax/ax-capturer.js";
export { NoopAxSource } from "./capture/ax/noop.js";
export { SwiftAxSource, type SwiftAxSourceOptions } from "./capture/ax/swift-ax-source.js";
export { parseAxElements, coerceAxElements } from "./capture/ax/parse.js";
// frame pipeline (pure) + ffmpeg screen producer (child_process only).
// Native producers (uiohook-input, active-window) are intentionally NOT exported
// here so importing the package never loads their optional native modules;
// import them directly from "./capture/producers/…" when doing input/window capture.
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

// segment/ — boundary detection + multi-granularity windowing
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

// represent/ — per-segment embeddable views (event-only ones so far)
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
// region pipeline (Tier 3 represent/)
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
// caption view (view 2) — VLM captioning
export {
  CaptionRepresenter,
  type CaptionRepresenterOptions,
  type CaptionRepresentResult,
} from "./represent/caption/caption-representer.js";
export { FakeCaptionProvider } from "./represent/caption/fake.js";
export { AnthropicCaptionProvider, type AnthropicCaptionOptions } from "./represent/caption/anthropic.js";
export { GeminiCaptionProvider, type GeminiCaptionOptions } from "./represent/caption/gemini.js";

// retrieve/ — coarse-to-fine tiers (Tier 1: multi-view segment ANN + RRF)
export {
  reciprocalRankFusion,
  DEFAULT_RRF_K,
  type RankedList,
  type FusedItem,
} from "./retrieve/rrf.js";
export { Tier1Retriever } from "./retrieve/retriever.js";
export { Tier2Retriever, type Tier2Options } from "./retrieve/tier2.js";
export { Tier3Retriever, type Tier3Options } from "./retrieve/tier3.js";
export { Retriever, type RetrieverOptions } from "./retrieve/assemble.js";
export { TextViewSearcher, BehaviorViewSearcher } from "./retrieve/searchers.js";
// Tier-4 rerank
export type { Reranker, RerankCandidate } from "./retrieve/rerank/types.js";
export { FakeReranker } from "./retrieve/rerank/fake.js";
export { LLMReranker, type LLMRerankerOptions } from "./retrieve/rerank/llm.js";
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
