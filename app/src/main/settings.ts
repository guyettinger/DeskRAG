/**
 * SettingsStore — persists settings as JSON under the app data dir.
 *
 * There are no secrets to hold: every provider runs on this machine, so there is
 * no API key, no `safeStorage`, and no `keys.enc`. A stale keys.enc from a build
 * that had cloud providers is deleted on open rather than left sitting on disk
 * encrypted-but-unreadable.
 */

import { app } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  SettingsView,
  SettingsPatch,
  SignalConfig,
  McpSettings,
  ProviderSettingsView,
} from "@shared/types";
import { DEFAULT_AUDIO_INPUT } from "deskrag";
import { DEFAULT_WHISPER_BIN, resolveWhisperBinary } from "./whisper.js";

interface PersistedSettings {
  providers: ProviderSettingsView;
  signals: SignalConfig;
  mcp: McpSettings;
}

/**
 * The MCP endpoint's default port.
 *
 * Nothing well-known sits here, and it is fixed rather than searched for: the
 * URL goes into an agent's config by hand, so a port that moves on its own
 * breaks a connection the user already made.
 */
export const DEFAULT_MCP_PORT = 41777;

const DEFAULTS: PersistedSettings = {
  providers: {
    ollamaHost: "http://localhost:11434",
    ollamaModel: "nomic-embed-text",
    ollamaCaptionModel: "qwen3-vl:4b",
    ollamaSummaryModel: "qwen3:4b",
    textProvider: "ollama",
    imageProvider: "none",
    captionProvider: "none",
    // "none" still builds the whole hierarchy — structurally, with templated
    // rollups. A model only upgrades the prose.
    summaryProvider: "none",
    rerankProvider: "none",
    localModels: { dir: "" },
    // Empty modelPath means "use the managed download" (MODELS.whisper), not
    // "disabled" — set it only to point at your own GGML file.
    whisper: { binaryPath: DEFAULT_WHISPER_BIN, modelPath: "" },
  },
  signals: {
    screen: { enabled: true, fps: 1, imageMaxWidth: 1280 },
    input: { enabled: true },
    activeWin: { enabled: true },
    // On by default: mic audio is the only source of transcripts, and the model
    // it feeds is now downloaded automatically, so leaving it off made
    // transcription unreachable without hand-editing settings.json.
    //
    // The device is `:default` — the input macOS Sound is set to — and NOT an
    // index. See LEGACY_AUDIO_DEVICE below for what the index cost.
    audio: { enabled: true, device: DEFAULT_AUDIO_INPUT, chunkSeconds: 10 },
    ax: { enabled: false },
  },
  mcp: { enabled: true, port: DEFAULT_MCP_PORT },
};

/**
 * A persisted port, or the default.
 *
 * Ports below 1024 need root and would fail to bind; anything outside the 16-bit
 * range is not a port at all. Both reset rather than being carried forward, the
 * same rule `PROVIDER_VALUES` follows: a stored value the app cannot act on is
 * better replaced than handed to `listen()` to fail on every launch.
 */
export function mcpPortFor(port: number | undefined): number {
  if (typeof port !== "number" || !Number.isInteger(port)) return DEFAULT_MCP_PORT;
  if (port < 1024 || port > 65535) return DEFAULT_MCP_PORT;
  return port;
}

/**
 * The audio device DEFAULTS used to carry. It is an index into a table that is
 * different on every Mac, and index 0 is frequently not a microphone: measured
 * on a real machine it was "Virtual Desktop Mic", which recorded **digital
 * silence at -91 dB** for an entire session while the built-in mic sat at index
 * 1. No error, no warning, just an empty transcript.
 */
const LEGACY_AUDIO_DEVICE = ":0";

/**
 * A persisted `":0"` is migrated to `":default"`, and nothing else is touched.
 *
 * This rewrites a stored value, which is normally off-limits — justified here
 * because `":0"` cannot be a deliberate choice: it is exactly the string the old
 * DEFAULTS wrote, and the audio signal shipped DISABLED until the same change
 * that turned it on, so no one ever recorded with a device they had picked. A
 * value the user actually typed differs from this one and is preserved.
 */
export function audioDeviceFor(device: string | undefined): string {
  const raw = (device ?? "").trim();
  if (raw.length === 0 || raw === LEGACY_AUDIO_DEVICE) return DEFAULT_AUDIO_INPUT;
  return raw;
}

/**
 * The allowed value of each provider field. A persisted value outside its set —
 * a hand-edited file, or a selection left by a build that had cloud providers —
 * resets to the default rather than being carried forward, which would let the
 * app try to construct a provider that no longer exists.
 */
const PROVIDER_VALUES = {
  textProvider: ["ollama", "onnx"],
  imageProvider: ["none", "nomic", "colsmol", "colmodernvbert"],
  captionProvider: ["none", "ollama"],
  summaryProvider: ["none", "ollama"],
  rerankProvider: ["none", "onnx"],
} as const satisfies Partial<Record<keyof ProviderSettingsView, readonly string[]>>;

type ProviderKey = keyof typeof PROVIDER_VALUES;

export class SettingsStore {
  private readonly dir: string;
  private readonly settingsPath: string;
  private settings: PersistedSettings;

  constructor(dataDir: string) {
    this.dir = dataDir;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.settingsPath = join(this.dir, "settings.json");
    // No code path reads this any more; leaving it would be encrypted secrets
    // with no owner.
    rmSync(join(this.dir, "keys.enc"), { force: true });
    this.settings = this.load();
  }

  private load(): PersistedSettings {
    if (!existsSync(this.settingsPath)) return structuredClone(DEFAULTS);
    try {
      const raw = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Partial<PersistedSettings>;
      const providers: ProviderSettingsView = {
        ...DEFAULTS.providers,
        ...raw.providers,
        // A blank binaryPath is normalized back to the default rather than
        // carried forward: it is what you get by clearing the field in Settings,
        // and a persisted "" used to read as "no whisper" — which turned the
        // transcribe stage off and with it the automatic model download.
        whisper: {
          ...DEFAULTS.providers.whisper,
          ...raw.providers?.whisper,
          binaryPath: resolveWhisperBinary(raw.providers?.whisper?.binaryPath),
        },
        localModels: { ...DEFAULTS.providers.localModels, ...raw.providers?.localModels },
      };
      for (const key of Object.keys(PROVIDER_VALUES) as ProviderKey[]) {
        const allowed: readonly string[] = PROVIDER_VALUES[key];
        if (!allowed.includes(providers[key])) {
          providers[key] = DEFAULTS.providers[key] as never;
        }
      }

      return {
        providers,
        signals: {
          screen: { ...DEFAULTS.signals.screen, ...raw.signals?.screen },
          input: { ...DEFAULTS.signals.input, ...raw.signals?.input },
          activeWin: { ...DEFAULTS.signals.activeWin, ...raw.signals?.activeWin },
          audio: {
            ...DEFAULTS.signals.audio,
            ...raw.signals?.audio,
            device: audioDeviceFor(raw.signals?.audio?.device),
          },
          ax: { ...DEFAULTS.signals.ax, ...raw.signals?.ax },
        },
        mcp: {
          ...DEFAULTS.mcp,
          ...raw.mcp,
          port: mcpPortFor(raw.mcp?.port),
        },
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  private persist(): void {
    writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf8");
  }

  view(): SettingsView {
    return {
      providers: this.settings.providers,
      signals: this.settings.signals,
      mcp: this.settings.mcp,
    };
  }

  apply(patch: SettingsPatch): SettingsView {
    if (patch.providers) {
      // Nested objects merge rather than replace, so a partial patch cannot
      // silently blank a sibling field.
      const { whisper, localModels, ...rest } = patch.providers;
      this.settings.providers = { ...this.settings.providers, ...rest };
      // NOT normalized here, unlike load(): this runs on every keystroke in the
      // Settings field, and snapping a cleared box back to "whisper-cli"
      // mid-edit would fight the typist. An empty value is resolved at spawn
      // time instead (resolveWhisperBinary), so it is never "off".
      if (whisper) {
        this.settings.providers.whisper = { ...this.settings.providers.whisper, ...whisper };
      }
      if (localModels) {
        this.settings.providers.localModels = {
          ...this.settings.providers.localModels,
          ...localModels,
        };
      }
    }
    if (patch.signals) {
      const s = this.settings.signals;
      const p = patch.signals;
      this.settings.signals = {
        screen: { ...s.screen, ...p.screen },
        input: { ...s.input, ...p.input },
        activeWin: { ...s.activeWin, ...p.activeWin },
        audio: { ...s.audio, ...p.audio },
        ax: { ...s.ax, ...p.ax },
      };
    }
    if (patch.mcp) {
      // Normalized here, unlike the whisper path: a port has no "resolve at
      // spawn time" moment to defer to — the listener binds whatever is stored.
      // So the pane must commit the port on BLUR rather than on every keystroke,
      // or the first digit typed would snap back to the default mid-edit.
      this.settings.mcp = {
        ...this.settings.mcp,
        ...patch.mcp,
        port: mcpPortFor(patch.mcp.port ?? this.settings.mcp.port),
      };
    }
    this.persist();
    return this.view();
  }
}

/** The app's data directory: <userData>/DeskRAG. */
export function dataDir(): string {
  return join(app.getPath("userData"), "DeskRAG");
}
