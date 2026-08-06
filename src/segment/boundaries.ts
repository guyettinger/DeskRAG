/**
 * Event-driven boundary detection (v1). Candidate boundaries:
 *  - session_start (t=0) and session_end (endTMono) always bracket the timeline,
 *  - focus_change / bookmark events (semantic switches the user made),
 *  - dwell_gap: activity resuming after ANY input-idle gap > dwellGapMs — the
 *    "nothing happened at all, not even mouse movement" signal,
 *  - burst_gap: activity resuming after a gap > burstGapMs between MEANINGFUL
 *    input (mouse_down, key_down, scroll) specifically. mouse_move is excluded:
 *    it samples every 12-100ms, so a check over ALL events almost never lets
 *    dwell_gap fire during active use — this is the finer signal that does.
 *
 * When several reasons land on the same t_mono, the most specific wins
 * (bookmark > focus_change > dwell_gap > burst_gap); the endpoints always stay
 * session_start / session_end.
 */

import type { Boundary, BoundaryReason, SegEvent } from "./types.js";
import { DEFAULT_BURST_GAP_MS, DEFAULT_DWELL_GAP_MS } from "./types.js";

const PRIORITY: Record<BoundaryReason, number> = {
  session_start: 100,
  session_end: 100,
  bookmark: 30,
  focus_change: 20,
  dwell_gap: 10,
  burst_gap: 5,
  window: 0,
};

const MEANINGFUL_KINDS = new Set(["mouse_down", "key_down", "scroll"]);

export function computeBoundaries(
  events: readonly SegEvent[],
  endTMono: number,
  dwellGapMs: number = DEFAULT_DWELL_GAP_MS,
  burstGapMs: number = DEFAULT_BURST_GAP_MS,
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
  let lastMeaningfulT: number | undefined;
  for (const ev of events) {
    if (lastT !== undefined && ev.tMono - lastT > dwellGapMs) {
      add(ev.tMono, "dwell_gap");
    }
    lastT = ev.tMono;

    if (MEANINGFUL_KINDS.has(ev.kind)) {
      if (lastMeaningfulT !== undefined && ev.tMono - lastMeaningfulT > burstGapMs) {
        add(ev.tMono, "burst_gap");
      }
      lastMeaningfulT = ev.tMono;
    }

    if (ev.kind === "focus_change") add(ev.tMono, "focus_change");
    else if (ev.kind === "bookmark") add(ev.tMono, "bookmark");
  }
  add(endTMono, "session_end");

  return [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tMono, reason]) => ({ tMono, reason }));
}
