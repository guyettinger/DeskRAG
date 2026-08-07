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
      appCaption: false,
      rerank: false,
    });
  });

  it("enables a capability on selection alone — local models need no credential", () => {
    const c = capabilitiesFor({
      ...base,
      imageProvider: "colsmol",
      captionProvider: "ollama",
      rerankProvider: "onnx",
    });
    expect(c).toEqual({ imageSearch: true, caption: true, appCaption: true, rerank: true });
  });

  it("keeps the three provider capabilities independent", () => {
    expect(capabilitiesFor({ ...base, imageProvider: "colsmol" })).toEqual({
      imageSearch: true,
      caption: false,
      appCaption: false,
      rerank: false,
    });
  });

  /**
   * Capabilities report configured INTENT, and no whisper setting expresses
   * "off": both fields default when empty (managed model, "whisper-cli" on
   * PATH). A `transcript` member could therefore only ever be `true`, and the
   * version of it that read a field is precisely what silently disabled the
   * stage — and with it the model download, since only that stage fetches it.
   * Availability belongs to EnvInfo.whisperConfigured, which probes the binary.
   */
  it("never grows a whisper-derived member", () => {
    for (const whisper of [
      { binaryPath: "", modelPath: "" },
      { binaryPath: "w", modelPath: "" },
      { binaryPath: "", modelPath: "/m.bin" },
      { binaryPath: "w", modelPath: "/m.bin" },
    ]) {
      const c = capabilitiesFor({ ...base, whisper });
      expect(c).not.toHaveProperty("transcript");
      expect(Object.keys(c).sort()).toEqual(["appCaption", "caption", "imageSearch", "rerank"]);
    }
  });
});
