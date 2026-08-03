/**
 * Time → fixed-width buckets. Every density lane of the timeline rail is built
 * from these, so the arithmetic lives in one tested place instead of being
 * re-derived in fifteen lane builders.
 *
 * PURE: no store, no filesystem, no Electron, no DTOs. Tested in the ROOT
 * vitest suite alongside `plan-view.ts` and `graph-layout.ts`.
 */

/**
 * The bucket a second-offset falls in. Clamped at both ends, so `totalSec`
 * itself lands in the LAST bucket rather than one past the end of the array.
 */
export function bucketIndex(sec: number, totalSec: number, buckets: number): number {
  if (!(totalSec > 0) || buckets <= 0) return 0;
  const i = Math.floor((sec / totalSec) * buckets);
  return Math.min(buckets - 1, Math.max(0, i));
}

/** How many of `secs` land in each bucket. */
export function bucketCounts(
  secs: readonly number[],
  totalSec: number,
  buckets: number,
): number[] {
  const out = new Array<number>(buckets).fill(0);
  for (const s of secs) {
    const i = bucketIndex(s, totalSec, buckets);
    out[i] = (out[i] ?? 0) + 1;
  }
  return out;
}

/**
 * Max value per bucket; buckets with no sample stay 0.
 *
 * Max, never mean. A fast pointer flick inside an otherwise idle bucket must
 * not be averaged away — showing when the pointer moved fast is the whole
 * purpose of a speed lane.
 */
export function bucketMax(
  samples: readonly { sec: number; value: number }[],
  totalSec: number,
  buckets: number,
): number[] {
  const out = new Array<number>(buckets).fill(0);
  for (const s of samples) {
    const b = bucketIndex(s.sec, totalSec, buckets);
    if (s.value > out[b]!) out[b] = s.value;
  }
  return out;
}

/**
 * Last value seen at or before each bucket — a step function, which is what a
 * pointer coordinate is between samples.
 *
 * Buckets before the first sample are null: a pointer has no position before it
 * was first observed, and that is absent coverage rather than the origin.
 */
export function bucketHold(
  samples: readonly { sec: number; value: number }[],
  totalSec: number,
  buckets: number,
): (number | null)[] {
  const out = new Array<number | null>(buckets).fill(null);
  for (const s of samples) out[bucketIndex(s.sec, totalSec, buckets)] = s.value;
  let last: number | null = null;
  for (let i = 0; i < buckets; i++) {
    if (out[i] === null) out[i] = last;
    else last = out[i]!;
  }
  return out;
}

/**
 * Counts per bucket → a per-second rate, smoothed over at least one second.
 *
 * A raw per-bucket rate is arithmetically true and practically a lie. With 1000
 * buckets over a 40-second recording each bucket is 40ms, so ONE keystroke
 * reads as "25 keys/s" — a rate nobody types at. Measured exactly that way on a
 * real recording: 65 keystrokes reported a 25.2 keys/s peak.
 *
 * The window is `max(1s, one bucket)`, so a long session whose buckets already
 * exceed a second is left alone.
 */
export function bucketRate(counts: readonly number[], perBucketSec: number): number[] {
  if (!(perBucketSec > 0) || counts.length === 0) return counts.map(() => 0);
  const span = Math.max(1, Math.round(1 / perBucketSec)); // buckets per second
  if (span === 1) return counts.map((c) => c / perBucketSec);

  // Prefix sums so the sliding window stays O(n) rather than O(n * span).
  const prefix = new Array<number>(counts.length + 1).fill(0);
  for (let i = 0; i < counts.length; i++) prefix[i + 1] = prefix[i]! + counts[i]!;

  const half = Math.floor(span / 2);
  return counts.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(counts.length, i - half + span);
    // Divide by the window ACTUALLY covered, so the first and last buckets are
    // not damped toward zero by a window hanging off the end of the axis.
    return (prefix[hi]! - prefix[lo]!) / ((hi - lo) * perBucketSec);
  });
}

/** Scale to 0–1 by the largest value present, preserving nulls. */
export function normalize(raw: readonly (number | null)[]): {
  values: (number | null)[];
  peak: number;
} {
  let peak = 0;
  for (const v of raw) if (v !== null && v > peak) peak = v;
  return {
    values: raw.map((v) => (v === null ? null : peak > 0 ? v / peak : 0)),
    peak,
  };
}

export interface AudioBlobPeaks {
  /** Offset of the blob's first sample on the session axis. */
  startSec: number;
  /**
   * Duration MEASURED FROM THE BYTES (`WavPeaks.durationSec`), never the blob
   * row's declared span. A truncated file must read as a gap for the part that
   * is missing, not as an envelope stretched over time nobody recorded.
   */
  durationSec: number;
  peaks: readonly number[];
}

/**
 * How many peaks to ask `wavPeaks` for so every session bucket the blob covers
 * receives at least one sample. Oversampled 4x, because a blob starts and ends
 * mid-bucket and an exact ratio would leave its edge buckets empty.
 */
export function peakCountFor(durationSec: number, totalSec: number, buckets: number): number {
  if (!(totalSec > 0) || !(durationSec > 0)) return 1;
  return Math.max(1, Math.ceil((durationSec / totalSec) * buckets * 4));
}

/**
 * Place per-blob envelopes onto the session axis, taking the max where they
 * overlap.
 *
 * A bucket no blob covers stays NULL — not zero. Silence during a recorded
 * stretch is a flat zero; a stretch with no blob at all is unknown, and a dead
 * microphone must not be indistinguishable from a quiet room.
 */
export function mergeAudioPeaks(
  blobs: readonly AudioBlobPeaks[],
  totalSec: number,
  buckets: number,
): (number | null)[] {
  const out = new Array<number | null>(buckets).fill(null);
  for (const b of blobs) {
    if (b.peaks.length === 0 || !(b.durationSec > 0)) continue;
    for (let p = 0; p < b.peaks.length; p++) {
      // Sample the CENTRE of each peak's slice, so a blob starting at 0 does
      // not bias its first peak into the bucket before it.
      const sec = b.startSec + ((p + 0.5) / b.peaks.length) * b.durationSec;
      const i = bucketIndex(sec, totalSec, buckets);
      // `?? null` because an out-of-range read is `undefined` under
      // noUncheckedIndexedAccess, and "no coverage" has exactly one spelling.
      const cur = out[i] ?? null;
      out[i] = cur === null ? b.peaks[p]! : Math.max(cur, b.peaks[p]!);
    }
  }
  return out;
}
