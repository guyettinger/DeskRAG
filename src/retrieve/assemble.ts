/**
 * Retriever — the coarse-to-fine capstone. One call runs every applicable tier,
 * always narrowing the scope, then assembles a final per-frame score:
 *
 *   score = w1·frame + w2·topK-mean(region hits) + w3·segment
 *
 * and returns `highlights` (matched region bboxes + labels) per recalled frame —
 * so the UI can outline WHERE on the frame the match is.
 *
 Query modes:
 *   - with a patch embedder: Tier1 (if text/behavior) -> Tier2 late-interaction
 *     frames, scoped to those segments (else unscoped), for TEXT as well as
 *     image queries since one model embeds both -> Tier3 AX-label regions.
 *   - without one: Tier1 segments; frames recalled via segment membership, and
 *     Tier 3's AX-label FTS is the only per-frame evidence there is.
 *
 * Each score component is max-normalized across the candidates so the weights are
 * comparable despite RRF scores and ANN distances living on different scales.
 */

import type { MultiVectorProvider, QueryEmbedding } from "../embed/types.js";
import type { FrameRow, Store } from "../store/types.js";
import { Tier1Retriever } from "./retriever.js";
import { Tier2MultiVectorRetriever } from "./tier2-mv.js";
import { Tier3Retriever } from "./tier3.js";
import type { Reranker, RerankCandidate } from "./rerank/types.js";
import type {
  AssembledResult,
  FrameHit,
  FrameResult,
  LexicalSearcher,
  Query,
  RegionHit,
  RetrieverWeights,
  SegmentHit,
  Tier1Options,
  ViewSearcher,
} from "./types.js";

/** How wide each tier casts and how the per-tier scores are combined. */
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
  /**
   * Multivector path only: how many of the returned frames get highlight boxes.
   * Each one costs a patch-set read, and the UI outlines one frame at a time.
   */
  highlightTopN?: number;
}

const DEFAULT_WEIGHTS: RetrieverWeights = { frame: 1, region: 0.5, segment: 0.5 };

/**
 * The coarse-to-fine capstone: one `retrieve()` call runs every applicable tier,
 * narrowing scope at each step, and returns ranked frames with `highlights`.
 *
 * Its `searchers` may only name namespaces present in `store.listVectorSpaces()` —
 * `searchSegments` throws otherwise, and caption/transcript spaces don't exist
 * until something has been indexed with those providers.
 */
/**
 * Drop a hit that is an ancestor or a descendant of a better-ranked one.
 *
 * A parent's span contains its children's, so Tier 1 returns a task AND several
 * of its actions as separate results — the very redundancy the compositional
 * hierarchy exists to remove, reproduced one layer up in the result list. A
 * moment belongs to ONE place in the tree, so the better-ranked hit keeps it.
 *
 * `hits` must be best-first. SIBLINGS are untouched: two siblings are two
 * answers, not one.
 *
 * Pure, and takes the tree as a callback, so it is testable without a store.
 */
export function collapseAncestors<T extends { segmentId: string }>(
  hits: readonly T[],
  childrenOf: (id: string) => string[],
): T[] {
  const descendantsOf = (id: string): Set<string> => {
    const out = new Set<string>();
    const stack = [...childrenOf(id)];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (out.has(cur)) continue;
      out.add(cur);
      stack.push(...childrenOf(cur));
    }
    return out;
  };

  const kept: T[] = [];
  const covered = new Set<string>();
  for (const hit of hits) {
    // Already claimed by a better-ranked ANCESTOR.
    if (covered.has(hit.segmentId)) continue;
    // Or is itself an ancestor of one — a descendant ranked higher wins, because
    // it is the more specific answer to the same query.
    if (kept.some((k) => descendantsOf(hit.segmentId).has(k.segmentId))) continue;
    kept.push(hit);
    for (const d of descendantsOf(hit.segmentId)) covered.add(d);
  }
  return kept;
}

export class Retriever {
  private readonly tier1: Tier1Retriever;
  private readonly tier3: Tier3Retriever;
  /** The visual path. Absent when no image provider is configured. */
  private readonly tier2mv: Tier2MultiVectorRetriever | undefined;
  private readonly weights: RetrieverWeights;
  private readonly segmentScope: number;
  private readonly regionTopK: number;
  private readonly finalTopN: number;
  private readonly reranker: Reranker | undefined;
  private readonly rerankTopN: number;
  private readonly highlightTopN: number;

  constructor(
    private readonly store: Store,
    config: {
      searchers: ViewSearcher[];
      /** The visual path. Omit for the DEFAULT configuration, which has none. */
      patchEmbedder?: MultiVectorProvider;
      /**
       * Optional lexical lane fused into Tier 1 alongside the dense views.
       * Needs no provider, so unlike everything else here it is always
       * available — see LexicalSegmentSearcher.
       */
      lexical?: LexicalSearcher;
    },
    opts: RetrieverOptions = {},
  ) {
    this.tier1 = new Tier1Retriever(store, config.searchers, {
      ...opts.tier1,
      ...(config.lexical ? { lexical: config.lexical } : {}),
    });
    // Tier 3 ALWAYS exists, and needs no provider: its AX-label FTS is, for a
    // text query, the only per-frame evidence in the system. Without it, frames
    // recalled by segment membership carry no distance and every frame sharing a
    // segment scores identically — measured, one query returned 11 frames tied
    // to six decimal places.
    this.tier3 = new Tier3Retriever(store, {
      ...(opts.regionTopN !== undefined ? { topN: opts.regionTopN } : {}),
    });
    if (config.patchEmbedder) {
      this.tier2mv = new Tier2MultiVectorRetriever(store, config.patchEmbedder, {
        ...(opts.frameTopN !== undefined ? { topN: opts.frameTopN } : {}),
      });
    }
    this.weights = opts.weights ?? DEFAULT_WEIGHTS;
    this.segmentScope = opts.segmentScope ?? 50;
    this.regionTopK = opts.regionTopK ?? 3;
    this.finalTopN = opts.finalTopN ?? 30;
    this.reranker = opts.reranker;
    this.rerankTopN = opts.rerankTopN ?? 10;
    this.highlightTopN = opts.highlightTopN ?? 10;
  }

  async retrieve(query: Query): Promise<AssembledResult> {
    // Tier 1 — coarse segment scope (text/behavioral views).
    const raw: SegmentHit[] =
      query.text || query.behavior ? (await this.tier1.retrieve(query)).segments : [];
    // A parent's span CONTAINS its children's, so Tier 1 happily returns a task
    // and three of its own actions as separate results — the redundancy the
    // hierarchy exists to remove, reproduced in the result list.
    const t1 = collapseAncestors(raw, (id) => this.store.getSegmentChildren(id));
    const segScore = new Map(t1.map((s) => [s.segmentId, s.score]));
    // EXPAND TO LEAVES for the frame scope. Frame vectors denormalize
    // `segment_ids` at represent time, long before composing runs, so a composed
    // level can never appear in that field: scoping a parent hit directly
    // matches ZERO frames and returns empty with no error at all — the same
    // silent shape as the frame<->segment bug. A leaf resolves to itself, so
    // this path needs no special case.
    const segScope = [
      ...new Set(
        t1
          .slice(0, this.segmentScope)
          .flatMap((s) => this.store.getDescendantLeaves(s.segmentId)),
      ),
    ];

    // Tier 2 — recall frames. On the multivector path the query is embedded ONCE
    // here and reused for highlights: embedding costs a vision forward pass.
    const queryVectors = this.tier2mv ? await this.tier2mv.embedQuery(query) : null;
    const frameHits = await this.recallFrames(query, segScope, queryVectors);

    // Tier 3 — region evidence per recalled frame. Runs for a TEXT query as
    // well as an image one: the AX-label half is the only thing that can tell
    // two frames of the same segment apart, and it is also what puts highlights
    // on a text result at all (they used to be image-query-only, leaving 1,153
    // labelled regions unreachable from the search box).
    const frameIds = frameHits.map((f) => f.frameId);
    const regionHits =
      query.text && frameIds.length > 0
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

    // Highlights last on the multivector path: presentation only, and each one
    // costs a patch-set read, so only the frames actually shown pay for it.
    if (this.tier2mv && queryVectors) {
      frames = await this.attachPatchHighlights(frames, queryVectors);
    }
    return { segments: t1, frames };
  }

  private async attachPatchHighlights(
    frames: FrameResult[],
    queryVectors: QueryEmbedding,
  ): Promise<FrameResult[]> {
    const out = [...frames];
    for (let i = 0; i < Math.min(this.highlightTopN, out.length); i++) {
      const f = out[i]!;
      const frame = f.frame ?? this.store.getFrame(f.frameId);
      if (!frame) continue;
      const patches = await this.tier2mv!.highlightsForFrame(
        f.frameId,
        queryVectors,
        frame.width,
        frame.height,
      );
      // APPENDED, not substituted. Patch highlights are synthetic tiles with no
      // label; Tier 3's are real `region` rows carrying an AX role and label.
      // Overwriting dropped every named highlight on this path, which is the
      // only path that can say WHAT the outlined thing is called.
      out[i] = { ...f, highlights: [...f.highlights, ...patches] };
    }
    return out;
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

  private async recallFrames(
    query: Query,
    segScope: string[],
    queryVectors: QueryEmbedding | null,
  ): Promise<FrameHit[]> {
    // Multivector: serves TEXT as well as image, since one model embeds both.
    if (this.tier2mv && queryVectors) {
      return segScope.length > 0
        ? this.tier2mv.retrieveFrames(queryVectors.vectors, segScope)
        : this.tier2mv.retrieveFramesUnscoped(queryVectors.vectors);
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
    // Frame distances are turned into scores by rank position within the
    // candidate set, NOT by a fixed 1/(1+d) transform.
    //
    // 1/(1+d) assumes d >= 0, which holds for L2 and single-vector cosine
    // distance but NOT for multivector MaxSim: LanceDB returns a negated
    // similarity, so d sits around -1 and 1/(1+d) explodes through a pole —
    // observed producing scores near -1e8 that happened to stay correctly
    // ordered by luck. Rank position is monotone in distance for every metric
    // and has no pole.
    const finite = frameHits.filter((f) => !Number.isNaN(f.distance)).map((f) => f.distance);
    const minD = finite.length ? Math.min(...finite) : 0;
    const maxD = finite.length ? Math.max(...finite) : 0;
    const spread = maxD - minD;
    const frameScoreOf = (d: number): number => {
      if (Number.isNaN(d)) return 0; // recalled by segment membership, not ANN
      if (spread <= 0) return 1; // single candidate, or all tied
      return (maxD - d) / spread; // 1 = nearest, 0 = furthest
    };

    // Raw components per frame.
    const raw = frameHits.map((fh) => {
      const regions = regionsByFrame.get(fh.frameId) ?? [];
      // An FTS-only hit scores by its bm25 RANK, not a flat constant. The
      // constant said only "something here matched", so every frame containing
      // any matching label scored identically — precisely the tie this tier is
      // supposed to break.
      const regionScores = regions
        .map((r) =>
          r.distance !== undefined
            ? 1 / (1 + r.distance)
            : r.ftsRank !== undefined
              ? 1 / r.ftsRank
              : 0,
        )
        .sort((a, b) => b - a)
        .slice(0, this.regionTopK);
      // Divided by regionTopK, NOT by how many hits there were. Dividing by the
      // count made a frame with one strong match and two weak ones score BELOW
      // a frame with only the strong one — adding evidence lowered the score.
      // Padding to K makes the measure monotone: another match never hurts.
      const regionScore = regionScores.reduce((s, v) => s + v, 0) / this.regionTopK;
      const frameScore = frameScoreOf(fh.distance);
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

    // Ties are REAL and are left as ties — frames with no region match and one
    // shared segment are genuinely equal on every signal we have. What they
    // must not be is arbitrarily ordered, so the tie-break is explicit: earlier
    // frame first. It relied on Map insertion order plus V8's stable sort
    // before, which is true today and is not a property to depend on. A frame
    // id is a ULID and therefore already time-ordered, so it carries the same
    // meaning when a row was not hydrated.
    results.sort(
      (a, b) =>
        b.score - a.score ||
        (a.frame?.tMono ?? 0) - (b.frame?.tMono ?? 0) ||
        (a.frameId < b.frameId ? -1 : a.frameId > b.frameId ? 1 : 0),
    );
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
