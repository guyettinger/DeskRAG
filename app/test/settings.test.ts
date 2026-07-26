import {
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
  it("ships local-capable but not local-forced", () => {
    const p = new SettingsStore(dir).view().providers;
    expect(p.textProvider).toBe("ollama");
    expect(p.imageProvider).toBe("none");
    expect(p.captionProvider).toBe("none");
    expect(p.rerankProvider).toBe("none");
    expect(p.ollamaCaptionModel).toBe("qwen3-vl:4b");
    expect(p.localModels.dir).toBe("");
  });

  it("never exposes raw keys to the renderer view", () => {
    const v = new SettingsStore(dir).view();
    expect(v.providers.keys).toEqual({ voyage: false, gemini: false, anthropic: false });
  });
});

describe("rerank -> rerankProvider migration", () => {
  it("maps legacy rerank:true to anthropic", () => {
    seed({ rerank: true });
    expect(new SettingsStore(dir).view().providers.rerankProvider).toBe("anthropic");
  });

  it("maps legacy rerank:false to none", () => {
    seed({ rerank: false });
    expect(new SettingsStore(dir).view().providers.rerankProvider).toBe("none");
  });

  it("prefers an explicit rerankProvider over the legacy flag", () => {
    seed({ rerank: true, rerankProvider: "onnx" });
    expect(new SettingsStore(dir).view().providers.rerankProvider).toBe("onnx");
  });

  it("drops the legacy key on the next persist", () => {
    seed({ rerank: true });
    const s = new SettingsStore(dir);
    s.apply({ providers: { textProvider: "onnx" } });
    const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as {
      providers: Record<string, unknown>;
    };
    expect(raw.providers.rerank).toBeUndefined();
    expect(raw.providers.rerankProvider).toBe("anthropic");
  });

  it("falls back to defaults on a corrupt settings file", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{not json", "utf8");
    expect(new SettingsStore(dir).view().providers.rerankProvider).toBe("none");
  });
});

describe("apply", () => {
  it("round-trips the new provider fields and survives a reload", () => {
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

  it("applies the local profile in one patch, including AX capture", () => {
    const s = new SettingsStore(dir);
    const v = s.apply({
      providers: {
        textProvider: "onnx",
        imageProvider: "colsmol",
        captionProvider: "ollama",
        rerankProvider: "onnx",
      },
      signals: { ax: { enabled: true }, screen: { imageMaxWidth: 2560 } },
    });
    expect(v.signals.ax.enabled).toBe(true);
    // >= 2048 keeps ColSmol preprocessing on its downscale path
    expect(v.signals.screen.imageMaxWidth).toBe(2560);
    expect(v.signals.screen.fps).toBe(1); // sibling untouched
  });
});
