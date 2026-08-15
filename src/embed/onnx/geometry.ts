/**
 * Idefics3 tile layout and the patch-index -> frame-bbox mapping that turns a
 * MaxSim argmax into a highlight box.
 *
 * Pure — no weights, no native modules — because this is the design's highest-risk
 * silent failure: wrong geometry puts highlights on the wrong part of the frame
 * while retrieval scores stay entirely plausible.
 *
 Numbers come from the processor config: image_size 512, patch_size 16 -> 1024
 * patches per tile; pixel_shuffle_factor 4 -> divide by 16 -> 64 tokens per tile,
 * an 8x8 grid. DEFAULT_TILE_CONFIG restates them, but a provider must pass its
 * OWN `tileConfig` — see MultiVectorProvider.tileConfig. Agreeing with the
 * default is a coincidence to be checked, never a fact to rely on.
 *
 The tiling rule was MEASURED against the reference Idefics3 processor, not
 * inferred from the config, because two plausible readings of it are both wrong:
 *
 *   1. The longest edge is scaled TO maxEdge, not capped at it. A 1280x800 frame
 *      is scaled UP by 1.6x, not left alone.
 *   2. Both dimensions are then rounded UP to a multiple of tileSize and the
 *      image is RESIZED to that — not padded, and not stretched per tile. Every
 *      tile is a full, fully-valid tileSize square (verified: every tile reports
 *      pixel_attention_mask frac = 1.000).
 *
 * Consequence: the resize is anisotropic, so mapping a patch back to source
 * pixels needs separate x and y factors. 1280x800 -> 2048x1536 -> 4x3 grid + a
 * global tile = 13 tiles = 832 image tokens.
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
  /** Dimensions the image is resized to — always exact multiples of tileSize. */
  scaledWidth: number;
  scaledHeight: number;
  /** Scaled -> source factors. Anisotropic: the resize does not preserve aspect. */
  scaleX: number;
  scaleY: number;
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
  // Scale the longest edge TO maxEdge — this upscales small frames, it does not
  // merely cap large ones.
  const s = cfg.maxEdge / Math.max(srcWidth, srcHeight);
  // Then round both dimensions up to a whole number of tiles and resize to that.
  const scaledWidth =
    Math.ceil(Math.round(srcWidth * s) / cfg.tileSize) * cfg.tileSize;
  const scaledHeight =
    Math.ceil(Math.round(srcHeight * s) / cfg.tileSize) * cfg.tileSize;

  const cols = scaledWidth / cfg.tileSize;
  const rows = scaledHeight / cfg.tileSize;
  const perTile = (cfg.tileSize / cfg.patchSize) ** 2 / cfg.shuffleFactor ** 2;

  return {
    srcWidth,
    srcHeight,
    scaledWidth,
    scaledHeight,
    scaleX: srcWidth / scaledWidth,
    scaleY: srcHeight / scaledHeight,
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

/** A cell in the whole-frame token grid: `cols * tokenGrid` by `rows * tokenGrid`. */
export interface TileCell {
  col: number;
  row: number;
}

/** Image tokens belonging to the tile GRID — i.e. excluding the global tile. */
export function gridTokenCount(g: TileGeometry): number {
  return g.cols * g.rows * g.tokensPerTile;
}

/**
 * The token-grid cell an image token occupies, or null when it has no cell:
 * a global-tile token (it covers the whole frame) or an out-of-range index.
 *
 * Callers that need to tell those two apart range-check first, as
 * `patchIndexToBox` does.
 */
export function patchIndexToCell(index: number, g: TileGeometry): TileCell | null {
  if (!Number.isInteger(index) || index < 0 || index >= expectedTokenCount(g)) return null;
  const tileIndex = Math.floor(index / g.tokensPerTile);
  if (g.hasGlobalTile && tileIndex === g.cols * g.rows) return null;
  const within = index % g.tokensPerTile;
  return {
    col: (tileIndex % g.cols) * g.tokenGrid + (within % g.tokenGrid),
    row: Math.floor(tileIndex / g.cols) * g.tokenGrid + Math.floor(within / g.tokenGrid),
  };
}

/**
 * Frame-space box for one cell.
 *
 * Every tile is a full tileSize square (the image was resized, not padded), so
 * the cell size is uniform. Scaled space -> source space with SEPARATE factors:
 * the resize to a whole number of tiles does not preserve aspect ratio.
 */
export function cellToBox(cell: TileCell, g: TileGeometry): Box {
  const size = g.tileSize / g.tokenGrid;
  const x = cell.col * size * g.scaleX;
  const y = cell.row * size * g.scaleY;
  return {
    x,
    y,
    w: Math.max(0, Math.min(size * g.scaleX, g.srcWidth - x)),
    h: Math.max(0, Math.min(size * g.scaleY, g.srcHeight - y)),
  };
}

/**
 * Frame-space bbox for one image token, or null if the index is out of range.
 * A global-tile token maps to the whole frame.
 */
export function patchIndexToBox(index: number, g: TileGeometry): Box | null {
  if (!Number.isInteger(index) || index < 0 || index >= expectedTokenCount(g)) {
    return null;
  }
  const cell = patchIndexToCell(index, g);
  // In range and cell-less means the global tile, which covers everything.
  if (!cell) return { x: 0, y: 0, w: g.srcWidth, h: g.srcHeight };
  return cellToBox(cell, g);
}
