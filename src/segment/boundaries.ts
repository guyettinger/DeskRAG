/**
 * Event-driven boundary detection (v1). Candidate boundaries:
 *  - session_start (t=0) and session_end (endTMono) always bracket the timeline,
 *  - focus_change / bookmark events (semantic switches the user made),
 *  - dwell_gap: activity resuming after an input-idle gap > dwellGapMs.
 *
 * When several reasons land on the same t_mono, the most specific wins
 * (bookmark > focus_change > dwell_gap); the endpoints always stay
 * session_start / session_end.
 */

import type { Boundary, BoundaryReason, SegEvent } from "./types.js";
import { DEFAULT_DWELL_GAP_MS } from "./types.js";

const PRIORITY: Record<BoundaryReason, number> = {
  session_start: 100,
  session_end: 100,
  bookmark: 30,
  focus_change: 20,
  dwell_gap: 10,
  window: 0,
};

export function computeBoundaries(
  events: readonly SegEvent[],
  endTMono: number,
  dwellGapMs: number = DEFAULT_DWELL_GAP_MS,
): Boundary[] {
  const best = new Map<number, BoundaryReason>();
  const add = (tMono: number, reason: BoundaryReason) => {
    if (tMono < 0 || tMono > endTMono) return;
    const existing = best.get(tMono);
    if (existing === undefined || PRIORITY[reason] > PRIORITY[existing]) {
      best.set(tMono, reason);
    }
  };

  add(0, "session_start");
  let lastT: number | undefined;
  for (const ev of events) {
    if (lastT !== undefined && ev.tMono - lastT > dwellGapMs) {
      add(ev.tMono, "dwell_gap");
    }
    lastT = ev.tMono;
    if (ev.kind === "focus_change") add(ev.tMono, "focus_change");
    else if (ev.kind === "bookmark") add(ev.tMono, "bookmark");
  }
  add(endTMono, "session_end");

  return [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tMono, reason]) => ({ tMono, reason }));
}
