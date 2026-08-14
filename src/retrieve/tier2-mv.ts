/**
 * Tier-2 over the late-interaction `frame_patches` space.
 *
 * Differs from Tier2Retriever in three ways that matter:
 *
 *  - it serves TEXT queries as well as image queries, because one model embeds
 *    both into the same space, so text reaches frames directly;
 *  - highlights fall out of the MaxSim argmax rather than a separate region ANN —
 *    the patches ARE the regions, so there is no Tier 3 on this path;
 *  - query embedding is EXPLICIT rather than hidden inside retrieve*(). Embedding
 *    a query costs a vision forward pass (the graph requires pixel inputs even
 *    for text), so the caller embeds once and passes the vectors to both the
 *    search and the highlight step.
 *
 * Barrel-safe: the provider is injected, so no native module loads here.
 */

import type { MultiVectorProvider, QueryEmbedding } from "../embed/types.js";
import { namespaceFor } from "../embed/types.js";
import { computeTileGeometry, patchIndexToBox } from "../embed/onnx/geometry.js";
import type { Store } from "../store/types.js";
import type { FrameHit, Query, RegionHit } from "./types.js";

export interface Tier2MultiVectorOptions {
  topN?: number;
  hydrate?: boolean;
  /** Upper bound on highlight boxes per frame. */
  maxHighlights?: number;
}

export class Tier2MultiVectorRetriever {
  readonly namespace: string;
  private readonly topN: number;
  private readonly hydrate: boolean;
  private readonly maxHighlights: number;

  constructor(
    private readonly store: Store,
    private readonly provider: MultiVectorProvider,
    opts: Tier2MultiVectorOptions = {},
  ) {
    this.namespace = namespaceFor("frame_patches", provider);
    this.topN = opts.topN ?? 30;
    this.hydrate = opts.hydrate ?? true;
    this.maxHighlights = opts.maxHighlights ?? 8;
  }

  /**
   * Query vectors for either modality, or null when the query carries neither.
   * Call ONCE per retrieval: this is the expensive step.
   */
  async embedQuery(q: Query): Promise<QueryEmbedding | null> {
    if (q.image) {
      const [v] = await this.provider.embedImages([q.image]);
      if (!v || v.length === 0) return null;
      // An image query's vectors ARE patches of the query image, so all of them
      // carry content — there is no prompt padding on this branch.
      return { vectors: v, contentIndices: v.map((_, i) => i) };
    }
    if (q.text && q.text.length > 0) {
      const [e] = await this.provider.embedQueries([q.text]);
      return e && e.vectors.length > 0 ? e : null;
    }
    return null;
  }

  async retrieveFrames(
    queryVectors: Float32Array[],
    segmentIds: string[],
  ): Promise<FrameHit[]> {
    if (segmentIds.length === 0 || queryVectors.length === 0) return [];
    return this.hydrateHits(
      await this.store.searchFramePatches(this.namespace, queryVectors, this.topN, {
        segmentIds,
      }),
    );
  }

  async retrieveFramesUnscoped(queryVectors: Float32Array[]): Promise<FrameHit[]> {
    if (queryVectors.length === 0) return [];
    return this.hydrateHits(
      await this.store.searchFramePatches(this.namespace, queryVectors, this.topN),
    );
  }

  /**
   * Highlight boxes for one frame, from the MaxSim argmax: for each query vector,
   * the best-matching patch, mapped to frame coordinates.
   *
   * Reads the frame's stored patch set rather than re-embedding it.
   */
  async highlightsForFrame(
    frameId: string,
    queryVectors: Float32Array[],
    width: number,
    height: number,
  ): Promise<RegionHit[]> {
    if (queryVectors.length === 0 || width <= 0 || height <= 0) return [];
    const patches = await this.store.getFramePatches(this.namespace, frameId);
    if (!patches || patches.length === 0) return [];
    return this.highlightsFrom(frameId, queryVectors, patches, width, height);
  }

  /** Pure part of the above, separated so it is testable without a store. */
  highlightsFrom(
    frameId: string,
    queryVectors: Float32Array[],
    patches: Float32Array[],
    width: number,
    height: number,
  ): RegionHit[] {
    const geo = computeTileGeometry(width, height);
    const best = new Map<number, number>(); // patch index -> best similarity

    for (const q of queryVectors) {
      let argmax = -1;
      let top = -Infinity;
      for (let p = 0; p < patches.length; p++) {
        const sim = dot(q, patches[p]!);
        if (sim > top) {
          top = sim;
          argmax = p;
        }
      }
      if (argmax < 0) continue;
      const prev = best.get(argmax);
      if (prev === undefined || top > prev) best.set(argmax, top);
    }

    const topSim = Math.max(...best.values());
    return [...best.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.maxHighlights)
      .flatMap(([index, sim]) => {
        const bbox = patchIndexToBox(index, geo);
        // The global tile's token covers the whole frame — true, but useless as a
        // highlight, so it is dropped rather than drawn over everything.
        if (!bbox || (bbox.w >= width && bbox.h >= height)) return [];
        return [
          {
            // Synthetic: no `regions` row backs a patch. AX-label FTS still
            // contributes real, labelled regions on the cloud path.
            regionId: `${frameId}#p${index}`,
            frameId,
            bbox,
            role: null,
            label: null,
            matchedBy: ["ann"] as ("ann" | "fts")[],
            distance: 1 - sim,
            strength: sim / topSim,
          } satisfies RegionHit,
        ];
      });
  }

  private hydrateHits(hits: { id: string; distance: number }[]): FrameHit[] {
    return hits.map((h) => {
      const frame = this.hydrate ? this.store.getFrame(h.id) : undefined;
      return { frameId: h.id, distance: h.distance, ...(frame ? { frame } : {}) };
    });
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let n = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) n += a[i]! * b[i]!;
  return n;
}
