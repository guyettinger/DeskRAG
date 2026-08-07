/**
 * Concrete ViewSearchers for the segment views we can query today.
 *  - TextViewSearcher: embeds the query text with a view's own embedder (digest
 *    now; caption/transcript later). Also serves image spaces that are
 *    sharedTextSpace, since a text query can hit those directly.
 *  - BehaviorViewSearcher: routes a behavioral query vector to the behavior space.
 */

import type { EmbeddingProvider, NamespacedProvider, View } from "../embed/types.js";
import { namespaceFor } from "../embed/types.js";
import type { Store } from "../store/types.js";
import type { LexicalSearcher, Query, ViewSearcher } from "./types.js";

export class TextViewSearcher implements ViewSearcher {
  readonly namespace: string;
  constructor(
    private readonly embedder: EmbeddingProvider,
    readonly view: View = "digest",
  ) {
    this.namespace = namespaceFor(view, embedder);
  }

  async queryVector(q: Query): Promise<Float32Array | null> {
    if (q.text === undefined || q.text.length === 0) return null;
    // Asymmetric embedding: documents were embedded with role "document", so a
    // query must say so or it lands in a different region of the same space —
    // no error, just quietly worse retrieval.
    const [vec] = await this.embedder.embed([q.text], { role: "query" });
    return vec ?? null;
  }
}

export class BehaviorViewSearcher implements ViewSearcher {
  readonly namespace: string;
  readonly view: View = "behavior";
  constructor(private readonly provider: NamespacedProvider) {
    this.namespace = namespaceFor("behavior", provider);
  }

  async queryVector(q: Query): Promise<Float32Array | null> {
    if (!q.behavior) return null;
    if (q.behavior.length !== this.provider.dimensions) {
      throw new Error(
        `behavior query has ${q.behavior.length} dims, expected ${this.provider.dimensions}`,
      );
    }
    return q.behavior;
  }
}

/**
 * The lexical lane over `segment_fts` — the one Tier-1 source that needs no
 * provider and no vector space, so it is always available. That matters: on a
 * default install (no image provider, no captioner) it is the only path from a
 * query to an EXACT term, and exact terms — a filename, an error string, a URL,
 * a proper noun — are precisely where a dense embedding is weakest.
 */
export class LexicalSegmentSearcher implements LexicalSearcher {
  readonly key = "lexical";
  constructor(private readonly store: Store) {}

  search(q: Query, limit: number): string[] {
    if (q.text === undefined || q.text.length === 0) return [];
    return this.store.ftsSegments(q.text, limit);
  }
}
