import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { MonotonicClock } from "../src/timeline/clock.js";
import { CaptureSession } from "../src/capture/session.js";
import { KeyframeBudget } from "../src/capture/keyframe-budget.js";
import {
  FfmpegScreenProducer,
  screenInputFor,
} from "../src/capture/producers/ffmpeg-screen.js";

const hasFfmpeg = (() => {
  try {
    return spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;
  } catch {
    return false;
  }
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Real ffmpeg end-to-end (skipped when ffmpeg is absent). Uses a synthetic
 * lavfi `testsrc` input — no screen, no permissions — but drives the exact same
 * two-output pipeline (grayscale pipe:1 + MJPEG pipe:3) the screen capture uses,
 * proving the frames land as real JPEG keyframe blobs.
 */
describe.skipIf(!hasFfmpeg)("FfmpegScreenProducer (real ffmpeg, lavfi testsrc)", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-ff-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures real frames with grayscale pHash and a JPEG keyframe blob", async () => {
    const errors: string[] = [];
    const session = new CaptureSession(store, {
      clock: MonotonicClock.start(),
      keyframeBudget: new KeyframeBudget({ minIntervalMs: 0 }),
      blobStore: blobs,
    });
    // Same two-output shape as the real screen args, but from a moving test
    // pattern for ~1s at 5fps (grayW/grayH default to 9x8 to match the chunker).
    session.addProducer(
      new FfmpegScreenProducer({
        grayW: 9,
        grayH: 8,
        storeImages: true,
        onError: (m) => errors.push(m),
        ffmpegArgs: [
          "-hide_banner", "-loglevel", "error",
          "-f", "lavfi", "-i", "testsrc=size=64x48:rate=5:duration=1",
          "-filter_complex",
          "[0:v]fps=5,split=2[g][c];[g]scale=9:8,format=gray[gg];[c]scale=64:-2[cc]",
          "-map", "[gg]", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
          "-map", "[cc]", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "5", "pipe:3",
        ],
      }),
    );

    const sessionId = await session.start();
    // Wait for ffmpeg (duration=1s) to produce + ingest frames.
    const deadline = Date.now() + 10_000;
    while (store.getFramesBySession(sessionId).length === 0 && Date.now() < deadline) {
      await sleep(100);
    }
    await session.stop();

    const frames = store.getFramesBySession(sessionId);
    expect(frames.length, `ffmpeg errors: ${errors.join(" | ")}`).toBeGreaterThan(0);

    // A kept frame carries a JPEG image blob (valid SOI marker).
    const withImage = frames.find((f) => f.blobId);
    expect(withImage).toBeDefined();
    const blob = store.getBlob(withImage!.blobId!);
    expect(blob!.media).toBe("keyframe");
    expect(blob!.codec).toBe("jpeg");
    const bytes = await blobs.read(blob!);
    expect(bytes[0]).toBe(0xff); // JPEG SOI
    expect(bytes[1]).toBe(0xd8);

    // pHash is present (Tier-0 works on these frames).
    expect(store.phashPrefilter(withImage!.phash, 0)).toContain(withImage!.id);
  }, 20_000);

  it("records a continuous MP4 alongside the sampled keyframes", async () => {
    const errors: string[] = [];
    const session = new CaptureSession(store, {
      clock: MonotonicClock.start(),
      keyframeBudget: new KeyframeBudget({ minIntervalMs: 0 }),
      blobStore: blobs,
    });
    // Drives the REAL args() graph (all three outputs) off a synthetic lavfi
    // source — no screen, no permissions. The video path is chosen by
    // reserveBlob inside start(), so this must not use `ffmpegArgs`.
    session.addProducer(
      new FfmpegScreenProducer({
        grayW: 9,
        grayH: 8,
        fps: 5,
        videoFps: 10,
        storeImages: true,
        inputFormat: "lavfi",
        omitInputFramerate: true,
        input: "testsrc=size=64x48:rate=10:duration=2",
        imageMaxWidth: 64,
        videoMaxWidth: 64,
        onError: (m) => errors.push(m),
      }),
    );

    const sessionId = await session.start();
    const deadline = Date.now() + 15_000;
    while (store.getFramesBySession(sessionId).length === 0 && Date.now() < deadline) {
      await sleep(100);
    }
    await session.stop();

    const video = store.getBlobsBySession(sessionId).find((b) => b.media === "screen");
    expect(video, `ffmpeg errors: ${errors.join(" | ")}`).toBeDefined();
    expect(video!.codec).toBe("mp4");
    expect(video!.byteLength).toBeGreaterThan(0);
    expect(video!.tMonoEnd).toBeGreaterThanOrEqual(video!.tMonoStart);

    // A real MP4: bytes 4..8 are the 'ftyp' box type.
    const bytes = await blobs.read(video!);
    expect(Buffer.from(bytes.subarray(4, 8)).toString("ascii")).toBe("ftyp");

    // The keyframe pipeline is untouched by the new branch.
    const frames = store.getFramesBySession(sessionId);
    expect(frames.some((f) => f.blobId)).toBe(true);
  }, 30_000);
});

/** args() is pure — assert the filter graph without spawning anything. */
describe("FfmpegScreenProducer.args", () => {
  it("emits three mapped outputs and decimates only the sampling branches", () => {
    const p = new FfmpegScreenProducer({ fps: 1, videoFps: 10, grayW: 32, grayH: 32 });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args("/tmp/out.mp4");
    const joined = a.join(" ");

    expect(joined).toContain("split=3[v][g][c]");
    expect(joined).toContain("[g]fps=1,"); // sampling branch decimated
    expect(joined).toContain("[c]fps=1,");
    expect(joined).not.toContain("[v]fps="); // video branch keeps full rate
    expect(joined).toContain("-framerate 10"); // input runs at videoFps
    expect(joined).toContain("+frag_keyframe+empty_moov+default_base_moof");
    expect(joined).toContain("-pix_fmt yuv420p");
    expect(a[a.length - 1]).toBe("pipe:3");
    expect(joined).toContain("/tmp/out.mp4");
  });

  it("logs at warning level so avfoundation's recovery line is visible", () => {
    // At `error`, macOS shows "Selected pixel format (yuv420p) is not supported"
    // but hides "Overriding selected pixel format to use uyvy422 instead" — half
    // a warning pair that reads as a failed capture when capture actually works.
    const p = new FfmpegScreenProducer({ fps: 1, storeImages: true });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args("/tmp/out.mp4");
    expect(a[a.indexOf("-loglevel") + 1]).toBe("warning");
  });

  it("omits the video branch when recordVideo is false", () => {
    const p = new FfmpegScreenProducer({ recordVideo: false });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args(null);

    expect(a.join(" ")).toContain("split=2[g][c]");
    expect(a.join(" ")).not.toContain("libx264");
  });

  it("drops to a gray-only single output when storeImages is false", () => {
    const p = new FfmpegScreenProducer({ storeImages: false, recordVideo: false });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args(null);

    expect(a.join(" ")).not.toContain("split");
    expect(a[a.length - 1]).toBe("pipe:1");
  });
});

describe("screenInputFor", () => {
  const never = (): string | undefined => {
    throw new Error("probe must not run");
  };

  it("discovers the display index instead of assuming one", () => {
    expect(screenInputFor({}, () => "2")).toEqual({ kind: "discovered", input: "2" });
  });

  /**
   * The whole point. `"1"` was the default, and on a machine with a camera — or
   * a paired iPhone — that index IS the camera. Falling back to it after the
   * probe came up empty records the wrong device silently, which is strictly
   * worse than recording nothing loudly.
   */
  it("refuses to fall back to an index when the probe found no display", () => {
    const r = screenInputFor({}, () => undefined);
    expect(r.kind).toBe("unavailable");
    expect(JSON.stringify(r)).not.toContain('"1"');
    if (r.kind === "unavailable") expect(r.reason).toContain("Screen Recording");
  });

  it("does not probe when the caller already named an input", () => {
    expect(screenInputFor({ input: "testsrc=size=64x48" }, never)).toEqual({
      kind: "explicit",
      input: "testsrc=size=64x48",
    });
  });

  it("does not probe for an overridden arg list or a foreign input format", () => {
    expect(screenInputFor({ ffmpegArgs: ["-f", "lavfi"] }, never).kind).toBe("explicit");
    expect(screenInputFor({ inputFormat: "lavfi" }, never).kind).toBe("explicit");
  });
});
