/**
 * RegionRepresenter (represent/) — the PixelRAG proposal stage. For each
 * keyframe: gather its interaction events, propose <= maxRegions high-value
 * regions (AX + hotspots + grid, fused), and persist via store.putRegions —
 * which also writes AX role/label into the FTS index, so regions are
 * text-searchable by UI role (a path pure-pixel systems can't offer).
 *
 * PROPOSAL ONLY, since the single-vector image lane was removed: a region row
 * carries geometry, source and AX role/label, and nothing crops or embeds it.
 * That is not a reduction in what the app can do — on the late-interaction path
 * Tier 3 was ALREADY deliberately FTS-only, because there the patches ARE the
 * regions and a region ANN over the same MaxSim would double-count the frame's
 * own evidence. What these rows feed is unchanged: `region_fts`, the digest's
 * "label of what was clicked", `Anchor.visual` in the trace graph, and the
 * rail's region counts.
 *
 * Each region is anchored to the frame's MOST-SPECIFIC (shortest) containing
 * segment.
 */

import { ulid } from "ulid";
import type { UIElement } from "../../embed/types.js";
import type { FrameRow, RegionInsert, SegmentRow, Store } from "../../store/types.js";
import { FusedRegionProposer, type FusedProposerOptions } from "./proposer.js";

export interface RegionRepresenterOptions {
  proposer?: FusedRegionProposer;
  proposerOptions?: FusedProposerOptions;
  /** Accessibility-tree source for a frame (the macOS AX addon plugs in here).
   *  Best-effort: returns [] when unavailable, and hotspots + grid stand alone. */
  axProvider?: (frame: FrameRow) => UIElement[] | Promise<UIElement[]>;
}

export interface RegionRepresentResult {
  frameCount: number;
  regionCount: number;
}

export class RegionRepresenter {
  private readonly proposer: FusedRegionProposer;
  private readonly axProvider: RegionRepresenterOptions["axProvider"];

  constructor(
    private readonly store: Store,
    opts: RegionRepresenterOptions,
  ) {
    this.proposer = opts.proposer ?? new FusedRegionProposer(opts.proposerOptions);
    this.axProvider = opts.axProvider;
  }

  async represent(sessionId: string): Promise<RegionRepresentResult> {
    const frames = this.store.getFramesBySession(sessionId);
    const segments = this.store.getSegmentsBySession(sessionId);
    const events = this.store.getEventsBySession(sessionId);
    if (frames.length === 0) return { frameCount: 0, regionCount: 0 };

    const sessionEnd = Math.max(...segments.map((s) => s.tMonoEnd), 0);
    const containing = (frame: { tMono: number }): SegmentRow[] =>
      segments.filter((s) => {
        const inclusiveRight = s.tMonoEnd === sessionEnd;
        return (
          frame.tMono >= s.tMonoStart &&
          (inclusiveRight ? frame.tMono <= s.tMonoEnd : frame.tMono < s.tMonoEnd)
        );
      });

    const rows: RegionInsert[] = [];
    for (const frame of frames) {
      // Nothing here reads the image, so a frame with no blob at all still gets
      // regions — their geometry is what anchors an action.
      const segs = containing(frame);
      if (segs.length === 0) continue;
      const primary = segs.reduce((best, s) =>
        s.tMonoEnd - s.tMonoStart < best.tMonoEnd - best.tMonoStart ? s : best,
      );

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
        rows.push({
          id: ulid(),
          frameId: frame.id,
          segmentId: primary.id,
          sessionId,
          x: r.x, y: r.y, w: r.w, h: r.h,
          source: r.source,
          priority: r.priority,
          ...(r.role ? { role: r.role } : {}),
          ...(r.label ? { label: r.label } : {}),
        });
      }
    }

    if (rows.length > 0) await this.store.putRegions(rows);
    return { frameCount: frames.length, regionCount: rows.length };
  }
}
