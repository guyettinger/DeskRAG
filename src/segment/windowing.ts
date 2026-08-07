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
  const effective = g.cutReasons
    ? boundaries.filter(
        (b) =>
          b.reason === "session_start" ||
          b.reason === "session_end" ||
          g.cutReasons!.includes(b.reason),
      )
    : boundaries;
  const start0 = effective[0]!.tMono;
  const end = effective[effective.length - 1]!.tMono;
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
    for (let i = 0; i < effective.length - 1; i++) {
      const b0 = effective[i]!;
      const b1 = effective[i + 1]!;
      // One segment per span: the span is a visual state, and a clock-sliced
      // piece of it is not a smaller state, just a smaller piece.
      if (g.subdivide === false) {
        mk(b0.tMono, b1.tMono, b0.reason);
        continue;
      }
      let start = b0.tMono;
      let first = true;
      while (start < b1.tMono) {
        const stop = Math.min(start + g.targetMs, b1.tMono);
        mk(start, stop, first ? b0.reason : "window");
        // Stop the moment a window reaches the span's end, same rule the
        // non-boundary-aware branch already uses. Without it, a span shorter
        // than targetMs but longer than strideMs gets a bogus trailing
        // window that's a near-duplicate of the one that already covered it
        // — invisible whenever strideMs === targetMs (action), only exposed
        // once task became boundary-aware with strideMs < targetMs.
        if (stop >= b1.tMono) break;
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
