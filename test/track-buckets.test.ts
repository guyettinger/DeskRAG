import { describe, expect, it } from "vitest";
import {
  bucketCounts,
  bucketHold,
  bucketIndex,
  bucketMax,
  bucketRate,
  mergeAudioPeaks,
  normalize,
  peakCountFor,
} from "../app/src/main/track-buckets.js";

describe("bucketIndex", () => {
  it("clamps at both ends and puts totalSec itself in the LAST bucket", () => {
    expect(bucketIndex(0, 10, 10)).toBe(0);
    expect(bucketIndex(5, 10, 10)).toBe(5);
    expect(bucketIndex(10, 10, 10)).toBe(9); // not 10 — that index does not exist
    expect(bucketIndex(99, 10, 10)).toBe(9);
    expect(bucketIndex(-1, 10, 10)).toBe(0);
  });

  it("does not divide by zero on a session with no span", () => {
    expect(bucketIndex(3, 0, 10)).toBe(0);
  });
});

describe("bucketCounts", () => {
  it("puts an event exactly on a boundary in exactly one bucket", () => {
    const counts = bucketCounts([0, 1, 1, 2.999, 3], 10, 10);
    expect(counts[0]).toBe(1);
    expect(counts[1]).toBe(2);
    expect(counts[2]).toBe(1);
    expect(counts[3]).toBe(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
  });
});

describe("bucketMax", () => {
  it("takes the max, never the mean — a flick must not average away", () => {
    const out = bucketMax(
      [
        { sec: 0.1, value: 10 },
        { sec: 0.2, value: 900 },
        { sec: 0.3, value: 10 },
      ],
      10,
      10,
    );
    expect(out[0]).toBe(900);
  });

  it("leaves untouched buckets at zero", () => {
    expect(bucketMax([{ sec: 5, value: 3 }], 10, 10)[0]).toBe(0);
  });
});

describe("bucketHold", () => {
  it("is null before the first sample and holds the last value after", () => {
    const out = bucketHold([{ sec: 3, value: 42 }], 10, 10);
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out.slice(3)).toEqual([42, 42, 42, 42, 42, 42, 42]);
  });
});

describe("bucketRate", () => {
  // 25 buckets to the second — the shape a 40s recording takes at 1000 buckets,
  // which is where the misleading number was measured.
  const PER_BUCKET = 0.04;

  it("does not turn ONE event into 25 per second", () => {
    const counts = new Array(1000).fill(0);
    counts[500] = 1;
    const rate = bucketRate(counts, PER_BUCKET);
    expect(Math.max(...rate)).toBeCloseTo(1, 5);
  });

  it("reports a real burst at its real rate", () => {
    // Five keystrokes inside one second is five per second.
    const counts = new Array(1000).fill(0);
    for (let i = 500; i < 505; i++) counts[i] = 1;
    expect(Math.max(...bucketRate(counts, PER_BUCKET))).toBeCloseTo(5, 5);
  });

  it("leaves a long session alone, where a bucket already exceeds a second", () => {
    expect(bucketRate([0, 2, 0], 4)).toEqual([0, 0.5, 0]);
  });

  it("does not damp the edges toward zero with a window hanging off the axis", () => {
    const counts = new Array(1000).fill(0);
    counts[0] = 1;
    const rate = bucketRate(counts, PER_BUCKET);
    // The window at index 0 covers 13 buckets, not 25, and divides by 13.
    expect(rate[0]!).toBeGreaterThan(1);
    expect(rate[0]!).toBeLessThan(2.5);
  });
});

describe("normalize", () => {
  it("scales to 0–1, reports the peak in real units, and preserves nulls", () => {
    const { values, peak } = normalize([null, 5, 10, 0]);
    expect(peak).toBe(10);
    expect(values).toEqual([null, 0.5, 1, 0]);
  });

  it("does not produce NaN when everything is zero", () => {
    const { values, peak } = normalize([0, 0]);
    expect(peak).toBe(0);
    expect(values).toEqual([0, 0]);
  });
});

describe("peakCountFor", () => {
  it("oversamples enough that every bucket a blob spans gets a sample", () => {
    // A blob covering a tenth of a 1000-bucket session spans 100 buckets.
    expect(peakCountFor(10, 100, 1000)).toBeGreaterThanOrEqual(100);
  });

  it("never returns zero, however short the blob", () => {
    expect(peakCountFor(0.001, 3600, 1000)).toBe(1);
    expect(peakCountFor(0, 10, 1000)).toBe(1);
  });
});

describe("mergeAudioPeaks", () => {
  it("leaves a stretch no blob covers NULL, not zero", () => {
    // Two blobs with a hole between them. A dead microphone must not look like
    // a quiet room — that is the entire point of the null.
    const out = mergeAudioPeaks(
      [
        { startSec: 0, durationSec: 2, peaks: [0.5, 0.5] },
        { startSec: 8, durationSec: 2, peaks: [0.5, 0.5] },
      ],
      10,
      10,
    );
    expect(out[0]).toBeGreaterThan(0);
    expect(out[9]).toBeGreaterThan(0);
    expect(out.slice(3, 8)).toEqual([null, null, null, null, null]);
  });

  it("keeps recorded silence at ZERO, which is covered and quiet", () => {
    const out = mergeAudioPeaks(
      [{ startSec: 0, durationSec: 10, peaks: new Array(40).fill(0) }],
      10,
      10,
    );
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("takes the max where two media overlap", () => {
    const out = mergeAudioPeaks(
      [
        { startSec: 0, durationSec: 10, peaks: new Array(40).fill(0.2) },
        { startSec: 0, durationSec: 10, peaks: new Array(40).fill(0.7) },
      ],
      10,
      10,
    );
    expect(out[5]).toBeCloseTo(0.7, 5);
  });
});
