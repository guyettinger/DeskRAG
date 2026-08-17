/**
 * FrameIngestor — turns sampled frames into persisted keyframe rows. Every
 * frame offered here has ALREADY been decided to be a visual state change by
 * ffmpeg's `mpdecimate`; this applies the KeyframeBudget's rate limit, hashes
 * the frame (dHash) for the Tier-0 coarse visual index, and writes a frame row.
 * Frames are stored relational-only here: segment_ids are attached later (lazy,
 * at/after segmentation) and the frame_patches vectors are a later represent/ view.
 *
 * A frame source (e.g. the ffmpeg screen producer) feeds SampledFrames in; the
 * source owns decoding to grayscale and, if desired, writing the keyframe image
 * blob (passing its blobId here).
 */

import { ulid } from "ulid";
import type { Store } from "../store/types.js";
import type { BlobStore } from "../store/blob-store.js";
import { dHash } from "./phash.js";
import { KeyframeBudget } from "./keyframe-budget.js";

export interface SampledFrame {
  tMono: number;
  /** Full-resolution frame dimensions (recorded on the frame row). */
  width: number;
  height: number;
  /** Grayscale pixels for hashing, sized grayW x grayH. */
  gray: Uint8Array;
  grayW: number;
  grayH: number;
  /** Pre-existing keyframe image blob id (if the source already stored one). */
  blobId?: string;
  /** Encoded full keyframe image to persist (for Tier 2 and the app_caption crop). */
  image?: { bytes: Uint8Array; codec?: string };
}

export interface IngestResult {
  kept: boolean;
  phash: bigint;
  frameId?: string;
  /**
   * The keyframe image blob, when one was written or carried in. Reported so a
   * caller can SHOW the frame it just kept without a store round trip — the row
   * and the blob both exist by the time this returns.
   */
  blobId?: string;
}

export class FrameIngestor {
  private offset = 0;

  constructor(
    private readonly store: Store,
    private readonly sessionId: string,
    private readonly budget: KeyframeBudget = new KeyframeBudget(),
    private readonly blobStore?: BlobStore,
  ) {}

  async ingest(frame: SampledFrame): Promise<IngestResult> {
    // The hash is computed for EVERY frame regardless: it is the Tier-0 index
    // on the row, not a keep decision any more.
    const phash = dHash(frame.gray, frame.grayW, frame.grayH);
    if (!this.budget.consider(frame.tMono)) return { kept: false, phash };

    // Persist the keyframe image blob first (frame.blob_id FK needs it to exist).
    let blobId = frame.blobId;
    if (frame.image && this.blobStore) {
      const blob = await this.blobStore.write(
        this.sessionId,
        "keyframe",
        frame.image.bytes,
        { tMonoStart: frame.tMono, tMonoEnd: frame.tMono, codec: frame.image.codec ?? "png" },
      );
      await this.store.putBlobs([blob]);
      blobId = blob.id;
    }

    const frameId = ulid();
    await this.store.putFrames([
      {
        id: frameId,
        sessionId: this.sessionId,
        tMono: frame.tMono,
        width: frame.width,
        height: frame.height,
        phash,
        frameOffset: this.offset++,
        segmentIds: [], // attached later, at/after segmentation
        ...(blobId !== undefined ? { blobId } : {}),
      },
    ]);
    return { kept: true, phash, frameId, ...(blobId !== undefined ? { blobId } : {}) };
  }

  /** Number of keyframes kept so far (== next frame_offset). */
  get keptCount(): number {
    return this.offset;
  }
}
