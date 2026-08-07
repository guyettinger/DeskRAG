/**
 * Reciprocal Rank Fusion. We fuse the per-view ranked lists by RANK, not by
 * score, because similarity scores from different vector spaces (a digest text
 * embedding vs a 12-dim behavior vector) live on incomparable scales — averaging
 * them is meaningless. RRF only needs each item's position in each list.
 *
 *   score(d) = Σ_lists  1 / (k + rank_d)      (rank is 1-based; absent => 0)
 *
 * k damps the influence of top ranks so many mediocre-but-agreeing lists can
 * outweigh a single list's #1. Items appearing in MULTIPLE lists rise —
 * cross-view agreement is the signal.
 *
 * K IS 10, NOT THE USUAL 60, AND THE DIFFERENCE IS LOAD-BEARING HERE.
 *
 * 60 is calibrated for the regime RRF was published in: a few systems, top-1000
 * lists, millions of documents. This retriever runs FIVE lanes (digest, caption,
 * app_caption, transcript, lexical) over a corpus that starts at a few hundred
 * segments, and at that shape 60 inverts the ranking. The count term spans N
 * (5x, from appearing in one lane versus all five) while the rank term spans
 * only (k+L)/(k+1) — with k=60 over a 100-long list that is 2.6x. So a segment
 * ranked ~20th in five lanes ALWAYS beats one ranked 1st in two, and mediocre
 * ubiquity outranks an exact match by construction.
 *
 * Measured on a real library, searching for a sentence the user had typed, which
 * the digest lane ranked #1 and the lexical lane ranked #1: fused with k=60 it
 * came 13th. Mean rank of the correct segment over five known-answer queries:
 *
 *     k:            5     10     20     60
 *     perViewK=30  1.2    1.2    1.6    2.0
 *     perViewK=50  1.2    1.2    1.2    3.2
 *     perViewK=100 1.2    1.4    1.2    5.6
 *
 * k=10 keeps the rank term wider than the count term at every list length in
 * that table ((10+50)/11 = 5.5 > 5, (10+100)/11 = 10 > 5), which is why it is
 * flat across perViewK where 60 degrades with it. Anything in 5..20 works; the
 * differences inside that band are noise at five queries, so do not re-tune on a
 * small sample — re-run the sweep against a real library instead.
 */

/** One view's ranked ids, as fed to `reciprocalRankFusion`. */
export interface RankedList {
  /** Stable label for this list's source (e.g. a namespace). */
  key: string;
  /** Ids in rank order (index 0 = best). */
  ids: string[];
}

/** A fused result: the RRF score plus which lists contributed, and at what rank. */
export interface FusedItem {
  id: string;
  score: number;
  /** 1-based rank of this id within each list it appeared in, by list key. */
  ranks: Record<string, number>;
}

export const DEFAULT_RRF_K = 10;

export function reciprocalRankFusion(
  lists: readonly RankedList[],
  k: number = DEFAULT_RRF_K,
): FusedItem[] {
  const acc = new Map<string, FusedItem>();
  for (const list of lists) {
    for (let i = 0; i < list.ids.length; i++) {
      const id = list.ids[i]!;
      const rank = i + 1;
      let item = acc.get(id);
      if (!item) {
        item = { id, score: 0, ranks: {} };
        acc.set(id, item);
      }
      item.score += 1 / (k + rank);
      item.ranks[list.key] = rank;
    }
  }
  // Highest fused score first; deterministic id tie-break.
  return [...acc.values()].sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : 1,
  );
}
