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
 * device (e.g. BlackHole) selected via `device`, but the shipped route for
 * computer audio is `SystemAudioProducer` and its Core Audio tap — macOS
 * exposes no system audio to avfoundation at all. Like FfmpegScreenProducer
 * this only spawns a subprocess (no native addon), so it IS re-exported from
 * the barrel.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import {
  DEFAULT_AUDIO_INPUT,
  listAvfoundationDevices,
  resolveAudioInput,
} from "./avfoundation-devices.js";
import { FrameChunker } from "../frame-chunker.js";
import { firstPtsTimeMs } from "../pts-line.js";
import { encodeWav } from "./wav.js";

import type { AudioChunk, CaptureContext, Producer } from "../types.js";

/** Metadata key added purely so `ametadata=mode=print` emits a frame header. */
const META_KEY = "deskrag";

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
  /** Instance-derived: `SystemAudioProducer` is the other audio producer. */
  readonly id: string;
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
  /** Partial fd-3 text awaiting a complete pts_time. */
  private metaBuf = "";
  /** PCM windows held until the anchor arrives; see enqueue(). */
  private pending: Uint8Array[] = [];
  /** PCM bytes emitted so far (drives per-chunk t_mono). */
  private bytesEmitted = 0;

  constructor(private readonly opts: FfmpegAudioOptions = {}) {
    this.media = opts.media ?? "mic";
    this.id = `audio-${this.media === "mic" ? "mic" : "desktop"}`;
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
      // The device-time anchor, on its OWN fd. `-copyts` makes the reported pts
      // the capture device's timestamp rather than a stream-relative one, which
      // is what makes it convertible to t_mono.
      //
      // Neither obvious alternative works: `mkvtimestamp_v2` rejects audio
      // streams outright, and `ashowinfo` reports the number only through the
      // LOG, which would mean `-loglevel info` — and stderr goes straight to
      // the user, so every ordinary ffmpeg line would surface as an error.
      //
      // `mode=print` emits nothing for a frame with no metadata, hence the
      // `add` first. The colon in `pipe:3` is escaped because it is a filter
      // option separator TWICE over: the value is unescaped at the filtergraph
      // level and again at the option level, so it needs two literal backslashes.
      "-copyts",
      "-af", `ametadata=mode=add:key=${META_KEY}:value=1,ametadata=mode=print:file=pipe\\\\:3`,
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
      // fd 3 is the device-time anchor channel; see args().
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => {
      for (const pcm of this.chunker.push(chunk)) this.enqueue(pcm);
    });
    // fd 3 carries the device-time anchor and nothing else. Accumulate rather
    // than parse per chunk: a chunk boundary can land mid-number, and only the
    // first complete value is wanted.
    const meta = proc.stdio[3] as Readable | undefined;
    meta?.on("data", (d: Buffer) => {
      if (this.anchorMono !== undefined) return;
      this.metaBuf += d.toString();
      const pts = firstPtsTimeMs(this.metaBuf);
      if (pts !== null) {
        // The DEVICE time of audio sample 0. Everything after it comes from the
        // byte count, which was always exact — only the anchor was
        // arrival-contaminated, and that error was the audio pipeline's own
        // latency baked into every chunk of the recording.
        this.anchorMono = ctx.deviceClock.toTMono(pts);
        this.metaBuf = "";
        // PCM can outrun the anchor: ffmpeg may deliver audio bytes before the
        // first metadata line is flushed. Those chunks were held rather than
        // dropped, and they are timed correctly now — the anchor describes byte
        // 0 whenever we happen to learn it.
        const held = this.pending;
        this.pending = [];
        for (const pcm of held) this.emit(pcm);
      }
    });
    proc.stderr?.on("data", (d: Buffer) => onError(d.toString().trim()));
    proc.on("error", (err) => onError(err.message));
  }

  /**
   * Take one PCM window. Held until the device-time anchor arrives, because
   * audio bytes can outrun it — holding is lossless, where stamping arrival
   * time would silently put this recording's audio on a different clock from
   * its frames and events.
   */
  private enqueue(pcm: Uint8Array): void {
    if (this.anchorMono === undefined) {
      this.pending.push(pcm);
      return;
    }
    this.emit(pcm);
  }

  /** WAV-wrap one PCM window and ingest it with audio-derived timestamps. */
  private emit(pcm: Uint8Array): void {
    const ctx = this.ctx!;
    if (this.anchorMono === undefined) {
      // No fallback to arrival time. Anchoring on when the bytes turned up
      // would put this recording's audio on a different clock from its frames
      // and events, silently and for the whole session.
      throw new Error(
        "audio bytes arrived before any ashowinfo pts — cannot anchor the " +
          "stream on device time. Check that the args carry `-copyts -af ashowinfo` " +
          "and that -loglevel is `info`.",
      );
    }
    const anchor = this.anchorMono;
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
    if (this.anchorMono === undefined && this.pending.length > 0) {
      // Bytes arrived but no device timestamp ever did, so there is no honest
      // time to store them at. Say so and drop them: mistimed audio would sit
      // silently on a different clock from every other signal in the recording,
      // which is the failure this whole design removes.
      const onError = this.opts.onError ?? ((m) => console.error(`[ffmpeg-audio] ${m}`));
      onError(
        `captured ${this.pending.length} audio window(s) but ffmpeg reported no ` +
          "pts on fd 3 — cannot anchor them on device time, so they are dropped. " +
          "Check that the args carry `-copyts` and the ametadata print filter.",
      );
      this.pending = [];
    }
    await this.ingestChain; // drain chunks already read
  }
}
