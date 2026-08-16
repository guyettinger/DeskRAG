import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MCP_PORT, SettingsStore } from "../src/main/settings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "set-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(providers: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ providers }), "utf8");
}

function seedSignals(signals: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ signals }), "utf8");
}

describe("defaults", () => {
  it("ships with every optional model off", () => {
    const p = new SettingsStore(dir).view().providers;
    expect(p.textModel).toBe("nomic-embed-text-v1.5");
    expect(p.imageProvider).toBe("none");
    expect(p.captionProvider).toBe("none");
    expect(p.rerankProvider).toBe("none");
    expect(p.ollamaCaptionModel).toBe("qwen3-vl:4b");
    expect(p.localModels.dir).toBe("");
  });

  it("exposes no key field at all — there is nothing to hold", () => {
    expect(new SettingsStore(dir).view().providers).not.toHaveProperty("keys");
  });

  /**
   * `:0` is an INDEX into a per-machine table, and on a real Mac index 0 was
   * "Virtual Desktop Mic" — a full session of digital silence at -91 dB with no
   * error anywhere, just an empty transcript. `:default` is whatever macOS Sound
   * is set to, which is the answer the user already gave the system.
   */
  it("records from the system default input, never index 0", () => {
    expect(new SettingsStore(dir).view().signals.audio.device).toBe(":default");
  });

  // Safe to rewrite because it cannot be a deliberate choice: it is exactly the
  // string the old DEFAULTS wrote, and audio shipped disabled until the same
  // change that turned it on.
  it("migrates the legacy :0 that no one chose", () => {
    seedSignals({ audio: { enabled: true, device: ":0", chunkSeconds: 10 } });
    const audio = new SettingsStore(dir).view().signals.audio;
    expect(audio.device).toBe(":default");
    expect(audio.chunkSeconds).toBe(10); // siblings untouched
  });

  it("keeps a device the user actually picked", () => {
    seedSignals({ audio: { enabled: true, device: ":2", chunkSeconds: 10 } });
    expect(new SettingsStore(dir).view().signals.audio.device).toBe(":2");
  });

  // A persisted "" is what clearing the Settings field leaves behind, and it
  // used to read as "no whisper": the transcribe stage was skipped, so the
  // managed model — which only that stage fetches — never downloaded.
  it("restores the default whisper binary when the persisted one is blank", () => {
    seed({ whisper: { binaryPath: "", modelPath: "" } });
    expect(new SettingsStore(dir).view().providers.whisper.binaryPath).toBe("whisper-cli");
  });

  it("keeps an explicitly set whisper binary", () => {
    seed({ whisper: { binaryPath: "/opt/w/whisper-cli", modelPath: "" } });
    expect(new SettingsStore(dir).view().providers.whisper.binaryPath).toBe(
      "/opt/w/whisper-cli",
    );
  });
});

describe("unknown persisted values", () => {
  // Settings left by a build that had cloud providers, or a hand-edited file.
  // Carrying one forward would ask the app to construct a provider that no
  // longer exists.
  it.each([
    ["imageProvider", "voyage", "none"],
    ["captionProvider", "anthropic", "none"],
    ["rerankProvider", "anthropic", "none"],
    ["textModel", "text-embedding-3-large", "nomic-embed-text-v1.5"],
  ])("resets %s=%s to %s", (field, bad, expected) => {
    seed({ [field]: bad });
    expect(new SettingsStore(dir).view().providers[field as "imageProvider"]).toBe(expected);
  });

  /**
   * A REMOVED value with a successor migrates instead of resetting, and the two
   * answers mean different things: `"none"` says the user asked for no visual
   * search, where `"nomic"`/`"colsmol"` said they asked for the best one
   * available — which is now ColModernVBERT.
   *
   * Rewriting a stored value is normally off-limits; this is safe for the same
   * reason `audioDeviceFor`'s `":0"` migration is: only a previous BUILD could
   * have written either string, so neither can be a live choice.
   */
  it.each([["nomic"], ["colsmol"]])("migrates imageProvider=%s to colmodernvbert", (old) => {
    seed({ imageProvider: old });
    const store = new SettingsStore(dir);
    expect(store.view().providers.imageProvider).toBe("colmodernvbert");
    // And it SAYS SO: the frames indexed under the old model are in a space
    // nothing can query, so the user is told a re-index is needed.
    expect(store.migratedImageProvider).toBe(old);
  });

  it("reports no migration when the persisted provider is a live one", () => {
    seed({ imageProvider: "colmodernvbert" });
    expect(new SettingsStore(dir).migratedImageProvider).toBeNull();
    seed({ imageProvider: "none" });
    expect(new SettingsStore(dir).migratedImageProvider).toBeNull();
  });

  /**
   * The retired text lane. Unlike imageProvider this is a removed KEY, not a
   * removed value, so it cannot ride PROVIDER_VALUES/PROVIDER_MIGRATIONS.
   */
  it("migrates a persisted textProvider=ollama and says so", () => {
    seed({ textProvider: "ollama", ollamaModel: "nomic-embed-text" });
    const store = new SettingsStore(dir);
    expect(store.view().providers.textModel).toBe("nomic-embed-text-v1.5");
    // Every text vector this install holds is namespaced *:ollama:*, which
    // nothing can query now — digest, caption, transcript and summary search
    // are ALL empty until a re-index, so it must not be silent.
    expect(store.migratedTextProvider).toBe("ollama");
  });

  /**
   * An install already on ONNX lost NOTHING: its vectors sit in
   * `*:onnx:nomic-embed-text-v1.5:768`, which is exactly what textModel now
   * defaults to. Telling that user to re-index would be a lie costing an hour.
   */
  it("stays silent for an install already on the onnx lane", () => {
    seed({ textProvider: "onnx" });
    const store = new SettingsStore(dir);
    expect(store.view().providers.textModel).toBe("nomic-embed-text-v1.5");
    expect(store.migratedTextProvider).toBeNull();
  });

  it("drops the retired fields rather than persisting them forever", () => {
    seed({ textProvider: "ollama", ollamaModel: "muse-glimmer:30b-mlx" });
    const s = new SettingsStore(dir);
    s.apply({ providers: { textModel: "embeddinggemma-300m" } });
    const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as {
      providers: Record<string, unknown>;
    };
    expect(raw.providers.textProvider).toBeUndefined();
    expect(raw.providers.ollamaModel).toBeUndefined();
    expect(raw.providers.textModel).toBe("embeddinggemma-300m");
  });

  it("does not migrate an unknown value — that resets", () => {
    seed({ imageProvider: "voyage" });
    const store = new SettingsStore(dir);
    expect(store.view().providers.imageProvider).toBe("none");
    expect(store.migratedImageProvider).toBeNull();
  });

  it("rewrites the reset value on the next persist", () => {
    seed({ imageProvider: "voyage" });
    const s = new SettingsStore(dir);
    s.apply({ providers: { textModel: "embeddinggemma-300m" } });
    const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as {
      providers: Record<string, unknown>;
    };
    expect(raw.providers.imageProvider).toBe("none");
  });

  it("keeps valid siblings when resetting one field", () => {
    seed({
      imageProvider: "voyage",
      textModel: "embeddinggemma-300m",
      ollamaHost: "http://h:1",
    });
    const p = new SettingsStore(dir).view().providers;
    expect(p.imageProvider).toBe("none");
    expect(p.textModel).toBe("embeddinggemma-300m");
    expect(p.ollamaHost).toBe("http://h:1");
  });

  it("falls back to defaults on a corrupt settings file", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{not json", "utf8");
    expect(new SettingsStore(dir).view().providers.rerankProvider).toBe("none");
  });
});

describe("stale key storage", () => {
  it("deletes a leftover keys.enc — no code path can read it any more", () => {
    mkdirSync(dir, { recursive: true });
    const keys = join(dir, "keys.enc");
    writeFileSync(keys, "encrypted-secrets");
    new SettingsStore(dir);
    expect(existsSync(keys)).toBe(false);
  });

  it("is a no-op when there is none", () => {
    expect(() => new SettingsStore(dir)).not.toThrow();
  });
});

describe("apply", () => {
  it("round-trips the provider fields and survives a reload", () => {
    const s = new SettingsStore(dir);
    const v = s.apply({
      providers: {
        textModel: "embeddinggemma-300m",
        imageProvider: "colmodernvbert",
        captionProvider: "ollama",
        rerankProvider: "onnx",
        localModels: { dir: "/models" },
      },
    });
    expect(v.providers.textModel).toBe("embeddinggemma-300m");
    expect(v.providers.imageProvider).toBe("colmodernvbert");
    expect(v.providers.localModels.dir).toBe("/models");

    const reloaded = new SettingsStore(dir).view().providers;
    expect(reloaded.imageProvider).toBe("colmodernvbert");
    expect(reloaded.localModels.dir).toBe("/models");
  });

  it("merges nested objects rather than replacing them", () => {
    const s = new SettingsStore(dir);
    s.apply({ providers: { whisper: { modelPath: "/m.bin" } } });
    const p = s.apply({ providers: { whisper: { binaryPath: "whisper-x" } } }).providers;
    // setting one field must not blank its sibling
    expect(p.whisper).toEqual({ binaryPath: "whisper-x", modelPath: "/m.bin" });
  });

  it("patches providers and signals together", () => {
    const s = new SettingsStore(dir);
    const v = s.apply({
      providers: { imageProvider: "colmodernvbert" },
      signals: { ax: { enabled: true }, screen: { imageMaxWidth: 2560 } },
    });
    expect(v.signals.ax.enabled).toBe(true);
    // >= 2048 keeps Idefics3 preprocessing on its downscale path
    expect(v.signals.screen.imageMaxWidth).toBe(2560);
    expect(v.signals.screen.fps).toBe(1); // sibling untouched
  });
});

describe("the MCP endpoint's settings", () => {
  function seedMcp(mcp: Record<string, unknown>): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ mcp }), "utf8");
  }

  it("is on by default, on the fixed port", () => {
    expect(new SettingsStore(dir).view().mcp).toEqual({ enabled: true, port: DEFAULT_MCP_PORT });
  });

  it("appears on a settings.json written before it existed", () => {
    // The same shape as every other addition here: an older file gains the key
    // with its default rather than reading as "disabled".
    seed({ textProvider: "ollama" });
    expect(new SettingsStore(dir).view().mcp.enabled).toBe(true);
  });

  it("resets a port the OS could never bind", () => {
    // A stored value the app cannot act on is better replaced than handed to
    // listen() to fail on every launch — the rule PROVIDER_VALUES follows.
    for (const port of [0, 80, 1023, 65_536, -1, 1.5, "41777", null]) {
      seedMcp({ enabled: true, port });
      expect(new SettingsStore(dir).view().mcp.port, String(port)).toBe(DEFAULT_MCP_PORT);
    }
  });

  it("keeps a port that is genuinely bindable", () => {
    seedMcp({ enabled: false, port: 51_000 });
    expect(new SettingsStore(dir).view().mcp).toEqual({ enabled: false, port: 51_000 });
  });

  it("normalizes on write, because a port has no later moment to resolve at", () => {
    // Unlike the whisper binary, which resolves at spawn time, the listener
    // binds whatever is stored. So the pane must commit on BLUR — on every
    // keystroke the first digit typed would snap back to the default.
    const store = new SettingsStore(dir);
    expect(store.apply({ mcp: { port: 3 } }).mcp.port).toBe(DEFAULT_MCP_PORT);
    expect(store.apply({ mcp: { port: 50_000 } }).mcp.port).toBe(50_000);
    // A patch touching only `enabled` leaves the port alone.
    expect(store.apply({ mcp: { enabled: false } }).mcp).toEqual({ enabled: false, port: 50_000 });
  });

  it("persists across reopen", () => {
    new SettingsStore(dir).apply({ mcp: { enabled: false, port: 50_001 } });
    expect(new SettingsStore(dir).view().mcp).toEqual({ enabled: false, port: 50_001 });
  });
});
