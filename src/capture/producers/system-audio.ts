/**
 * SystemAudioProducer — captures COMPUTER AUDIO (everything this Mac plays) by
 * spawning the `audio-tap` Swift sidecar, reading 16-bit little-endian mono PCM
 * from its stdout, and reassembling it into fixed-duration WAV chunks stored as
 * `desktop_audio` blobs. The transcript view is regenerated from those blobs
 * downstream, exactly as it is for the microphone.
 *
 * WHY NOT ffmpeg, like every other producer here. macOS does not expose system
 * audio to AVFoundation at all: `-list_devices` puts "Capture screen N" under
 * VIDEO only, and `AVCaptureScreenInput` carries no audio stream. The only
 * routes are a Core Audio process tap, ScreenCaptureKit, or asking the user to
 * install a loopback driver. The tap wins on a measurement: it is PRE-MIXER, so
 * with the system output MUTED a tone still captured at -34.5 dB, and moving the
 * volume slider from 20 to 90 moved the captured level by 0.0 dB. A
 * ScreenCaptureKit capture is post-mixer and would have recorded silence.
 *
 * The sidecar's own header carries the rest of the argument, including why
 * Electron's `audio:'loopback'` — the same tap underneath — is the wrong shape
 * for this codebase.
 *
 * This mirrors `FfmpegAudioProducer` deliberately and closely: same
 * hold-until-anchored discipline, same byte-derived timestamps, same
 * SIGINT-then-await stop. Where it differs, it differs because of something
 * measured, and each of those is marked below.
 *
 * In the barrel: it spawns a binary but loads no native module.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import { FrameChunker } from "../frame-chunker.js";
import { parseAudioTapAnchor } from "../audio-tap-anchor.js";
import { encodeWav } from "./wav.js";

import type { AudioChunk, CaptureContext, Producer } from "../types.js";

const run = promisify(execFile);

/** The only contract this producer knows how to read. See `--version`. */
const SUPPORTED_CONTRACT = 1;

const BITS_PER_SAMPLE = 16;

export interface SystemAudioOptions {
  /** Seconds of audio per emitted WAV chunk. */
  chunkSeconds?: number;
  /** PCM sample rate; 16 kHz mono is whisper-friendly and small. */
  sampleRate?: number;
  /** Path to the sidecar (default: ERAG_AUDIO_TAP_BIN or "audio-tap" on PATH). */
  binaryPath?: string;
  /**
   * Processes whose audio must NOT be captured, as unix pids.
   *
   * A SNAPSHOT, NOT A RULE. `CATapDescription` resolves pids to audio objects
   * once, at tap creation: a process that starts playing later cannot be
   * excluded at all, and a process that has never played has no audio object to
   * exclude. Electron in particular plays through helper processes rather than
   * the main one, so passing a single `process.pid` excludes nothing that makes
   * sound — pass every pid the app knows about.
   */
  excludePids?: number[];
  onError?: (msg: string) => void;
}

/** An anchor resolved onto the session clock. */
interface Segment {
  byteOffset: number;
  tMono: number;
}

export class SystemAudioProducer implements Producer {
  /**
   * Distinct from `FfmpegAudioProducer`'s. Nothing reads `Producer.id` today,
   * but two producers answering "audio" is an ambiguity waiting for the first
   * caller that does.
   */
  readonly id = "audio-desktop";

  private proc: ChildProcess | undefined;
  private ctx: CaptureContext | undefined;
  private ingestChain: Promise<void> = Promise.resolve();
  private readonly sampleRate: number;
  private readonly channels = 1;
  private readonly bytesPerChunk: number;
  private readonly binaryPath: string;

  /** Unprocessed stdout bytes; `bufStart` is the absolute offset of buf[0]. */
  private buf: Buffer = Buffer.alloc(0);
  private bufStart = 0;
  /** Anchors in arrival order; the sidecar emits them in increasing offset. */
  private readonly segments: Segment[] = [];
  /** Index into `segments` governing the bytes being windowed now; -1 = none. */
  private cur = -1;
  private chunker: FrameChunker;
  /** Bytes emitted WITHIN the current segment; drives that segment's clock. */
  private segEmitted = 0;
  /** Partial fd-3 text awaiting a newline. */
  private metaBuf = "";
  private stopped = false;

  constructor(private readonly opts: SystemAudioOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 16000;
    const chunkSeconds = opts.chunkSeconds ?? 10;
    this.bytesPerChunk = Math.max(1, Math.round(chunkSeconds * this.bytesPerSecond));
    this.chunker = new FrameChunker(this.bytesPerChunk);
    this.binaryPath =
      opts.binaryPath ?? process.env["ERAG_AUDIO_TAP_BIN"] ?? "audio-tap";
  }

  private get bytesPerSecond(): number {
    return this.sampleRate * this.channels * (BITS_PER_SAMPLE / 8);
  }

  private get onError(): (msg: string) => void {
    return this.opts.onError ?? ((m) => console.error(`[system-audio] ${m}`));
  }

  private args(): string[] {
    const args = ["--sample-rate", String(this.sampleRate)];
    for (const pid of this.opts.excludePids ?? []) {
      args.push("--exclude-pid", String(pid));
    }
    return args;
  }

  /**
   * NEVER THROWS. `CaptureSession.start()` awaits every producer in turn AFTER
   * the session row exists, so a throw here takes down a whole recording —
   * including its screen and its events — over one optional signal. A missing
   * binary, an old macOS or a stale contract are reported and the producer
   * simply does not spawn, the way the screen producer returns without spawning
   * when it finds no display.
   */
  async start(ctx: CaptureContext): Promise<void> {
    this.ctx = ctx;

    // The version handshake BEFORE the capture, not from the first anchor.
    // A tap is silent until something plays, so an anchor may be minutes away —
    // and a mismatch discovered then would have already cost the recording. The
    // cost is one short-lived process at Record. `ax-dump` has no such
    // handshake, and a stale copy silently ignoring its flags cost two days and
    // every recording's typed text.
    let version: number;
    try {
      const { stdout } = await run(this.binaryPath, ["--version"], { timeout: 5000 });
      version = Number(/audio-tap\s+(\d+)/.exec(stdout)?.[1] ?? NaN);
    } catch (err) {
      this.onError(
        `computer audio is unavailable: could not run ${this.binaryPath} ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          "Run `npm run build:ax` to build the sidecar.",
      );
      return;
    }
    if (version !== SUPPORTED_CONTRACT) {
      this.onError(
        `computer audio is unavailable: ${this.binaryPath} speaks contract ` +
          `${Number.isFinite(version) ? version : "?"}, this build needs ` +
          `${SUPPORTED_CONTRACT}. Rebuild the sidecar (\`npm run build:ax\`).`,
      );
      return;
    }

    const proc = spawn(this.binaryPath, this.args(), {
      // fd 3 is the device-time anchor channel; see audio-tap-anchor.ts.
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.drain(false);
    });

    // Buffer until a newline before parsing. The anchor line is short, but the
    // rule is the one `replay/sidecar.ts` pays for: a chunk boundary lands
    // mid-JSON on a large payload and parse-errors only there, so splitting per
    // chunk works against every small fixture and fails on real data.
    const meta = proc.stdio[3] as Readable | undefined;
    meta?.on("data", (d: Buffer) => {
      this.metaBuf += d.toString();
      let nl = this.metaBuf.indexOf("\n");
      while (nl >= 0) {
        const line = this.metaBuf.slice(0, nl);
        this.metaBuf = this.metaBuf.slice(nl + 1);
        if (line.trim().length > 0) this.onAnchor(line);
        nl = this.metaBuf.indexOf("\n");
      }
    });

    proc.stderr?.on("data", (d: Buffer) => this.onError(d.toString().trim()));
    proc.on("error", (err) => this.onError(err.message));
  }

  /** Resolve one anchor onto the session clock and window whatever it unblocks. */
  private onAnchor(line: string): void {
    const ctx = this.ctx;
    if (ctx === undefined) return;
    let anchor;
    try {
      anchor = parseAudioTapAnchor(line);
    } catch (err) {
      this.onError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (anchor.version !== SUPPORTED_CONTRACT) {
      this.onError(`ignoring an anchor from contract ${anchor.version}`);
      return;
    }
    this.segments.push({
      byteOffset: anchor.byteOffset,
      // `deviceClock` is the ONLY conversion from device time to t_mono, and
      // the session clock is never read here — arrival time carries the whole
      // capture latency.
      tMono: ctx.deviceClock.toTMono(anchor.anchorMs),
    });
    this.drain(false);
  }

  /**
   * Window whatever bytes are now covered by an anchor.
   *
   * A chunk may never span a discontinuity, so each segment gets its own
   * chunker and is flushed when the next segment's offset is reached. That is
   * the one structural difference from `FfmpegAudioProducer`, which can assume
   * one anchor for the whole stream because ffmpeg keeps reading a device that
   * is always running. A tap stops delivering entirely when the output device
   * goes idle.
   */
  private drain(final: boolean): void {
    for (;;) {
      if (this.cur < 0) {
        // Find the last anchor at or before the next unprocessed byte. Until
        // one exists the bytes are HELD, never stamped with arrival time.
        let idx = -1;
        for (let i = 0; i < this.segments.length; i += 1) {
          const seg = this.segments[i];
          if (seg !== undefined && seg.byteOffset <= this.bufStart) idx = i;
        }
        if (idx < 0) return;
        this.cur = idx;
        this.segEmitted = this.bufStart - (this.segments[idx]?.byteOffset ?? 0);
        this.chunker = new FrameChunker(this.bytesPerChunk);
      }

      const next = this.segments[this.cur + 1];
      const boundary = next?.byteOffset ?? Number.POSITIVE_INFINITY;
      const available = this.bufStart + this.buf.length;
      const limit = Math.min(available, boundary);
      const take = limit - this.bufStart;
      if (take > 0) {
        const slice = this.buf.subarray(0, take);
        for (const pcm of this.chunker.push(slice)) this.emit(pcm);
        this.buf = this.buf.subarray(take);
        this.bufStart += take;
      }

      if (this.bufStart >= boundary && next !== undefined) {
        // A hole. Close this segment with a short chunk rather than letting a
        // window straddle it, then continue in the next segment.
        const rest = this.chunker.flush();
        if (rest !== undefined && rest.length > 0) this.emit(rest);
        this.cur += 1;
        this.segEmitted = 0;
        this.chunker = new FrameChunker(this.bytesPerChunk);
        continue;
      }

      if (final) {
        const rest = this.chunker.flush();
        if (rest !== undefined && rest.length > 0) this.emit(rest);
      }
      return;
    }
  }

  /** WAV-wrap one PCM window and ingest it with audio-derived timestamps. */
  private emit(pcm: Uint8Array): void {
    const ctx = this.ctx;
    const seg = this.segments[this.cur];
    if (ctx === undefined || seg === undefined) {
      // Unreachable: drain() only emits with a segment selected. No fallback to
      // arrival time — that would put this recording's audio on a different
      // clock from its frames and events, silently and for the whole session.
      throw new Error("system-audio: emitted a window with no device-time anchor");
    }
    const tMonoStart = seg.tMono + (this.segEmitted / this.bytesPerSecond) * 1000;
    this.segEmitted += pcm.length;
    const tMonoEnd = seg.tMono + (this.segEmitted / this.bytesPerSecond) * 1000;
    const chunk: AudioChunk = {
      bytes: encodeWav(pcm, {
        sampleRate: this.sampleRate,
        channels: this.channels,
        bitsPerSample: BITS_PER_SAMPLE,
      }),
      tMonoStart,
      tMonoEnd,
      media: "desktop_audio",
      codec: "wav",
    };
    this.ingestChain = this.ingestChain.then(() => ctx.ingestAudio(chunk));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const proc = this.proc;
    if (proc !== undefined) {
      this.proc = undefined;
      // SIGINT then AWAIT, for the reason the microphone path measured: bytes
      // sitting in the stdout pipe are only delivered while the stream drains,
      // and returning early dropped 16000 of 32000 bytes. The already-exited
      // check is not redundant — 'close' has then already fired, so `once` would
      // never resolve and every such stop would burn the full timeout.
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

    // Window whatever is left, including a trailing partial chunk.
    this.drain(true);

    if (this.buf.length > 0) {
      // Bytes arrived that no anchor ever covered, so there is no honest time to
      // store them at. Say so and drop them: mistimed audio would sit silently
      // on a different clock from every other signal in the recording, which is
      // the failure this whole design removes.
      this.onError(
        `captured ${this.buf.length} byte(s) of computer audio that no anchor ` +
          "covers, so they are dropped. The sidecar should emit an anchor on fd 3 " +
          "before its first PCM.",
      );
      this.buf = Buffer.alloc(0);
    }
    await this.ingestChain; // drain chunks already read
  }
}
