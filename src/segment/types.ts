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
  | "scene_change" // the screen itself changed — a kept keyframe (mpdecimate)
  | "dwell_gap" // activity resumed after a long input-idle gap (any event, including mouse_move)
  | "burst_gap" // activity resumed after a shorter gap between MEANINGFUL input (click/key/scroll)
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
 *    `targetMs` chunks (stride = targetMs => no overlap). Used for "actions"
 *    and (as of this change) "tasks".
 *  - !boundaryAware: pure sliding windows of `targetMs` every `strideMs`
 *    (stride < target => overlap).
 */
export interface GranularityConfig {
  name: string;
  targetMs: number;
  strideMs: number;
  boundaryAware: boolean;
  /**
   * Which boundary reasons count as a cut for this granularity, in addition to
   * session_start/session_end (always included). Undefined means every
   * reason counts — the granularity reacts to everything computeBoundaries
   * produces, which is what "action" wants: it should track behavior at full
   * resolution. "task" narrows this to the big semantic switches only, since a
   * click/key pause is noise at task scale.
   */
  cutReasons?: BoundaryReason[];
  /**
   * Subdivide a span longer than `targetMs` into `targetMs` chunks. Defaults to
   * true (undefined means true), which is what "task" wants.
   *
   * `action` sets it FALSE. A sub-window is a slice of clock with no boundary
   * behind it and therefore no keyframe of its own, so a caption or a digest
   * attached to it is draped over time nothing distinguishes — exactly the
   * defect this design removes. An action span's length is bounded by
   * mpdecimate's `max` heartbeat instead, at capture time.
   */
  subdivide?: boolean;
}

export interface SegmenterOptions {
  /** Input-idle gap (any event) that starts a new "true idle" boundary. */
  dwellGapMs?: number;
  /** Input-idle gap (meaningful input only) that starts a burst boundary. */
  burstGapMs?: number;
  /** Granularities to produce. Omit to resolve BASE_GRANULARITIES against the
   *  session's own length (adaptive task sizing) — see resolveGranularities. */
  granularities?: GranularityConfig[];
}

export const BASE_GRANULARITIES: GranularityConfig[] = [
  {
    name: "action",
    targetMs: 10_000,
    strideMs: 10_000,
    boundaryAware: true,
    // Inactivity indicates INTENT, not a change of state, so it does not cut
    // here — it is surfaced as its own rail lane instead.
    cutReasons: ["scene_change", "focus_change", "bookmark"],
    subdivide: false,
  },
  {
    name: "task",
    targetMs: 180_000,
    strideMs: 90_000,
    boundaryAware: true,
    cutReasons: ["focus_change", "bookmark"],
  },
];

export const DEFAULT_DWELL_GAP_MS = 3_000;
export const DEFAULT_BURST_GAP_MS = 1_500;

/**
 * Task's targetMs/strideMs scale to the session's own length so a short
 * recording doesn't collapse into one giant window (clamped to [30s, 180s]);
 * action is unaffected — its 10s cap only ever subdivides a span between real
 * boundaries, so it stays meaningful at any session length.
 */
export function resolveGranularities(
  endTMono: number,
  base: GranularityConfig[] = BASE_GRANULARITIES,
): GranularityConfig[] {
  return base.map((g) => {
    if (g.name !== "task") return g;
    const targetMs = Math.min(180_000, Math.max(30_000, Math.round(endTMono / 2)));
    return { ...g, targetMs, strideMs: targetMs / 2 };
  });
}

/** Minimal event shape the boundary detector needs (EventRow is compatible). */
export interface SegEvent {
  tMono: number;
  kind: string;
}
