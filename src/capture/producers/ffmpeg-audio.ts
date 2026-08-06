/**
 * FfmpegAudioProducer — captures audio by spawning ffmpeg with an avfoundation
 * audio input, reads raw 16-bit little-endian PCM from stdout, and reassembles
 * it into fixed-duration WAV chunks (reusing FrameChunker for byte-exact
 * windowing). Each chunk is stamped on the monotonic clock — derived from the
 * audio byte position so timestamps track audio time, not wall-clock jitter —
 * and pushed through ctx.ingestAudio to be persisted verbatim as a blob. The
 * transcript view is (re-)generated from those blobs downstream.
 *
 * Default is mic-only from avfoundation's `:default` — the input macOS Sound is
 * set to — resolved in start() against the machine's real device table. An
 * INDEX is not a safe default: index 0 is often a virtual device that records
 * silence (see resolveAudioInput). Desktop/system audio needs a loopback
 * device (e.g. BlackHole) selected via `device`. Like FfmpegScreenProducer this
 * only spawns a subprocess (no native addon), but it is NOT re-exported from the
 * barrel — import it from this path.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  DEFAULT_AUDIO_INPUT,
  listAvfoundationDevices,
  resolveAudioInput,
} from "./avfoundation-devices.js";
import { FrameChunker } from "../frame-chunker.js";
import { encodeWav } from "./wav.js";
import type { AudioChunk, CaptureContext, Producer } from "../types.js";

export interface FfmpegAudioOptions {
  /**
   * avfoundation audio device. Defaults to `":default"` (whatever macOS Sound
   * is set to); an index like `":2"` selects a specific one, e.g. a loopback.
   */
  device?: string;
  /** Which media kind these bytes represent (affects blob.media). */
  media?: "mic" | "desktop_audio";
  /** Seconds of audio per emitted WAV chunk. */
  chunkSeconds?: number;
  /** PCM sample rate; 16 kHz mono is whisper-friendly and small. */
  sampleRate?: number;
  channels?: number;
  ffmpegPath?: string;
  /** Fully override the ffmpeg args (bypasses the defaults). */
  ffmpegArgs?: string[];
  onError?: (msg: string) => void;
}

const BITS_PER_SAMPLE = 16;

export class FfmpegAudioProducer implements Producer {
  readonly id = "audio";
  private proc: ChildProcess | undefined;
  private ctx: CaptureContext | undefined;
  private ingestChain: Promise<void> = Promise.resolve();
  private readonly chunker: FrameChunker;
  private readonly media: "mic" | "desktop_audio";
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly bytesPerChunk: number;
  /** avfoundation device validated in start(); see FfmpegAudioOptions.device. */
  private resolvedDevice: string | undefined;
  /** Monotonic anchor for the first sample; audio time is measured from here. */
  private anchorMono: number | undefined;
  /** PCM bytes emitted so far (drives per-chunk t_mono). */
  private bytesEmitted = 0;

  constructor(private readonly opts: FfmpegAudioOptions = {}) {
    this.media = opts.media ?? "mic";
    this.sampleRate = opts.sampleRate ?? 16000;
    this.channels = opts.channels ?? 1;
    const chunkSeconds = opts.chunkSeconds ?? 10;
    const bytesPerSecond = this.sampleRate * this.channels * (BITS_PER_SAMPLE / 8);
    this.bytesPerChunk = Math.max(1, Math.round(chunkSeconds * bytesPerSecond));
    this.chunker = new FrameChunker(this.bytesPerChunk);
  }

  private get bytesPerSecond(): number {
    return this.sampleRate * this.channels * (BITS_PER_SAMPLE / 8);
  }

  private args(): string[] {
    if (this.opts.ffmpegArgs) return this.opts.ffmpegArgs;
    // Resolved in start(); the last fallback is only reachable when args() is
    // called without one, which nothing does.
    const device = this.resolvedDevice ?? this.opts.device ?? DEFAULT_AUDIO_INPUT;
    return [
      "-hide_banner", "-loglevel", "error",
      "-f", "avfoundation", "-i", device,
      "-ac", String(this.channels), "-ar", String(this.sampleRate),
      "-f", "s16le", "pipe:1",
    ];
  }

  start(ctx: CaptureContext): void {
    this.ctx = ctx;
    const onError = this.opts.onError ?? ((m) => console.error(`[ffmpeg-audio] ${m}`));

    // Validate the device against the machine's real table before spawning. The
    // audio index moves exactly like the screen one does — plugging in an
    // interface reorders it — and a device that names nothing yields a bare
    // "Input/output error" that reads as a broken build. Skipped when
    // `ffmpegArgs` replaces the arg list, since then `device` is unused.
    if (!this.opts.ffmpegArgs) {
      const decided = resolveAudioInput(
        this.opts.device,
        listAvfoundationDevices({ ffmpegPath: this.opts.ffmpegPath ?? "ffmpeg" }),
      );
      if (decided.warning) onError(decided.warning);
      this.resolvedDevice = decided.input;
    }

    const proc = spawn(this.opts.ffmpegPath ?? "ffmpeg", this.args(), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (this.anchorMono === undefined) this.anchorMono = ctx.clock.now();
      for (const pcm of this.chunker.push(chunk)) this.enqueue(pcm);
    });
    proc.stderr?.on("data", (d: Buffer) => onError(d.toString().trim()));
    proc.on("error", (err) => onError(err.message));
  }

  /** WAV-wrap one PCM window and ingest it with audio-derived timestamps. */
  private enqueue(pcm: Uint8Array): void {
    const ctx = this.ctx!;
    const anchor = this.anchorMono ?? ctx.clock.now();
    const tMonoStart = anchor + (this.bytesEmitted / this.bytesPerSecond) * 1000;
    this.bytesEmitted += pcm.length;
    const tMonoEnd = anchor + (this.bytesEmitted / this.bytesPerSecond) * 1000;
    const chunk: AudioChunk = {
      bytes: encodeWav(pcm, {
        sampleRate: this.sampleRate,
        channels: this.channels,
        bitsPerSample: BITS_PER_SAMPLE,
      }),
      tMonoStart,
      tMonoEnd,
      media: this.media,
      codec: "wav",
    };
    this.ingestChain = this.ingestChain.then(() => ctx.ingestAudio(chunk));
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (proc) {
      this.proc = undefined;
      // SIGINT then AWAIT: ffmpeg exits on its own, but bytes still sitting in
      // the stdout pipe are only delivered while the stream is draining. Not
      // waiting dropped the tail of every recording — up to a whole chunk.
      // SIGKILL is the backstop so a wedged ffmpeg cannot hang stopRecording().
      //
      // The already-exited check is not redundant: 'close' has then ALREADY
      // fired, so `once` would never resolve and every such stop would burn the
      // full timeout. A finite input (a test's lavfi source, or a device that
      // went away) hits this every time.
      const alive = proc.exitCode === null && proc.signalCode === null;
      if (alive) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            proc.kill("SIGKILL");
            done();
          }, 2000);
          proc.once("close", done);
          proc.kill("SIGINT");
        });
      }
    }
    // Emit any trailing partial window so short recordings aren't lost.
    const rest = this.chunker.flush();
    if (rest && rest.length > 0) this.enqueue(rest);
    await this.ingestChain; // drain chunks already read
  }
}
