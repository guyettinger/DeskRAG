/**
 * Reciprocal Rank Fusion. We fuse the per-view ranked lists by RANK, not by
 * score, because similarity scores from different vector spaces (a digest text
 * embedding vs a 12-dim behavior vector) live on incomparable scales — averaging
 * them is meaningless. RRF only needs each item's position in each list.
 *
 *   score(d) = Σ_lists  1 / (k + rank_d)      (rank is 1-based; absent => 0)
 *
 * k (default 60) damps the influence of top ranks so many mediocre-but-agreeing
 * lists can outweigh a single list's #1. Items appearing in MULTIPLE lists rise —
 * cross-view agreement is the signal.
 */

export interface RankedList {
  /** Stable label for this list's source (e.g. a namespace). */
  key: string;
  /** Ids in rank order (index 0 = best). */
  ids: string[];
}

export interface FusedItem {
  id: string;
  score: number;
  /** 1-based rank of this id within each list it appeared in, by list key. */
  ranks: Record<string, number>;
}

export const DEFAULT_RRF_K = 60;

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
