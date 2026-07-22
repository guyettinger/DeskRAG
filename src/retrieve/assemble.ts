/**
 * Retriever — the coarse-to-fine capstone. One call runs every applicable tier,
 * always narrowing the scope, then assembles a final per-frame score:
 *
 *   score = w1·frame + w2·topK-mean(region hits) + w3·segment
 *
 * and returns `highlights` (matched region bboxes + labels) per recalled frame —
 * so the UI can outline WHERE on the frame the match is.
 *
 * Query modes:
 *   - visual (image [+ text/behavior]): Tier1 (if text/behavior) -> Tier2 frames
 *     (scoped to those segments, else unscoped) -> Tier3 regions per frame.
 *   - text/behavioral only: Tier1 segments; frames recalled via segment membership
 *     (no visual ANN, so no highlights).
 *
 * Each score component is max-normalized across the candidates so the weights are
 * comparable despite RRF scores and ANN distances living on different scales.
 */

import type { ImageEmbeddingProvider } from "../embed/types.js";
import type { FrameRow, Store } from "../store/types.js";
import { Tier1Retriever } from "./retriever.js";
import { Tier2Retriever } from "./tier2.js";
import { Tier3Retriever } from "./tier3.js";
import type { Reranker, RerankCandidate } from "./rerank/types.js";
import type {
  AssembledResult,
  FrameHit,
  FrameResult,
  Query,
  RegionHit,
  RetrieverWeights,
  SegmentHit,
  Tier1Options,
  ViewSearcher,
} from "./types.js";

export interface RetrieverOptions {
  weights?: RetrieverWeights;
  tier1?: Tier1Options;
  /** Segments from Tier 1 used as the frame scope. */
  segmentScope?: number;
  /** Frames pulled from Tier 2. */
  frameTopN?: number;
  /** Regions pulled from Tier 3 (per frame set). */
  regionTopN?: number;
  /** K for the top-K mean of region scores per frame. */
  regionTopK?: number;
  /** Frames returned. */
  finalTopN?: number;
  /** Optional Tier-4 LLM reranker (applied to NL/text queries only). */
  reranker?: Reranker;
  /** Frames handed to the reranker (top of the assembled list). */
  rerankTopN?: number;
}

const DEFAULT_WEIGHTS: RetrieverWeights = { frame: 1, region: 0.5, segment: 0.5 };
/** Score assigned to an FTS-only region hit (no ANN distance). */
const FTS_ONLY_SCORE = 0.5;

export class Retriever {
  private readonly tier1: Tier1Retriever;
  private readonly tier2: Tier2Retriever;
  private readonly tier3: Tier3Retriever;
  private readonly weights: RetrieverWeights;
  private readonly segmentScope: number;
  private readonly regionTopK: number;
  private readonly finalTopN: number;
  private readonly reranker: Reranker | undefined;
  private readonly rerankTopN: number;

  constructor(
    private readonly store: Store,
    config: {
      searchers: ViewSearcher[];
      imageEmbedder: ImageEmbeddingProvider;
    },
    opts: RetrieverOptions = {},
  ) {
    this.tier1 = new Tier1Retriever(store, config.searchers, opts.tier1);
    this.tier2 = new Tier2Retriever(store, config.imageEmbedder, {
      ...(opts.frameTopN !== undefined ? { topN: opts.frameTopN } : {}),
    });
    this.tier3 = new Tier3Retriever(store, config.imageEmbedder, {
      ...(opts.regionTopN !== undefined ? { topN: opts.regionTopN } : {}),
    });
    this.weights = opts.weights ?? DEFAULT_WEIGHTS;
    this.segmentScope = opts.segmentScope ?? 50;
    this.regionTopK = opts.regionTopK ?? 3;
    this.finalTopN = opts.finalTopN ?? 30;
    this.reranker = opts.reranker;
    this.rerankTopN = opts.rerankTopN ?? 10;
  }

  async retrieve(query: Query): Promise<AssembledResult> {
    // Tier 1 — coarse segment scope (text/behavioral views).
    const t1: SegmentHit[] =
      query.text || query.behavior ? (await this.tier1.retrieve(query)).segments : [];
    const segScore = new Map(t1.map((s) => [s.segmentId, s.score]));
    const segScope = t1.slice(0, this.segmentScope).map((s) => s.segmentId);

    // Tier 2 — recall frames.
    const frameHits = await this.recallFrames(query, segScope);

    // Tier 3 — region highlights per recalled frame (visual queries only).
    const frameIds = frameHits.map((f) => f.frameId);
    const regionHits =
      query.image && frameIds.length > 0
        ? await this.tier3.retrieveRegions(query, frameIds)
        : [];
    const regionsByFrame = new Map<string, RegionHit[]>();
    for (const r of regionHits) {
      (regionsByFrame.get(r.frameId) ?? regionsByFrame.set(r.frameId, []).get(r.frameId)!).push(r);
    }

    let frames = this.assemble(frameHits, regionsByFrame, segScore);

    // Tier 4 — optional LLM rerank of the top frames for fuzzy NL queries.
    // Skipped for fast visual queries (no query text).
    if (this.reranker && query.text && frames.length > 1) {
      frames = await this.rerank(query.text, frames);
    }
    return { segments: t1, frames };
  }

  private async rerank(query: string, frames: FrameResult[]): Promise<FrameResult[]> {
    const head = frames.slice(0, this.rerankTopN);
    const tail = frames.slice(this.rerankTopN);
    const candidates: RerankCandidate[] = head.map((f) => {
      const digest = f.segmentId ? (this.store.getSegment(f.segmentId)?.digest ?? "") : "";
      const labels = f.highlights.map((h) => h.label).filter((l): l is string => !!l);
      return { id: f.frameId, text: `${digest} regions: ${labels.join(", ")}`.trim() };
    });
    const order = await this.reranker!.rerank(query, candidates);
    const byId = new Map(head.map((f) => [f.frameId, f]));
    const reordered = order.map((id) => byId.get(id)).filter((f): f is FrameResult => !!f);
    // Any head frame the reranker dropped is appended, then the untouched tail.
    for (const f of head) if (!order.includes(f.frameId)) reordered.push(f);
    return [...reordered, ...tail];
  }

  private async recallFrames(query: Query, segScope: string[]): Promise<FrameHit[]> {
    if (query.image) {
      return segScope.length > 0
        ? this.tier2.retrieveFrames(query, segScope)
        : this.tier2.retrieveFramesUnscoped(query);
    }
    if (segScope.length > 0) {
      // Non-visual: recall the frames belonging to the scoped segments (dedup).
      const seen = new Map<string, FrameRow>();
      for (const segId of segScope) {
        for (const f of this.store.getFramesBySegment(segId)) seen.set(f.id, f);
      }
      return [...seen.values()].map((frame) => ({ frameId: frame.id, distance: Number.NaN, frame }));
    }
    return [];
  }

  private assemble(
    frameHits: FrameHit[],
    regionsByFrame: Map<string, RegionHit[]>,
    segScore: Map<string, number>,
  ): FrameResult[] {
    // Raw components per frame.
    const raw = frameHits.map((fh) => {
      const regions = regionsByFrame.get(fh.frameId) ?? [];
      const regionScores = regions
        .map((r) => (r.distance !== undefined ? 1 / (1 + r.distance) : FTS_ONLY_SCORE))
        .sort((a, b) => b - a)
        .slice(0, this.regionTopK);
      const regionScore = regionScores.length
        ? regionScores.reduce((s, v) => s + v, 0) / regionScores.length
        : 0;
      const frameScore = Number.isNaN(fh.distance) ? 0 : 1 / (1 + fh.distance);
      const best = this.bestSegment(fh, segScore);
      return {
        fh,
        regions,
        frameScore,
        regionScore,
        segmentScore: best ? (segScore.get(best) ?? 0) : 0,
        segmentId: best,
      };
    });

    const maxFrame = Math.max(1e-9, ...raw.map((r) => r.frameScore));
    const maxRegion = Math.max(1e-9, ...raw.map((r) => r.regionScore));
    const maxSegment = Math.max(1e-9, ...raw.map((r) => r.segmentScore));
    const w = this.weights;

    const results: FrameResult[] = raw.map((r) => ({
      frameId: r.fh.frameId,
      score:
        w.frame * (r.frameScore / maxFrame) +
        w.region * (r.regionScore / maxRegion) +
        w.segment * (r.segmentScore / maxSegment),
      highlights: r.regions,
      ...(r.segmentId !== undefined ? { segmentId: r.segmentId } : {}),
      ...(Number.isNaN(r.fh.distance) ? {} : { frameDistance: r.fh.distance }),
      ...(r.fh.frame ? { frame: r.fh.frame } : {}),
    }));

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, this.finalTopN);
  }

  /**
   * The frame's containing segment with the highest Tier-1 score; ties (including
   * the no-signal case) break toward the MOST SPECIFIC (shortest) segment — the
   * action, not the enclosing task — since that's the better label/rerank context.
   */
  private bestSegment(fh: FrameHit, segScore: Map<string, number>): string | undefined {
    const ids = fh.frame?.segmentIds ?? [];
    if (ids.length === 0) return undefined;
    let best: string | undefined;
    let bestScore = -Infinity;
    let bestDuration = Infinity;
    for (const id of ids) {
      const s = segScore.get(id) ?? 0;
      const seg = this.store.getSegment(id);
      const duration = seg ? seg.tMonoEnd - seg.tMonoStart : Infinity;
      if (s > bestScore || (s === bestScore && duration < bestDuration)) {
        best = id;
        bestScore = s;
        bestDuration = duration;
      }
    }
    return best;
  }
}
