import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { MonotonicClock } from "../src/timeline/clock.js";
import { CaptureSession } from "../src/capture/session.js";
import { FfmpegAudioProducer } from "../src/capture/producers/ffmpeg-audio.js";

const hasFfmpeg = (() => {
  try {
    return spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;
  } catch {
    return false;
  }
})();

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // mono, s16le
/** 44-byte RIFF header written by encodeWav around each PCM window. */
const WAV_HEADER = 44;

/**
 * Real ffmpeg end to end (skipped when ffmpeg is absent). A synthetic lavfi
 * `sine` source stands in for the microphone — no device, no permissions — but
 * drives the exact PCM → FrameChunker → WAV → ingestAudio path the mic uses.
 *
 * What this is really here for is `stop()`. ffmpeg's stdout bytes are only
 * delivered while the stream drains, so a stop that killed the process without
 * awaiting its exit dropped the tail of every recording — up to a whole chunk.
 * A finite source makes that loss exact and countable: 1s of 16kHz mono s16le is
 * 32000 bytes, and anything less than that is the bug.
 */
describe.skipIf(!hasFfmpeg)("FfmpegAudioProducer (real ffmpeg, lavfi sine)", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-ffa-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const record = async (
    seconds: number,
    chunkSeconds: number,
    /**
     * Wait for the first chunk to land before stopping. FALSE is the case that
     * matters: stop() then runs while ffmpeg is still mid-flight, which is
     * exactly what a user pressing Stop does to a live microphone, and it is the
     * only shape in which the tail can be lost.
     */
    settle = true,
  ): Promise<string> => {
    const errors: string[] = [];
    const session = new CaptureSession(store, {
      clock: MonotonicClock.start(),
      blobStore: blobs,
    });
    session.addProducer(
      new FfmpegAudioProducer({
        chunkSeconds,
        sampleRate: SAMPLE_RATE,
        channels: 1,
        onError: (m) => errors.push(m),
        // Bypasses args(), which also skips the avfoundation device probe —
        // there is no device here to look up.
        ffmpegArgs: [
          "-hide_banner", "-loglevel", "error",
          "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
          "-ac", "1", "-ar", String(SAMPLE_RATE),
          "-f", "s16le", "pipe:1",
        ],
      }),
    );
    const sessionId = await session.start();
    if (settle) {
      // Let ffmpeg generate the audio first. lavfi runs far faster than real
      // time, so this is a deadline on the process finishing, not on `seconds`.
      const deadline = Date.now() + 10_000;
      while (micBlobs(sessionId).length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await session.stop();
    expect(errors, `ffmpeg errors: ${errors.join(" | ")}`).toEqual([]);
    return sessionId;
  };

  const micBlobs = (sessionId: string): ReturnType<DualStore["getBlobsBySession"]> =>
    store.getBlobsBySession(sessionId).filter((b) => b.media === "mic");

  const pcmBytes = (sessionId: string): number =>
    micBlobs(sessionId).reduce((n, b) => n + b.byteLength - WAV_HEADER, 0);

  it("loses nothing off the end when chunks divide the input exactly", async () => {
    // 1s at 0.5s chunks = exactly two full windows and no remainder, so every
    // byte has to arrive through the stdout drain rather than the flush.
    const sessionId = await record(1, 0.5);
    const mic = micBlobs(sessionId);
    expect(mic.length).toBe(2);
    expect(pcmBytes(sessionId)).toBe(BYTES_PER_SECOND);
    expect(mic.every((b) => b.codec === "wav")).toBe(true);
  }, 20_000);

  it("keeps the trailing partial window too", async () => {
    // 1s at 0.75s chunks = one full window plus a 0.25s remainder, which only
    // the flush can emit. Both halves of stop() are needed for the total.
    const sessionId = await record(1, 0.75);
    expect(pcmBytes(sessionId)).toBe(BYTES_PER_SECOND);
  }, 20_000);

  it("stamps chunks on audio time, contiguously", async () => {
    const sessionId = await record(1, 0.5);
    const mic = micBlobs(sessionId).sort((a, b) => a.tMonoStart - b.tMonoStart);

    // Derived from the byte position, so the windows abut exactly and each
    // spans its configured duration — no wall-clock jitter in either.
    expect(mic[1]!.tMonoStart).toBeCloseTo(mic[0]!.tMonoEnd, 6);
    for (const b of mic) expect(b.tMonoEnd - b.tMonoStart).toBeCloseTo(500, 6);
  }, 20_000);
});

/**
 * The reason `stop()` awaits the child's exit, tested against a stand-in child
 * rather than ffmpeg — because the thing under test is a RACE, and a real ffmpeg
 * outruns it. lavfi generates a finite clip faster than the test can stop it, so
 * the bytes are always already read and both implementations look identical.
 *
 * The stand-in writes half its PCM immediately and the rest only after a delay,
 * which is the shape a live microphone always has at stop: audio the process has
 * yet to hand over. Stopping after the first half lands leaves the second in
 * flight, and that is what a stop which signals and returns drops. Measured
 * against the raw child: 32000 bytes awaited, 16000 not. Needs no ffmpeg, so it
 * never skips.
 */
describe("FfmpegAudioProducer.stop", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-ffa-stop-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("waits for bytes the child has not delivered yet", async () => {
    const half = BYTES_PER_SECOND / 2; // 0.5s == exactly one chunk
    const session = new CaptureSession(store, {
      clock: MonotonicClock.start(),
      blobStore: blobs,
    });
    session.addProducer(
      new FfmpegAudioProducer({
        chunkSeconds: 0.5,
        sampleRate: SAMPLE_RATE,
        channels: 1,
        ffmpegPath: process.execPath,
        ffmpegArgs: [
          "-e",
          // Ignoring SIGINT for the delay models ffmpeg finalizing its output
          // instead of dying where it stands.
          `process.on("SIGINT", () => {});
           const buf = Buffer.alloc(${half});
           process.stdout.write(buf);
           setTimeout(() => { process.stdout.write(buf); process.exit(0); }, 200);`,
        ],
      }),
    );

    const sessionId = await session.start();
    // Stop once the FIRST half has landed — the child is then certainly running
    // (a signal delivered during its startup would just kill it) and the second
    // half is certainly still in flight, which is the state under test.
    const deadline = Date.now() + 10_000;
    while (
      store.getBlobsBySession(sessionId).filter((b) => b.media === "mic").length === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await session.stop();

    const mic = store.getBlobsBySession(sessionId).filter((b) => b.media === "mic");
    const bytes = mic.reduce((n, b) => n + b.byteLength - WAV_HEADER, 0);
    expect(bytes).toBe(BYTES_PER_SECOND); // both halves, not just the first
    expect(mic.length).toBe(2);
  }, 20_000);
});
