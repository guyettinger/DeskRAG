/**
 * Stream sync. Every producer stamps items with the same {@link MonotonicClock},
 * so correlating signals is just merging by t_mono. A k-way merge of
 * already-sorted per-producer streams yields one t_mono-ordered timeline in O(n).
 */

/** Anything carrying a monotonic timestamp. */
export interface Stamped {
  tMono: number;
}

/**
 * Merge multiple streams, each already sorted ascending by t_mono, into one
 * ascending stream. Stable across streams: on a t_mono tie, earlier-listed
 * streams come first. Inputs are not mutated.
 */
export function mergeSortedByTMono<T extends Stamped>(streams: readonly T[][]): T[] {
  const cursors = new Array(streams.length).fill(0);
  const total = streams.reduce((n, s) => n + s.length, 0);
  const out: T[] = new Array(total);
  for (let written = 0; written < total; written++) {
    let bestStream = -1;
    let bestT = Infinity;
    for (let s = 0; s < streams.length; s++) {
      const i = cursors[s];
      const stream = streams[s]!;
      if (i >= stream.length) continue;
      const t = stream[i]!.tMono;
      if (t < bestT) {
        bestT = t;
        bestStream = s;
      }
    }
    out[written] = streams[bestStream]![cursors[bestStream]++]!;
  }
  return out;
}

/** Assert a stream is monotonically non-decreasing in t_mono (dev guard). */
export function isMonotonic<T extends Stamped>(stream: readonly T[]): boolean {
  for (let i = 1; i < stream.length; i++) {
    if (stream[i]!.tMono < stream[i - 1]!.tMono) return false;
  }
  return true;
}
