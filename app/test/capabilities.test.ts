import { describe, expect, it } from "vitest";
import { capabilitiesFor } from "../src/main/deskrag-service.js";
import type { ProviderSettingsView } from "../src/shared/types.js";

const base: ProviderSettingsView = {
  ollamaHost: "http://localhost:11434",
  ollamaModel: "nomic-embed-text",
  ollamaCaptionModel: "qwen3-vl:4b",
  textProvider: "ollama",
  imageProvider: "none",
  captionProvider: "none",
  rerankProvider: "none",
  localModels: { dir: "" },
  whisper: { binaryPath: "whisper-cli", modelPath: "" },
};

describe("capabilitiesFor", () => {
  it("reports nothing enabled by default", () => {
    expect(capabilitiesFor(base)).toEqual({
      imageSearch: false,
      caption: false,
      rerank: false,
      transcript: false,
    });
  });

  it("enables a capability on selection alone — local models need no credential", () => {
    const c = capabilitiesFor({
      ...base,
      imageProvider: "colsmol",
      captionProvider: "ollama",
      rerankProvider: "onnx",
    });
    expect(c).toEqual({
      imageSearch: true,
      caption: true,
      rerank: true,
      transcript: false,
    });
  });

  it("keeps the three provider capabilities independent", () => {
    expect(capabilitiesFor({ ...base, imageProvider: "colsmol" })).toEqual({
      imageSearch: true,
      caption: false,
      rerank: false,
      transcript: false,
    });
  });

  it("ties transcript to a whisper model path, not the binary", () => {
    expect(
      capabilitiesFor({ ...base, whisper: { binaryPath: "w", modelPath: "" } }).transcript,
    ).toBe(false);
    expect(
      capabilitiesFor({ ...base, whisper: { binaryPath: "w", modelPath: "/m.bin" } }).transcript,
    ).toBe(true);
  });
});
