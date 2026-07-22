/**
 * FrameRepresenter (Tier-2 represent/) — two jobs per kept keyframe:
 *  1. ASSOCIATE it with the segments whose time window contains it (populates the
 *     frame_segment M:N in SQLite). This is the lazy denormalization the store's
 *     frame vectors need for Tier-2 scoping.
 *  2. EMBED its stored image via an ImageEmbeddingProvider into the frame_image
 *     namespace, with those segment_ids denormalized onto the Lance row.
 *
 * Association (SQLite) happens before the vector write (Lance), so the write-order
 * rule holds and a crash leaves a re-embeddable gap. Frames without a stored image
 * are still associated; they just have no frame_image vector.
 */

import type { ImageEmbeddingProvider } from "../embed/types.js";
import { namespaceFor } from "../embed/types.js";
import type { BlobStore } from "../store/blob-store.js";
import type { FrameVectorInsert, Store } from "../store/types.js";

export interface FrameRepresenterOptions {
  imageEmbedder: ImageEmbeddingProvider;
  blobStore: BlobStore;
}

export interface FrameRepresentResult {
  frameCount: number;
  embeddedCount: number;
  namespace: string;
}

export class FrameRepresenter {
  private readonly imageEmbedder: ImageEmbeddingProvider;
  private readonly blobStore: BlobStore;
  readonly namespace: string;
  private spaceReady = false;

  constructor(
    private readonly store: Store,
    opts: FrameRepresenterOptions,
  ) {
    this.imageEmbedder = opts.imageEmbedder;
    this.blobStore = opts.blobStore;
    this.namespace = namespaceFor("frame_image", this.imageEmbedder);
  }

  async ensureSpace(): Promise<void> {
    if (this.spaceReady) return;
    await this.store.registerVectorSpace({
      namespace: this.namespace,
      view: "frame_image",
      providerId: this.imageEmbedder.id,
      model: this.imageEmbedder.model,
      dimensions: this.imageEmbedder.dimensions,
      sharedTextSpace: this.imageEmbedder.sharedTextSpace,
    });
    this.spaceReady = true;
  }

  async represent(sessionId: string): Promise<FrameRepresentResult> {
    await this.ensureSpace();
    const frames = this.store.getFramesBySession(sessionId);
    const segments = this.store.getSegmentsBySession(sessionId);
    if (frames.length === 0) {
      return { frameCount: 0, embeddedCount: 0, namespace: this.namespace };
    }
    const sessionEnd = Math.max(...segments.map((s) => s.tMonoEnd), 0);

    const pending: { frameId: string; segmentIds: string[]; bytes: Uint8Array }[] = [];
    for (const frame of frames) {
      const segmentIds = segments
        .filter((s) => {
          const inclusiveRight = s.tMonoEnd === sessionEnd;
          return (
            frame.tMono >= s.tMonoStart &&
            (inclusiveRight ? frame.tMono <= s.tMonoEnd : frame.tMono < s.tMonoEnd)
          );
        })
        .map((s) => s.id);

      // SQLite association first (idempotent).
      await this.store.associateFrameSegments(frame.id, segmentIds);

      if (!frame.blobId) continue;
      const blob = this.store.getBlob(frame.blobId);
      if (!blob) continue;
      const bytes = await this.blobStore.read(blob);
      pending.push({ frameId: frame.id, segmentIds, bytes });
    }

    if (pending.length === 0) {
      return { frameCount: frames.length, embeddedCount: 0, namespace: this.namespace };
    }

    const vectors = await this.imageEmbedder.embedImages(pending.map((p) => p.bytes));
    const rows: FrameVectorInsert[] = pending.map((p, i) => ({
      frameId: p.frameId,
      sessionId,
      segmentIds: p.segmentIds,
      namespace: this.namespace,
      vector: vectors[i]!,
    }));
    await this.store.putFrameVectors(rows);

    return { frameCount: frames.length, embeddedCount: rows.length, namespace: this.namespace };
  }
}
