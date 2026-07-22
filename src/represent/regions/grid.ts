/**
 * Source C — Grid tiling. Lowest priority; fills coverage where AX and hotspots
 * are absent. Tiles overlap (~15%) so a dialog straddling a seam still lands
 * mostly inside one tile.
 */

import type { Region } from "../../embed/types.js";
import { clampToFrame } from "./geometry.js";

export interface GridOptions {
  cols?: number;
  rows?: number;
  /** Fractional overlap of adjacent tiles (0.15 = 15%). */
  overlap?: number;
  priority?: number;
}

export function gridRegions(frameW: number, frameH: number, opts: GridOptions = {}): Region[] {
  const cols = opts.cols ?? 4;
  const rows = opts.rows ?? 3;
  const overlap = opts.overlap ?? 0.15;
  const priority = opts.priority ?? 0.5;

  const stepX = frameW / cols;
  const stepY = frameH / rows;
  const tileW = stepX * (1 + overlap);
  const tileH = stepY * (1 + overlap);

  const regions: Region[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const box = clampToFrame(
        { x: c * stepX - (tileW - stepX) / 2, y: r * stepY - (tileH - stepY) / 2, w: tileW, h: tileH },
        frameW, frameH,
      );
      if (box.w > 0 && box.h > 0) regions.push({ ...box, source: "grid", priority });
    }
  }
  return regions;
}
