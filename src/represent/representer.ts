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
import { buildDigest, type DigestEvent } from "./digest.js";
import { BehaviorFeatureExtractor, type BehaviorEvent } from "./behavior.js";

export interface RepresenterOptions {
  digestEmbedder: EmbeddingProvider;
  behavior?: BehaviorFeatureExtractor;
}

export interface RepresentResult {
  segmentCount: number;
  digestNamespace: string;
  behaviorNamespace: string;
}

export class Representer {
  private readonly digestEmbedder: EmbeddingProvider;
  private readonly behavior: BehaviorFeatureExtractor;
  readonly digestNamespace: string;
  readonly behaviorNamespace: string;
  private spacesReady = false;

  constructor(
    private readonly store: Store,
    opts: RepresenterOptions,
  ) {
    this.digestEmbedder = opts.digestEmbedder;
    this.behavior = opts.behavior ?? new BehaviorFeatureExtractor();
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

    const digestTexts: string[] = [];
    const digestSegIds: string[] = [];
    const behaviorRows: SegmentVectorInsert[] = [];

    for (const seg of segments) {
      // Events in [start, end); the final segment includes an event sitting
      // exactly on the session end so nothing is dropped at the right edge.
      const inclusiveRight = seg.tMonoEnd === sessionEnd;
      const segEvents = events.filter(
        (e) =>
          e.tMono >= seg.tMonoStart &&
          (inclusiveRight ? e.tMono <= seg.tMonoEnd : e.tMono < seg.tMonoEnd),
      );

      const digest = buildDigest(segEvents as DigestEvent[]);
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

    // Batch-embed all digests, then write digest + behavior vectors to Lance.
    const digestVecs = await this.digestEmbedder.embed(digestTexts);
    const digestRows: SegmentVectorInsert[] = digestSegIds.map((id, i) => ({
      segmentId: id,
      sessionId,
      namespace: this.digestNamespace,
      vector: digestVecs[i]!,
    }));
    await this.store.putSegmentVectors([...digestRows, ...behaviorRows]);

    return {
      segmentCount: segments.length,
      digestNamespace: this.digestNamespace,
      behaviorNamespace: this.behaviorNamespace,
    };
  }
}
