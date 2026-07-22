/**
 * RegionRepresenter (Tier-3 represent/) — the PixelRAG stage. For each keyframe:
 * gather its interaction events, propose ≤ maxRegions high-value regions (AX +
 * hotspots + grid, fused), crop each region from the frame image, embed the crops
 * into the region_image space, and persist via store.putRegions — which also
 * writes AX role/label into the FTS index, so regions are text-searchable by UI
 * role (a path pure-pixel systems can't offer).
 *
 * Each region is anchored to the frame's MOST-SPECIFIC (shortest) containing
 * segment. AX capture is deferred (needs a macOS addon), so axTree is empty for
 * now; hotspots + grid stand alone.
 */

import { ulid } from "ulid";
import type { ImageEmbeddingProvider, UIElement } from "../../embed/types.js";
import { namespaceFor } from "../../embed/types.js";
import type { BlobStore } from "../../store/blob-store.js";
import type { FrameRow, RegionInsert, SegmentRow, Store } from "../../store/types.js";
import { FusedRegionProposer, type FusedProposerOptions } from "./proposer.js";
import type { RegionCropper } from "./cropper.js";

export interface RegionRepresenterOptions {
  imageEmbedder: ImageEmbeddingProvider;
  blobStore: BlobStore;
  cropper: RegionCropper;
  proposer?: FusedRegionProposer;
  proposerOptions?: FusedProposerOptions;
  /** Accessibility-tree source for a frame (the macOS AX addon plugs in here).
   *  Best-effort: returns [] when unavailable, and hotspots + grid stand alone. */
  axProvider?: (frame: FrameRow) => UIElement[] | Promise<UIElement[]>;
}

export interface RegionRepresentResult {
  frameCount: number;
  regionCount: number;
  namespace: string;
}

export class RegionRepresenter {
  private readonly imageEmbedder: ImageEmbeddingProvider;
  private readonly blobStore: BlobStore;
  private readonly cropper: RegionCropper;
  private readonly proposer: FusedRegionProposer;
  private readonly axProvider: RegionRepresenterOptions["axProvider"];
  readonly namespace: string;
  private spaceReady = false;

  constructor(
    private readonly store: Store,
    opts: RegionRepresenterOptions,
  ) {
    this.imageEmbedder = opts.imageEmbedder;
    this.blobStore = opts.blobStore;
    this.cropper = opts.cropper;
    this.proposer = opts.proposer ?? new FusedRegionProposer(opts.proposerOptions);
    this.axProvider = opts.axProvider;
    this.namespace = namespaceFor("region_image", this.imageEmbedder);
  }

  async ensureSpace(): Promise<void> {
    if (this.spaceReady) return;
    await this.store.registerVectorSpace({
      namespace: this.namespace,
      view: "region_image",
      providerId: this.imageEmbedder.id,
      model: this.imageEmbedder.model,
      dimensions: this.imageEmbedder.dimensions,
      sharedTextSpace: this.imageEmbedder.sharedTextSpace,
    });
    this.spaceReady = true;
  }

  async represent(sessionId: string): Promise<RegionRepresentResult> {
    await this.ensureSpace();
    const frames = this.store.getFramesBySession(sessionId);
    const segments = this.store.getSegmentsBySession(sessionId);
    const events = this.store.getEventsBySession(sessionId);
    if (frames.length === 0) {
      return { frameCount: 0, regionCount: 0, namespace: this.namespace };
    }
    const sessionEnd = Math.max(...segments.map((s) => s.tMonoEnd), 0);
    const containing = (frame: { tMono: number }): SegmentRow[] =>
      segments.filter((s) => {
        const inclusiveRight = s.tMonoEnd === sessionEnd;
        return (
          frame.tMono >= s.tMonoStart &&
          (inclusiveRight ? frame.tMono <= s.tMonoEnd : frame.tMono < s.tMonoEnd)
        );
      });

    // Propose + crop across all frames, then embed the crops in one batch.
    const pending: { insert: Omit<RegionInsert, "vector">; crop: Uint8Array }[] = [];
    for (const frame of frames) {
      if (!frame.blobId) continue;
      const blob = this.store.getBlob(frame.blobId);
      if (!blob) continue;
      const segs = containing(frame);
      if (segs.length === 0) continue;
      const primary = segs.reduce((best, s) =>
        s.tMonoEnd - s.tMonoStart < best.tMonoEnd - best.tMonoStart ? s : best,
      );

      const image = await this.blobStore.read(blob);
      const frameEvents = events.filter(
        (e) => e.tMono >= primary.tMonoStart && e.tMono <= primary.tMonoEnd,
      );
      const axTree = this.axProvider ? await this.axProvider(frame) : [];
      const regions = this.proposer.propose({
        frameW: frame.width,
        frameH: frame.height,
        axTree,
        events: frameEvents,
      });

      for (const r of regions) {
        const crop = await this.cropper.crop(image, frame.width, frame.height, r);
        pending.push({
          insert: {
            id: ulid(),
            frameId: frame.id,
            segmentId: primary.id,
            sessionId,
            x: r.x, y: r.y, w: r.w, h: r.h,
            source: r.source,
            priority: r.priority,
            ...(r.role ? { role: r.role } : {}),
            ...(r.label ? { label: r.label } : {}),
          },
          crop,
        });
      }
    }

    if (pending.length === 0) {
      return { frameCount: frames.length, regionCount: 0, namespace: this.namespace };
    }

    const vectors = await this.imageEmbedder.embedImages(pending.map((p) => p.crop));
    const rows: RegionInsert[] = pending.map((p, i) => ({
      ...p.insert,
      vector: { namespace: this.namespace, vector: vectors[i]! },
    }));
    await this.store.putRegions(rows);

    return { frameCount: frames.length, regionCount: rows.length, namespace: this.namespace };
  }
}
