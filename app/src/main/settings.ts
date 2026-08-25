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
  FlowsSettings,
  ProviderSettingsView,
} from "@shared/types";
import { DEFAULT_AUDIO_INPUT } from "deskrag";
import { DEFAULT_WHISPER_BIN, resolveWhisperBinary } from "./whisper.js";

interface PersistedSettings {
  providers: ProviderSettingsView;
  signals: SignalConfig;
  mcp: McpSettings;
  flows: FlowsSettings;
}

/**
 * The MCP endpoint's default port.
 *
 * Nothing well-known sits here, and it is fixed rather than searched for: the
 * URL goes into an agent's config by hand, so a port that moves on its own
 * breaks a connection the user already made.
 */
export const DEFAULT_MCP_PORT = 41777;

/**
 * DeskRAG itself, in both spellings of both builds.
 *
 * `active-win` reports `owner.name` `"Electron"` and bundle `com.github.Electron`
 * from a dev checkout, and `"DeskRAG"` / `com.deskrag.app` from a signed bundle —
 * and the consumer has no way to know which it is holding, so all four are
 * listed. Recordings taken since `focus_change` started carrying `recorder: true`
 * do not need any of them; this is what reaches everything recorded before that.
 *
 * Seeded, not hardcoded: the user can clear it, and a rebuild puts their own app
 * back in its own graph.
 */
export const DEFAULT_EXCLUDED_APPS = [
  "DeskRAG",
  "Electron",
  "com.deskrag.app",
  "com.github.Electron",
] as const;

/**
 * How wide a keyframe reaches the CAPTIONER — not how wide it is stored.
 *
 * Two consumers want opposite things and both are right. `imageMaxWidth` belongs
 * to the image model: ColModernVBERT's preprocessor upscales below 2048px and
 * match quality degrades with no visible error, which is why Settings banners
 * the user to raise it to 2560. The VLM pays for every one of those pixels —
 * measured on real keyframes with a 30B captioner, one caption cost 4113 prompt
 * tokens and 154-224s at 2560px against 1389 tokens and 91-107s at 1280px, and
 * both replies still read the calculator expression that was the whole
 * retrievable content of the segment.
 *
 * 1280 rather than the 896 that measured fastest: 896 was 3-4x on two frames
 * with one model, and `probe:caption` is what would justify moving there.
 */
export const DEFAULT_CAPTION_MAX_WIDTH = 1280;

/**
 * The band a stored value is kept inside.
 *
 * Below the floor a desktop screenshot stops being legible to any VLM, and the
 * ceiling is `imageMaxWidth`'s own maximum — above it the cap could never bind,
 * so a larger number is not a stronger preference, it is a no-op wearing one.
 */
const CAPTION_WIDTH_MIN = 320;
const CAPTION_WIDTH_MAX = 3840;

/**
 * A persisted caption width, or the default.
 *
 * Coerced on READ only, the same split `mcpPortFor` follows and for the same
 * reason `resolveWhisperBinary` is not: `apply()` runs on every keystroke in the
 * Settings field, so clamping there would fight the typist mid-edit.
 */
export function captionMaxWidthFor(width: number | undefined): number {
  if (typeof width !== "number" || !Number.isFinite(width)) return DEFAULT_CAPTION_MAX_WIDTH;
  const rounded = Math.round(width);
  if (rounded < CAPTION_WIDTH_MIN || rounded > CAPTION_WIDTH_MAX) {
    return DEFAULT_CAPTION_MAX_WIDTH;
  }
  return rounded;
}

const DEFAULTS: PersistedSettings = {
  providers: {
    ollamaHost: "http://localhost:11434",
    ollamaCaptionModel: "qwen3-vl:4b",
    captionMaxWidth: DEFAULT_CAPTION_MAX_WIDTH,
    ollamaSummaryModel: "qwen3:4b",
    // Stays nomic even though embeddinggemma scores higher: flipping this
    // strands every text vector on disk, so it is a decision for the bake-off
    // against a real store, not for a leaderboard.
    textModel: "nomic-embed-text-v1.5",
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
    // OFF by default, and for the opposite reason the microphone is on.
    // Computer audio records the FAR END of a call and everything else the
    // machine plays, so defaulting it on would start recording other people
    // without the user having chosen to. It also asks macOS for a permission
    // nothing else here needs, and a prompt the user did not provoke reads as
    // the app overstepping.
    desktopAudio: { enabled: false, chunkSeconds: 10 },
    ax: { enabled: false },
  },
  mcp: { enabled: true, port: DEFAULT_MCP_PORT },
  flows: { excludeApps: [...DEFAULT_EXCLUDED_APPS] },
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
  textModel: ["nomic-embed-text-v1.5", "embeddinggemma-300m"],
  imageProvider: ["none", "colmodernvbert"],
  captionProvider: ["none", "ollama"],
  summaryProvider: ["none", "ollama"],
  rerankProvider: ["none", "onnx"],
} as const satisfies Partial<Record<keyof ProviderSettingsView, readonly string[]>>;

type ProviderKey = keyof typeof PROVIDER_VALUES;

/**
 * Removed provider values, and what each becomes. Consulted BEFORE the
 * reset-to-default loop above, which would otherwise send them to `"none"`.
 *
 * Rewriting a stored value is normally off-limits; this follows the
 * `audioDeviceFor` precedent and is justified the same way — these are values
 * only a PREVIOUS BUILD could have written, so none of them can be a live
 * choice. And the two answers differ in what they mean: `"none"` says the user
 * asked for no visual search, where these said they asked for the best one
 * available, which is now this one.
 *
 * The migration is NOT free and is not hidden. Those frames are indexed in a
 * vector space nothing can query any more, and `DualStore` drops its tables on
 * open — so the install needs a re-index, which `EnvInfo.migratedImageProvider`
 * exists to say out loud.
 */
const PROVIDER_MIGRATIONS: Partial<Record<ProviderKey, Record<string, string>>> = {
  imageProvider: { nomic: "colmodernvbert", colsmol: "colmodernvbert" },
};

/**
 * The retired text lane, read off a persisted file before the loop above runs.
 *
 * This one cannot go through `PROVIDER_MIGRATIONS`: that table migrates a
 * VALUE of a key that still exists, and here the key itself is gone —
 * `textProvider` and the free-text `ollamaModel` beside it are both no longer
 * fields. So the shape of the old file is read directly, once.
 *
 * Only `"ollama"` is disclosed. `"onnx"` was already producing
 * `*:onnx:nomic-embed-text-v1.5:768`, which is exactly what `textModel` now
 * defaults to — that install lost nothing and must not be told to re-index.
 */
interface RetiredProviderFields {
  textProvider?: string;
}

/** Provider fields a previous build persisted that are no longer settings. */
const RETIRED_PROVIDER_FIELDS = ["textProvider", "ollamaModel"] as const;

export function retiredTextProvider(raw: unknown): string | null {
  const persisted = (raw as RetiredProviderFields | undefined)?.textProvider;
  return persisted === "ollama" ? persisted : null;
}

export class SettingsStore {
  private readonly dir: string;
  private readonly settingsPath: string;
  private settings: PersistedSettings;
  /**
   * The removed image provider this install had selected, if `load()` migrated
   * one. Read once, at startup, into `EnvInfo` — the user is told a re-index is
   * needed rather than one being started for them.
   */
  migratedImageProvider: string | null = null;
  /**
   * `"ollama"` if this install had the retired text lane selected. Same contract
   * as the field above: read once into `EnvInfo`, and nothing is started for
   * them.
   */
  migratedTextProvider: string | null = null;

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
      this.migratedTextProvider = retiredTextProvider(raw.providers);
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
        captionMaxWidth: captionMaxWidthFor(raw.providers?.captionMaxWidth),
      };
      // The spread above copies whatever the old file held, including fields
      // that are no longer settings at all. Dropped rather than carried, so the
      // next save writes a file that matches the current shape instead of
      // preserving a dead `textProvider` forever.
      for (const dead of RETIRED_PROVIDER_FIELDS) {
        delete (providers as unknown as Record<string, unknown>)[dead];
      }
      for (const key of Object.keys(PROVIDER_VALUES) as ProviderKey[]) {
        const allowed: readonly string[] = PROVIDER_VALUES[key];
        if (allowed.includes(providers[key])) continue;
        // A removed value with a successor migrates; anything else resets.
        const migrated = PROVIDER_MIGRATIONS[key]?.[providers[key]];
        if (migrated !== undefined) {
          if (key === "imageProvider") this.migratedImageProvider = providers[key];
          providers[key] = migrated as never;
        } else {
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
          // No device coercion here, unlike `audio` above: `audioDeviceFor` is
          // the microphone's `":0" -> ":default"` migration, and its whole
          // justification is that ":0" was the exact string the OLD mic default
          // wrote and so cannot have been deliberate. A tap has no device at all.
          desktopAudio: { ...DEFAULTS.signals.desktopAudio, ...raw.signals?.desktopAudio },
          ax: { ...DEFAULTS.signals.ax, ...raw.signals?.ax },
        },
        mcp: {
          ...DEFAULTS.mcp,
          ...raw.mcp,
          port: mcpPortFor(raw.mcp?.port),
        },
        // An ARRAY, so a spread would not merge it usefully: a persisted list is
        // taken whole or not at all. An empty one is a real answer — "put my own
        // app back in its graph" — and must survive, which is why the check is
        // `Array.isArray` and not truthiness.
        flows: {
          excludeApps: Array.isArray(raw.flows?.excludeApps)
            ? raw.flows.excludeApps.filter((a): a is string => typeof a === "string")
            : [...DEFAULT_EXCLUDED_APPS],
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
      flows: this.settings.flows,
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
        desktopAudio: { ...s.desktopAudio, ...p.desktopAudio },
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
    if (patch.flows?.excludeApps !== undefined) {
      // Replaced wholesale for the reason above: there is no partial edit of a
      // list that a merge could express.
      this.settings.flows = { excludeApps: [...patch.flows.excludeApps] };
    }
    this.persist();
    return this.view();
  }
}

/** The app's data directory: <userData>/DeskRAG. */
export function dataDir(): string {
  return join(app.getPath("userData"), "DeskRAG");
}
