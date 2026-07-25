/**
 * ColSmol tile layout and the patch-index -> frame-bbox mapping that turns a
 * MaxSim argmax into a highlight box.
 *
 * Pure — no weights, no native modules — because this is the design's highest-risk
 * silent failure: wrong geometry puts highlights on the wrong part of the frame
 * while retrieval scores stay entirely plausible.
 *
 * Numbers come from vidore/colSmol-256M: image_size 512, patch_size 16 -> 1024
 * patches per tile; pixel_shuffle_factor 4 -> divide by 16 -> 64 tokens per tile,
 * an 8x8 grid.
 *
 * NOTE the edge case that a naive implementation gets wrong: the last column and
 * last row of tiles are usually SMALLER than tileSize, and the preprocessor
 * stretches them to tileSize before the vision encoder sees them. A token in
 * such a tile therefore covers less source area than one in a full tile, so the
 * cell size is derived per tile from its real extent, never assumed.
 */

import type { Box } from "../../represent/regions/geometry.js";

export interface TileConfig {
  /** Longest edge the source is resized to before tiling. */
  maxEdge: number;
  /** Square tile edge. */
  tileSize: number;
  /** ViT patch edge. */
  patchSize: number;
  /** Pixel-shuffle factor; token count is divided by its square. */
  shuffleFactor: number;
  /** Whether a whole-image thumbnail tile is appended after the grid. */
  globalTile: boolean;
}

export const DEFAULT_TILE_CONFIG: TileConfig = {
  maxEdge: 2048,
  tileSize: 512,
  patchSize: 16,
  shuffleFactor: 4,
  globalTile: true,
};

/** One preprocessed image: normalized CHW tiles plus the source dimensions. */
export interface TiledImage {
  /** One normalized CHW tile buffer per tile, grid order then global. */
  tiles: Float32Array[];
  width: number;
  height: number;
}

export interface TileGeometry {
  srcWidth: number;
  srcHeight: number;
  /** Resize factor applied before tiling (<= 1). */
  scale: number;
  /** Dimensions after the maxEdge resize, in which tiling happens. */
  scaledWidth: number;
  scaledHeight: number;
  cols: number;
  rows: number;
  tokensPerTile: number;
  /** sqrt(tokensPerTile) — the token grid edge within a tile. */
  tokenGrid: number;
  hasGlobalTile: boolean;
  tileSize: number;
}

export function computeTileGeometry(
  srcWidth: number,
  srcHeight: number,
  cfg: TileConfig = DEFAULT_TILE_CONFIG,
): TileGeometry {
  const scale = Math.min(1, cfg.maxEdge / Math.max(srcWidth, srcHeight));
  const scaledWidth = Math.round(srcWidth * scale);
  const scaledHeight = Math.round(srcHeight * scale);
  const cols = Math.max(1, Math.ceil(scaledWidth / cfg.tileSize));
  const rows = Math.max(1, Math.ceil(scaledHeight / cfg.tileSize));
  const perTile = (cfg.tileSize / cfg.patchSize) ** 2 / cfg.shuffleFactor ** 2;
  return {
    srcWidth,
    srcHeight,
    scale,
    scaledWidth,
    scaledHeight,
    cols,
    rows,
    tokensPerTile: perTile,
    tokenGrid: Math.round(Math.sqrt(perTile)),
    // A single-tile image is already its own global view.
    hasGlobalTile: cfg.globalTile && cols * rows > 1,
    tileSize: cfg.tileSize,
  };
}

/** How many image tokens the model should emit for this geometry. */
export function expectedTokenCount(g: TileGeometry): number {
  return (g.cols * g.rows + (g.hasGlobalTile ? 1 : 0)) * g.tokensPerTile;
}

/**
 * Frame-space bbox for one image token, or null if the index is out of range.
 * A global-tile token maps to the whole frame.
 */
export function patchIndexToBox(index: number, g: TileGeometry): Box | null {
  if (!Number.isInteger(index) || index < 0 || index >= expectedTokenCount(g)) {
    return null;
  }

  const tileIndex = Math.floor(index / g.tokensPerTile);
  const gridTiles = g.cols * g.rows;
  if (g.hasGlobalTile && tileIndex === gridTiles) {
    return { x: 0, y: 0, w: g.srcWidth, h: g.srcHeight };
  }

  const within = index % g.tokensPerTile;
  const tileCol = tileIndex % g.cols;
  const tileRow = Math.floor(tileIndex / g.cols);

  // Real extent of THIS tile in scaled space — edge tiles are smaller and were
  // stretched to tileSize before encoding, so their tokens cover less area.
  const originX = tileCol * g.tileSize;
  const originY = tileRow * g.tileSize;
  const tileW = Math.min(g.tileSize, g.scaledWidth - originX);
  const tileH = Math.min(g.tileSize, g.scaledHeight - originY);

  const cellW = tileW / g.tokenGrid;
  const cellH = tileH / g.tokenGrid;
  const gx = within % g.tokenGrid;
  const gy = Math.floor(within / g.tokenGrid);

  // Scaled space -> source space.
  const inv = 1 / g.scale;
  const x = (originX + gx * cellW) * inv;
  const y = (originY + gy * cellH) * inv;

  return {
    x,
    y,
    w: Math.max(0, Math.min(cellW * inv, g.srcWidth - x)),
    h: Math.max(0, Math.min(cellH * inv, g.srcHeight - y)),
  };
}
