/**
 * CaptionRepresenter (view 2) — the visual-semantic summary. For each segment,
 * sample a few of its keyframes, caption them with a VLM (passing the structured
 * digest as context), persist the caption text, and embed it into the caption
 * space. Mirrors the digest/behavior Representer: updateSegment (text -> SQLite)
 * BEFORE putSegmentVectors (vector -> Lance), so reconcile can re-embed a caption
 * from the persisted text after a crash.
 *
 * The caption becomes a Tier-1 text view: a TextViewSearcher(captionEmbedder,
 * "caption") lets NL queries hit it directly.
 */

import type { CaptionProvider, EmbeddingProvider } from "../../embed/types.js";
import { namespaceFor } from "../../embed/types.js";
import type { BlobStore } from "../../store/blob-store.js";
import type { SegmentVectorInsert, Store } from "../../store/types.js";
import { sample } from "../sample.js";
import type { ImageDownscaler } from "./downscale.js";

export interface CaptionRepresenterOptions {
  captioner: CaptionProvider;
  captionEmbedder: EmbeddingProvider;
  blobStore: BlobStore;
  /** Keyframes sampled per segment for captioning. */
  maxFramesPerSegment?: number;
  /**
   * Shrinks each keyframe on its way to the model, and only there — what is
   * stored is untouched.
   *
   * Optional, and ABSENCE PASSES THE ORIGINAL BYTES THROUGH, which is what this
   * stage did before the hook existed. That degradation is the right one: a
   * missing downscaler costs time, never a caption. See `downscale.ts` for why
   * the captioner needs its own width cap rather than a lower `imageMaxWidth`.
   */
  downscale?: ImageDownscaler;
  /**
   * Whether the segment starting at this `t_mono` belongs to something that is
   * NOT the work — in practice the recorder itself.
   *
   * THE RECORDER IS NOT PART OF THE WORK IT RECORDS, and captioning was the one
   * expensive stage still describing it. `liftTrace` has excluded it since the
   * `n0 — no state` root was removed; measured on the real store, captioning had
   * no equivalent and 114 of 367 captions described the DeskRAG window — 41 of 47
   * in one recording. That is not only wasted VLM time: `ComposeRepresenter`
   * builds its input from `s.caption ?? s.digest`, caption FIRST, so the
   * contamination climbed the ladder and three of eight composed roots named
   * recording rather than the calculator, the news and Spotify they were about.
   *
   * An excluded segment is skipped BEFORE any blob is read, so the saving is the
   * whole call and not just the model's share of it. It keeps `caption = null`
   * and composes from its digest, which is the fallback that was already there.
   *
   * The predicate is INJECTED, the same way `excludeFocusedApps` takes its rule:
   * `represent/` has never heard of any particular application, and the caller
   * holds the setting. Absent means exclude nothing.
   */
  isExcluded?: (tMonoStart: number) => boolean;
  /**
   * Called with the segments finished so far. A VLM call per segment is the
   * slowest stage in the whole pipeline — measured at 14m 16s on a real
   * recording — so this is the one that most needs surfacing.
   */
  onProgress?: (done: number, total: number) => void;
}

export interface CaptionRepresentResult {
  segmentCount: number;
  captionedCount: number;
  /**
   * Segments `isExcluded` skipped — the recorder's own stretches.
   *
   * Disclosure, not bookkeeping, and the same reason `ExcludeResult.dropped`
   * exists: a stage that quietly captions fewer frames than it was given is
   * indistinguishable on screen from one that is broken, which is the whole
   * class of bug `StageSpec.skipReason` was added for.
   */
  excludedCount: number;
  namespace: string;
}

export class CaptionRepresenter {
  private readonly captioner: CaptionProvider;
  private readonly captionEmbedder: EmbeddingProvider;
  private readonly blobStore: BlobStore;
  private readonly maxFrames: number;
  private readonly downscale: ImageDownscaler | undefined;
  private readonly isExcluded: ((tMonoStart: number) => boolean) | undefined;
  private readonly onProgress: ((done: number, total: number) => void) | undefined;
  readonly namespace: string;
  private spaceReady = false;

  constructor(
    private readonly store: Store,
    opts: CaptionRepresenterOptions,
  ) {
    this.captioner = opts.captioner;
    this.captionEmbedder = opts.captionEmbedder;
    this.blobStore = opts.blobStore;
    this.maxFrames = opts.maxFramesPerSegment ?? 3;
    this.downscale = opts.downscale;
    this.isExcluded = opts.isExcluded;
    this.onProgress = opts.onProgress;
    this.namespace = namespaceFor("caption", this.captionEmbedder);
  }

  async ensureSpace(): Promise<void> {
    if (this.spaceReady) return;
    await this.store.registerVectorSpace({
      namespace: this.namespace,
      view: "caption",
      providerId: this.captionEmbedder.id,
      model: this.captionEmbedder.model,
      dimensions: this.captionEmbedder.dimensions,
      sharedTextSpace: false,
    });
    this.spaceReady = true;
  }

  async represent(sessionId: string): Promise<CaptionRepresentResult> {
    await this.ensureSpace();
    const segments = this.store.getSegmentsBySession(sessionId);
    const frames = this.store.getFramesBySession(sessionId);
    if (segments.length === 0) {
      return { segmentCount: 0, captionedCount: 0, excludedCount: 0, namespace: this.namespace };
    }
    const sessionEnd = Math.max(...segments.map((s) => s.tMonoEnd), 0);

    const captions: string[] = [];
    const segIds: string[] = [];
    let excludedCount = 0;
    // Reported at the TOP as "segments finished before this one", with one final
    // call after the loop. Every other shape needs a call beside each `continue`
    // — there are three here now — and a fourth added later would silently stall
    // the meter on the exact segments that were cheapest to skip.
    for (const [i, seg] of segments.entries()) {
      this.onProgress?.(i, segments.length);
      // FIRST, before any blob is read: an excluded segment costs nothing at all,
      // which is the point. It keeps `caption = null` and composes from its digest.
      if (this.isExcluded?.(seg.tMonoStart) === true) {
        excludedCount++;
        continue;
      }
      const inclusiveRight = seg.tMonoEnd === sessionEnd;
      const segFrames = frames.filter(
        (f) =>
          f.blobId &&
          f.tMono >= seg.tMonoStart &&
          (inclusiveRight ? f.tMono <= seg.tMonoEnd : f.tMono < seg.tMonoEnd),
      );
      if (segFrames.length === 0) continue; // no keyframes to caption

      const chosen = sample(segFrames, this.maxFrames);
      const bytes: Uint8Array[] = [];
      for (const f of chosen) {
        const blob = this.store.getBlob(f.blobId!);
        if (!blob) continue;
        const raw = await this.blobStore.read(blob);
        // Downscaled for the MODEL only — nothing here writes back a blob.
        bytes.push(this.downscale === undefined ? raw : await this.downscale(raw));
      }
      if (bytes.length === 0) continue;

      const caption = await this.captioner.caption(bytes, seg.digest ?? undefined);
      await this.store.updateSegment(seg.id, { caption }); // SQLite text first
      captions.push(caption);
      segIds.push(seg.id);
    }
    this.onProgress?.(segments.length, segments.length);

    if (captions.length > 0) {
      const vecs = await this.captionEmbedder.embed(captions);
      const rows: SegmentVectorInsert[] = segIds.map((id, i) => ({
        segmentId: id,
        sessionId,
        namespace: this.namespace,
        vector: vecs[i]!,
      }));
      await this.store.putSegmentVectors(rows);
    }

    return {
      segmentCount: segments.length,
      captionedCount: segIds.length,
      excludedCount,
      namespace: this.namespace,
    };
  }
}
