/**
 * Turn boundaries + a time range into SegmentInserts for one granularity.
 *
 * boundaryAware  -> for each [b0, b1) span, emit windows of `targetMs`; the FIRST
 *                   window of a span carries the boundary's reason, later
 *                   subdivisions are "window". (actions)
 * !boundaryAware -> sliding windows [start, start+targetMs) every `strideMs`
 *                   across the whole range; overlap when strideMs < targetMs.
 *                   (tasks)
 */

import type { SegmentInsert } from "../store/types.js";
import type { Boundary, GranularityConfig } from "./types.js";

export function windowSegments(
  sessionId: string,
  g: GranularityConfig,
  boundaries: readonly Boundary[],
  mintId: () => string,
): SegmentInsert[] {
  if (boundaries.length === 0) return [];
  const start0 = boundaries[0]!.tMono;
  const end = boundaries[boundaries.length - 1]!.tMono;
  if (end <= start0) return [];

  const segs: SegmentInsert[] = [];
  const mk = (a: number, b: number, reason: string) =>
    segs.push({
      id: mintId(),
      sessionId,
      granularity: g.name,
      tMonoStart: a,
      tMonoEnd: b,
      boundaryReason: reason,
    });

  if (g.boundaryAware) {
    for (let i = 0; i < boundaries.length - 1; i++) {
      const b0 = boundaries[i]!;
      const b1 = boundaries[i + 1]!;
      let start = b0.tMono;
      let first = true;
      while (start < b1.tMono) {
        const stop = Math.min(start + g.targetMs, b1.tMono);
        mk(start, stop, first ? b0.reason : "window");
        start += g.strideMs;
        first = false;
      }
    }
  } else {
    let start = start0;
    for (;;) {
      const stop = Math.min(start + g.targetMs, end);
      mk(start, stop, "window");
      if (stop >= end) break;
      start += g.strideMs;
    }
  }
  return segs;
}
