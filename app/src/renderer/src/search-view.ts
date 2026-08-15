/**
 * The Search screen's pure projections — everything about a result row that can
 * be decided from the DTOs alone.
 *
 * A `.ts` and not a `.tsx` on purpose, the `graph-view.ts` / `track-view.ts`
 * precedent: the ROOT tsconfig sets no `jsx`, so a root test that reaches into a
 * `.tsx` — even for a type — breaks `npm run typecheck`. It also imports nothing
 * from `api.ts`, which evaluates `window.deskrag` at module scope.
 */

import type { FrameHitDTO } from "@shared/types";
import { scoresAreTied } from "@shared/evidence";

export interface RowText {
  /** The loudest line, or null when the row has no description at all. */
  headline: string | null;
  /** The templated digest, when something else already took the headline. */
  digest: string | null;
  /** Speech during this hit's segment. */
  said: string | null;
  /** The task it happened inside — null when it was promoted to the headline. */
  task: string | null;
}

/**
 * What a row SAYS, and what it withholds.
 *
 * Built on the app's one label rule — caption beats digest, because the VLM
 * describes the pixels and the digest is a template — with one deviation this
 * surface has to make: `keyframeLabel` ends at the TIMECODE, and a row already
 * prints the timecode in its header. Falling through to it produced a row whose
 * headline restated the line above it, which is worse than saying nothing.
 *
 * So the chain ends at the task summary instead, and the task line is dropped
 * when that happens — the same string twice is the thing being avoided. A row
 * with none of the three has genuinely nothing to describe it and says so, in
 * the app's degraded-text idiom, because the alternative is a blank space that
 * looks like a rendering fault.
 */
export function rowText(hit: {
  segmentCaption: string | null;
  segmentDigest: string | null;
  segmentTranscript: string | null;
  taskSummary: string | null;
}): RowText {
  const clean = (s: string | null): string | null => (s !== null && s.trim() !== "" ? s : null);
  const caption = clean(hit.segmentCaption);
  const digest = clean(hit.segmentDigest);
  const task = clean(hit.taskSummary);

  const headline = caption ?? digest ?? task;
  return {
    headline,
    // Only when something ABOVE it took the headline, or it repeats that line.
    digest: caption !== null ? digest : null,
    said: clean(hit.segmentTranscript),
    // Withheld when it was promoted, kept whenever it is still a wider answer.
    task: headline === task ? null : task,
  };
}

export interface EvidenceBars {
  /** Fill fraction per hit, index-aligned with the input. */
  fill: number[];
  /**
   * Every hit scored identically, so the bars carry no information and the
   * header says so instead of drawing a wall of full ones.
   */
  tied: boolean;
}

/**
 * Bar fill per hit, RELATIVE TO THE BEST HIT IN THIS LIST — which is the only
 * thing the score can honestly express.
 *
 * Every term of the score is max-normalized across the candidate set, so the top
 * hit sits at the weight ceiling on every query ever run (1.000 on a default
 * install, a flat 0.500 when no region matched). The number is an ordering; a
 * percentage drawn from it would read "100% confident" every single time.
 *
 * Two things this must not assume. The max is taken over the whole list rather
 * than from index 0, because a Tier-4 rerank reorders without recomputing scores
 * and can leave the list non-monotonic. And an all-equal list is REAL — the tie
 * rule is `scoresAreTied` in `@shared/evidence`, shared with the MCP tool so
 * both surfaces call the same lists tied.
 */
export function evidenceBars(hits: readonly Pick<FrameHitDTO, "score">[]): EvidenceBars {
  if (hits.length === 0) return { fill: [], tied: false };
  const scores = hits.map((h) => h.score);
  const max = Math.max(...scores);
  const tied = scoresAreTied(hits);
  // A non-positive max is a list where nothing scored at all; a tied list has
  // nothing to compare within. Both get a uniform bar rather than a full one.
  if (max <= 0 || tied) {
    return { fill: scores.map(() => (hits.length === 1 ? 1 : 0.25)), tied };
  }
  return { fill: scores.map((s) => Math.max(0, Math.min(1, s / max))), tied: false };
}

export interface LocatorTicks {
  /** This hit's position along the recording, 0..1. */
  self: number;
  /** Every OTHER hit from the same recording in this result list, 0..1. */
  others: number[];
}

/**
 * Where a hit sits on its own recording's axis, and where its neighbours sit.
 *
 * The other ticks are what make the strip worth its 3px: several results from
 * one recording read as a cluster, so a reader can tell "this query found one
 * moment" from "this query found a whole stretch of one session".
 *
 * Returns null when the span is unknown — a recording with no video and no end
 * time has no axis to place anything on, and an invented one would put every
 * tick at a position that means nothing. Withholding is the same rule the rail
 * follows for a lane with no coverage.
 */
export function locatorTicks(
  hits: readonly Pick<FrameHitDTO, "sessionId" | "offsetSec" | "sessionSpanSec">[],
  index: number,
): LocatorTicks | null {
  const hit = hits[index];
  if (!hit || hit.sessionId === "" || hit.sessionSpanSec <= 0) return null;
  const at = (offsetSec: number): number =>
    Math.max(0, Math.min(1, offsetSec / hit.sessionSpanSec));
  return {
    self: at(hit.offsetSec),
    others: hits
      .filter((h, i) => i !== index && h.sessionId === hit.sessionId)
      .map((h) => at(h.offsetSec)),
  };
}
