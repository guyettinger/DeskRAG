/**
 * Fusion — turn the concatenated per-source regions into ≤ maxRegions high-value
 * ones:
 *   1. sort by priority (AX + hotspot naturally outrank grid),
 *   2. NMS by IoU, keeping the higher-priority region on overlap,
 *   3. on a cross-source overlap, BUMP the kept region's priority — an AX box the
 *      user also clicked in is almost certainly THE thing (the quiet workhorse),
 *   4. budget-cut to the top maxRegions by (boosted) priority.
 *
 * Because focused/labeled AX regions carry the highest base priority, the budget
 * cut inherently preserves the focused element and labeled high-priority regions.
 */

import type { Region } from "../../embed/types.js";
import { iou } from "./geometry.js";

export interface FuseOptions {
  iouThreshold?: number;
  maxRegions?: number;
  agreementBoost?: number;
}

export function fuseRegions(regions: readonly Region[], opts: FuseOptions = {}): Region[] {
  const iouThreshold = opts.iouThreshold ?? 0.5;
  const maxRegions = opts.maxRegions ?? 14;
  const agreementBoost = opts.agreementBoost ?? 1.5;

  const sorted = [...regions].sort((a, b) => b.priority - a.priority);
  const kept: Region[] = [];
  for (const r of sorted) {
    const overlap = kept.find((k) => iou(k, r) > iouThreshold);
    if (overlap) {
      // Cross-source agreement: the surviving region gets a confidence bump.
      if (overlap.source !== r.source) overlap.priority += agreementBoost;
      continue;
    }
    kept.push({ ...r }); // clone so boosts never mutate the caller's regions
  }

  kept.sort((a, b) => b.priority - a.priority);
  return kept.slice(0, maxRegions);
}
