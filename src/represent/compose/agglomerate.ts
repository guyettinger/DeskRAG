/**
 * The pure judgment core of the composer: where a level MAY be cut, and — with
 * no model at all — where it IS cut.
 *
 * No store, no provider, no I/O. Root-testable like `track-buckets.ts` and
 * `graph-view.ts`.
 */

import type { Block, ChildSummary, ComposeGroup } from "./types.js";

/**
 * Children per model call.
 *
 * A CALIBRATION TARGET, not a tuned value: it trades context length against how
 * often a real run is forced apart, and the first real recording is what sets
 * it. 24 is a starting point, not a measurement.
 */
export const DEFAULT_BATCH_CAP = 24;

/**
 * Is this a partition of `[start, end)` — contiguous, non-overlapping, covering?
 *
 * A group cannot cross a barrier because barriers are BLOCK EDGES and a
 * partition is validated per block, so that containment falls out of the
 * geometry rather than needing a check of its own.
 */
export function validatePartition(
  groups: readonly ComposeGroup[],
  start: number,
  end: number,
): boolean {
  if (groups.length === 0) return false;
  let cursor = start;
  for (const g of groups) {
    if (!Number.isInteger(g.start) || !Number.isInteger(g.end)) return false;
    if (g.start !== cursor) return false;
    if (g.end <= g.start) return false;
    if (g.end > end) return false;
    cursor = g.end;
  }
  return cursor === end;
}

/**
 * Cut a level into blocks a partitioner can be asked about one at a time.
 *
 * Barriers cut first and unconditionally. Anything still over the cap is cut at
 * its largest STRUCTURAL discontinuity — the biggest inter-child gap, then an
 * app change, then the lowest index — so the split is deterministic and no
 * cross-batch stitching is ever needed.
 *
 * Gaps are DIFFERENCES, which is what makes this translation invariant: a
 * uniform time shift must not change the layout, the trap `thumbPlacement` and
 * `Path.curve` span-splitting both hit.
 */
export function splitIntoBlocks(children: readonly ChildSummary[], cap: number): Block[] {
  if (children.length === 0) return [];

  // From index 1: a barrier on the first child bars nothing, since there is no
  // child to its left to be separated from.
  const atBarriers: Block[] = [];
  let start = 0;
  for (let i = 1; i < children.length; i++) {
    if (children[i]!.barrier) {
      atBarriers.push({ start, end: i });
      start = i;
    }
  }
  atBarriers.push({ start, end: children.length });

  const out: Block[] = [];
  for (const b of atBarriers) out.push(...splitToCap(children, b, cap));
  return out;
}

function splitToCap(children: readonly ChildSummary[], b: Block, cap: number): Block[] {
  if (b.end - b.start <= Math.max(1, cap)) return [b];

  let bestIdx = b.start + 1;
  let bestGap = -Infinity;
  let bestAppChange = false;
  for (let i = b.start + 1; i < b.end; i++) {
    const prev = children[i - 1]!;
    const cur = children[i]!;
    const gap = cur.startSec - prev.endSec;
    const appChange = prev.app !== null && cur.app !== null && prev.app !== cur.app;
    // Strictly greater keeps the LOWEST index on a tie, which is what stops the
    // choice flipping under floating-point noise.
    if (gap > bestGap || (gap === bestGap && appChange && !bestAppChange)) {
      bestGap = gap;
      bestIdx = i;
      bestAppChange = appChange;
    }
  }
  return [
    ...splitToCap(children, { start: b.start, end: bestIdx }, cap),
    ...splitToCap(children, { start: bestIdx, end: b.end }, cap),
  ];
}

/**
 * How strongly two adjacent children want to be siblings.
 *
 * These signals are CORRELATES of intent, not intent. A task is often
 * goal-directed heterogeneity — open terminal, run build, read error, edit, run
 * again — which spans several apps with several focus changes and which this
 * therefore scores badly, by construction. That is exactly why it is the
 * fallback and the control, not the primary.
 *
 * An unknown app is no evidence, never a match: two nulls are not the same app.
 */
export function coherence(a: ChildSummary, b: ChildSummary): number {
  let s = 0;
  if (a.app !== null && a.app === b.app) s += 2;
  if (a.url !== null && a.url === b.url) s += 1;
  const gap = b.startSec - a.endSec;
  if (gap <= 1) s += 1;
  else if (gap >= 3) s -= 1;
  return s;
}

/**
 * The always-on grouping: greedy-merge the best-scoring adjacent pair until the
 * block's node count is AT MOST HALF its child count.
 *
 * Halving is what guarantees the strict shrinkage `composeLevels` depends on to
 * terminate — with no model, or with one whose answer was rejected.
 */
export function structuralRanges(children: readonly ChildSummary[], block: Block): Block[] {
  const n = block.end - block.start;
  if (n <= 0) return [];
  if (n === 1) return [{ start: block.start, end: block.end }];

  let groups: Block[] = [];
  for (let i = block.start; i < block.end; i++) groups.push({ start: i, end: i + 1 });

  const target = Math.max(1, Math.ceil(n / 2));
  while (groups.length > target) {
    let bestI = 0;
    let bestS = -Infinity;
    for (let i = 0; i + 1 < groups.length; i++) {
      const s = coherence(children[groups[i]!.end - 1]!, children[groups[i + 1]!.start]!);
      // Strictly greater: a tie keeps the leftmost seam, so the result cannot
      // flip on floating-point noise.
      if (s > bestS) {
        bestS = s;
        bestI = i;
      }
    }
    groups = [
      ...groups.slice(0, bestI),
      { start: groups[bestI]!.start, end: groups[bestI + 1]!.end },
      ...groups.slice(bestI + 2),
    ];
  }
  return groups;
}
