/**
 * Shared contracts between the Electron main process and the renderer. Kept free
 * of any Node or library imports so both sides can depend on it. The renderer
 * only ever sees these plain, serializable shapes — never the DeskRAG library
 * objects, the store, or native code.
 */

// --- signals -----------------------------------------------------------------

export type SignalKind = "screen" | "input" | "active-win" | "audio" | "ax";

export interface SignalConfig {
  screen: { enabled: boolean; fps: number; imageMaxWidth: number };
  input: { enabled: boolean };
  activeWin: { enabled: boolean };
  audio: { enabled: boolean; device: string; chunkSeconds: number };
  ax: { enabled: boolean };
}

// --- providers / settings ----------------------------------------------------

/**
 * Every provider runs on this machine. There is no remote option and no API key
 * anywhere in the app — that is the privacy guarantee, made structural rather
 * than left to how the user filled in Settings.
 */

/**
 * Which local text model embeds digest, caption, transcript and summary text.
 *
 * It was `TextProvider = "ollama" | "onnx"` with the Ollama model typed into a
 * FREE-TEXT box, and that combination is gone for a reason that was measured on
 * a real store rather than argued: a 30B chat model typed into that box minted
 * `digest:ollama:muse-glimmer:768` and a Lance table declaring 768 floats, then
 * failed on the add. Two dead vector spaces, no error on screen. The dimension
 * was hardcoded 768 and never read from the model, so ANY 1024-dim choice
 * (bge-m3, qwen3-embedding, mxbai) would have done the same — a dropdown over
 * whatever the daemon happened to have pulled would ship the same bug wearing a
 * `<select>`.
 *
 * So the menu is PINNED instead of discovered. Every entry is a real ONNX export
 * with a checked-in SHA, a declared dimension, and its own prefixes — see
 * `TEXT_PROFILES` in the library, which this list must stay in step with.
 *
 * The consequence is that text embedding no longer needs a daemon at ALL. Ollama
 * remains for captions and summaries; it is no longer on the path between a
 * query and a text result, which is the path a default install depends on.
 */
export type TextModelId = "nomic-embed-text-v1.5" | "embeddinggemma-300m";
/**
 * The visual path: ColModernVBERT, or nothing.
 *
 * It was a menu of four — `nomic` (single-vector) and `colsmol` alongside this —
 * and the bake-off that produced that menu is over. Keeping the losers cost two
 * model adapters, a 953MB download entry, an export toolchain, a whole
 * single-vector retrieval lane, and a settings control asking the user to make a
 * decision that had already been made. All of it is gone; a persisted `"nomic"`
 * or `"colsmol"` MIGRATES here (see `PROVIDER_MIGRATIONS`) and needs a re-index.
 *
 * `colmodernvbert` is late interaction, so ONE model embeds both images and text
 * into ONE space — which is what lets a TEXT query reach frames directly, and
 * what nomic could never do. Its patches ARE the regions, so Tier 3 stays
 * AX-label FTS only on this path, exactly as it already was.
 *
 * `none` is the DEFAULT and stays on the menu: it is the whole of what
 * optionality buys once there is one model worth running.
 */
export type ImageProvider = "none" | "colmodernvbert";
export type CaptionProvider = "none" | "ollama";
export type RerankProvider = "none" | "onnx";
/**
 * The model that composes actions into tasks and names each one.
 *
 * "none" does NOT disable the hierarchy — the tree is always built, from
 * structural coherence, and every node gets a templated rollup. A model
 * upgrades the prose without changing the shape, which is why this is the one
 * provider whose absence costs no capability.
 */
export type SummaryProvider = "none" | "ollama";

export interface ProviderSettingsView {
  ollamaHost: string;
  /** The VLM used for captions — distinct from the embedding model. */
  ollamaCaptionModel: string;
  /** The chat model used to compose and name levels — distinct from both above. */
  ollamaSummaryModel: string;
  /**
   * There is no `ollamaModel` beside these two any more: text embedding left
   * Ollama entirely and is `textModel` below. Ollama is still on this screen,
   * but no longer between a query and a text result.
   */
  textModel: TextModelId;
  imageProvider: ImageProvider;
  captionProvider: CaptionProvider;
  summaryProvider: SummaryProvider;
  rerankProvider: RerankProvider;
  /** "" means managed downloads under the app data dir. */
  localModels: { dir: string };
  whisper: { binaryPath: string; modelPath: string };
}

/**
 * The MCP server's own settings.
 *
 * `port` is fixed rather than auto-assigned on purpose: the user pastes a URL
 * into an agent's config once, and a server that quietly moved to a free port
 * would present as broken with nothing on screen to say why. A bind failure is
 * reported instead — see `McpStatusDTO.error`.
 */
export interface McpSettings {
  enabled: boolean;
  port: number;
}

export interface SettingsView {
  providers: ProviderSettingsView;
  signals: SignalConfig;
  mcp: McpSettings;
}

export interface SettingsPatch {
  providers?: Partial<
    Omit<ProviderSettingsView, "whisper" | "localModels"> & {
      whisper: Partial<{ binaryPath: string; modelPath: string }>;
      localModels: Partial<{ dir: string }>;
    }
  >;
  signals?: DeepPartial<SignalConfig>;
  mcp?: Partial<McpSettings>;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Weight-download progress. Its own channel rather than a stage of
 * IndexingProgress, because a download can begin from a SEARCH as well as from
 * indexing — weights are fetched lazily on first use.
 */
export interface ModelDownloadProgress {
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
}

/**
 * What library features are usable given the current settings (renderer gating).
 *
 * Configured INTENT, so every member is a provider choice. Transcription has no
 * member and must not get one back: both whisper settings default when empty
 * (managed model, `whisper-cli` on PATH), so no setting expresses "off" and the
 * answer would be a constant `true`. Whether it can actually run is a fact about
 * the machine, not the settings — `EnvInfo.whisperConfigured`.
 */
export interface Capabilities {
  imageSearch: boolean;
  caption: boolean;
  appCaption: boolean;
  rerank: boolean;
}

// --- recording ---------------------------------------------------------------

/**
 * TWO STATES, not three. `"indexing"` used to be one of them, and that single
 * fact is what made recording and indexing mutually exclusive: `startRecording`
 * refuses whenever the state is not `"idle"`, so the record button was dead for
 * as long as the last recording took to index — measured at about ten minutes
 * over 546 frames with an image provider configured.
 *
 * Indexing is now a QUEUE with its own status (`IndexQueueDTO`) and its own
 * screen. Do not reintroduce a member here to represent it: the guards that read
 * this state are about the CAPTURE device, and a queue draining in the
 * background is not a reason to refuse a recording. It is the reason the queue
 * exists.
 */
export type RecordingState = "idle" | "recording";

export interface RecordingStatus {
  state: RecordingState;
  sessionId?: string;
  /** Wall-clock ms when recording started (for elapsed display). */
  startedAt?: number;
  activeSignals: SignalKind[];
}

// --- indexing queue ----------------------------------------------------------

/**
 * What a queued job is for.
 *
 * `record` and `reindex` differ only in whether derived rows are purged first,
 * but they are separate kinds rather than a flag because jobs deduplicate by
 * (kind, session): a manual re-index must be able to queue BEHIND the automatic
 * job for the same recording instead of being folded into it and silently doing
 * nothing.
 */
export type IndexJobKind = "record" | "reindex" | "trace-rebuild";

export type IndexJobState = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * `skipped` is a first-class outcome, not an absence.
 *
 * A stage that simply never appeared is indistinguishable from one somebody
 * forgot to implement — which is the exact shape of the bug that once let a
 * default install return nothing at all for every text query, silently, because
 * frame↔segment linking had been gated on an image provider. A skipped stage is
 * drawn, and it states its reason.
 */
export type IndexStageState = "pending" | "running" | "done" | "skipped" | "failed";

/**
 * One node of the stage ladder.
 *
 * **`row` is EXECUTION ORDER and `col` is dependency depth**, and the split is
 * load-bearing. `runStages` is a strictly sequential loop, so drawing the
 * pipeline as a free-branching DAG would assert a concurrency the app does not
 * have; but the dependency structure is real and worth seeing. So the vertical
 * axis is the order things actually happen — monotonic, and every `needs` edge
 * therefore points at a strictly smaller row — while the horizontal axis carries
 * the shape. Deriving `row` from `needs` instead would be wrong in a way that is
 * easy to miss: `trace` is depth 2 but runs LAST.
 */
export interface IndexStageDTO {
  /** The `StageId`. Opaque to the renderer, which only groups and keys by it. */
  id: string;
  label: string;
  state: IndexStageState;
  /**
   * The one line under the stage name: what it produced, why its gate said no,
   * or the message from a tolerated failure. Null while pending.
   */
  detail: string | null;
  elapsedMs: number | null;
  row: number;
  col: number;
  /** Ids this stage declares it needs. Drawn as wires; always at a smaller row. */
  needs: string[];
}

export interface IndexJobDTO {
  id: string;
  kind: IndexJobKind;
  /** Null for library-scoped work — a trace graph belongs to no one recording. */
  sessionId: string | null;
  /** The recording's purpose, or its wall clock. Null when it has neither yet. */
  sessionLabel: string | null;
  posterUrl: string | null;
  state: IndexJobState;
  enqueuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  /** Groups the fan-out of one full-library re-index. */
  batchId: string | null;
  /** Every stage in this job's scope, including the ones that will not run. */
  stages: IndexStageDTO[];
  /**
   * Over STAGES, and only stages. The number this replaced meant stages on the
   * record path, recordings during a re-index, and frames inside the patch
   * stage — all plotted on one bar, which therefore changed scale mid-run.
   * Skipped stages count toward neither half: a job whose captioner is off is
   * not part-finished before it starts.
   */
  done: number;
  total: number;
}

/** Why the worker is running nothing. `null` means it is running something. */
export type IndexHoldReason = "recording" | "empty";

export interface IndexQueueDTO {
  jobs: IndexJobDTO[];
  runningJobId: string | null;
  held: IndexHoldReason | null;
  /** The sentence the screen shows while held, or null when there is nothing to say. */
  heldMessage: string | null;
}

/**
 * The fine-grained tick for the RUNNING stage only.
 *
 * Its own channel rather than a field on `IndexQueueDTO`, because the patch
 * stage reports per frame and re-serialising the whole queue at that rate is
 * waste — the same reasoning that made the rail smooth its per-bucket rate.
 * The queue snapshot fires on state transitions; this fires in between.
 */
export interface IndexTickDTO {
  jobId: string;
  stageId: string;
  detail: string;
}

// --- search / results --------------------------------------------------------

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HighlightDTO {
  regionId: string;
  bbox: Bbox;
  role: string | null;
  label: string | null;
  matchedBy: string[];
  /**
   * Confidence within this frame's highlight set (1 = strongest), or null when
   * there is no similarity behind the hit — every labelled AX region is null
   * and draws solid. See RegionHit.strength in the library.
   */
  strength: number | null;
}

export interface FrameHitDTO {
  frameId: string;
  score: number;
  /** The recording this frame came from, so a result can be opened in the Library. */
  sessionId: string;
  tMono: number;
  /**
   * The moment this frame is at, in LANE seconds — the axis the track rail is
   * drawn in and the axis every cross-screen jump is expressed in. NOT
   * `tMono / 1000`: lane offset 0 is the video's first frame. Same meaning as
   * `KeyframeMarkerDTO.offsetSec`; both come from `laneSec`.
   */
  offsetSec: number;
  /** Wall-clock ms (session.startedAt + tMono), for human display. */
  wallClock: number;
  width: number;
  height: number;
  segmentDigest: string | null;
  /**
   * The VLM caption for this hit's segment, so a result can be named by the ONE
   * label rule (`keyframeLabel`: caption -> digest -> timecode) that every other
   * surface already uses.
   *
   * Its absence is why the search card was the only place in the app that
   * labelled a keyframe by the templated digest, and printed "no digest" over a
   * frame the rail was happily captioning.
   */
  segmentCaption: string | null;
  /** What was said during this hit's segment. Null without a transcriber. */
  segmentTranscript: string | null;
  /**
   * The summary of the LOWEST composed level containing this hit — the answer
   * to "what was I doing?" when the thing retrieved is a single frame.
   *
   * The nearest ancestor, never the root: the root's summary is the whole
   * session's purpose, which is true of every hit in that recording and so
   * tells a reader nothing about this one.
   *
   * Null for a recording indexed before composing, or one whose tree has no
   * level above its leaves.
   */
  taskSummary: string | null;
  /**
   * The focused application at this frame's `t_mono`, resolved latest-at-or-before
   * from the session's own `focus_change` events, with the stable palette slot
   * `appTone` assigns it — so one app is one colour on the rail, in Flows and
   * here. Null when the session recorded no focus changes.
   */
  app: string | null;
  appTone: TrackTone | null;
  /**
   * The recording's own axis length in LANE seconds, so a hit can be placed on
   * it. 0 when unknown, which withholds the locator rather than dividing by it.
   */
  sessionSpanSec: number;
  /**
   * WHY this frame was retrieved, mirroring the library's `FrameEvidence`.
   *
   * `score` cannot answer that: every term is max-normalized across the current
   * result set, so the top hit of every query sits at the weight ceiling — 1.000
   * on a default install — however good or bad the match. Agreement across
   * independent lanes is the signal, so the lanes are what the UI shows.
   */
  evidence: {
    frame: number;
    region: number;
    segment: number;
    lanes: { key: string; rank: number; count?: number }[];
  };
  /** deskrag://frame/<blobId> URL, or null when the frame has no keyframe. */
  thumbUrl: string | null;
  highlightCount: number;
}

/**
 * A captured accessibility element. Flat array + `parent` back-references rather
 * than nested objects, matching the sidecar's wire format: main fills the links
 * (from the sidecar, or by containment for older captures) so the renderer never
 * has to reconstruct them. A parent always precedes its children, so a single
 * forward pass can build the tree. Bboxes are in frame space — screen points.
 */
export interface UIElementDTO {
  role: string;
  label?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  focused?: boolean;
  /** Index into the same `ax` array; absent means root. */
  parent?: number;
  /** Depth among emitted elements; absent means 0. */
  depth?: number;
}

export interface ResultDetailDTO {
  frameId: string;
  imageUrl: string | null;
  width: number;
  height: number;
  tMono: number;
  /** As `FrameHitDTO.offsetSec` — LANE seconds, for the jump into the Library. */
  offsetSec: number;
  wallClock: number;
  // No `score`. There was one, `detailWith` never set it, and the row that read
  // it therefore never rendered. It would have been the wrong number anyway:
  // the score is relative to a result LIST, and this view is opened from the
  // Library too, where there is no list and no query.
  session: { id: string; startedAt: number };
  segment: {
    id: string;
    granularity: string;
    digest: string | null;
    caption: string | null;
    transcript: string | null;
  } | null;
  /**
   * The summary of the LOWEST composed level containing this hit — the answer
   * to "what was I doing?" when the thing retrieved is a single frame.
   *
   * The nearest ancestor, never the root: the root's summary is the whole
   * session's purpose, which is true of every hit in that recording and so
   * tells a reader nothing about this one.
   *
   * Null for a recording indexed before composing, or one whose tree has no
   * level above its leaves.
   */
  taskSummary: string | null;
  /**
   * The focused application at this frame's `t_mono` and its stable palette
   * slot, exactly as `FrameHitDTO` carries them.
   *
   * FRAME-INTRINSIC, which is why it belongs here and `score` does not: which
   * app was in front at a given moment is a fact about the recording, not about
   * a result list, so the Library's keyframe inspector gets it too. That view
   * previously could not name the application at all.
   */
  app: string | null;
  appTone: TrackTone | null;
  /**
   * The recording's own axis length in LANE seconds, so this frame can be placed
   * on it. 0 when unknown, which withholds the locator rather than dividing by it
   * — the same rule `locatorTicks` already follows for a search row.
   */
  sessionSpanSec: number;
  ax: UIElementDTO[];
  highlights: HighlightDTO[];
}

export interface SessionSummaryDTO {
  id: string;
  startedAt: number;
  endedAt: number | null;
  /** endedAt - startedAt, or 0 while a session is still open. */
  durationMs: number;
  frameCount: number;
  segmentCount: number;
  eventCount: number;
  /** Total bytes across every blob for the session. */
  sizeBytes: number;
  hasVideo: boolean;
  /** deskrag://frame/<blobId> of the first keyframe, for the list thumbnail. */
  posterUrl: string | null;
  /**
   * What the recording was FOR — the summary of its root segment, the one node
   * covering the whole session.
   *
   * Null for a session captured but not yet indexed, in which case the list
   * shows what it always did and asserts nothing false.
   */
  purpose: string | null;
  /**
   * Which path produced `purpose`; null whenever `purpose` is.
   *
   * "template" means the tree was composed structurally because no text model
   * was configured, so the string is a rollup rather than a sentence. Disclosed
   * rather than smoothed over, the same rule the rail's lane `warning` follows.
   */
  purposeSource: "llm" | "template" | null;
}

export interface SessionVideoDTO {
  blobId: string;
  /** deskrag://media/<blobId> — Range-capable, so <video> can seek. */
  url: string;
  tMonoStart: number;
  tMonoEnd: number;
  sizeBytes: number;
}

export interface KeyframeMarkerDTO {
  frameId: string;
  tMono: number;
  /** Position within the video: (tMono - video.tMonoStart) / 1000. */
  offsetSec: number;
  thumbUrl: string | null;
  /**
   * The VLM caption of the enclosing segment — the preferred label everywhere a
   * keyframe is named. Null unless a captioner was configured when the session
   * was indexed, which is why `segmentDigest` stays as the fallback.
   */
  segmentCaption: string | null;
  segmentDigest: string | null;
}

export interface SessionDetailDTO {
  id: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  /** Null for sessions recorded before video capture, or with Screen disabled. */
  video: SessionVideoDTO | null;
  keyframes: KeyframeMarkerDTO[];
  frameCount: number;
  segmentCount: number;
  eventCount: number;
  sizeBytes: number;
}

// --- timeline tracks ---------------------------------------------------------

/**
 * Bucket count for every density lane. FIXED, never the renderer's pixel width:
 * the width changes on every frame of a resize drag, and an SVG path scales to
 * any width for free.
 */
export const TRACK_BUCKETS = 1000;

/**
 * Tone names, mapped to colours by `styles.css`. The `app-N` slots come from a
 * stable hash of the application name, so one app is one colour across every
 * lane and every session — position in the timeline never decides a colour.
 */
export type TrackTone =
  | "neutral"
  | "accent"
  | "ok"
  | "warn"
  | "alarm"
  | "app-0"
  | "app-1"
  | "app-2"
  | "app-3"
  | "app-4"
  | "app-5"
  | "app-6"
  | "app-7";

export type TrackShape = "density" | "span" | "mark" | "thumb";

/**
 * Which band of the rail a lane belongs to, so sixteen lanes can be collapsed to
 * the few a reader currently cares about.
 *
 * Named for the SIGNAL each lane comes from, never for its shape: `apps` and
 * `keyframes` are both "screen" though one is a span and one a thumbnail,
 * because what a reader collapses is "I am not looking at the screen right now"
 * — not "I am not looking at spans". A shape-keyed grouping would scatter one
 * question across three bands.
 *
 * Required on `TrackLaneDTO` rather than optional, for the same reason
 * `showLabels` is: the compiler then finds every builder and every test fixture,
 * so a new lane cannot silently land in a default band.
 */
export type TrackGroup = "screen" | "segments" | "input" | "audio" | "marks";

/** Band order and display names. The rail renders bands in THIS order. */
export const TRACK_GROUPS: readonly { id: TrackGroup; title: string }[] = [
  { id: "screen", title: "screen" },
  { id: "segments", title: "segments" },
  { id: "audio", title: "audio" },
  { id: "input", title: "input" },
  { id: "marks", title: "marks" },
];

export interface TrackSpanDTO {
  startSec: number;
  endSec: number;
  label: string;
  tone: TrackTone;
}

export interface TrackMarkDTO {
  atSec: number;
  label: string;
  tone: TrackTone;
}

export interface TrackThumbDTO {
  atSec: number;
  /**
   * The SAME marker the player's chapter cues and hover thumbnails use, so
   * `keyframeLabel()` stays the one label rule rather than gaining a second
   * implementation here.
   */
  marker: KeyframeMarkerDTO;
  regionCount: number;
}

export interface TrackDensityDTO {
  /**
   * Length TRACK_BUCKETS, normalized 0–1.
   *
   * `null` means NO COVERAGE and is NOT zero. Recorded silence is a flat zero;
   * a stretch with no audio blob at all is null. Collapsing the two would make
   * a dead microphone indistinguishable from a quiet room. Only audio emits
   * null — for event-sourced lanes absence genuinely is zero, because nobody
   * typed.
   */
  values: (number | null)[];
  /** The real-world value that 1.0 corresponds to. */
  peak: number;
  unit: string;
  /** A second trace in the same lane, same length. Only `mouse-xy` uses it. */
  values2?: (number | null)[];
}

export interface TrackLaneDTO {
  id: string;
  title: string;
  shape: TrackShape;
  /** Which collapsible band of the rail this lane sits in. See `TrackGroup`. */
  group: TrackGroup;
  /**
   * Whether this lane's spans may paint their label into the bar.
   *
   * `span` lanes ONLY — `mark` and `thumb` lanes carry labels in the DTO but the
   * renderer has never painted them, and `density` lanes have no label at all.
   *
   * Prose lanes are false. Adjacent segments each carrying a caption made the
   * rail one run-on clipped paragraph; the text lives in the hover card, which
   * resolves every lane at the cursor at once. Only `apps` is true, and even
   * then the renderer paints the label only if it fits untruncated.
   */
  showLabels: boolean;
  /**
   * Depth in the compositional hierarchy — 0 for `action`, 1 for `task`, 2 for
   * `process`, up to the root. `null` for every lane that is not part of the
   * tree.
   *
   * REQUIRED rather than optional, the same rationale as `showLabels` and
   * `TrackGroup`: the compiler then finds every builder and every fixture, so a
   * lane cannot silently claim a depth it does not have. The renderer indents
   * lane titles by it, which is what makes the rail read as an outline.
   */
  level: number | null;
  density?: TrackDensityDTO;
  spans?: TrackSpanDTO[];
  marks?: TrackMarkDTO[];
  thumbs?: TrackThumbDTO[];
  /** Non-null when the lane is legitimately empty. The reason IS the payload. */
  emptyReason: string | null;
  /**
   * Non-null when the lane HAS data and that data is compromised. Not an
   * alternative to `emptyReason`: a session with `key_down` events and no
   * `keymap_change` has a full, healthy-looking typing lane whose every
   * character was dropped at lift, and an empty-reason cannot say that.
   */
  warning: string | null;
}

export interface SessionTracksDTO {
  sessionId: string;
  /** Seconds. The axis every lane's offsets are measured against. */
  totalSec: number;
  /** Offsets are relative to the video when there is one, else to t_mono zero. */
  anchoredToVideo: boolean;
  /**
   * Whether this recording was captured with the device-clock bridge.
   *
   * REQUIRED, so the compiler finds every builder and fixture — the same
   * rationale as `showLabels` and `TrackGroup`. False means the session predates
   * the bridge: its frames and audio were timed by ARRIVAL, so its lanes sit
   * about a second from the video they describe, and nothing can recover the
   * difference because the delivery latency was never recorded.
   */
  clockCalibrated: boolean;
  lanes: TrackLaneDTO[];
}

export interface EnvInfo {
  platform: string;
  ffmpegAvailable: boolean;
  axSidecarAvailable: boolean;
  whisperConfigured: boolean;
  dataDir: string;
  /**
   * The image provider this install had selected before it was removed, when
   * settings were migrated on open — `"nomic"` or `"colsmol"`, else null.
   *
   * Surfaced because the migration is silent otherwise and its consequence is
   * not: the frames indexed under that model live in a vector space nothing can
   * query, and their tables have been dropped. The user is TOLD a re-index is
   * needed; nothing starts one for them.
   */
  migratedImageProvider: string | null;
  /**
   * `"ollama"` when this install had the retired Ollama text lane selected and
   * `load()` moved it to a pinned ONNX model, else null.
   *
   * Surfaced for the same reason as its sibling and with the same restraint:
   * every text vector this install holds is namespaced `*:ollama:<model>:768`,
   * which nothing can query once the provider that produced it is gone — so the
   * digest, caption, transcript and summary lanes are ALL empty until a
   * re-index, which is far too big a consequence to leave to a user noticing
   * that search got quiet.
   *
   * Deliberately null for an install that was already on `"onnx"`: its vectors
   * sit in `*:onnx:nomic-embed-text-v1.5:768`, `textModel` defaults to exactly
   * that model, and nothing it holds became unreachable. Telling that user to
   * re-index would be a lie that costs them an hour.
   */
  migratedTextProvider: string | null;
}

// --- permissions -------------------------------------------------------------

export type PermissionKind = "screen" | "microphone" | "accessibility";
export type PermissionState =
  | "granted"
  | "denied"
  | "restricted"
  | "not-determined"
  | "unknown";

export interface PermissionStatus {
  kind: PermissionKind;
  state: PermissionState;
  /** Whether the app can trigger an in-app prompt (mic only on macOS). */
  canRequest: boolean;
}

// --- the IPC API exposed on window.deskrag ----------------------------------

/**
 * Search results plus a reason when there are none. There is deliberately NO
 * migration path between providers, so switching one leaves prior recordings
 * indexed in a namespace the current provider never queries. Without this flag
 * that looks identical to "nothing matched" over a full library.
 */
export interface SearchResultDTO {
  frames: FrameHitDTO[];
  /** True when no text vector space exists for the CURRENT provider. */
  indexedUnderDifferentProvider?: boolean;
  /**
   * Segments matched, but not one of them has a keyframe linked to it, so
   * nothing could be returned. This is an INDEX defect, not an empty library:
   * frame↔segment links used to be written only by the image stages, which are
   * gated on a provider defaulting to "none". Reported separately because it is
   * indistinguishable from "nothing matched" and has a specific remedy —
   * Settings → Rebuild search index.
   */
  segmentsMatchedButNoFrames?: number;
}

export interface SearchInput {
  text?: string;
  /** Raw image bytes for search-by-visual-example (requires an image provider). */
  imageBytes?: Uint8Array;
}

// --- flows (the graph exploration surface) ----------------------------------
//
// THIS SURFACE READS; IT NEVER ACTS. The executor still exists in the library
// (`src/replay/`) and is deliberately not wired to anything here: there is no
// plan DTO, no arm channel, and no live observation of the desktop, which is
// what lets the app run without ever spawning `ax-exec`.

/**
 * Trace ids are session-scoped — `01KYX6DDK2PFXFDAX0XB3PH1DM:n3` — so every one
 * is 30 characters, and a node card is 180px wide. Strip the ULID for display
 * and keep the full id in a `title` wherever this is used.
 *
 * Suffixes CAN repeat across sessions in an accreted graph, so this is a display
 * aid and never an identifier: position on the canvas and the tooltip are what
 * actually distinguish two nodes. It lives here because both processes need the
 * same rule — main labels nodes, the renderer labels routes and edges.
 */
export function shortId(id: string): string {
  const colon = id.lastIndexOf(":");
  return colon < 0 ? id : id.slice(colon + 1);
}

/**
 * One recording that observed a state, and where within it.
 *
 * `atSec` is **lane seconds** — the `t_mono` offset the track rail's axis is
 * drawn in — NOT media seconds. The encoded video runs about 1% short of the
 * session span it covers, so the two clocks meet only as a fraction; `TrackRail`
 * converts at exactly one place and nothing outside it may do the division.
 */
export interface NodeSourceDTO {
  sessionId: string;
  /** Wall clock, for naming the recording. Display only, as everywhere. */
  startedAt: number;
  atSec: number;
}

/** As `NodeSourceDTO`, for the span an edge's actions were recorded in. */
export interface EdgeSourceDTO {
  sessionId: string;
  startedAt: number;
  atSec: number;
  throughSec: number;
}

export interface GraphNodeDTO {
  id: string;
  /** "TextEdit — Save", or the id when the node describes no state. */
  label: string;
  app?: string;
  /**
   * A Sheet/Dialog or focused-element label. NEVER a window title: a title is
   * document identity rather than state, which is why `extractPredicates` emits
   * no `window` predicate and `STABLE_ROLES` omits `Window`.
   */
  hint?: string;
  /**
   * The short id to print on the card. Usually just the suffix (`n3`), but
   * widened with a slice of the session ULID when two nodes in the graph share
   * a suffix — which a merged graph produces as soon as a second session is
   * recorded, and which is otherwise indistinguishable on screen.
   */
  chip: string;
  /** From TraceNode.visual — served via deskrag://frame/<blobId>. */
  frameBlobId?: string;
  observations: number;
  /**
   * The node's whole identity, human-readable via `describePredicate`. Empty
   * when the node describes no state. This is what merges, verifies and
   * locates, and it had no surface in the app until now.
   */
  predicates: string[];
  /**
   * False when the identity is only `app`. Such a node is satisfied by every
   * observation in that application, so it cannot answer "which state is
   * this?" — it verifies perfectly and locates never, which makes it unusable
   * as a goal. Measured: without a URL only 3 of 8 nodes were locatable.
   */
  locatable: boolean;
  intervene: "none" | "select" | "synthesize";
  /** BFS distance from the graph entry. The canvas's row. */
  rank: number;
  /**
   * The recordings this state was observed in, newest observation last.
   *
   * MAY BE SHORTER THAN `observations`, in two legitimate ways: a graph built
   * before provenance was captured has none at all, and deleting a recording
   * removes its sources while leaving the count it contributed. Never derive
   * one from the other — show the difference.
   */
  sources: NodeSourceDTO[];
}

/** One action on an edge, in a reader's words rather than an enum's. */
export interface EdgeActionDTO {
  /** "3× click", "type", "press cmd+a", "wait until app(TextEdit)". */
  action: string;
  /** The RECORDED descriptors: `Button "Send"`, `#save-btn`, or a point. */
  target: string;
  /**
   * For a `type` action: the slot and every value recorded into it. Two samples
   * is a discovered variable — the thing recording a task twice produces — and
   * this edge is the one place that fact is about something specific.
   */
  slot?: { name: string; samples: string[] };
}

export interface GraphEdgeDTO {
  id: string;
  from: string;
  to: string;
  actions: EdgeActionDTO[];
  /** To an equal or lower rank — a loop a merge produced, not a mistake. */
  back: boolean;
  provenance: "recorded" | "synthesized";
  /** How many recordings walked this edge. The canvas's wire weight. */
  observations: number;
  /** See `GraphNodeDTO.sources` — same caveat about the count. */
  sources: EdgeSourceDTO[];
  /** What lifting could not do here, e.g. a dropped wait. */
  liftWarnings?: string[];
}

export interface GraphDTO {
  id: string;
  entry: string;
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  slots: { name: string; samples: string[] }[];
}

/**
 * A FLOW: one recording's own path through the graph, and every recording that
 * took exactly that path.
 *
 * Deliberately NOT a graph traversal. A merged graph composes paths no single
 * recording ever walked, and listing those as "your common flows" would be the
 * same category error the IR rejects elsewhere — variation comes from recording
 * a task twice, not from something inventing it. So a route is keyed by the
 * ordered edge-id sequence a session actually produced, and two recordings of
 * one task merge onto the same edges and become one route with `count: 2`.
 *
 * A graph with no provenance therefore yields NO routes, never a synthesized
 * one. The screen says so and points at the rebuild.
 */
export interface FlowRouteDTO {
  /** The joined edge-id sequence — stable across reloads, and its own key. */
  id: string;
  /** Recordings that walked exactly this sequence. */
  count: number;
  /** "TextEdit → Google Chrome → github.com/user/repo", from the node labels. */
  label: string;
  /**
   * What the route DOES, from the composed level covering its recordings — the
   * lowest level at which one node covers the majority of a walk.
   *
   * Null when no level qualifies, which is the honest answer for a route that
   * is not one task; the caller falls back to `label`. Never part of the route
   * KEY: summaries are nondeterministic, so keying on them would change a
   * route's identity on every re-index.
   */
  name: string | null;
  /**
   * How many of this route's recordings agreed on `name`.
   *
   * Shown rather than smoothed over, the `observations`/`sources` rule: several
   * recordings sharing a shape can disagree about what they were for, and the
   * dominant name winning is not the same as unanimity.
   */
  nameObservations: number;
  /** For highlighting the route on the canvas. */
  nodeIds: string[];
  edgeIds: string[];
  sessionIds: string[];
}

export interface FlowsDTO {
  graph: GraphDTO;
  /** Most-walked first. Empty when the graph carries no provenance. */
  routes: FlowRouteDTO[];
}

export interface DeskRagApi {
  settings: {
    get(): Promise<SettingsView>;
    set(patch: SettingsPatch): Promise<SettingsView>;
    capabilities(): Promise<Capabilities>;
  };
  permissions: {
    check(): Promise<PermissionStatus[]>;
    request(kind: PermissionKind): Promise<PermissionStatus>;
    openSettings(kind: PermissionKind): Promise<void>;
  };
  recording: {
    start(): Promise<RecordingStatus>;
    /**
     * Stop capture and hand the recording to the indexing queue.
     *
     * Returns as soon as the capture producers are down — it does NOT wait for
     * indexing. It used to: this promise spanned the whole pipeline, so the
     * `recording:stop` IPC call could take minutes and the record button stayed
     * disabled for all of it.
     */
    stop(): Promise<RecordingStatus>;
    status(): Promise<RecordingStatus>;
    onState(cb: (s: RecordingStatus) => void): () => void;
  };
  /**
   * The indexing queue. Every mutating call here ENQUEUES and returns — none of
   * them runs the pipeline inline, and none of them refuses because a recording
   * is in progress. The worker yields to capture on its own, between stages.
   */
  indexing: {
    queue(): Promise<IndexQueueDTO>;
    /** Re-index one recording from raw capture. Purges its derived rows first. */
    reindexSession(sessionId: string): Promise<void>;
    /**
     * DESTRUCTIVE. Fan out one job per recording plus a trace rebuild, under one
     * batch.
     *
     * Every recording has everything the pipeline derived from it discarded —
     * segments, regions, captions, transcripts, summaries, the lexical index and
     * every vector — and rebuilt from raw capture, which is never touched. The
     * cost the caller must disclose: it rebuilds with the providers configured
     * **now**, so re-indexing with no captioner discards every caption and with
     * no whisper binary every transcript. Both are recomputable from blobs still
     * on disk, but only by a run that has the provider.
     */
    reindexAll(): Promise<void>;
    /** Re-lift every recording into a fresh trace graph. One library-scoped job. */
    rebuildTraces(): Promise<void>;
    /** Drop a queued job. A running job is left alone — see the main-side guard. */
    cancel(jobId: string): Promise<void>;
    /** Re-queue a failed or cancelled job. It will purge before running. */
    retry(jobId: string): Promise<void>;
    /** Forget every terminal job. Never touches queued or running ones. */
    clearFinished(): Promise<void>;
    onQueue(cb: (q: IndexQueueDTO) => void): () => void;
    onTick(cb: (t: IndexTickDTO) => void): () => void;
  };
  search: {
    query(input: SearchInput): Promise<SearchResultDTO>;
    detail(frameId: string): Promise<ResultDetailDTO | null>;
  };
  sessions: {
    list(): Promise<SessionSummaryDTO[]>;
    detail(sessionId: string): Promise<SessionDetailDTO | null>;
    remove(sessionId: string): Promise<void>;
    // Re-indexing moved to `indexing.*`: it is queued work now, not a call that
    // blocks until a library rebuild finishes. Keeping a second entry point here
    // is exactly how the rebuild path went stale the first time.
    /** Every recorded signal, bucketed onto the session's own time axis. */
    tracks(sessionId: string): Promise<SessionTracksDTO | null>;
  };
  /**
   * READ ONLY, and that is the whole of it. One call, no subscriptions, no
   * sidecar, nothing that observes or touches the live desktop.
   */
  flows: {
    graph(): Promise<FlowsDTO | null>;
  };
  models: {
    /** Fires while weights download; may start from a search, not just indexing. */
    onDownload(cb: (p: ModelDownloadProgress) => void): () => void;
  };
  ollama: {
    /**
     * Vision-capable models resident on THIS machine. Never a hardcoded list:
     * Ollama's library now includes cloud-hosted models, and offering one here
     * would route screenshots off the device.
     */
    visionModels(): Promise<string[]>;
    /**
     * Chat-capable models resident on THIS machine — the ones that can compose
     * and name levels. Same /api/tags rule and the same reason.
     */
    chatModels(): Promise<string[]>;
  };
  /**
   * The MCP endpoint external agents read the experience index through.
   *
   * READ ONLY on both sides: these three calls report what the server is doing
   * and what has been asked of it. There is no tool-invocation channel here —
   * the renderer is a spectator, and the server itself can reach neither
   * `src/replay/` nor `ax-exec` (`test/mcp.readonly.test.ts`).
   */
  mcp: {
    status(): Promise<McpStatusDTO>;
    /** The whole ring buffer, newest last. For the pane's first paint. */
    log(): Promise<McpLogEntryDTO[]>;
    /** One entry per tool call, as it completes. */
    onLog(cb: (entry: McpLogEntryDTO) => void): () => void;
  };
  system: {
    env(): Promise<EnvInfo>;
    /**
     * Wipes the app data dir (`app.db`, `lance/`, `blobs/`, `models/`,
     * `settings.json`) and relaunches. A custom Model directory (Settings >
     * Models) lives outside the app data dir and is never touched. Throws
     * without deleting anything if a recording is in progress.
     */
    reset(): Promise<void>;
  };
}

// Re-indexing no longer RETURNS a result: `indexing.reindexAll()` enqueues and
// comes back immediately, and the outcome is the queue itself — every job, its
// stage ladder and its counts, on the Indexing screen. `ReindexResultDTO` and
// `ReindexAllResultDTO` were deleted rather than left as shapes nothing fills,
// which is what a stale second copy of the rebuild's knowledge looks like just
// before it goes wrong. The DESTRUCTIVENESS those doc comments carried has not
// gone anywhere — it moved to the Settings confirmation, which is where a user
// can still act on it, and to `indexing.reindexAll()` above.

/**
 * What the MCP endpoint is actually doing right now.
 *
 * `listening` is not `enabled`: a server switched on that failed to bind is
 * enabled and not listening, and that is the state a reader most needs to see.
 */
export interface McpStatusDTO {
  enabled: boolean;
  port: number;
  listening: boolean;
  /** The bind failure, verbatim. Null while listening or while switched off. */
  error: string | null;
  /** `http://127.0.0.1:<port>/mcp` — null unless listening. */
  url: string | null;
  /** Ready to paste into a terminal. Null unless listening. */
  connectCommand: string | null;
}

/**
 * One tool call, for the activity log.
 *
 * The log is the user-facing gate on this endpoint — it carries no token, so
 * seeing what was asked is what stands in for controlling who may ask. It lives
 * in memory and resets when the app quits: a permanent, growing record of what
 * an agent read from your screen history is itself a second copy of sensitive
 * material, and nothing here needs it to survive a restart.
 */
export interface McpLogEntryDTO {
  id: string;
  /** Wall clock, epoch ms. */
  at: number;
  tool: string;
  /** The arguments, flattened to one short line. */
  args: string;
  /** What went back, summarized — never the full payload. */
  result: string;
  ms: number;
  ok: boolean;
}

/** IPC channel names — one place so main + preload can't drift. */
export const IPC = {
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  settingsCapabilities: "settings:capabilities",
  permissionsCheck: "permissions:check",
  permissionsRequest: "permissions:request",
  permissionsOpenSettings: "permissions:openSettings",
  recordingStart: "recording:start",
  recordingStop: "recording:stop",
  recordingStatus: "recording:status",
  recordingStateEvent: "recording:state-event",
  indexingQueue: "indexing:queue",
  indexingReindexSession: "indexing:reindex-session",
  indexingReindexAll: "indexing:reindex-all",
  indexingRebuildTraces: "indexing:rebuild-traces",
  indexingCancel: "indexing:cancel",
  indexingRetry: "indexing:retry",
  indexingClearFinished: "indexing:clear-finished",
  /** Full snapshot, on transitions only. */
  indexingQueueEvent: "indexing:queue-event",
  /** The running stage's detail line, which can fire per frame. */
  indexingTickEvent: "indexing:tick-event",
  searchQuery: "search:query",
  searchDetail: "search:detail",
  sessionsList: "sessions:list",
  sessionsDetail: "sessions:detail",
  sessionsRemove: "sessions:remove",
  sessionsTracks: "sessions:tracks",
  flowsGraph: "flows:graph",
  mcpStatus: "mcp:status",
  mcpLog: "mcp:log",
  mcpLogEvent: "mcp:log-event",
  modelDownloadEvent: "models:download-event",
  ollamaVisionModels: "ollama:vision-models",
  ollamaChatModels: "ollama:chat-models",
  systemEnv: "system:env",
  systemReset: "system:reset",
} as const;
