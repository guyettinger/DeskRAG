import { describe, expect, it } from "vitest";
import { DEFAULT_WHISPER_BIN, resolveWhisperBinary, whisperAvailable } from "../src/main/whisper.js";

describe("resolveWhisperBinary", () => {
  // The regression this whole module exists for: a persisted "" (what clearing
  // the Settings field writes) read as "no whisper", which skipped the
  // transcribe stage — and the managed model is only fetched by that stage, so
  // the automatic download never ran either.
  it("falls back to the default for an unset value", () => {
    expect(resolveWhisperBinary("")).toBe(DEFAULT_WHISPER_BIN);
    expect(resolveWhisperBinary("   ")).toBe(DEFAULT_WHISPER_BIN);
    expect(resolveWhisperBinary(undefined)).toBe(DEFAULT_WHISPER_BIN);
  });

  it("keeps an explicit binary", () => {
    expect(resolveWhisperBinary("/opt/homebrew/bin/whisper-cli")).toBe(
      "/opt/homebrew/bin/whisper-cli",
    );
  });
});

describe("whisperAvailable", () => {
  it("checks an explicit path on disk", () => {
    expect(whisperAvailable("/definitely/not/here/whisper-cli")).toBe(false);
  });

  it("looks a bare name up on PATH", () => {
    // "sh" stands in for whisper-cli: every machine running these tests has it,
    // and the point under test is the lookup, not the binary.
    expect(whisperAvailable("sh")).toBe(true);
    expect(whisperAvailable("deskrag-no-such-binary")).toBe(false);
  });
});
