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

/**
 * trace/ — the experience trace IR. A recorded session lifts into a linear
 * `Trace`; merging traces at equivalent states accretes a `Graph` whose nodes are
 * verified states and whose edges are action sequences. Variation therefore comes
 * from recording a task more than once, not from a model inventing alternatives.
 *
 * Pure TypeScript — no native modules, no subprocesses — which is why, unlike the
 * executor, it belongs in this barrel. Everything it needs from the store arrives
 * through injected callbacks (`VisualMatcher`, `LiftInput.axAt`).
 */
export * from "./trace/types.js";
export { fitPath, projectPath, VELOCITY_SAMPLES, type PathSample } from "./trace/paths.js";
export {
  extractPredicates,
  predicateKey,
  samePredicateSet,
  isVolatileLabel,
  DEFAULT_MAX_AX_PREDICATES,
  type PredicateContext,
} from "./trace/predicates.js";
export { buildAnchor, axPathOf, hitTest, anchorKey, type AnchorInput } from "./trace/anchors.js";
export {
  matchNode,
  DEFAULT_VISUAL_THRESHOLD,
  DEFAULT_VISUAL_MARGIN,
  type MatchOptions,
  type MatchResult,
} from "./trace/identity.js";
export {
  groupGestures,
  DEFAULT_GESTURE_OPTIONS,
  type Gesture,
  type GestureOptions,
} from "./trace/gestures.js";
export {
  liftTrace,
  resolveKeys,
  slotNameFor,
  type LiftInput,
  type AxSnapshot,
  type RegionsAtFrame,
} from "./trace/lift.js";
export { mergeTrace, edgeSignature, actionSignature, discoveredVariables } from "./trace/merge.js";
export {
  printGraph,
  parseGraph,
  printInterventionRequest,
  parseInterventionResponse,
} from "./trace/language.js";

/**
 * capture/env/ — display topology and keyboard layout. Both are facts that can
 * change mid-session and both fail SILENTLY when they do (a coordinate
 * attributed to the wrong display, text resolved against the wrong layout), so
 * both are captured as `t_mono`-stamped events and resolved at lift time by
 * "latest at-or-before".
 *
 * The Swift-backed sources ARE exported, alongside `SwiftAxSource`. The barrel
 * rule bars adapters that load a NATIVE MODULE at import time; these three only
 * `execFile` a binary, so importing them loads nothing and costs nothing. The
 * genuinely native adapters (`onnxruntime-node`, `uiohook-napi`, `active-win`,
 * `sharp`) remain out.
 */
export type {
  DisplayInfo,
  DisplaySource,
  Keymap,
  KeymapSource,
} from "./capture/env/types.js";
export { coerceDisplays, coerceKeymap } from "./capture/env/parse.js";
export {
  displayIdAt,
  outsideKnownDisplays,
  type Bounds,
  type Point2,
} from "./capture/env/displays.js";
export { macKeycodeFor, resolveChar } from "./capture/env/keymap.js";
export { FakeDisplaySource, FakeKeymapSource } from "./capture/env/fake.js";
export {
  SwiftDisplaySource,
  type SwiftDisplaySourceOptions,
} from "./capture/env/swift-displays.js";
export { SwiftKeymapSource, type SwiftKeymapSourceOptions } from "./capture/env/swift-keymap.js";
export {
  shouldSampleMove,
  modifiersOf,
  DEFAULT_SAMPLE_OPTIONS,
  type SampleOptions,
  type SampleState,
} from "./capture/producers/sampling.js";
export { KeymapProducer, type KeymapProducerOptions } from "./capture/producers/keymap-producer.js";
export { BoundaryAxTrigger, type BoundaryAxTriggerOptions } from "./capture/ax/boundary.js";

// --- replay/ (the executor) ------------------------------------------------
// Spawns a subprocess but loads no native module, so it belongs in the barrel:
// importing it loads nothing until it runs.
export {
  agreement,
  isRepairStep,
  isSupersededStep,
  LAYER_CEILING,
  pathCeiling,
  pathDepth,
  ceilingFor,
  BRITTLENESS_FLOOR,
  DEFAULT_MIN_CONFIDENCE,
  type ActivateOutcome,
  type Actuator,
  type AxDescriptor,
  type AxObservation,
  type Blocker,
  type EdgeBrittleness,
  type ExecOutcome,
  type Locate,
  type NodeLocation,
  type Plan,
  type PlannedAction,
  type PlanStep,
  type RemainderAction,
  type RemainderEdge,
  type RepairStep,
  type ReplayInput,
  type Resolution,
  type ResolvedLayer,
  type RunInput,
  type RunOutcome,
  type RunStop,
  type SegmentCut,
  type SupersededStep,
} from "./replay/types.js";
export { observe, windowOriginOf } from "./replay/observe.js";
export { resolveAnchor, type ResolveOptions } from "./replay/resolve.js";
export {
  verifyNode,
  blockersOf,
  repairableOf,
  type VerifyResult,
  type Violation,
} from "./replay/verify.js";
export { reverseKeymap, strokesFor, type KeyStroke } from "./replay/typing.js";
export { buildPlan, findPath, edgeCost, type BuildPlanInput } from "./replay/plan.js";
export { canArm, executePlan, type ExecuteOptions } from "./replay/execute.js";
export { AxExecSidecar, type SidecarOptions } from "./replay/sidecar.js";
