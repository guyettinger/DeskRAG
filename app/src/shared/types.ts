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

/** Where text embeddings come from. Ollama needs a daemon; onnx runs in-process. */
export type TextProvider = "ollama" | "onnx";
/**
 * The two local visual paths, mutually exclusive because they index different
 * vector spaces — the library's Retriever rejects both at once.
 *   nomic   — single-vector; writes region rows, so Tier 3 + AX-label FTS work
 *   colsmol — late interaction; patches ARE the regions, so no Tier 3
 */
export type ImageProvider = "none" | "nomic" | "colsmol";
export type CaptionProvider = "none" | "ollama";
export type RerankProvider = "none" | "onnx";

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
}

export interface SettingsView {
  providers: ProviderSettingsView;
  signals: SignalConfig;
}

export interface SettingsPatch {
  providers?: Partial<
    Omit<ProviderSettingsView, "whisper" | "localModels"> & {
      whisper: Partial<{ binaryPath: string; modelPath: string }>;
      localModels: Partial<{ dir: string }>;
    }
  >;
  signals?: DeepPartial<SignalConfig>;
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

export type RecordingState = "idle" | "recording" | "indexing";

export interface RecordingStatus {
  state: RecordingState;
  sessionId?: string;
  /** Wall-clock ms when recording started (for elapsed display). */
  startedAt?: number;
  activeSignals: SignalKind[];
}

export interface IndexingProgress {
  stage: string;
  done: number;
  total: number;
  message?: string;
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
}

export interface FrameHitDTO {
  frameId: string;
  score: number;
  tMono: number;
  /** Wall-clock ms (session.startedAt + tMono), for human display. */
  wallClock: number;
  width: number;
  height: number;
  segmentDigest: string | null;
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
  wallClock: number;
  score?: number;
  session: { id: string; startedAt: number };
  segment: {
    id: string;
    granularity: string;
    digest: string | null;
    caption: string | null;
    transcript: string | null;
  } | null;
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
  lanes: TrackLaneDTO[];
}

export interface EnvInfo {
  platform: string;
  ffmpegAvailable: boolean;
  axSidecarAvailable: boolean;
  whisperConfigured: boolean;
  dataDir: string;
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
    stop(): Promise<RecordingStatus>;
    status(): Promise<RecordingStatus>;
    onState(cb: (s: RecordingStatus) => void): () => void;
    onIndexing(cb: (p: IndexingProgress) => void): () => void;
  };
  search: {
    query(input: SearchInput): Promise<SearchResultDTO>;
    detail(frameId: string): Promise<ResultDetailDTO | null>;
  };
  sessions: {
    list(): Promise<SessionSummaryDTO[]>;
    detail(sessionId: string): Promise<SessionDetailDTO | null>;
    remove(sessionId: string): Promise<void>;
    /**
     * Re-lift every recording into a fresh trace graph. Progress arrives on the
     * existing indexing channel, so `onIndexing` covers this too.
     */
    reindex(): Promise<ReindexResultDTO>;
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

/**
 * The outcome of re-lifting every recording into a fresh graph.
 *
 * It is a REBUILD, not a per-session re-lift: a graph accretes, so folding one
 * session into a graph that already contains it would count it twice and inflate
 * the `observations`/`outcomes` evidence that edge cost uses to pick a path.
 */
export interface ReindexResultDTO {
  /** Sessions that produced a trace and were merged. */
  sessions: number;
  /** Sessions with no events — correctly contributing no node. */
  skipped: number;
  nodes: number;
  edges: number;
  /** Slots with more than one recorded sample. */
  variables: number;
  actions: number;
  /** At least one session had no keyboard layout, so its typed text was lost. */
  missingKeymap: boolean;
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
  recordingIndexingEvent: "recording:indexing-event",
  searchQuery: "search:query",
  searchDetail: "search:detail",
  sessionsList: "sessions:list",
  sessionsDetail: "sessions:detail",
  sessionsRemove: "sessions:remove",
  sessionsReindex: "sessions:reindex",
  sessionsTracks: "sessions:tracks",
  flowsGraph: "flows:graph",
  modelDownloadEvent: "models:download-event",
  ollamaVisionModels: "ollama:vision-models",
  systemEnv: "system:env",
  systemReset: "system:reset",
} as const;
