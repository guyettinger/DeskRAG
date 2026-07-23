/**
 * WhisperCppTranscription — local speech-to-text by shelling out to a whisper.cpp
 * binary. Uses only node:child_process (no native addon), so like the ffmpeg /
 * Swift-AX adapters it is NOT re-exported from the barrel — import it from this
 * path. Audio never leaves the machine; no API key, no per-minute cost.
 *
 * Best-effort by contract (mirrors SwiftAxSource): a missing binary, missing
 * model, non-zero exit, or timeout all resolve to `{ text: "" }` (logged via
 * onError), so absent STT degrades to "no transcript" rather than failing the
 * represent pass.
 *
 * Contract for the binary (whisper.cpp `whisper-cli` / legacy `main`):
 *   whisper-cli -m <model> -f <audio.wav> -nt -l <lang> -otxt -of <out>
 *   → writes recognized text (no timestamps) to `<out>.txt`.
 * The audio is written to a temp 16 kHz mono WAV first (that's what the audio
 * producer emits), transcribed, then both temp files are removed.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptionProvider, TranscriptionResult } from "../../embed/types.js";

export interface WhisperCppOptions {
  /** Path to the whisper.cpp binary (default: ERAG_WHISPER_BIN or "whisper-cli"). */
  binaryPath?: string;
  /** Path to a GGML/GGUF model (default: ERAG_WHISPER_MODEL). Required to work. */
  modelPath?: string;
  /** Language hint, e.g. "en" (default "auto"). */
  language?: string;
  /** Extra args appended before the input file. */
  args?: string[];
  /** Kill + return "" after this many ms (default 120000). */
  timeoutMs?: number;
  onError?: (msg: string) => void;
}

export class WhisperCppTranscription implements TranscriptionProvider {
  private readonly binaryPath: string;
  private readonly modelPath: string | undefined;
  private readonly language: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs: number;
  private readonly onError: (msg: string) => void;

  constructor(opts: WhisperCppOptions = {}) {
    this.binaryPath = opts.binaryPath ?? process.env.ERAG_WHISPER_BIN ?? "whisper-cli";
    this.modelPath = opts.modelPath ?? process.env.ERAG_WHISPER_MODEL;
    this.language = opts.language ?? "auto";
    this.extraArgs = opts.args ?? [];
    this.timeoutMs = opts.timeoutMs ?? 120000;
    this.onError = opts.onError ?? ((m) => console.error(`[whisper] ${m}`));
  }

  async transcribe(
    audio: Uint8Array,
    opts?: { language?: string },
  ): Promise<TranscriptionResult> {
    if (!this.modelPath) {
      this.onError("no model path configured (set modelPath or ERAG_WHISPER_MODEL)");
      return { text: "" };
    }
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "erag-whisper-"));
      const wavPath = join(dir, "clip.wav");
      const outBase = join(dir, "clip"); // whisper appends ".txt"
      await writeFile(wavPath, audio);
      const args = [
        "-m", this.modelPath,
        "-f", wavPath,
        "-nt",
        "-l", opts?.language ?? this.language,
        "-otxt", "-of", outBase,
        ...this.extraArgs,
      ];
      const text = await this.run(args, `${outBase}.txt`);
      return { text: text.trim() };
    } catch (err) {
      this.onError(err instanceof Error ? err.message : String(err));
      return { text: "" };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private run(args: string[], outPath: string): Promise<string> {
    return new Promise((resolve) => {
      execFile(
        this.binaryPath,
        args,
        { timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
        (err, stdout) => {
          if (err) {
            this.onError(err.message);
            resolve("");
            return;
          }
          // Prefer the -otxt file; fall back to stdout for binaries that ignore it.
          readFile(outPath, "utf8").then(
            (txt) => resolve(txt),
            () => resolve(stdout ?? ""),
          );
        },
      );
    });
  }
}
