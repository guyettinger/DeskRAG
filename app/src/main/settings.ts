/**
 * SettingsStore — persists non-secret settings as JSON and API keys encrypted at
 * rest via Electron safeStorage (OS keychain-backed). Keys never leave the main
 * process in plaintext; the renderer only learns whether a key is present.
 */

import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  SettingsView,
  SettingsPatch,
  SignalConfig,
  ProviderSettingsView,
} from "@shared/types";

type KeyName = "voyage" | "gemini" | "anthropic";

interface PersistedSettings {
  providers: Omit<ProviderSettingsView, "keys">;
  signals: SignalConfig;
}

const DEFAULTS: PersistedSettings = {
  providers: {
    ollamaHost: "http://localhost:11434",
    ollamaModel: "nomic-embed-text",
    imageProvider: "none",
    captionProvider: "none",
    rerank: false,
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

export class SettingsStore {
  private readonly dir: string;
  private readonly settingsPath: string;
  private readonly keysPath: string;
  private settings: PersistedSettings;
  private keys: Partial<Record<KeyName, string>> = {};

  constructor(dataDir: string) {
    this.dir = dataDir;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.settingsPath = join(this.dir, "settings.json");
    this.keysPath = join(this.dir, "keys.enc");
    this.settings = this.load();
    this.keys = this.loadKeys();
  }

  private load(): PersistedSettings {
    if (!existsSync(this.settingsPath)) return structuredClone(DEFAULTS);
    try {
      const raw = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Partial<PersistedSettings>;
      return {
        providers: { ...DEFAULTS.providers, ...raw.providers, whisper: { ...DEFAULTS.providers.whisper, ...raw.providers?.whisper } },
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

  private loadKeys(): Partial<Record<KeyName, string>> {
    if (!existsSync(this.keysPath)) return {};
    try {
      const enc = readFileSync(this.keysPath);
      if (!safeStorage.isEncryptionAvailable()) return {};
      const json = safeStorage.decryptString(enc);
      return JSON.parse(json) as Partial<Record<KeyName, string>>;
    } catch {
      return {};
    }
  }

  private persistKeys(): void {
    if (!safeStorage.isEncryptionAvailable()) return; // no keychain -> don't write plaintext
    const enc = safeStorage.encryptString(JSON.stringify(this.keys));
    writeFileSync(this.keysPath, enc);
  }

  /** Full view for the renderer — keys reduced to presence booleans. */
  view(): SettingsView {
    return {
      providers: {
        ...this.settings.providers,
        keys: {
          voyage: Boolean(this.keys.voyage),
          gemini: Boolean(this.keys.gemini),
          anthropic: Boolean(this.keys.anthropic),
        },
      },
      signals: this.settings.signals,
    };
  }

  /** Raw key access — main process only. */
  key(name: KeyName): string | undefined {
    return this.keys[name];
  }

  apply(patch: SettingsPatch): SettingsView {
    if (patch.providers) {
      const { whisper, ...rest } = patch.providers;
      this.settings.providers = { ...this.settings.providers, ...rest };
      if (whisper) {
        this.settings.providers.whisper = { ...this.settings.providers.whisper, ...whisper };
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
    if (patch.keys) {
      for (const [k, v] of Object.entries(patch.keys) as [KeyName, string | null | undefined][]) {
        if (v === undefined) continue;
        if (v === null || v === "") delete this.keys[k];
        else this.keys[k] = v;
      }
      this.persistKeys();
    }
    this.persist();
    return this.view();
  }
}

/** The app's data directory: <userData>/DeskRAG. */
export function dataDir(): string {
  return join(app.getPath("userData"), "DeskRAG");
}
