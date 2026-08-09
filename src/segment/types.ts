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

/**
 * Level 0 of the hierarchy, and the ONLY granularity segmentation produces.
 *
 * `task` used to live here as a second, LONGER window over the same event
 * timeline — which is exactly why the rail's ACTION and TASK lanes read as one
 * signal drawn twice: they differed only in duration and in which boundary
 * reasons cut them, and both were labelled by the same VLM caption.
 *
 * Height in the hierarchy is now COMPOSED from what actions mean together
 * (`represent/compose/`), never cut from a bigger box. A bigger box cannot
 * produce a higher altitude — the captioner describes a screen either way.
 */
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
];

export const DEFAULT_DWELL_GAP_MS = 3_000;
export const DEFAULT_BURST_GAP_MS = 1_500;

/**
 * The seam where a granularity could scale with session length.
 *
 * Nothing scales today. It existed for `task`, whose window was clamped to
 * [30s, 180s] of the session's own length so a short recording did not collapse
 * into one giant box — and `task` is gone. `action` never needed it: its 10s cap
 * only ever subdivides a span between real boundaries, so it stays meaningful at
 * any session length, and every level above it is composed rather than windowed.
 */
export function resolveGranularities(
  _endTMono: number,
  base: GranularityConfig[] = BASE_GRANULARITIES,
): GranularityConfig[] {
  return base;
}

/** Minimal event shape the boundary detector needs (EventRow is compatible). */
export interface SegEvent {
  tMono: number;
  kind: string;
}
