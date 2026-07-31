/**
 * Pure geometry over a display topology. No store, no clock, no I/O.
 *
 * `Point2`/`Bounds` are declared here rather than imported from `trace/`:
 * `trace/` depends on `capture/`, never the reverse. Same "minimal local shape"
 * pattern `segment/types.ts` uses for `SegEvent`.
 */

import type { DisplayInfo } from "./types.js";

export interface Point2 {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The default `lift` already uses when no display is known. */
const NO_DISPLAY = "D0";

/**
 * Half-open containment: `[x, x+w)`. Closed intervals would make the seam
 * between adjacent displays ambiguous, so a point on the boundary would resolve
 * to whichever display happened to be listed first.
 */
const contains = (d: DisplayInfo, p: Point2): boolean =>
  p.x >= d.x && p.x < d.x + d.w && p.y >= d.y && p.y < d.y + d.h;

const overlaps = (d: DisplayInfo, b: Bounds): boolean =>
  b.x < d.x + d.w && b.x + b.w > d.x && b.y < d.y + d.h && b.y + b.h > d.y;

export function displayIdAt(displays: readonly DisplayInfo[], p: Point2): string {
  if (displays.length === 0) return NO_DISPLAY;
  const hit = displays.find((d) => contains(d, p));
  if (hit !== undefined) return hit.id;
  // A point off every display still has to land somewhere deterministic.
  return (displays.find((d) => d.primary) ?? displays[0]!).id;
}

/**
 * True when `bounds` lies wholly outside every known display — the signal that
 * topology changed and must be re-queried.
 *
 * Returns false with no known displays (nothing to contradict, and re-querying
 * on every poll would thrash) and false for a degenerate zero-area window, which
 * some apps report transiently while opening.
 */
export function outsideKnownDisplays(displays: readonly DisplayInfo[], bounds: Bounds): boolean {
  if (displays.length === 0) return false;
  if (bounds.w <= 0 || bounds.h <= 0) return false;
  return !displays.some((d) => overlaps(d, bounds));
}
