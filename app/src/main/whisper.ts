/**
 * Whisper settings resolution.
 *
 * Both whisper fields are "empty means default", and neither empty value means
 * "off":
 *   - modelPath "" -> the managed GGML file (MODELS.whisper), downloaded on
 *     first transcribe like every other weight;
 *   - binaryPath "" -> "whisper-cli" on PATH.
 *
 * The second one used to be missing, and it silently cost people transcripts:
 * clearing the Binary path field in Settings persisted "", the transcribe stage
 * is gated on that string being non-empty, so the stage never ran — and because
 * the model is only fetched by that stage, the automatic download never happened
 * either. It looked exactly like "the download is broken" when the real state was
 * "transcription is disabled".
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const DEFAULT_WHISPER_BIN = "whisper-cli";

/** The binary that will actually be spawned for a given settings value. */
export function resolveWhisperBinary(binaryPath: string | undefined): string {
  const trimmed = (binaryPath ?? "").trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_WHISPER_BIN;
}

/**
 * Is that binary actually here? A path is checked on disk, a bare name on PATH
 * (which ensureToolPath() has already widened to include Homebrew).
 *
 * This is what gates the model download: fetching 57MB for a machine with no
 * whisper.cpp installed would be pure waste.
 */
export function whisperAvailable(binaryPath: string | undefined): boolean {
  const bin = resolveWhisperBinary(binaryPath);
  if (bin.includes("/")) return existsSync(bin);
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    return spawnSync(probe, [bin], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
