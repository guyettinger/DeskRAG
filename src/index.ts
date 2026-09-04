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
 * What each selectable text model needs from the adapter, as data. Barrel-safe
 * on purpose — plain objects, no native module — so a CONSUMER that only pins
 * and downloads weights (the app's model manifest) can read the same prefixes
 * and dimensions the adapter runs on, instead of restating them beside a
 * download URL and drifting.
 */
export {
  EMBEDDINGGEMMA_PROFILE,
  NOMIC_PROFILE,
  TEXT_PROFILES,
  textProfile,
} from "./embed/text-profiles.js";
export type { TextModelId, TextModelProfile, TextOutput } from "./embed/text-profiles.js";
/**
 * The composing provider — it partitions a level AND names each run in one
 * call. Barrel-safe like every other Ollama adapter: plain fetch, no native
 * module, so importing the package loads nothing until it runs.
 */
export { FakeSummaryProvider } from "./embed/summary.js";
export type { ComposeContext, SummaryProvider } from "./embed/summary.js";
export { OllamaSummaryProvider, listSummaryModels } from "./embed/ollama-summary.js";
export type { OllamaSummaryOptions } from "./embed/ollama-summary.js";
/**
 * Habit prose — the PROSE half of a HABIT.md, never the record. The four-field
 * reply shape is what keeps a model from rewriting steps it did not observe.
 * Barrel-safe: an interface, a deterministic fake, two pure functions, and an
 * adapter that only calls `fetch`.
 */
export {
  FakeHabitProseProvider,
  parseHabitResponse,
  habitPrompt,
  HABIT_SYSTEM,
} from "./embed/habit-prose.js";
export type { HabitBrief, HabitProse, HabitProseProvider } from "./embed/habit-prose.js";
export { OllamaHabitProseProvider } from "./embed/ollama-habit-prose.js";
export type { OllamaHabitProseOptions } from "./embed/ollama-habit-prose.js";

/**
 * The note written after a recording — what it was for, what stalled, what order
 * would have been better. MODEL-ONLY and with no template path: a rollup can
 * honestly name a stretch of work, but it cannot honestly say a session dragged,
 * so with no model configured there is simply no note. Same four-string seam as
 * habit prose, and for the same reason — a reflection reaches a habit as an
 * opinion in the prompt and can never reach the record.
 */
export {
  FakeReflectionProvider,
  parseReflectionResponse,
  reflectionPrompt,
  renderReflection,
  REFLECTION_HEADINGS,
  REFLECTION_SYSTEM,
} from "./embed/reflection.js";
export type {
  ReflectionBrief,
  ReflectionProvider,
  SessionReflection,
} from "./embed/reflection.js";
export { OllamaReflectionProvider } from "./embed/ollama-reflection.js";
export type { OllamaReflectionOptions } from "./embed/ollama-reflection.js";
export { firstJsonObject } from "./embed/json-reply.js";

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
/**
 * The capture device's timebase, bridged onto t_mono. Without it a frame can
 * only be timed by when it ARRIVED, which is a whole capture latency after the
 * moment it shows — measured 3.05s on a real screen device.
 */
export { DeviceClock } from "./timeline/device-clock.js";
export { RingBuffer } from "./timeline/ring-buffer.js";
export { mergeSortedByTMono, isMonotonic, type Stamped } from "./timeline/sync.js";

/**
 * capture/ — the producer contract and the session that orchestrates producers.
 * A `Producer` emits stamped events; `CaptureSession` batches them into the store
 * and owns blob reservation, so producers never touch the store themselves.
 */
export type {
  Producer,
  CaptureContext,
  EmittedEvent,
  EventKind,
  AudioChunk,
  CaptureActivity,
  ActivityObserver,
} from "./capture/types.js";
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
export {
  KeyframeBudget,
  DEFAULT_KEYFRAME_MIN_INTERVAL_MS,
  type KeyframeBudgetOptions,
} from "./capture/keyframe-budget.js";
export {
  FrameIngestor,
  type SampledFrame,
  type IngestResult,
} from "./capture/frame-ingest.js";
export { FrameChunker } from "./capture/frame-chunker.js";
export { JpegStreamSplitter } from "./capture/jpeg-splitter.js";
export {
  FfmpegScreenProducer,
  DEFAULT_DECIMATE,
  type FfmpegScreenOptions,
  type DecimateOptions,
} from "./capture/producers/ffmpeg-screen.js";
export {
  DEFAULT_AUDIO_INPUT,
  listAvfoundationDevices,
  parseAvfoundationDevices,
  resetDeviceCache,
  resolveAudioInput,
  resolveScreenInput,
  screenDeviceIndex,
  type AudioInputResolution,
  type AvfDevice,
  type AvfDevices,
  type DeviceProbe,
  type ListDevicesOptions,
} from "./capture/producers/avfoundation-devices.js";

/** Audio capture (`child_process` only, like the screen producer) + a WAV helper. */
export {
  FfmpegAudioProducer,
  type FfmpegAudioOptions,
} from "./capture/producers/ffmpeg-audio.js";
export {
  SystemAudioProducer,
  type SystemAudioOptions,
} from "./capture/producers/system-audio.js";
export {
  parseAudioTapAnchor,
  type AudioTapAnchor,
} from "./capture/audio-tap-anchor.js";
export { encodeWav, wavPeaks, type WavFormat, type WavPeaks } from "./capture/producers/wav.js";

/**
 * segment/ — boundary detection plus multi-granularity overlapping windowing.
 * Boundaries are event-driven (focus change, dwell gap, bookmark); segments are
 * detected after capture, which is why frame↔segment association is set lazily at
 * represent time.
 */
export { Segmenter, type SegmentResult } from "./segment/segmenter.js";
export { computeBoundaries, MEANINGFUL_INPUT_KINDS } from "./segment/boundaries.js";
export { windowSegments } from "./segment/windowing.js";
export {
  BASE_GRANULARITIES,
  resolveGranularities,
  DEFAULT_DWELL_GAP_MS,
  DEFAULT_BURST_GAP_MS,
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
export {
  buildDigest,
  DEFAULT_MAX_TYPED_CHARS,
  type DigestContext,
  type DigestEvent,
} from "./represent/digest.js";
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
/**
 * Frame↔segment association, split out so it can run WITHOUT an image provider.
 * Text-only retrieval recalls frames purely by segment membership, so these
 * links are the difference between search working and returning nothing.
 */
export {
  associateFrames,
  segmentIdsForFrame,
  sessionEndOf,
} from "./represent/frame-segments.js";
/**
 * Frame↔AX association. Capture cannot know which frame a walk describes — the
 * walk starts when a frame ARRIVES, a whole capture latency after the pixels it
 * shows — so the walk is assigned here instead, by content time.
 */
export { associateFrameAx, nearestFrameId } from "./represent/frame-ax.js";
/**
 * The lexical index pass — the last represent stage. Needs no provider, so like
 * `associateFrames` it always runs.
 */
export { indexSegmentText, type SegmentTextResult } from "./represent/segment-text.js";
/**
 * The compositional hierarchy. Level 0 is windowed by `segment/`; every level
 * above it is COMPOSED here from what those actions mean together, up to one
 * root whose summary is the session's purpose.
 *
 * Always on: the structural path needs no provider, and a configured
 * `SummaryProvider` upgrades the prose without changing the shape.
 */
export {
  ComposeRepresenter,
  LEAF_GRANULARITY,
  LEVEL_PREFIX,
  ROOT_GRANULARITY,
  type ComposeRepresenterOptions,
  type ComposeResult,
} from "./represent/compose/compose-representer.js";
export { LEVELS, composeLadder, type ComposeFn } from "./represent/compose/levels.js";
export { LEVEL_GRANULARITY, levelQualifies } from "./represent/compose/admission.js";
export type {
  ChildSummary,
  ComposeGroup,
  Ladder,
  LadderChild,
  LadderNode,
  LevelKind,
} from "./represent/compose/types.js";
/**
 * Typed text runs coalesced at SESSION scope — deliberately a different
 * grouping policy from `groupGestures`, which must flush on any non-key event
 * because a replayable `type` action has to be contiguous. See typed-runs.ts.
 */
export {
  typedRuns,
  typedTextOverlapping,
  DEFAULT_RUN_GAP_MS,
  type TypedRun,
  type TypedRunOptions,
} from "./represent/typed-runs.js";
/**
 * The `frame_patches` view — the ONLY frame vector there is, since the
 * single-vector image lane was removed. Barrel-safe: the provider is injected,
 * so nothing native loads from here.
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
/**
 * The captioner's own width cap. `ImageDownscaler` is an interface; the
 * sharp-backed implementation is native and lives at
 * `./represent/caption/sharp-downscale.js` — the same arrangement as
 * `RegionCropper`, and for the same reason.
 */
export type { ImageDownscaler } from "./represent/caption/downscale.js";
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
export {
  Tier2MultiVectorRetriever,
  type Tier2MultiVectorOptions,
} from "./retrieve/tier2-mv.js";
export { Tier3Retriever, type Tier3Options } from "./retrieve/tier3.js";
export { Retriever, type RetrieverOptions } from "./retrieve/assemble.js";
export {
  TextViewSearcher,
  BehaviorViewSearcher,
  LexicalSegmentSearcher,
} from "./retrieve/searchers.js";
/**
 * Tier-4 rerank. The real reranker is a local ONNX cross-encoder and therefore NOT
 * here — import it from `./retrieve/rerank/onnx.js`.
 */
export type { Reranker, RerankCandidate } from "./retrieve/rerank/types.js";
export { FakeReranker } from "./retrieve/rerank/fake.js";
export type {
  Query,
  ViewSearcher,
  LexicalSearcher,
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
/**
 * `isLocatable` is exported for the app's graph projection: a node whose
 * identity is only `app` VERIFIES perfectly and LOCATES never, and the reviewer
 * has to be told that before a node is chosen as a goal. Pure, in `trace/`,
 * loads nothing native.
 */
export { isLocatable } from "./trace/identity-set.js";

/**
 * How settled a node or an edge is, from the recordings it came from. Derived
 * on every call and stored NOWHERE — see the header of `trace/stability.ts`
 * and docs/internals/persistence.md.
 */
export {
  stabilityOf,
  CORE_SESSIONS,
  type Stability,
  type StabilityTier,
} from "./trace/stability.js";
/**
 * The site-level prefix rule — id-like path segments dropped, capped at 3.
 * Exported so anything that displays a recorded URL reads it the same way node
 * identity does, rather than growing a second, quietly different prefix rule.
 */
export { urlPrefix } from "./trace/url.js";
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
/**
 * The recorder is not part of the work it records. Lifting is re-runnable over
 * recordings already on disk, so a filter at that layer repairs an existing
 * library — which is why this is exported rather than living in the app.
 */
export {
  excludeFocusedApps,
  excludedByName,
  focusOf,
  type ExcludedFocus,
  type ExcludeResult,
} from "./trace/exclude.js";
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
/**
 * The capture clock. `ax-dump --clock` reads the base avfoundation stamps
 * capture timestamps on, which Node cannot read for itself — without it a frame
 * can only be timed by when it arrived, measured 3.05s after it was captured.
 */
export {
  SwiftDeviceClockSource,
  type SwiftDeviceClockSourceOptions,
} from "./capture/env/swift-clock.js";
export { parseDeviceClock } from "./capture/env/clock.js";
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
  type EdgeRecency,
  type ExecOutcome,
  type Locate,
  type LocateHit,
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
export { locateNode } from "./replay/locate.js";
export { executeRun } from "./replay/run.js";
export { observe, predicatesOf, surfaceOriginOf, windowOriginOf } from "./replay/observe.js";
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
