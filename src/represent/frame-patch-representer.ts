/**
 * Writes the `frame_patches` view: one late-interaction patch set per keyframe.
 *
 * The multi-vector counterpart to FrameRepresenter. Segment association is set
 * lazily here, at represent time, because segments are detected after capture —
 * the denormalized segment_ids column is what lets Tier 2 pre-filter its scope
 * without a cross-engine round-trip mid-search.
 *
 * Unlike FrameRepresenter this embeds and writes ONE FRAME AT A TIME rather than
 * batching. Two reasons: a patch set is ~832 vectors, so accumulating a whole
 * session would hold hundreds of MB; and the embedder costs seconds per frame,
 * so a crash mid-pass should cost one frame, not the session.
 *
 * Barrel-safe: the provider is injected, so this file loads no native code.
 */

import type { MultiVectorProvider } from "../embed/types.js";
import { namespaceFor } from "../embed/types.js";
import type { BlobStore } from "../store/blob-store.js";
import type { Store } from "../store/types.js";
import { segmentIdsForFrame, sessionEndOf } from "./frame-segments.js";

export interface FramePatchRepresenterOptions {
  patchEmbedder: MultiVectorProvider;
  blobStore: BlobStore;
  /** Called after each frame lands. Embedding is slow enough to be worth surfacing. */
  onProgress?: (done: number, total: number) => void;
}

export interface FramePatchRepresentResult {
  frameCount: number;
  embeddedCount: number;
  namespace: string;
}

export class FramePatchRepresenter {
  private readonly patchEmbedder: MultiVectorProvider;
  private readonly blobStore: BlobStore;
  private readonly onProgress: ((done: number, total: number) => void) | undefined;
  private spaceReady = false;
  readonly namespace: string;

  constructor(
    private readonly store: Store,
    opts: FramePatchRepresenterOptions,
  ) {
    this.patchEmbedder = opts.patchEmbedder;
    this.blobStore = opts.blobStore;
    this.onProgress = opts.onProgress;
    this.namespace = namespaceFor("frame_patches", this.patchEmbedder);
  }

  async ensureSpace(): Promise<void> {
    if (this.spaceReady) return;
    await this.store.registerVectorSpace({
      namespace: this.namespace,
      view: "frame_patches",
      providerId: this.patchEmbedder.id,
      model: this.patchEmbedder.model,
      dimensions: this.patchEmbedder.dimensions,
      // One model embeds both images and queries, so a text query reaches this
      // space directly — there is no separate tower to align.
      sharedTextSpace: true,
    });
    this.spaceReady = true;
  }

  async represent(sessionId: string): Promise<FramePatchRepresentResult> {
    await this.ensureSpace();
    const frames = this.store.getFramesBySession(sessionId);
    const segments = this.store.getSegmentsBySession(sessionId);
    if (frames.length === 0) {
      return { frameCount: 0, embeddedCount: 0, namespace: this.namespace };
    }
    const sessionEnd = sessionEndOf(segments);

    let embedded = 0;
    let processed = 0;
    for (const frame of frames) {
      const segmentIds = segmentIdsForFrame(frame, segments, sessionEnd);

      // SQLite association first (idempotent), matching the write-order rule.
      await this.store.associateFrameSegments(frame.id, segmentIds);
      processed++;

      const blob = frame.blobId ? this.store.getBlob(frame.blobId) : undefined;
      if (!blob) {
        this.onProgress?.(processed, frames.length);
        continue;
      }

      const bytes = await this.blobStore.read(blob);
      const [patches] = await this.patchEmbedder.embedImages([bytes]);
      // Never write an empty multivector row: it would be indistinguishable from
      // a frame that simply has no vector, and Lance cannot score it.
      if (patches && patches.length > 0) {
        await this.store.putFramePatches([
          {
            frameId: frame.id,
            sessionId,
            segmentIds,
            namespace: this.namespace,
            patches,
          },
        ]);
        embedded++;
      }
      this.onProgress?.(processed, frames.length);
    }

    return {
      frameCount: frames.length,
      embeddedCount: embedded,
      namespace: this.namespace,
    };
  }
}
