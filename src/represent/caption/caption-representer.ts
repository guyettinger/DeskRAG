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

export interface CaptionRepresenterOptions {
  captioner: CaptionProvider;
  captionEmbedder: EmbeddingProvider;
  blobStore: BlobStore;
  /** Keyframes sampled per segment for captioning. */
  maxFramesPerSegment?: number;
}

export interface CaptionRepresentResult {
  segmentCount: number;
  captionedCount: number;
  namespace: string;
}

/** Evenly sample up to `k` items from `arr` (first..last spread). */
function sample<T>(arr: T[], k: number): T[] {
  if (arr.length <= k) return arr;
  const out: T[] = [];
  for (let i = 0; i < k; i++) {
    out.push(arr[Math.floor((i * (arr.length - 1)) / (k - 1))]!);
  }
  return out;
}

export class CaptionRepresenter {
  private readonly captioner: CaptionProvider;
  private readonly captionEmbedder: EmbeddingProvider;
  private readonly blobStore: BlobStore;
  private readonly maxFrames: number;
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
      return { segmentCount: 0, captionedCount: 0, namespace: this.namespace };
    }
    const sessionEnd = Math.max(...segments.map((s) => s.tMonoEnd), 0);

    const captions: string[] = [];
    const segIds: string[] = [];
    for (const seg of segments) {
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
        if (blob) bytes.push(await this.blobStore.read(blob));
      }
      if (bytes.length === 0) continue;

      const caption = await this.captioner.caption(bytes, seg.digest ?? undefined);
      await this.store.updateSegment(seg.id, { caption }); // SQLite text first
      captions.push(caption);
      segIds.push(seg.id);
    }

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
      namespace: this.namespace,
    };
  }
}
