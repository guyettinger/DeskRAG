/**
 * Segmenter — reads a session's events from the store, detects boundaries, and
 * windows them into overlapping multi-granularity segments, then persists them.
 * Pure event-driven boundaries plus the session's own keyframes, which are the
 * visual-state-change signal; speech boundaries plug in later the same way.
 *
 * Segments are relational-only here (transcript/digest/caption/vectors are
 * filled by represent/ downstream), so this uses store.putSegments with no
 * vectors — the dual-store write path stays SQLite-only for now.
 */

import { ulid } from "ulid";
import type { Store, SegmentInsert } from "../store/types.js";
import { computeBoundaries } from "./boundaries.js";
import { windowSegments } from "./windowing.js";
import {
  DEFAULT_BURST_GAP_MS,
  DEFAULT_DWELL_GAP_MS,
  resolveGranularities,
  type Boundary,
  type GranularityConfig,
  type SegmenterOptions,
} from "./types.js";

/** What one segmentation pass produced, per granularity. */
export interface SegmentResult {
  boundaries: Boundary[];
  /** Persisted segment ids grouped by granularity name. */
  byGranularity: Record<string, string[]>;
  endTMono: number;
}

/**
 * Turns a session's events into segments: detects event-driven boundaries, then
 * windows them at multiple overlapping granularities. Runs after capture, which is
 * why frame↔segment association is set later, at represent time.
 */
export class Segmenter {
  private readonly dwellGapMs: number;
  private readonly burstGapMs: number;
  private readonly granularitiesOverride: GranularityConfig[] | undefined;

  constructor(
    private readonly store: Store,
    opts: SegmenterOptions = {},
  ) {
    this.dwellGapMs = opts.dwellGapMs ?? DEFAULT_DWELL_GAP_MS;
    this.burstGapMs = opts.burstGapMs ?? DEFAULT_BURST_GAP_MS;
    this.granularitiesOverride = opts.granularities;
  }

  async segment(sessionId: string): Promise<SegmentResult> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const events = this.store.getEventsBySession(sessionId);

    const endTMono = this.deriveEnd(session.startedAt, session.endedAt, events);
    // A kept frame IS a visual state change — mpdecimate decided that at
    // capture time and FrameIngestor only wrote a row for frames that survived
    // it. Passed as bare t_monos, not as events, so boundaries.ts still sees
    // only SegEvent and `segment/` stays a leaf that knows nothing about frames.
    const sceneTMonos = this.store.getFramesBySession(sessionId).map((f) => f.tMono);
    const boundaries = computeBoundaries(
      events,
      endTMono,
      this.dwellGapMs,
      this.burstGapMs,
      sceneTMonos,
    );
    const granularities = this.granularitiesOverride ?? resolveGranularities(endTMono);

    const all: SegmentInsert[] = [];
    const byGranularity: Record<string, string[]> = {};
    for (const g of granularities) {
      const segs = windowSegments(sessionId, g, boundaries, ulid);
      byGranularity[g.name] = segs.map((s) => s.id);
      all.push(...segs);
    }
    await this.store.putSegments(all);

    return { boundaries, byGranularity, endTMono };
  }

  /**
   * t_mono of the session end. Prefer the wall-clock duration (endedAt-startedAt)
   * but never cut before the last observed event.
   */
  private deriveEnd(
    startedAt: number,
    endedAt: number | null,
    events: readonly { tMono: number }[],
  ): number {
    const lastEvent = events.length ? events[events.length - 1]!.tMono : 0;
    const wallDuration = endedAt !== null ? endedAt - startedAt : 0;
    return Math.max(lastEvent, wallDuration);
  }
}
