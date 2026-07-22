/**
 * FusedRegionProposer — runs all three sources for one frame and fuses them into
 * ≤ maxRegions high-value regions. AX is best-effort (empty when no addon/app
 * support); hotspots come from the frame's interaction events; grid always
 * provides fallback coverage.
 */

import type { Region, UIElement } from "../../embed/types.js";
import { axFilter, type AxFilterOptions } from "./ax.js";
import { eventsToPoints, hotspotRegions, type HotspotEvent, type HotspotOptions } from "./hotspots.js";
import { gridRegions, type GridOptions } from "./grid.js";
import { fuseRegions, type FuseOptions } from "./fuse.js";

export interface RegionSignals {
  frameW: number;
  frameH: number;
  axTree?: UIElement[];
  events?: HotspotEvent[];
}

export interface FusedProposerOptions {
  ax?: Partial<Omit<AxFilterOptions, "frameW" | "frameH">>;
  hotspot?: Partial<Omit<HotspotOptions, "frameW" | "frameH">>;
  grid?: GridOptions;
  fuse?: FuseOptions;
  /** Set grid: false to skip grid coverage entirely. */
  useGrid?: boolean;
}

export class FusedRegionProposer {
  constructor(private readonly opts: FusedProposerOptions = {}) {}

  propose(signals: RegionSignals): Region[] {
    const { frameW, frameH } = signals;
    const all: Region[] = [];

    if (signals.axTree && signals.axTree.length > 0) {
      all.push(...axFilter(signals.axTree, { frameW, frameH, ...this.opts.ax }));
    }
    if (signals.events && signals.events.length > 0) {
      const points = eventsToPoints(signals.events);
      all.push(...hotspotRegions(points, { frameW, frameH, ...this.opts.hotspot }));
    }
    if (this.opts.useGrid !== false) {
      all.push(...gridRegions(frameW, frameH, this.opts.grid));
    }
    return fuseRegions(all, this.opts.fuse);
  }
}
