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
import { SettingsStore } from "../src/main/settings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "set-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(providers: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ providers }), "utf8");
}

describe("defaults", () => {
  it("ships with every optional model off", () => {
    const p = new SettingsStore(dir).view().providers;
    expect(p.textProvider).toBe("ollama");
    expect(p.imageProvider).toBe("none");
    expect(p.captionProvider).toBe("none");
    expect(p.rerankProvider).toBe("none");
    expect(p.ollamaCaptionModel).toBe("qwen3-vl:4b");
    expect(p.localModels.dir).toBe("");
  });

  it("exposes no key field at all — there is nothing to hold", () => {
    expect(new SettingsStore(dir).view().providers).not.toHaveProperty("keys");
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
    ["textProvider", "gemini", "ollama"],
  ])("resets %s=%s to %s", (field, bad, expected) => {
    seed({ [field]: bad });
    expect(new SettingsStore(dir).view().providers[field as "imageProvider"]).toBe(expected);
  });

  it("rewrites the reset value on the next persist", () => {
    seed({ imageProvider: "voyage" });
    const s = new SettingsStore(dir);
    s.apply({ providers: { textProvider: "onnx" } });
    const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as {
      providers: Record<string, unknown>;
    };
    expect(raw.providers.imageProvider).toBe("none");
  });

  it("keeps valid siblings when resetting one field", () => {
    seed({ imageProvider: "voyage", textProvider: "onnx", ollamaHost: "http://h:1" });
    const p = new SettingsStore(dir).view().providers;
    expect(p.imageProvider).toBe("none");
    expect(p.textProvider).toBe("onnx");
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
        textProvider: "onnx",
        imageProvider: "colsmol",
        captionProvider: "ollama",
        rerankProvider: "onnx",
        localModels: { dir: "/models" },
      },
    });
    expect(v.providers.textProvider).toBe("onnx");
    expect(v.providers.imageProvider).toBe("colsmol");
    expect(v.providers.localModels.dir).toBe("/models");

    const reloaded = new SettingsStore(dir).view().providers;
    expect(reloaded.imageProvider).toBe("colsmol");
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
      providers: { imageProvider: "colsmol" },
      signals: { ax: { enabled: true }, screen: { imageMaxWidth: 2560 } },
    });
    expect(v.signals.ax.enabled).toBe(true);
    // >= 2048 keeps ColSmol preprocessing on its downscale path
    expect(v.signals.screen.imageMaxWidth).toBe(2560);
    expect(v.signals.screen.fps).toBe(1); // sibling untouched
  });
});
