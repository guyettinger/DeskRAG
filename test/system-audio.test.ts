import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceClock } from "../src/timeline/device-clock.js";
import { MonotonicClock } from "../src/timeline/clock.js";
import { SystemAudioProducer } from "../src/capture/producers/system-audio.js";
import type { AudioChunk, CaptureContext } from "../src/capture/types.js";

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // mono, s16le
const WAV_HEADER = 44;

/**
 * A STAND-IN SIDECAR, not the real one. The real `audio-tap` only produces
 * bytes when the Mac is actually playing something — measured: five seconds of
 * silence yields zero callbacks and a zero-byte file — so it cannot drive a
 * deterministic test at all. What matters here is the half that owns the
 * TIMING: which anchor governs which byte, what is held, and what is dropped.
 *
 * `test/audio-tap.swift.test.ts` covers the other half, compiling the real
 * Swift and checking it still emits this contract. The two are deliberately
 * split: they are two readers of one protocol, which is the drift hazard that
 * already cost this repo a replay path.
 */
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("audio-tap 1"); process.exit(0); }
const anchor = (ms, off) => fs.writeSync(3, JSON.stringify(
  { v: 1, anchorMs: ms, byteOffset: off, sampleRate: 16000, channels: 1, format: "s16le" }) + "\\n");
const pcm = (bytes) => fs.writeSync(1, Buffer.alloc(bytes, 7));
switch (process.env.FAKE_TAP) {
  case "simple":   anchor(1000, 0); pcm(64000); break;
  // PCM BEFORE the anchor: the sidecar flushes bytes then writes fd 3, and two
  // pipes give no ordering guarantee, so this is the ordinary case, not an edge.
  case "held":     pcm(64000); setTimeout(() => anchor(1000, 0), 40); break;
  // A hole: the output device idled and restarted 6s later.
  case "gap":      anchor(1000, 0); pcm(32000); anchor(39000, 32000); pcm(32000); break;
  // A short tail that never fills a whole window.
  case "tail":     anchor(1000, 0); pcm(48000); break;
  case "noanchor": pcm(64000); break;
}
process.on("SIGINT", () => process.exit(0));
setTimeout(() => {}, 60000);
`;

describe("SystemAudioProducer", () => {
  let dir: string;
  let bin: string;
  let chunks: AudioChunk[];
  let errors: string[];
  let ctx: CaptureContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "erag-tap-"));
    bin = join(dir, "fake-audio-tap");
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    chunks = [];
    errors = [];
    ctx = {
      sessionId: "s1",
      clock: MonotonicClock.start(),
      // calibrate(0, 0) makes toTMono the identity, so every expectation below
      // is the arithmetic itself rather than a number plus an offset.
      deviceClock: DeviceClock.calibrate(0, 0),
      emitEvent: () => {},
      ingestFrame: async () => ({ kept: false }) as never,
      ingestAudio: async (c: AudioChunk) => {
        chunks.push(c);
      },
      reserveBlob: async () => null,
      commitBlob: async () => {},
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const record = async (scenario: string, chunkSeconds = 1): Promise<void> => {
    process.env["FAKE_TAP"] = scenario;
    const p = new SystemAudioProducer({
      binaryPath: bin,
      chunkSeconds,
      sampleRate: SAMPLE_RATE,
      onError: (m) => errors.push(m),
    });
    await p.start(ctx);
    await new Promise((r) => setTimeout(r, 250));
    await p.stop();
    delete process.env["FAKE_TAP"];
  };

  it("times each window from the anchor plus the byte count", async () => {
    await record("simple");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.tMonoStart).toBe(1000);
    expect(chunks[0]?.tMonoEnd).toBe(2000);
    expect(chunks[1]?.tMonoStart).toBe(2000);
    expect(chunks[1]?.tMonoEnd).toBe(3000);
    expect(chunks[0]?.media).toBe("desktop_audio");
    expect(chunks[0]?.codec).toBe("wav");
    expect(chunks[0]?.bytes.length).toBe(BYTES_PER_SECOND + WAV_HEADER);
    expect(errors).toEqual([]);
  });

  it("HOLDS pcm that arrives before the anchor and times it correctly", async () => {
    await record("held");
    // Identical to "simple": holding is lossless. Stamping arrival time instead
    // would put this audio on a different clock from the recording's frames.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.tMonoStart).toBe(1000);
    expect(chunks[1]?.tMonoEnd).toBe(3000);
    expect(errors).toEqual([]);
  });

  it("re-anchors at a discontinuity instead of sliding the rest earlier", async () => {
    await record("gap");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.tMonoStart).toBe(1000);
    expect(chunks[0]?.tMonoEnd).toBe(2000);
    // The second anchor says 39000, so the hole is REPORTED as a hole. Naive
    // byte arithmetic would have said 2000 and moved 37 seconds of audio.
    expect(chunks[1]?.tMonoStart).toBe(39000);
    expect(chunks[1]?.tMonoEnd).toBe(40000);
  });

  it("never lets one window straddle a hole", async () => {
    await record("gap", 4);
    // 4s windows, but only 1s of audio sits either side of the gap, so both
    // come out short rather than one 4s window spanning two clocks.
    expect(chunks).toHaveLength(2);
    for (const c of chunks) {
      expect(c.bytes.length).toBe(BYTES_PER_SECOND + WAV_HEADER);
    }
    expect(chunks[1]!.tMonoStart - chunks[0]!.tMonoEnd).toBe(37000);
  });

  it("emits the trailing partial window so short captures are not lost", async () => {
    await record("tail");
    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.bytes.length).toBe(BYTES_PER_SECOND / 2 + WAV_HEADER);
    expect(chunks[1]?.tMonoEnd).toBe(2500);
  });

  it("DROPS audio no anchor covers, and says so", async () => {
    await record("noanchor");
    expect(chunks).toEqual([]);
    expect(errors.join(" ")).toMatch(/no anchor covers/);
  });

  it("does not spawn, and does not throw, when the sidecar is missing", async () => {
    const p = new SystemAudioProducer({
      binaryPath: join(dir, "nope"),
      onError: (m) => errors.push(m),
    });
    // start() must never throw: CaptureSession awaits every producer AFTER the
    // session row exists, so a throw here costs the screen and the events too.
    await expect(p.start(ctx)).resolves.toBeUndefined();
    await expect(p.stop()).resolves.toBeUndefined();
    expect(errors.join(" ")).toMatch(/computer audio is unavailable/);
    expect(chunks).toEqual([]);
  });

  it("refuses a sidecar speaking a different contract", async () => {
    const stale = join(dir, "stale");
    writeFileSync(stale, '#!/usr/bin/env node\nconsole.log("audio-tap 99");\n');
    chmodSync(stale, 0o755);
    const p = new SystemAudioProducer({
      binaryPath: stale,
      onError: (m) => errors.push(m),
    });
    await p.start(ctx);
    await p.stop();
    expect(errors.join(" ")).toMatch(/contract 99/);
    expect(errors.join(" ")).toMatch(/npm run build:ax/);
  });
});
