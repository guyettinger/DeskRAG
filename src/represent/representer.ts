/**
 * Representer — builds the event-only per-segment views (digest text + behavioral
 * vector) for a session and persists them. This is the first pipeline stage that
 * writes vectors for existing segments, exercising the dual-store enrich path:
 * updateSegment (digest text -> SQLite) BEFORE putSegmentVectors (vectors ->
 * Lance), so a crash in between leaves a re-embeddable gap that reconcile()
 * recovers from the persisted digest text.
 *
 * Frame-dependent views (captions, keyframe image, regions) are added later once
 * capture produces frames; they slot in alongside these without changing this.
 */

import type { EmbeddingProvider } from "../embed/types.js";
import { namespaceFor } from "../embed/types.js";
import type { Store, SegmentVectorInsert } from "../store/types.js";
import { buildDigest, type DigestContext, type DigestEvent } from "./digest.js";
import { BehaviorFeatureExtractor, type BehaviorEvent } from "./behavior.js";
import { typedRuns, typedTextOverlapping } from "./typed-runs.js";
import type { TraceEvent } from "../trace/types.js";

/** The providers backing the event-only views. `behavior` defaults to a fresh extractor. */
export interface RepresenterOptions {
  digestEmbedder: EmbeddingProvider;
  behavior?: BehaviorFeatureExtractor;
  /**
   * The world the digest resolves typed text and clicked labels against.
   * Injected for the same reason `LiftInput` injects its environment callbacks:
   * keeps `represent/` from parsing event payload shapes or hit-testing against
   * the store. Omitted means a tally-only digest — never a guess.
   */
  digestContext?: DigestContext;
  /** Called with the segments finished so far. */
  onProgress?: (done: number, total: number) => void;
}

/** What was written, and into which namespaces. */
export interface RepresentResult {
  segmentCount: number;
  digestNamespace: string;
  behaviorNamespace: string;
}

/**
 * Builds the event-only per-segment views — digest text and the behavioral vector —
 * and persists them, text to SQLite before vectors to Lance so a crash between the
 * two leaves a gap `reconcile()` can refill.
 */
export class Representer {
  private readonly digestEmbedder: EmbeddingProvider;
  private readonly behavior: BehaviorFeatureExtractor;
  private readonly digestContext: DigestContext;
  private readonly onProgress: ((done: number, total: number) => void) | undefined;
  readonly digestNamespace: string;
  readonly behaviorNamespace: string;
  private spacesReady = false;

  constructor(
    private readonly store: Store,
    opts: RepresenterOptions,
  ) {
    this.digestEmbedder = opts.digestEmbedder;
    this.behavior = opts.behavior ?? new BehaviorFeatureExtractor();
    this.digestContext = opts.digestContext ?? {};
    this.onProgress = opts.onProgress;
    this.digestNamespace = namespaceFor("digest", this.digestEmbedder);
    this.behaviorNamespace = namespaceFor("behavior", this.behavior);
  }

  /** Register the two namespaces (idempotent). */
  async ensureSpaces(): Promise<void> {
    if (this.spacesReady) return;
    await this.store.registerVectorSpace({
      namespace: this.digestNamespace,
      view: "digest",
      providerId: this.digestEmbedder.id,
      model: this.digestEmbedder.model,
      dimensions: this.digestEmbedder.dimensions,
      sharedTextSpace: false,
    });
    await this.store.registerVectorSpace({
      namespace: this.behaviorNamespace,
      view: "behavior",
      providerId: this.behavior.id,
      model: this.behavior.model,
      dimensions: this.behavior.dimensions,
      sharedTextSpace: this.behavior.sharedTextSpace,
    });
    this.spacesReady = true;
  }

  async represent(sessionId: string): Promise<RepresentResult> {
    await this.ensureSpaces();
    const segments = this.store.getSegmentsBySession(sessionId);
    const events = this.store.getEventsBySession(sessionId);
    if (segments.length === 0) {
      return {
        segmentCount: 0,
        digestNamespace: this.digestNamespace,
        behaviorNamespace: this.behaviorNamespace,
      };
    }

    const sessionEnd = Math.max(...segments.map((s) => s.tMonoEnd));

    // Typing runs are coalesced ONCE, over the whole session. Per segment they
    // would be shredded: `action` cuts at every visual state change and typing
    // is one, so a sentence lands in five segments as five fragments and the
    // phrase exists in none of them.
    const runs = this.digestContext.keymapAt
      ? typedRuns(events as unknown as TraceEvent[], this.digestContext.keymapAt)
      : [];
    const digestContext: DigestContext = {
      ...this.digestContext,
      typedTextAt: (start, end) => typedTextOverlapping(runs, start, end),
    };

    const digestTexts: string[] = [];
    const digestSegIds: string[] = [];
    const behaviorRows: SegmentVectorInsert[] = [];

    for (const [i, seg] of segments.entries()) {
      this.onProgress?.(i, segments.length);
      // Events in [start, end); the final segment includes an event sitting
      // exactly on the session end so nothing is dropped at the right edge.
      const inclusiveRight = seg.tMonoEnd === sessionEnd;
      const segEvents = events.filter(
        (e) =>
          e.tMono >= seg.tMonoStart &&
          (inclusiveRight ? e.tMono <= seg.tMonoEnd : e.tMono < seg.tMonoEnd),
      );

      const digest = buildDigest(segEvents as DigestEvent[], digestContext, {
        tMonoStart: seg.tMonoStart,
        tMonoEnd: seg.tMonoEnd,
      });
      const bvec = this.behavior.extract(segEvents as BehaviorEvent[], {
        tMonoStart: seg.tMonoStart,
        tMonoEnd: seg.tMonoEnd,
      });

      // SQLite text first (so the vector is re-embeddable after a crash).
      await this.store.updateSegment(seg.id, { digest });

      digestTexts.push(digest);
      digestSegIds.push(seg.id);
      behaviorRows.push({
        segmentId: seg.id,
        sessionId,
        namespace: this.behaviorNamespace,
        vector: bvec,
      });
    }
    this.onProgress?.(segments.length, segments.length);

    // Batch-embed all digests, then write digest + behavior vectors to Lance.
    const digestVecs = await this.digestEmbedder.embed(digestTexts);
    const digestRows: SegmentVectorInsert[] = digestSegIds.map((id, i) => ({
      segmentId: id,
      sessionId,
      namespace: this.digestNamespace,
      vector: digestVecs[i]!,
    }));
    // REPLACE, not add: this stage re-runs whenever the library is re-indexed
    // (a changed digest has to be re-embedded), and a bare add would leave two
    // vectors under one id in one namespace — undetectable, since both have a
    // live SQLite row, so reconcile() would never prune either.
    await this.store.replaceSegmentVectors([...digestRows, ...behaviorRows]);

    return {
      segmentCount: segments.length,
      digestNamespace: this.digestNamespace,
      behaviorNamespace: this.behaviorNamespace,
    };
  }
}
