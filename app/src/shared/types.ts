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

/** What library features are usable given the current settings (renderer gating). */
export interface Capabilities {
  imageSearch: boolean;
  caption: boolean;
  rerank: boolean;
  transcript: boolean;
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

// --- replay (the plan review surface) ---------------------------------------

/**
 * Trace ids are session-scoped — `01KYX6DDK2PFXFDAX0XB3PH1DM:n3` — so every one
 * is 30 characters, and a node card is 180px wide. Strip the ULID for display
 * and keep the full id in a `title` wherever this is used.
 *
 * Suffixes CAN repeat across sessions in an accreted graph, so this is a display
 * aid and never an identifier: position on the canvas and the tooltip are what
 * actually distinguish two nodes. It lives here because both processes need the
 * same rule — main labels nodes, the renderer labels edges in the review.
 */
export function shortId(id: string): string {
  const colon = id.lastIndexOf(":");
  return colon < 0 ? id : id.slice(colon + 1);
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
  /** From TraceNode.visual — served via deskrag://frame/<blobId>. */
  frameBlobId?: string;
  observations: number;
  intervene: "none" | "select" | "synthesize";
  /** BFS distance from the graph entry. The canvas's column. */
  rank: number;
}

export interface GraphEdgeDTO {
  id: string;
  from: string;
  to: string;
  actions: number;
  /** To an equal or lower rank — a loop a merge produced, not a mistake. */
  back: boolean;
  provenance: "recorded" | "synthesized";
}

export interface GraphDTO {
  id: string;
  entry: string;
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  slots: { name: string; samples: string[] }[];
}

/** Where the live desktop is, as far as the locator can tell. */
export interface LocationDTO {
  nodeId?: string;
  candidates: number;
  ambiguous: boolean;
  app?: string;
  /** From AxObservation.windowTitle — the one place a title is legitimate. */
  window?: string;
  /**
   * Age of the last FOREIGN observation. Set while DeskRAG itself is frontmost,
   * because then the observation describes the reviewer, not the desktop.
   */
  staleMs?: number;
}

export type PlanStepDTO =
  | { kind: "handoff"; app: string }
  | {
      kind: "action";
      edgeId: string;
      /** "click", "type", "wait until app(TextEdit)" — already human. */
      action: string;
      /** Described from the RECORDED descriptors, never from the resolution. */
      target: string;
      layer?: string;
      confidence?: number;
      slot?: { name: string; value: string };
    }
  | { kind: "repair"; edgeId: string; app: string; launch: boolean; reason: string }
  | { kind: "superseded"; edgeId: string; action: string; reason: string };

export interface PlanDTO {
  id: string;
  /** 1-based. There is deliberately no total: the loop does not know one. */
  segment: number;
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  steps: PlanStepDTO[];
  blockers: { reason: string; scope: "segment" | "remainder" }[];
  brittleness: {
    edgeId: string;
    axRate: number;
    belowFloor: boolean;
    bound: "measured" | "upper";
  }[];
  cut?: {
    resumeAt: string;
    edgeId: string;
    attempts: { layer: string; rejected: string }[];
  };
  remainder: {
    edgeId: string;
    toNodeId: string;
    actions: {
      kind: string;
      descriptors?: string[];
      /** Provenance. Never presented as a target. */
      recordedPoint?: { x: number; y: number };
      slot?: string;
    }[];
    repairs: { app: string; launch: boolean }[];
  }[];
  drift?: { expected: string; observed: string };
}

/**
 * Why the run ended. `declined` covers both a user's Cancel and a failed focus
 * handoff — `executeRun` reports any false `arm` as "declined" — so the service
 * distinguishes them here rather than leaving the panel to guess.
 */
export type ReplayStopReason =
  | "cancelled"
  | "handoff-failed"
  /** DeskRAG never stopped being frontmost, so the run had nothing to observe. */
  | "observe-blocked"
  | "not-located"
  | "no-path"
  | "no-progress"
  | "max-segments"
  | "failed";

export type RunEventDTO =
  | { type: "segment-planned"; plan: PlanDTO }
  | { type: "armed"; segment: number; app?: string }
  | {
      type: "segment-done";
      segment: number;
      completed: boolean;
      failure?: { step: number; reason: string };
      telemetry: { edgeId: string; layer: string; confidence: number }[];
    }
  | { type: "stopped"; reached: boolean; reason?: ReplayStopReason; detail?: string };

export interface ReplayStartInput {
  goalNodeId: string;
  slotBindings?: Record<string, string>;
  allowLaunch?: boolean;
}

export interface ReplayArmInput {
  segment: number;
  approve: boolean;
  /** Accepts brittleness only. Blockers have no override and never will. */
  override?: boolean;
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
  };
  replay: {
    graph(): Promise<GraphDTO | null>;
    /** Spawns/kills the ax-exec sidecar AND starts/stops the poller. */
    watch(on: boolean): Promise<void>;
    start(input: ReplayStartInput): Promise<void>;
    arm(input: ReplayArmInput): Promise<void>;
    cancel(): Promise<void>;
    onEvent(cb: (e: RunEventDTO) => void): () => void;
    onLocation(cb: (l: LocationDTO) => void): () => void;
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
  replayGraph: "replay:graph",
  replayWatch: "replay:watch",
  replayStart: "replay:start",
  replayArm: "replay:arm",
  replayCancel: "replay:cancel",
  replayEvent: "replay:event",
  replayLocationEvent: "replay:location-event",
  modelDownloadEvent: "models:download-event",
  ollamaVisionModels: "ollama:vision-models",
  systemEnv: "system:env",
} as const;
