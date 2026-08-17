/**
 * AppCaptionRepresenter (app_caption view) — the focused-window visual summary,
 * a SECOND signal alongside the whole-desktop caption (CaptionRepresenter). For
 * each segment, sample keyframes the same way CaptionRepresenter does, crop
 * each to the focused window's bounds (resolved from focus_change events,
 * latest at-or-before the frame's t_mono), caption the crops, and persist.
 *
 * A frame with no resolvable window bounds is dropped from the sample — never
 * falls back to the full frame, which would silently turn this into a copy of
 * `caption`. If no sampled frame in a segment has bounds, that segment gets no
 * app_caption row at all, the same "absence is meaningful" rule the rest of
 * the pipeline follows.
 */

import type { CaptionProvider, EmbeddingProvider } from "../../embed/types.js";
import { namespaceFor } from "../../embed/types.js";
import type { BlobStore } from "../../store/blob-store.js";
import type { EventRow, FrameRow, SegmentVectorInsert, Store } from "../../store/types.js";
import type { RegionCropper } from "../regions/cropper.js";
import type { Box } from "../regions/geometry.js";
import { sample } from "../sample.js";
import { resolveFocusBounds } from "./focus-bounds.js";

export interface AppCaptionRepresenterOptions {
  captioner: CaptionProvider;
  captionEmbedder: EmbeddingProvider;
  blobStore: BlobStore;
  cropper: RegionCropper;
  /** Keyframes sampled per segment for captioning. */
  maxFramesPerSegment?: number;
  /** Called with the segments finished so far — a crop plus a VLM call each. */
  onProgress?: (done: number, total: number) => void;
}

export interface AppCaptionRepresentResult {
  segmentCount: number;
  captionedCount: number;
  namespace: string;
}

export class AppCaptionRepresenter {
  private readonly captioner: CaptionProvider;
  private readonly captionEmbedder: EmbeddingProvider;
  private readonly blobStore: BlobStore;
  private readonly cropper: RegionCropper;
  private readonly maxFrames: number;
  private readonly onProgress: ((done: number, total: number) => void) | undefined;
  readonly namespace: string;
  private spaceReady = false;

  constructor(
    private readonly store: Store,
    opts: AppCaptionRepresenterOptions,
  ) {
    this.captioner = opts.captioner;
    this.captionEmbedder = opts.captionEmbedder;
    this.blobStore = opts.blobStore;
    this.cropper = opts.cropper;
    this.maxFrames = opts.maxFramesPerSegment ?? 3;
    this.onProgress = opts.onProgress;
    this.namespace = namespaceFor("app_caption", this.captionEmbedder);
  }

  async ensureSpace(): Promise<void> {
    if (this.spaceReady) return;
    await this.store.registerVectorSpace({
      namespace: this.namespace,
      view: "app_caption",
      providerId: this.captionEmbedder.id,
      model: this.captionEmbedder.model,
      dimensions: this.captionEmbedder.dimensions,
      sharedTextSpace: false,
    });
    this.spaceReady = true;
  }

  async represent(sessionId: string): Promise<AppCaptionRepresentResult> {
    await this.ensureSpace();
    const segments = this.store.getSegmentsBySession(sessionId);
    const frames = this.store.getFramesBySession(sessionId);
    if (segments.length === 0) {
      return { segmentCount: 0, captionedCount: 0, namespace: this.namespace };
    }
    const sessionEnd = Math.max(...segments.map((s) => s.tMonoEnd), 0);
    const focusEvents: EventRow[] = this.store
      .getEventsBySession(sessionId)
      .filter((e) => e.kind === "focus_change");

    const captions: string[] = [];
    const segIds: string[] = [];
    // Top-of-loop reporting, as in CaptionRepresenter: this body has three
    // `continue`s and counting at each of them is the shape that goes stale.
    for (const [i, seg] of segments.entries()) {
      this.onProgress?.(i, segments.length);
      const inclusiveRight = seg.tMonoEnd === sessionEnd;
      const segFrames = frames.filter(
        (f) =>
          f.blobId &&
          f.tMono >= seg.tMonoStart &&
          (inclusiveRight ? f.tMono <= seg.tMonoEnd : f.tMono < seg.tMonoEnd),
      );
      if (segFrames.length === 0) continue;

      const withBounds: { frame: FrameRow; bounds: Box }[] = [];
      for (const frame of sample(segFrames, this.maxFrames)) {
        const bounds = resolveFocusBounds(focusEvents, frame.tMono);
        if (bounds) withBounds.push({ frame, bounds });
      }
      if (withBounds.length === 0) continue; // never fall back to the full frame

      const crops: Uint8Array[] = [];
      for (const { frame, bounds } of withBounds) {
        const blob = this.store.getBlob(frame.blobId!);
        if (!blob) continue;
        const image = await this.blobStore.read(blob);
        crops.push(await this.cropper.crop(image, frame.width, frame.height, bounds));
      }
      if (crops.length === 0) continue;

      const caption = await this.captioner.caption(crops, seg.digest ?? undefined);
      await this.store.updateSegmentAppCaption(seg.id, caption); // SQLite text first
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
      namespace: this.namespace,
    };
  }
}
