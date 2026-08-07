/**
 * FfmpegScreenProducer — samples the screen by spawning ffmpeg. It emits TWO
 * aligned outputs from one process:
 *   - stdout (pipe:1): downscaled grayscale rawvideo → FrameChunker → dHash,
 *   - fd 3   (pipe:3): MJPEG full frames        → JpegStreamSplitter → the
 *                       stored keyframe image (frame_image view + region crops).
 * ffmpeg does the JPEG encoding, so no in-Node image codec is needed.
 *
 * WHAT CHANGED ON SCREEN IS DECIDED HERE, by `mpdecimate` on the shared
 * sampling branch BEFORE it splits into those two. mpdecimate compares 8x8
 * blocks against the last kept frame, so it sees a localized change that a
 * whole-frame hash averages away. Decimating before the split is also what
 * keeps the two outputs paired by index: both are downstream of one decimator,
 * so frame N of each still corresponds.
 *
 * Set `storeImages: false` to fall back to grayscale-only (dHash/Tier-0 only).
 * Device/input is platform-specific: on macOS the avfoundation display index is
 * discovered in start() (see `input`), and everything is overridable via
 * `ffmpegArgs`. Not exercised by the unit suite — the testable
 * parts are FrameChunker and JpegStreamSplitter.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { resolveScreenInput } from "./avfoundation-devices.js";
import { FrameChunker } from "../frame-chunker.js";
import { JpegStreamSplitter } from "../jpeg-splitter.js";
import type { CaptureContext, Producer } from "../types.js";

/**
 * What `start()` will record from, decided before anything is spawned.
 *
 * `unavailable` is a real outcome and not an error to paper over: the probe ran,
 * the machine reported its device table, and the table had no display in it.
 */
export type ScreenInput =
  | { kind: "explicit"; input: string }
  | { kind: "discovered"; input: string }
  | { kind: "unavailable"; reason: string };

/**
 * Pure input decision, so the part that matters is testable without a spawn.
 *
 * The probe runs ONLY for a real avfoundation capture. An explicit `input`, an
 * overridden arg list, or a non-avfoundation input format all mean the caller
 * already knows what it is recording — a test's lavfi source most of all.
 *
 * There is deliberately NO numeric fallback. `"1"` used to be the default, and
 * on a machine with a camera (or a paired iPhone) that index IS the camera: the
 * exact thing this discovery exists to prevent. Recording the wrong device
 * silently is worse than recording nothing loudly.
 */
export function screenInputFor(
  opts: Pick<FfmpegScreenOptions, "input" | "ffmpegArgs" | "inputFormat">,
  probe: () => string | undefined,
): ScreenInput {
  if (opts.input) return { kind: "explicit", input: opts.input };
  // `"1"` survives only here, where the probe never ran and the value is unused
  // anyway: `ffmpegArgs` replaces the whole arg list, and a non-avfoundation
  // format has no device table to look anything up in.
  if (opts.ffmpegArgs) return { kind: "explicit", input: "1" };
  if ((opts.inputFormat ?? "avfoundation") !== "avfoundation") {
    return { kind: "explicit", input: "1" };
  }
  const found = probe();
  if (found) return { kind: "discovered", input: found };
  return {
    kind: "unavailable",
    reason:
      "no avfoundation screen device found — grant Screen Recording in " +
      "System Settings > Privacy & Security, then record again",
  };
}

/**
 * `mpdecimate` parameters. It divides each frame into 8x8 blocks, computes SAD
 * per block against the LAST KEPT frame, and keeps the frame when any block
 * exceeds `hi`, or when more than `frac` of blocks exceed `lo`.
 */
export interface DecimateOptions {
  /** Any single 8x8 block above this keeps the frame outright. */
  hi?: number;
  /** Blocks above this are counted toward `frac`. */
  lo?: number;
  /** Fraction of blocks that must exceed `lo` to keep the frame. */
  frac?: number;
  /** Force a keep after this many consecutive drops — the heartbeat. */
  max?: number;
}

/**
 * MEASURED with scripts/decimate-probe.mjs against two real recordings plus
 * three synthetic controls. See the commit that set these.
 *
 * **`lo` is the load-bearing one, and ffmpeg's default of 64*5 = 320 is far too
 * low for screen content.** 320 is 5 per pixel, which H.264 ringing clears
 * across most of the frame, so nearly every block counts toward `frac` and the
 * filter keeps everything. Raising it to 64*20 = 1280 puts the threshold above
 * the compression noise floor while a real UI change still clears it easily.
 * On a real 18-frame Calculator recording this yields 13 keyframes against 13-14
 * distinct states counted by eye — the parameters are checked against what the
 * screen actually did, not against a target count.
 *
 * `frac` is small rather than ffmpeg's 0.33 because a state change is LOCAL: a
 * Calculator digit is roughly 10 of ~3600 blocks, i.e. 0.003. Pushing it to 0.01
 * dropped a real scrolling session from 20 kept frames to 5.
 *
 * `hi` sits above ffmpeg's 768 so the any-ONE-block path cannot fire alone on a
 * cursor or a caret. At these `lo`/`frac` values it measurably makes no
 * difference (4096, 16384 and 999999 all gave 13 and 20), so it is a fast path
 * for a genuinely huge single-block change rather than a tuned threshold.
 *
 * The three synthetic controls at these values: a static screen 20 frames -> 1,
 * a 64x64 patch changing every second -> 19 of 19 kept, an 8x16 caret-sized
 * patch -> 1. Caret rejected, digit kept, which is the whole discrimination.
 */
export const DEFAULT_DECIMATE: Required<DecimateOptions> = {
  hi: 64 * 64,
  lo: 64 * 20,
  frac: 0.003,
  max: 60,
};

export interface FfmpegScreenOptions {
  /**
   * avfoundation input (macOS screen device index or name), e.g. "2".
   *
   * Leave it unset: the index of "Capture screen 0" differs per machine (it sits
   * AFTER every camera, so a paired iPhone shifts it), and start() looks it up
   * with resolveScreenInput(). A hard-coded default used to land on a camera,
   * which rejects the input framerate outright — "Selected framerate (10.000000)
   * is not supported by the device" followed by an Input/output error.
   */
  input?: string;
  /** Frames sampled per second (keep low; the gate drops dupes). */
  fps?: number;
  /** Grayscale hash-frame size fed to dHash. */
  grayW?: number;
  grayH?: number;
  /**
   * The frame's coordinate space, recorded on every frame row. NOT informational
   * and NOT ffmpeg's pixel resolution: this must be the display's size in SCREEN
   * POINTS, because that is the space AX bboxes and mouse hotspots arrive in, and
   * everything downstream maps out of it (SharpRegionCropper scales frame space →
   * the downscaled JPEG). Leaving these at 0 silently disables the whole region
   * pipeline — axFilter cuts every element as a whole-window container, grid
   * tiling produces zero-width boxes, hotspots clamp to nothing, and Tier-2 patch
   * highlights early-return — so no regions and no highlights are ever produced.
   */
  width?: number;
  height?: number;
  /** Persist a full JPEG keyframe image per frame (frame_image + region crops). */
  storeImages?: boolean;
  /** Max width of the stored JPEG (aspect preserved); height auto (even). */
  imageMaxWidth?: number;
  /** MJPEG quality (ffmpeg -q:v, 2=best..31=worst). */
  imageQuality?: number;
  /**
   * Visual-state-change detection. `false` disables decimation entirely (every
   * sampled frame is offered to the KeyframeBudget) — for tests and for
   * diagnosing whether the filter is the reason a frame is missing.
   */
  decimate?: DecimateOptions | false;
  /** Record the full-rate session video to a file (third output branch). */
  recordVideo?: boolean;
  /** Input framerate; also the recorded video's framerate. */
  videoFps?: number;
  /** x264 constant rate factor (higher = smaller + worse). */
  videoCrf?: number;
  /** x264 speed/size preset. */
  videoPreset?: string;
  /** Max width of the recorded video (aspect preserved). */
  videoMaxWidth?: number;
  /** ffmpeg input format (default "avfoundation"; tests pass "lavfi"). */
  inputFormat?: string;
  /** Omit the -framerate flag (lavfi sources carry their own rate). */
  omitInputFramerate?: boolean;
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
  private readonly recordVideo: boolean;
  private readonly videoFps: number;
  /** avfoundation input discovered in start(); see FfmpegScreenOptions.input. */
  private resolvedInput: string | undefined;
  /** Blob id + monotonic start for the video file, set on start(). */
  private video: { blobId: string; path: string; tMonoStart: number } | undefined;

  constructor(private readonly opts: FfmpegScreenOptions = {}) {
    this.grayW = opts.grayW ?? 32;
    this.grayH = opts.grayH ?? 32;
    this.width = opts.width ?? 0;
    this.height = opts.height ?? 0;
    this.storeImages = opts.storeImages ?? true;
    this.recordVideo = opts.recordVideo ?? true;
    this.videoFps = opts.videoFps ?? 10;
    this.chunker = new FrameChunker(this.grayW * this.grayH);
  }

  private args(videoPath: string | null): string[] {
    if (this.opts.ffmpegArgs) return this.opts.ffmpegArgs;
    const fps = this.opts.fps ?? 1;
    // start() refuses to spawn without one, so this is always set by here.
    const input = this.resolvedInput ?? this.opts.input ?? "1";
    // With video recording the input must run at the video's framerate; the two
    // sampling branches then decimate back to `fps` with their own filter, so
    // the pHash/keyframe pipeline sees exactly the stream it always did.
    const inputRate = videoPath ? this.videoFps : fps;
    const maxW = this.opts.imageMaxWidth ?? 1280;
    const q = this.opts.imageQuality ?? 5;
    const crf = this.opts.videoCrf ?? 28;
    const preset = this.opts.videoPreset ?? "veryfast";
    const videoMaxW = this.opts.videoMaxWidth ?? 1920;
    // ONE scale, at the stored JPEG's own width, feeding the decimator AND both
    // sampling branches. Decimating at native resolution and re-scaling for the
    // JPEG would be two scale passes and maximally sensitive to a caret.
    const sample = `fps=${fps},scale=${maxW}:-2,${this.decimateFilter()}`;
    const gray = `scale=${this.grayW}:${this.grayH},format=gray`;
    const head = [
      // `warning`, not `error`, on purpose. macOS avfoundation logs
      //   "Selected pixel format (yuv420p) is not supported by the input device"
      // at ERROR level and its recovery
      //   "Overriding selected pixel format to use uyvy422 instead"
      // at WARNING. At `error` the user sees only the alarming half of a pair
      // that ffmpeg then handles itself, which reads as a failed capture when
      // capture is in fact fine. These are one-time startup lines, not per-frame.
      "-hide_banner", "-loglevel", "warning",
      "-f", this.opts.inputFormat ?? "avfoundation",
      ...(this.opts.omitInputFramerate ? [] : ["-framerate", String(inputRate)]),
      "-i", input,
    ];
    if (!this.storeImages && !videoPath) {
      return [
        ...head,
        "-vf", `${sample},${gray}`,
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
      ];
    }

    // Top split: the video branch keeps the full input rate, and ONE sampling
    // branch carries everything the keyframe pipeline sees. Decimating BEFORE
    // the gray/JPEG split is what keeps pair() aligned by construction — both
    // branches are downstream of the same decimator.
    const topLabels = [...(videoPath ? ["[v]"] : []), "[s]"];
    const chains: string[] = [`[0:v]split=${topLabels.length}${topLabels.join("")}`];
    // The video scale lives INSIDE the graph: -vf cannot be combined with
    // -filter_complex on the same output stream.
    if (videoPath) chains.push(`[v]scale='min(${videoMaxW},iw)':-2[vv]`);
    chains.push(`[s]${sample}[d]`);
    if (this.storeImages) {
      chains.push(`[d]split=2[g][c]`, `[g]${gray}[gg]`, `[c]null[cc]`);
    } else {
      chains.push(`[d]${gray}[gg]`);
    }

    const out: string[] = [...head, "-filter_complex", chains.join(";")];
    // Fragmented MP4: playable even if ffmpeg is killed mid-recording, at the
    // cost of fragment-granular (rather than indexed) seeking.
    if (videoPath) {
      out.push(
        "-map", "[vv]",
        "-c:v", "libx264", "-preset", preset, "-crf", String(crf),
        "-pix_fmt", "yuv420p", "-g", String(this.videoFps * 2),
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "-y", videoPath,
      );
    }
    out.push("-map", "[gg]", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1");
    if (this.storeImages) {
      out.push("-map", "[cc]", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", String(q), "pipe:3");
    }
    return out;
  }

  /**
   * The mpdecimate expression, or an inert `null` filter when decimation is
   * disabled — `null` rather than an empty string so the chain still links its
   * labels and the graph stays well formed.
   */
  private decimateFilter(): string {
    const d = this.opts.decimate;
    if (d === false) return "null";
    const o = d ?? {};
    const hi = o.hi ?? DEFAULT_DECIMATE.hi;
    const lo = o.lo ?? DEFAULT_DECIMATE.lo;
    const frac = o.frac ?? DEFAULT_DECIMATE.frac;
    const max = o.max ?? DEFAULT_DECIMATE.max;
    return `mpdecimate=hi=${hi}:lo=${lo}:frac=${frac}:max=${max}`;
  }

  async start(ctx: CaptureContext): Promise<void> {
    this.ctx = ctx;
    const onError = this.opts.onError ?? ((m) => console.error(`[ffmpeg-screen] ${m}`));

    // Find the display BEFORE spawning, and before reserving a blob: a session
    // that cannot see a display records nothing rather than recording a camera,
    // and a producer that will not spawn must not leave a reserved video path
    // behind either.
    const decided = screenInputFor(this.opts, () =>
      resolveScreenInput(this.opts.ffmpegPath ?? "ffmpeg"),
    );
    if (decided.kind === "unavailable") {
      onError(decided.reason);
      return;
    }
    this.resolvedInput = decided.input;

    // Reserve the path before spawning; without a blob store there is nowhere
    // to keep the file, so the video branch is dropped from the arg graph.
    let videoPath: string | null = null;
    if (this.recordVideo) {
      const reserved = await ctx.reserveBlob("screen", "mp4");
      if (reserved) {
        videoPath = reserved.path;
        this.video = { ...reserved, tMonoStart: ctx.clock.now() };
      }
    }

    // stdio: [stdin ignore, stdout gray, stderr, fd3 mjpeg (when storing images)].
    const stdio = this.storeImages
      ? (["ignore", "pipe", "pipe", "pipe"] as const)
      : (["ignore", "pipe", "pipe"] as const);
    const proc = spawn(this.opts.ffmpegPath ?? "ffmpeg", this.args(videoPath), {
      stdio: [...stdio],
    });
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
    const proc = this.proc;
    if (proc) {
      this.proc = undefined;
      proc.kill("SIGINT");
      // The MP4 is only complete once ffmpeg has exited; wait, but never hang.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 5000);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await this.ingestChain; // drain frames already read
    if (this.video && this.ctx) {
      await this.ctx.commitBlob(this.video.blobId, {
        tMonoStart: this.video.tMonoStart,
        tMonoEnd: this.ctx.clock.now(),
      });
      this.video = undefined;
    }
  }
}
