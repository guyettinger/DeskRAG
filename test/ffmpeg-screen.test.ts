import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { MonotonicClock } from "../src/timeline/clock.js";
import { CaptureSession } from "../src/capture/session.js";
import { KeyframeGate } from "../src/capture/keyframe.js";
import { FfmpegScreenProducer } from "../src/capture/producers/ffmpeg-screen.js";

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
      keyframeGate: new KeyframeGate({ hammingThreshold: 1 }),
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
});
