/**
 * Segmenter — reads a session's events from the store, detects boundaries, and
 * windows them into overlapping multi-granularity segments, then persists them.
 * Pure event-driven v1; scene-diff / speech-boundary signals plug in later by
 * contributing extra boundaries.
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
  DEFAULT_DWELL_GAP_MS,
  DEFAULT_GRANULARITIES,
  type Boundary,
  type GranularityConfig,
  type SegmenterOptions,
} from "./types.js";

export interface SegmentResult {
  boundaries: Boundary[];
  /** Persisted segment ids grouped by granularity name. */
  byGranularity: Record<string, string[]>;
  endTMono: number;
}

export class Segmenter {
  private readonly dwellGapMs: number;
  private readonly granularities: GranularityConfig[];

  constructor(
    private readonly store: Store,
    opts: SegmenterOptions = {},
  ) {
    this.dwellGapMs = opts.dwellGapMs ?? DEFAULT_DWELL_GAP_MS;
    this.granularities = opts.granularities ?? DEFAULT_GRANULARITIES;
  }

  async segment(sessionId: string): Promise<SegmentResult> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const events = this.store.getEventsBySession(sessionId);

    const endTMono = this.deriveEnd(session.startedAt, session.endedAt, events);
    const boundaries = computeBoundaries(events, endTMono, this.dwellGapMs);

    const all: SegmentInsert[] = [];
    const byGranularity: Record<string, string[]> = {};
    for (const g of this.granularities) {
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
