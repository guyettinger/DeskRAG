/**
 * Deterministic reranker for tests — ranks by query/candidate word-token overlap,
 * stable on ties. No network. Lets a test assert Tier-4 reordering precisely.
 */

import type { Reranker, RerankCandidate } from "./types.js";

function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []));
}

export class FakeReranker implements Reranker {
  async rerank(query: string, candidates: RerankCandidate[]): Promise<string[]> {
    const q = tokens(query);
    const scored = candidates.map((c, i) => {
      const ct = tokens(c.text);
      let overlap = 0;
      for (const t of ct) if (q.has(t)) overlap++;
      return { id: c.id, overlap, i };
    });
    scored.sort((a, b) => b.overlap - a.overlap || a.i - b.i);
    return scored.map((s) => s.id);
  }
}
