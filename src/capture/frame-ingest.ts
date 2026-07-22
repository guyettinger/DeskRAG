/**
 * FrameIngestor — turns sampled frames into persisted keyframe rows. It hashes
 * every sampled frame (dHash), runs the keyframe gate, and for KEPT frames writes
 * a frame row carrying the pHash (the Tier-0 coarse visual index + dedup key).
 * Frames are stored relational-only here: segment_ids are attached later (lazy,
 * at/after segmentation) and the frame_image vector is a later represent/ view.
 *
 * A frame source (e.g. the ffmpeg screen producer) feeds SampledFrames in; the
 * source owns decoding to grayscale and, if desired, writing the keyframe image
 * blob (passing its blobId here).
 */

import { ulid } from "ulid";
import type { Store } from "../store/types.js";
import type { BlobStore } from "../store/blob-store.js";
import { dHash } from "./phash.js";
import { KeyframeGate } from "./keyframe.js";

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
  /** Encoded full keyframe image to persist (for the frame_image view / Tier 2). */
  image?: { bytes: Uint8Array; codec?: string };
}

export interface IngestResult {
  kept: boolean;
  forced: boolean;
  phash: bigint;
  frameId?: string;
}

export class FrameIngestor {
  private offset = 0;

  constructor(
    private readonly store: Store,
    private readonly sessionId: string,
    private readonly gate: KeyframeGate = new KeyframeGate(),
    private readonly blobStore?: BlobStore,
  ) {}

  async ingest(frame: SampledFrame): Promise<IngestResult> {
    const phash = dHash(frame.gray, frame.grayW, frame.grayH);
    const { keep, forced } = this.gate.consider(phash);
    if (!keep) return { kept: false, forced, phash };

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
    return { kept: true, forced, phash, frameId };
  }

  /** Number of keyframes kept so far (== next frame_offset). */
  get keptCount(): number {
    return this.offset;
  }
}
