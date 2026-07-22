/**
 * Tier-4 reranking. After the coarse-to-fine tiers assemble candidate frames, an
 * optional LLM rerank of the top ~10 (using the query + each candidate's digest +
 * region labels) sharpens ordering for fuzzy natural-language queries. Skipped for
 * fast visual queries (no query text).
 */

export interface RerankCandidate {
  id: string;
  /** Compact textual description: segment digest + region labels. */
  text: string;
}

export interface Reranker {
  /** Return candidate ids in the new (best-first) order. */
  rerank(query: string, candidates: RerankCandidate[]): Promise<string[]>;
}
