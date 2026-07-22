/**
 * Tier2Retriever — whole-frame ANN scoped to the segments Tier 1 produced. This
 * is the "narrow, never widen" step: a visual query (or a shared-text-space text
 * query) hits the frame_image space, but ONLY among frames belonging to the
 * Tier-1 segment scope, via the denormalized segment_ids column. It returns
 * frames with bboxes-to-come once Tier 3 (regions) lands.
 */

import type { ImageEmbeddingProvider } from "../embed/types.js";
import { namespaceFor } from "../embed/types.js";
import type { Store } from "../store/types.js";
import type { FrameHit, Query } from "./types.js";

export interface Tier2Options {
  /** Frames to return. */
  topN?: number;
  /** Hydrate the FrameRow onto each hit (default true). */
  hydrate?: boolean;
}

export class Tier2Retriever {
  readonly namespace: string;
  private readonly topN: number;
  private readonly hydrate: boolean;

  constructor(
    private readonly store: Store,
    private readonly imageEmbedder: ImageEmbeddingProvider,
    opts: Tier2Options = {},
  ) {
    this.namespace = namespaceFor("frame_image", imageEmbedder);
    this.topN = opts.topN ?? 30;
    this.hydrate = opts.hydrate ?? true;
  }

  /**
   * Frame search for a visual query, scoped to `segmentIds` (the Tier-1 result).
   * Returns [] when the query has no image or the scope is empty.
   */
  async retrieveFrames(query: Query, segmentIds: string[]): Promise<FrameHit[]> {
    if (!query.image || segmentIds.length === 0) return [];
    const [vec] = await this.imageEmbedder.embedImages([query.image]);
    const hits = await this.store.searchFrames(this.namespace, vec!, this.topN, {
      segmentIds,
    });
    return this.hydrateHits(hits);
  }

  /**
   * Unscoped frame search — the coarse tier for a PURE visual query, where there
   * is no Tier-1 segment scope (the spec's pHash -> whole-frame -> region path).
   */
  async retrieveFramesUnscoped(query: Query): Promise<FrameHit[]> {
    if (!query.image) return [];
    const [vec] = await this.imageEmbedder.embedImages([query.image]);
    const hits = await this.store.searchFrames(this.namespace, vec!, this.topN);
    return this.hydrateHits(hits);
  }

  private hydrateHits(hits: { id: string; distance: number }[]): FrameHit[] {
    return hits.map((h) => {
      const frame = this.hydrate ? this.store.getFrame(h.id) : undefined;
      return {
        frameId: h.id,
        distance: h.distance,
        ...(frame ? { frame } : {}),
      };
    });
  }
}
