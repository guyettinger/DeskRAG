/**
 * Tier-2 over the late-interaction `frame_patches` space.
 *
 * Differs from Tier2Retriever in three ways that matter:
 *
 *  - it serves TEXT queries as well as image queries, because one model embeds
 *    both into the same space, so text reaches frames directly;
 *  - highlights fall out of the CONTENT vectors' similarity map rather than a
 *    separate region ANN — the patches ARE the regions, so there is no Tier 3
 *    on this path;
 *  - query embedding is EXPLICIT rather than hidden inside retrieve*(). Embedding
 *    a query costs a vision forward pass (the graph requires pixel inputs even
 *    for text), so the caller embeds once and passes the vectors to both the
 *    search and the highlight step.
 *
 * Barrel-safe: the provider is injected, so no native module loads here.
 */

import type { MultiVectorProvider, QueryEmbedding } from "../embed/types.js";
import { namespaceFor } from "../embed/types.js";
import {
  cellToBox,
  computeTileGeometry,
  gridTokenCount,
  patchIndexToCell,
} from "../embed/onnx/geometry.js";
import type { Store } from "../store/types.js";
import type { FrameHit, Query, RegionHit } from "./types.js";

export interface Tier2MultiVectorOptions {
  topN?: number;
  hydrate?: boolean;
  /** Upper bound on highlight boxes per frame, counted AFTER merging. */
  maxHighlights?: number;
  /** Keep patches scoring at least this fraction of the frame's best patch. */
  relativeFloor?: number;
  /** Draw nothing at all when the frame's best patch scores below this. */
  minScore?: number;
}

/**
 * Keep a patch scoring at least this fraction of the frame's best.
 *
 * MEASURED 2026-08-14 by `npm run probe:highlight` over 10 known-answer queries
 * on 6 real frames across 6 applications (Obsidian, Calculator, TextEdit,
 * Terminal, WebStorm, Chrome — `scripts/highlight-cases.json`), ColModernVBERT:
 *
 *   floor  boxes  on-answer  queries answered
 *   0.60      76         17   9/10
 *   0.70      68         15   8/10
 *   0.75      61         13   8/10
 *   0.80      51         11   8/10     <- the knee
 *   0.85      41         10   7/10
 *   0.90      28          8   5/10
 *
 * 0.80 answers as many queries as 0.70 while drawing 25% fewer boxes; 0.85
 * costs a query and 0.90 costs half of them. On the reported frame it boxes the
 * `mcp` tab title, `probe:mcp` inside the shell command and the `mcp` sidebar
 * entry — the three obvious answers — plus two on blank space.
 *
 * DISCLOSED, because it is what these numbers say: only about a fifth of the
 * boxes fall inside the hand-drawn answer at ANY floor (22% at 0.80, 29% at
 * 0.90). A patch map attends broadly, and a floor cannot make it precise — what
 * this constant buys is fewer, merged, ranked boxes, not a tight one.
 *
 * NOT measured: ColSmol (its table in the test library has zero rows, so
 * measuring it needs a full re-index) and image queries, whose 832 content
 * vectors are a different regime entirely.
 */
const DEFAULT_RELATIVE_FLOOR = 0.8;

/**
 * A frame whose best patch scores at or below this claims nothing rather than
 * outlining its least-bad cell. Zero also handles a negative best similarity,
 * where a relative floor is meaningless (0.8 x a negative number is LARGER).
 */
const DEFAULT_MIN_SCORE = 0;

export class Tier2MultiVectorRetriever {
  readonly namespace: string;
  private readonly topN: number;
  private readonly hydrate: boolean;
  private readonly maxHighlights: number;
  private readonly relativeFloor: number;
  private readonly minScore: number;

  constructor(
    private readonly store: Store,
    private readonly provider: MultiVectorProvider,
    opts: Tier2MultiVectorOptions = {},
  ) {
    this.namespace = namespaceFor("frame_patches", provider);
    this.topN = opts.topN ?? 30;
    this.hydrate = opts.hydrate ?? true;
    this.maxHighlights = opts.maxHighlights ?? 8;
    this.relativeFloor = opts.relativeFloor ?? DEFAULT_RELATIVE_FLOOR;
    this.minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
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
   * Highlight boxes for one frame: a similarity map over the frame's GRID
   * patches, cut at a floor and merged into contiguous regions.
   *
   * Only the query's CONTENT vectors score the map. One box per query vector's
   * argmax was the shipped rule, and for "probe mcp" that drew seven boxes from
   * fifteen vectors of which twelve were [CLS], [SEP] and buffer padding —
   * [CLS] scoring 0.992 against blank document space and therefore ranking
   * FIRST. Scoring still uses every vector; see QueryEmbedding.
   *
   * Reads the frame's stored patch set rather than re-embedding it.
   */
  async highlightsForFrame(
    frameId: string,
    query: QueryEmbedding,
    width: number,
    height: number,
  ): Promise<RegionHit[]> {
    if (query.contentIndices.length === 0 || width <= 0 || height <= 0) return [];
    const patches = await this.store.getFramePatches(this.namespace, frameId);
    if (!patches || patches.length === 0) return [];
    return this.highlightsFrom(frameId, query, patches, width, height);
  }

  /** Pure part of the above, separated so it is testable without a store. */
  highlightsFrom(
    frameId: string,
    query: QueryEmbedding,
    patches: Float32Array[],
    width: number,
    height: number,
  ): RegionHit[] {
    if (width <= 0 || height <= 0) return [];
    const content = query.contentIndices
      .map((i) => query.vectors[i])
      .filter((v): v is Float32Array => v !== undefined);
    if (content.length === 0) return [];

    const geo = computeTileGeometry(width, height);
    // GRID patches only. A global-tile token covers the whole frame — true, and
    // useless as a highlight — so it is excluded from the map rather than
    // dropped after the cap, where it silently cost a box.
    const gridCount = Math.min(gridTokenCount(geo), patches.length);
    if (gridCount === 0) return [];

    const score = new Float64Array(gridCount);
    let top = -Infinity;
    for (let p = 0; p < gridCount; p++) {
      let best = -Infinity;
      for (const q of content) best = Math.max(best, dot(q, patches[p]!));
      score[p] = best;
      if (best > top) top = best;
    }
    if (!Number.isFinite(top) || top <= this.minScore) return [];

    const floor = this.relativeFloor * top;
    // Cell key -> patch index, walked in index order so components and the ids
    // derived from them are discovered deterministically.
    const kept = new Map<string, number>();
    for (let p = 0; p < gridCount; p++) {
      if (score[p]! < floor) continue;
      const cell = patchIndexToCell(p, geo);
      if (cell) kept.set(`${cell.col},${cell.row}`, p);
    }

    const seen = new Set<string>();
    const hits: RegionHit[] = [];
    for (const [key, index] of kept) {
      if (seen.has(key)) continue;
      seen.add(key);
      // 4-connected flood fill: one box per contiguous run of kept cells, so a
      // phrase the model attended to across several patches reads as ONE
      // highlight rather than a scatter of 80x60 tiles.
      const stack = [key];
      const members = [index];
      while (stack.length > 0) {
        const [col, row] = stack.pop()!.split(",").map(Number) as [number, number];
        for (const [dc, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nk = `${col + dc},${row + dr}`;
          const ni = kept.get(nk);
          if (ni === undefined || seen.has(nk)) continue;
          seen.add(nk);
          stack.push(nk);
          members.push(ni);
        }
      }

      const boxes = members.map((m) => cellToBox(patchIndexToCell(m, geo)!, geo));
      const x = Math.min(...boxes.map((b) => b.x));
      const y = Math.min(...boxes.map((b) => b.y));
      const bestSim = Math.max(...members.map((m) => score[m]!));
      hits.push({
        // Synthetic: no `region` row backs a patch. AX-label FTS still
        // contributes real, labelled regions on the cloud path.
        regionId: `${frameId}#p${Math.min(...members)}`,
        frameId,
        bbox: {
          x,
          y,
          w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
          h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
        },
        role: null,
        label: null,
        matchedBy: ["ann"],
        distance: 1 - bestSim,
        strength: bestSim / top,
      });
    }

    return hits
      .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
      .slice(0, this.maxHighlights);
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
