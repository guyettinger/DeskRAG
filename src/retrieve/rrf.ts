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
 * K IS 5, NOT THE USUAL 60, AND THE DIFFERENCE IS LOAD-BEARING HERE.
 *
 * 60 is calibrated for the regime RRF was published in: a few systems, top-1000
 * lists, millions of documents. This retriever runs SIX lanes (digest, summary,
 * caption, app_caption, transcript, lexical) over a corpus that starts at a few
 * hundred segments, and at that shape 60 inverts the ranking. The count term
 * spans N (6x, from appearing in one lane versus all six) while the rank term
 * spans only (k+L)/(k+1) — with k=60 over a 100-long list that is 2.6x. So a
 * segment ranked ~20th in six lanes ALWAYS beats one ranked 1st in two, and
 * mediocre ubiquity outranks an exact match by construction.
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
 * That table was taken at FIVE lanes and could not separate 5 from 10 — anything
 * in 5..20 looked equivalent at five queries.
 *
 * RE-SWEPT AT SIX LANES (2026-08-09), after `summary` joined Tier 1: FOUR real
 * recordings, 183 segments, 53 known-answer queries. k=5 wins monotonically on
 * every metric, which is the theory above doing what it predicts — one more lane
 * widens the count term, so k must shrink to keep the rank term wider:
 *
 *     k:               5      10     20     60
 *     mean rank     19.02  25.04  32.60  43.28
 *     recall@5        58%    28%    15%     6%
 *     mean (leaf)    1.40   1.90   3.70  11.10
 *
 * The margin WIDENS with corpus size, swept four times as the library grew:
 * recall@5 at k=5 against k=10 went 47/33 (87 segments), 52/27 (151), 58/28
 * (183). Do not compare recall@1 between those runs — the query MIX changed as
 * composed levels accumulated, so only the ordering across k is comparable.
 *
 * THE ASYMMETRY THIS SWEEP EXPOSED, WHICH k CANNOT FIX. A composed level
 * (`level:N`, `session`) has ONLY a summary — no digest, no caption, no
 * app_caption, no transcript — so it participates in ONE dense lane where a leaf
 * participates in three or four. Since the score is a SUM over lanes, four
 * mediocre ranks outscore one perfect rank. Measured: over 20 composed queries
 * whose own summary lane ranked them #1 every time, NONE came first fused, and
 * the ranks split bimodally — 3,4,4,4,4,5,5,9,11 then 26,29,29,30,32,33,34,34,35,36.
 * One case in full:
 *
 *     query "Start calculator"
 *       correct (level:1): summary#1
 *       winner  (action):  digest#25 caption#32 app_caption#1 transcript#13
 *
 * This is the same failure the paragraph above describes, now STRUCTURAL rather
 * than a tuning artefact: the lane count differs by what a node IS, so no k
 * makes a one-lane node competitive. Fixing it means changing the fusion (a
 * participation-normalized score) or ranking altitudes separately — both are
 * design changes, deliberately not made here. Leaf retrieval is unaffected and
 * excellent (mean rank 1.40 at k=5).
 *
 * Do not re-tune on a small sample; re-run the sweep against a real library.
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

export const DEFAULT_RRF_K = 5;

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
