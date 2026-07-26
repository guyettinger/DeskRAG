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
  ProviderSettingsView,
} from "@shared/types";

interface PersistedSettings {
  providers: ProviderSettingsView;
  signals: SignalConfig;
}

const DEFAULTS: PersistedSettings = {
  providers: {
    ollamaHost: "http://localhost:11434",
    ollamaModel: "nomic-embed-text",
    ollamaCaptionModel: "qwen3-vl:4b",
    textProvider: "ollama",
    imageProvider: "none",
    captionProvider: "none",
    rerankProvider: "none",
    localModels: { dir: "" },
    whisper: { binaryPath: "whisper-cli", modelPath: "" },
  },
  signals: {
    screen: { enabled: true, fps: 1, imageMaxWidth: 1280 },
    input: { enabled: true },
    activeWin: { enabled: true },
    audio: { enabled: false, device: ":0", chunkSeconds: 10 },
    ax: { enabled: false },
  },
};

/**
 * The allowed value of each provider field. A persisted value outside its set —
 * a hand-edited file, or a selection left by a build that had cloud providers —
 * resets to the default rather than being carried forward, which would let the
 * app try to construct a provider that no longer exists.
 */
const PROVIDER_VALUES = {
  textProvider: ["ollama", "onnx"],
  imageProvider: ["none", "nomic", "colsmol"],
  captionProvider: ["none", "ollama"],
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
        whisper: { ...DEFAULTS.providers.whisper, ...raw.providers?.whisper },
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
          audio: { ...DEFAULTS.signals.audio, ...raw.signals?.audio },
          ax: { ...DEFAULTS.signals.ax, ...raw.signals?.ax },
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
    return { providers: this.settings.providers, signals: this.settings.signals };
  }

  apply(patch: SettingsPatch): SettingsView {
    if (patch.providers) {
      // Nested objects merge rather than replace, so a partial patch cannot
      // silently blank a sibling field.
      const { whisper, localModels, ...rest } = patch.providers;
      this.settings.providers = { ...this.settings.providers, ...rest };
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
    this.persist();
    return this.view();
  }
}

/** The app's data directory: <userData>/DeskRAG. */
export function dataDir(): string {
  return join(app.getPath("userData"), "DeskRAG");
}
