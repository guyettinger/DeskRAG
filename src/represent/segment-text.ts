/**
 * The lexical index pass — the LAST represent stage, and deliberately a
 * separate one.
 *
 * A segment's searchable text is spread across five views written by five
 * stages that run at different times and under different provider
 * configurations: `digest` (always), `caption` and `app_caption` (a captioner),
 * `transcript` (audio + a whisper binary), and `summary` (always, on composed
 * levels only). Indexing from inside each of them would mean five call sites
 * racing to rewrite one row, each seeing only its own fragment. One reader at
 * the end sees whatever actually landed, and is idempotent by construction.
 *
 * It needs no provider, so it always runs — which matters, because the lexical
 * lane is the only path a default install has to an exact term.
 */

import type { Store } from "../store/types.js";

export interface SegmentTextResult {
  segmentCount: number;
  /** Segments that had at least one non-empty view. */
  indexedCount: number;
}

/**
 * Rebuild the lexical index for every segment in a session.
 *
 * The views are concatenated rather than weighted: FTS5's bm25 already
 * normalizes for field length, and a segment matching a term in its transcript
 * is as much a hit as one matching in its caption. What the lane contributes to
 * RRF is a RANKED list; relative weighting between views belongs to the fusion,
 * not to this row.
 */
export function indexSegmentText(store: Store, sessionId: string): SegmentTextResult {
  const segments = store.getSegmentsBySession(sessionId);
  let indexed = 0;
  for (const seg of segments) {
    const parts = [
      seg.digest,
      seg.caption,
      store.getAppCaption(seg.id),
      seg.transcript,
      // A composed level carries no digest or caption of its own — the summary
      // IS its text. Without this a task is unreachable by an exact term, and
      // on a default install that is the only route to one at all.
      store.getSegmentSummary(seg.id)?.text,
    ].filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    // Written even when empty: indexSegmentText deletes first, so a segment
    // whose text was removed stops matching instead of answering with stale text.
    store.indexSegmentText(seg.id, parts.join(" "));
    if (parts.length > 0) indexed++;
  }
  return { segmentCount: segments.length, indexedCount: indexed };
}
