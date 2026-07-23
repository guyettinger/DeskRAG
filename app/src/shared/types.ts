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

export type ImageProvider = "none" | "voyage" | "gemini";
export type CaptionProvider = "none" | "anthropic" | "gemini";

export interface ProviderSettingsView {
  ollamaHost: string;
  ollamaModel: string;
  imageProvider: ImageProvider;
  captionProvider: CaptionProvider;
  rerank: boolean;
  whisper: { binaryPath: string; modelPath: string };
  /** Presence only — raw API keys never cross to the renderer. */
  keys: { voyage: boolean; gemini: boolean; anthropic: boolean };
}

export interface SettingsView {
  providers: ProviderSettingsView;
  signals: SignalConfig;
}

export interface SettingsPatch {
  providers?: Partial<
    Omit<ProviderSettingsView, "keys" | "whisper"> & {
      whisper: Partial<{ binaryPath: string; modelPath: string }>;
    }
  >;
  signals?: DeepPartial<SignalConfig>;
  /** New key values; `null` clears a stored key, `undefined`/absent leaves it. */
  keys?: Partial<Record<"voyage" | "gemini" | "anthropic", string | null>>;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

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

export interface UIElementDTO {
  role: string;
  label?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  focused?: boolean;
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
  frameCount: number;
  segmentCount: number;
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

export interface SearchInput {
  text?: string;
  /** Raw image bytes for search-by-visual-example (requires an image provider). */
  imageBytes?: Uint8Array;
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
    query(input: SearchInput): Promise<FrameHitDTO[]>;
    detail(frameId: string): Promise<ResultDetailDTO | null>;
  };
  sessions: {
    list(): Promise<SessionSummaryDTO[]>;
  };
  system: {
    env(): Promise<EnvInfo>;
  };
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
  systemEnv: "system:env",
} as const;
