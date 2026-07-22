/**
 * Tier3Retriever — region ANN scoped to the frames Tier 2 produced, fused with an
 * AX-label FTS match. This is the PixelRAG payoff: it returns `highlights` — the
 * matched region bboxes + labels — so the UI can outline WHERE on the recalled
 * frame the match is. Two match paths:
 *   - image query -> region_image ANN, pre-filtered to frame_id IN scope,
 *   - text query  -> region_fts MATCH on role/label, then filtered to the frame
 *     scope (a text path pure-pixel systems can't offer).
 * A region matched by both carries matchedBy: ["ann","fts"].
 */

import type { ImageEmbeddingProvider } from "../embed/types.js";
import { namespaceFor } from "../embed/types.js";
import type { RegionRow, Store } from "../store/types.js";
import type { Query, RegionHit } from "./types.js";

export interface Tier3Options {
  /** Region hits to return per source before merge. */
  topN?: number;
}

export class Tier3Retriever {
  readonly namespace: string;
  private readonly topN: number;

  constructor(
    private readonly store: Store,
    private readonly imageEmbedder: ImageEmbeddingProvider,
    opts: Tier3Options = {},
  ) {
    this.namespace = namespaceFor("region_image", imageEmbedder);
    this.topN = opts.topN ?? 20;
  }

  async retrieveRegions(query: Query, frameIds: string[]): Promise<RegionHit[]> {
    if (frameIds.length === 0) return [];
    const scope = new Set(frameIds);
    const hits = new Map<string, RegionHit>();

    const add = (region: RegionRow, how: "ann" | "fts", distance?: number) => {
      const existing = hits.get(region.id);
      if (existing) {
        if (!existing.matchedBy.includes(how)) existing.matchedBy.push(how);
        if (distance !== undefined && existing.distance === undefined) existing.distance = distance;
        return;
      }
      hits.set(region.id, {
        regionId: region.id,
        frameId: region.frameId,
        bbox: { x: region.x, y: region.y, w: region.w, h: region.h },
        role: region.role,
        label: region.label,
        matchedBy: [how],
        ...(distance !== undefined ? { distance } : {}),
      });
    };

    // Image ANN, pre-filtered to the frame scope.
    if (query.image) {
      const [vec] = await this.imageEmbedder.embedImages([query.image]);
      const annHits = await this.store.searchRegions(this.namespace, vec!, this.topN, { frameIds });
      for (const h of annHits) {
        const region = this.store.getRegion(h.id);
        if (region) add(region, "ann", h.distance);
      }
    }

    // AX-label FTS, then restricted to the frame scope.
    if (query.text && query.text.length > 0) {
      for (const id of this.store.ftsRegions(query.text, this.topN)) {
        const region = this.store.getRegion(id);
        if (region && scope.has(region.frameId)) add(region, "fts");
      }
    }

    // ANN-matched first (by distance), then FTS-only.
    return [...hits.values()].sort((a, b) => {
      const ad = a.distance ?? Infinity;
      const bd = b.distance ?? Infinity;
      return ad - bd;
    });
  }
}
