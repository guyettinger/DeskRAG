/**
 * FfmpegScreenProducer — samples the screen by spawning ffmpeg. It emits TWO
 * aligned outputs from one process, split by `-filter_complex ... split=2`:
 *   - stdout (pipe:1): downscaled grayscale rawvideo → FrameChunker → pHash,
 *   - fd 3   (pipe:3): MJPEG full frames        → JpegStreamSplitter → the
 *                       stored keyframe image (frame_image view + region crops).
 * Both are filtered from the same input at the same fps, so frame N of each
 * corresponds; they're paired by index and pushed through ctx.ingestFrame.
 * ffmpeg does the JPEG encoding, so no in-Node image codec is needed.
 *
 * Set `storeImages: false` to fall back to grayscale-only (pHash/Tier-0 only).
 * Device/input is platform-specific (macOS avfoundation defaults); everything is
 * overridable via `ffmpegArgs`. Not exercised by the unit suite — the testable
 * parts are FrameChunker and JpegStreamSplitter.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { FrameChunker } from "../frame-chunker.js";
import { JpegStreamSplitter } from "../jpeg-splitter.js";
import type { CaptureContext, Producer } from "../types.js";

export interface FfmpegScreenOptions {
  /** avfoundation input (macOS screen device index or name), e.g. "1". */
  input?: string;
  /** Frames sampled per second (keep low; the gate drops dupes). */
  fps?: number;
  /** Grayscale hash-frame size fed to dHash. */
  grayW?: number;
  grayH?: number;
  /** Full-resolution dims recorded on the frame row (informational). */
  width?: number;
  height?: number;
  /** Persist a full JPEG keyframe image per frame (frame_image + region crops). */
  storeImages?: boolean;
  /** Max width of the stored JPEG (aspect preserved); height auto (even). */
  imageMaxWidth?: number;
  /** MJPEG quality (ffmpeg -q:v, 2=best..31=worst). */
  imageQuality?: number;
  ffmpegPath?: string;
  /** Fully override the ffmpeg args (bypasses the defaults below). */
  ffmpegArgs?: string[];
  onError?: (msg: string) => void;
}

export class FfmpegScreenProducer implements Producer {
  readonly id = "screen";
  private proc: ChildProcess | undefined;
  private ctx: CaptureContext | undefined;
  private ingestChain: Promise<void> = Promise.resolve();
  private readonly chunker: FrameChunker;
  private readonly jpeg = new JpegStreamSplitter();
  private readonly grayQueue: Uint8Array[] = [];
  private readonly jpegQueue: Uint8Array[] = [];
  private readonly grayW: number;
  private readonly grayH: number;
  private readonly width: number;
  private readonly height: number;
  private readonly storeImages: boolean;

  constructor(private readonly opts: FfmpegScreenOptions = {}) {
    this.grayW = opts.grayW ?? 32;
    this.grayH = opts.grayH ?? 32;
    this.width = opts.width ?? 0;
    this.height = opts.height ?? 0;
    this.storeImages = opts.storeImages ?? true;
    this.chunker = new FrameChunker(this.grayW * this.grayH);
  }

  private args(): string[] {
    if (this.opts.ffmpegArgs) return this.opts.ffmpegArgs;
    const fps = this.opts.fps ?? 1;
    const input = this.opts.input ?? "1";
    const head = [
      "-hide_banner", "-loglevel", "error",
      "-f", "avfoundation", "-framerate", String(fps), "-i", input,
    ];
    if (!this.storeImages) {
      return [
        ...head,
        "-vf", `fps=${fps},scale=${this.grayW}:${this.grayH},format=gray`,
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
      ];
    }
    const maxW = this.opts.imageMaxWidth ?? 1280;
    const q = this.opts.imageQuality ?? 5;
    return [
      ...head,
      "-filter_complex",
      `[0:v]fps=${fps},split=2[g][c];` +
        `[g]scale=${this.grayW}:${this.grayH},format=gray[gg];` +
        `[c]scale=${maxW}:-2[cc]`,
      "-map", "[gg]", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
      "-map", "[cc]", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", String(q), "pipe:3",
    ];
  }

  start(ctx: CaptureContext): void {
    this.ctx = ctx;
    const onError = this.opts.onError ?? ((m) => console.error(`[ffmpeg-screen] ${m}`));
    // stdio: [stdin ignore, stdout gray, stderr, fd3 mjpeg (when storing images)].
    const stdio = this.storeImages
      ? (["ignore", "pipe", "pipe", "pipe"] as const)
      : (["ignore", "pipe", "pipe"] as const);
    const proc = spawn(this.opts.ffmpegPath ?? "ffmpeg", this.args(), { stdio: [...stdio] });
    this.proc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => {
      for (const gray of this.chunker.push(chunk)) {
        this.grayQueue.push(gray);
        this.pair();
      }
    });
    if (this.storeImages) {
      const mjpeg = proc.stdio[3] as Readable | undefined;
      mjpeg?.on("data", (chunk: Buffer) => {
        for (const img of this.jpeg.push(chunk)) {
          this.jpegQueue.push(img);
          this.pair();
        }
      });
    }
    proc.stderr?.on("data", (d: Buffer) => onError(d.toString().trim()));
    proc.on("error", (err) => onError(err.message));
  }

  /** Emit frames once both streams have the next index (or gray-only mode). */
  private pair(): void {
    if (!this.storeImages) {
      while (this.grayQueue.length > 0) this.enqueue(this.grayQueue.shift()!);
      return;
    }
    while (this.grayQueue.length > 0 && this.jpegQueue.length > 0) {
      this.enqueue(this.grayQueue.shift()!, this.jpegQueue.shift()!);
    }
  }

  private enqueue(gray: Uint8Array, jpeg?: Uint8Array): void {
    const ctx = this.ctx!;
    this.ingestChain = this.ingestChain.then(async () => {
      await ctx.ingestFrame({
        tMono: ctx.clock.now(),
        width: this.width,
        height: this.height,
        gray,
        grayW: this.grayW,
        grayH: this.grayH,
        ...(jpeg ? { image: { bytes: jpeg, codec: "jpeg" } } : {}),
      });
    });
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill("SIGINT");
      this.proc = undefined;
    }
    await this.ingestChain; // drain frames already read
  }
}
