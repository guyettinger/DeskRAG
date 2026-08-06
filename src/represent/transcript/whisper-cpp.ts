/**
 * WhisperCppTranscription — local speech-to-text by shelling out to a whisper.cpp
 * binary. Uses only node:child_process (no native addon), so like the ffmpeg /
 * Swift-AX adapters it is NOT re-exported from the barrel — import it from this
 * path. Audio never leaves the machine; no API key, no per-minute cost.
 *
 * Best-effort by contract (mirrors SwiftAxSource): a missing binary, missing
 * model, non-zero exit, or malformed output all resolve to `{ text: "" }`
 * (logged via onError), so absent/broken STT degrades to "no transcript"
 * rather than failing the represent pass.
 *
 * Contract for the binary (whisper.cpp `whisper-cli` / legacy `main`):
 *   whisper-cli -m <model> -f <audio.wav> -l <lang> -oj -of <out>
 *   → writes a JSON transcript (with per-segment offsets, in ms) to `<out>.json`.
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

interface WhisperJsonEntry {
  text?: unknown;
  offsets?: { from?: unknown; to?: unknown };
}

/** Parses whisper.cpp's -oj JSON shape defensively; any mismatch degrades to
 *  `{ text: "" }` rather than throwing, the same contract a missing binary has. */
export function parseWhisperJson(
  json: string,
  onError: (msg: string) => void,
): TranscriptionResult {
  let parsed: { transcription?: WhisperJsonEntry[] };
  try {
    parsed = JSON.parse(json) as { transcription?: WhisperJsonEntry[] };
  } catch (err) {
    onError(
      `could not parse whisper JSON output: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { text: "" };
  }
  const entries = parsed.transcription;
  if (!Array.isArray(entries)) return { text: "" };

  const segments: { text: string; startMs: number; endMs: number }[] = [];
  for (const e of entries) {
    const text = typeof e.text === "string" ? e.text.trim() : "";
    const startMs = e.offsets?.from;
    const endMs = e.offsets?.to;
    if (!text || typeof startMs !== "number" || typeof endMs !== "number") continue;
    segments.push({ text, startMs, endMs });
  }
  const text = segments.map((s) => s.text).join(" ").trim();
  return segments.length > 0 ? { text, segments } : { text };
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
      const outBase = join(dir, "clip"); // whisper appends ".json"
      await writeFile(wavPath, audio);
      const args = [
        "-m", this.modelPath,
        "-f", wavPath,
        "-l", opts?.language ?? this.language,
        "-oj", "-of", outBase,
        ...this.extraArgs,
      ];
      return await this.run(args, `${outBase}.json`);
    } catch (err) {
      this.onError(err instanceof Error ? err.message : String(err));
      return { text: "" };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private run(args: string[], outPath: string): Promise<TranscriptionResult> {
    return new Promise((resolve) => {
      execFile(
        this.binaryPath,
        args,
        { timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
        (err) => {
          if (err) {
            this.onError(err.message);
            resolve({ text: "" });
            return;
          }
          readFile(outPath, "utf8").then(
            (json) => resolve(parseWhisperJson(json, this.onError)),
            () => resolve({ text: "" }),
          );
        },
      );
    });
  }
}
