/**
 * Segmentation types. We cut the raw event timeline into discrete "experience"
 * units at MULTIPLE overlapping granularities (e.g. ~10s "actions" and ~3min
 * "tasks") so retrieval can match at the right scale. v1 boundaries are
 * event-driven; scene-diff / speech-boundary sources plug in later.
 */

/** Why a segment starts here. */
export type BoundaryReason =
  | "session_start"
  | "focus_change" // app/window focus changed
  | "dwell_gap" // activity resumed after a long input-idle gap
  | "bookmark" // explicit user hotkey marker
  | "session_end"
  | "window"; // time-driven subdivision inside a span (no semantic boundary)

export interface Boundary {
  tMono: number;
  reason: BoundaryReason;
}

/**
 * One granularity to window at.
 *  - boundaryAware: cut at detected boundaries, then subdivide long spans into
 *    `targetMs` chunks (stride = targetMs => no overlap). Used for "actions".
 *  - !boundaryAware: pure sliding windows of `targetMs` every `strideMs`
 *    (stride < target => overlap). Used for "tasks".
 */
export interface GranularityConfig {
  name: string;
  targetMs: number;
  strideMs: number;
  boundaryAware: boolean;
}

export interface SegmenterOptions {
  /** Input-idle gap that starts a new action segment. */
  dwellGapMs?: number;
  /** Granularities to produce (defaults to action + task). */
  granularities?: GranularityConfig[];
}

export const DEFAULT_GRANULARITIES: GranularityConfig[] = [
  { name: "action", targetMs: 10_000, strideMs: 10_000, boundaryAware: true },
  { name: "task", targetMs: 180_000, strideMs: 90_000, boundaryAware: false },
];

export const DEFAULT_DWELL_GAP_MS = 3_000;

/** Minimal event shape the boundary detector needs (EventRow is compatible). */
export interface SegEvent {
  tMono: number;
  kind: string;
}
