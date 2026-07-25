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
  keys: { voyage: false, gemini: false, anthropic: false },
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

  it("enables local capabilities with no API key at all", () => {
    const c = capabilitiesFor({
      ...base,
      imageProvider: "colsmol",
      captionProvider: "ollama",
      rerankProvider: "onnx",
    });
    expect(c.imageSearch).toBe(true);
    expect(c.caption).toBe(true);
    expect(c.rerank).toBe(true);
  });

  it("still gates cloud providers on key presence", () => {
    expect(capabilitiesFor({ ...base, imageProvider: "voyage" }).imageSearch).toBe(false);
    expect(
      capabilitiesFor({
        ...base,
        imageProvider: "voyage",
        keys: { ...base.keys, voyage: true },
      }).imageSearch,
    ).toBe(true);

    expect(capabilitiesFor({ ...base, rerankProvider: "anthropic" }).rerank).toBe(false);
    expect(
      capabilitiesFor({
        ...base,
        rerankProvider: "anthropic",
        keys: { ...base.keys, anthropic: true },
      }).rerank,
    ).toBe(true);

    expect(capabilitiesFor({ ...base, captionProvider: "gemini" }).caption).toBe(false);
  });

  it("does not let one provider's key enable another", () => {
    // A Gemini key must not turn on a Voyage-backed image search.
    const c = capabilitiesFor({
      ...base,
      imageProvider: "voyage",
      keys: { ...base.keys, gemini: true },
    });
    expect(c.imageSearch).toBe(false);
  });

  it("ties transcript to a whisper model path, not the binary", () => {
    expect(capabilitiesFor({ ...base, whisper: { binaryPath: "w", modelPath: "" } }).transcript).toBe(
      false,
    );
    expect(
      capabilitiesFor({ ...base, whisper: { binaryPath: "w", modelPath: "/m.bin" } }).transcript,
    ).toBe(true);
  });
});
