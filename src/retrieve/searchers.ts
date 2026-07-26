/**
 * Concrete ViewSearchers for the segment views we can query today.
 *  - TextViewSearcher: embeds the query text with a view's own embedder (digest
 *    now; caption/transcript later). Also serves image spaces that are
 *    sharedTextSpace, since a text query can hit those directly.
 *  - BehaviorViewSearcher: routes a behavioral query vector to the behavior space.
 */

import type { EmbeddingProvider, NamespacedProvider, View } from "../embed/types.js";
import { namespaceFor } from "../embed/types.js";
import type { Query, ViewSearcher } from "./types.js";

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
