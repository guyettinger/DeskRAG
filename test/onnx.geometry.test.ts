import { describe, expect, it } from "vitest";
import {
  DEFAULT_TILE_CONFIG,
  cellToBox,
  computeTileGeometry,
  expectedTokenCount,
  gridTokenCount,
  patchIndexToBox,
  patchIndexToCell,
} from "../src/embed/onnx/geometry.js";

/**
 * Ground truth measured from the reference Idefics3 processor
 * (scripts/dump-idefics3-processor.py):
 *
 *   1280x800  -> 13 tiles, 832 image tokens   (4x3 grid + global)
 *   1920x1080 -> 13 tiles, 832
 *   2560x1600 -> 13 tiles, 832
 *   1024x768  -> 13 tiles, 832
 *    800x600  -> 13 tiles, 832
 *   3840x2160 -> 13 tiles, 832
 *    512x512  -> 17 tiles, 1088          (4x4 grid + global)
 *   1280x1024 -> 17 tiles, 1088
 *
 * TAKEN FROM ColIdefics3Processor AND STILL VALID FOR ColModernVBertProcessor,
 * checked rather than assumed. The two `preprocessor_config.json` files are
 * byte-identical apart from `processor_class` — same `Idefics3ImageProcessor`,
 * same 2048 / 512, same mean/std/rescale/resample — and both `config.json`s
 * declare patch 16 and shuffle 4 (ColModernVBERT at the top level, ColSmol under
 * `text_config`, which is why `readTileConfig` accepts both spellings). Every
 * input this table depends on is therefore the same.
 *
 * And it is confirmed against the REAL export, not only against its config:
 * `npm run smoke:onnx-electron` embeds a 2560x1600 fixture through
 * ColModernVBERT and reports `4x3 + global = 13 tiles`, `vectors=832`, matching
 * row 3; `npm run probe:patchgeom` gets 832 for 1920x1080 and 1728x1117.
 */
const MEASURED: Array<[number, number, number]> = [
  [1280, 800, 13],
  [1920, 1080, 13],
  [2560, 1600, 13],
  [1024, 768, 13],
  [800, 600, 13],
  [3840, 2160, 13],
  [512, 512, 17],
  [1280, 1024, 17],
];

describe("computeTileGeometry", () => {
  it("derives 64 tokens per tile in an 8x8 grid from the Idefics3 config", () => {
    const g = computeTileGeometry(1280, 800);
    expect(g.tokensPerTile).toBe(64);
    expect(g.tokenGrid).toBe(8);
  });

  it("matches the processor's tile count on every measured size", () => {
    for (const [w, h, tiles] of MEASURED) {
      const g = computeTileGeometry(w, h);
      const got = g.cols * g.rows + (g.hasGlobalTile ? 1 : 0);
      expect(`${w}x${h}:${got}`).toBe(`${w}x${h}:${tiles}`);
      expect(expectedTokenCount(g)).toBe(tiles * 64);
    }
  });

  it("scales the longest edge UP to maxEdge, it does not merely cap it", () => {
    // 1280x800 is under the 2048 cap, but is still scaled up by 1.6x.
    const g = computeTileGeometry(1280, 800);
    expect([g.scaledWidth, g.scaledHeight]).toEqual([2048, 1536]);
  });

  it("rounds both dimensions up to whole tiles and resizes (never pads)", () => {
    // 1280 * 1.6 = 2048 exactly; 800 * 1.6 = 1280 -> rounded up to 1536.
    const g = computeTileGeometry(1280, 800);
    expect(g.scaledWidth % 512).toBe(0);
    expect(g.scaledHeight % 512).toBe(0);
    expect([g.cols, g.rows]).toEqual([4, 3]);
  });

  it("exposes anisotropic scale factors, because the resize distorts aspect", () => {
    const g = computeTileGeometry(1280, 800);
    expect(g.scaleX).toBeCloseTo(1280 / 2048, 9);
    expect(g.scaleY).toBeCloseTo(800 / 1536, 9);
    expect(g.scaleX).not.toBeCloseTo(g.scaleY, 3); // genuinely different
  });

  it("downscales an oversized frame to the same tiling", () => {
    const g = computeTileGeometry(3840, 2160);
    expect([g.scaledWidth, g.scaledHeight]).toEqual([2048, 1536]);
  });
});

describe("patchIndexToBox", () => {
  const g = computeTileGeometry(1280, 800);
  const cellW = 64 * (1280 / 2048); // 40
  const cellH = 64 * (800 / 1536); // 33.33...

  it("maps token 0 to the top-left cell in SOURCE pixels", () => {
    const b = patchIndexToBox(0, g)!;
    expect(b.x).toBeCloseTo(0, 9);
    expect(b.y).toBeCloseTo(0, 9);
    expect(b.w).toBeCloseTo(cellW, 9);
    expect(b.h).toBeCloseTo(cellH, 9);
  });

  it("maps within-tile position by an 8x8 grid", () => {
    const b = patchIndexToBox(9, g)!; // gx 1, gy 1
    expect(b.x).toBeCloseTo(cellW, 9);
    expect(b.y).toBeCloseTo(cellH, 9);
  });

  it("offsets by tile column and row", () => {
    const c1 = patchIndexToBox(64, g)!; // tile 1 -> col 1
    expect(c1.x).toBeCloseTo(512 * g.scaleX, 9);
    expect(c1.y).toBeCloseTo(0, 9);

    const r1 = patchIndexToBox(4 * 64, g)!; // tile 4 -> row 1, col 0
    expect(r1.x).toBeCloseTo(0, 9);
    expect(r1.y).toBeCloseTo(512 * g.scaleY, 9);
  });

  it("keeps every token box inside the frame with non-zero area", () => {
    for (let i = 0; i < expectedTokenCount(g); i++) {
      const b = patchIndexToBox(i, g)!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(1280 + 1e-9);
      expect(b.y + b.h).toBeLessThanOrEqual(800 + 1e-9);
      expect(b.w).toBeGreaterThan(0);
      expect(b.h).toBeGreaterThan(0);
    }
  });

  it("covers the bottom-right corner with the last grid token", () => {
    // last grid tile (index 11 = row 2, col 3), last token (gx 7, gy 7)
    const b = patchIndexToBox(11 * 64 + 63, g)!;
    expect(b.x + b.w).toBeCloseTo(1280, 6);
    expect(b.y + b.h).toBeCloseTo(800, 6);
  });

  it("maps a global-tile token to the whole frame", () => {
    const b = patchIndexToBox(12 * 64, g); // tile index 12 == cols*rows
    expect(b).toEqual({ x: 0, y: 0, w: 1280, h: 800 });
  });

  it("returns null past the end or below zero", () => {
    expect(patchIndexToBox(expectedTokenCount(g), g)).toBeNull();
    expect(patchIndexToBox(-1, g)).toBeNull();
    expect(patchIndexToBox(1.5, g)).toBeNull();
  });

  it("derives token count from the config, not a hardcoded 64", () => {
    expect(DEFAULT_TILE_CONFIG.tileSize).toBe(512);
    // (512/8)^2 / 4^2 = 4096/16 = 256 tokens, a 16x16 grid.
    const g3 = computeTileGeometry(1280, 800, { ...DEFAULT_TILE_CONFIG, patchSize: 8 });
    expect(g3.tokensPerTile).toBe(256);
    expect(g3.tokenGrid).toBe(16);
  });
});

describe("token-grid cells", () => {
  // 1920x1080 -> 2048x1536 -> 4x3 tiles of 8x8 tokens = a 32x24 cell grid.
  const g = computeTileGeometry(1920, 1080);

  it("counts only grid tokens, excluding the global tile", () => {
    expect(gridTokenCount(g)).toBe(4 * 3 * 64);
    // The global tile is the difference between the two counts.
    expect(expectedTokenCount(g)).toBe(gridTokenCount(g) + 64);
  });

  it("maps the first and last grid tokens to the corners of the cell grid", () => {
    expect(patchIndexToCell(0, g)).toEqual({ col: 0, row: 0 });
    expect(patchIndexToCell(gridTokenCount(g) - 1, g)).toEqual({ col: 31, row: 23 });
  });

  it("advances one cell per token within a tile and one tile per 64 tokens", () => {
    expect(patchIndexToCell(1, g)).toEqual({ col: 1, row: 0 });
    expect(patchIndexToCell(8, g)).toEqual({ col: 0, row: 1 });
    // Tile 1 is the second tile of the top row: its first token is at col 8.
    expect(patchIndexToCell(64, g)).toEqual({ col: 8, row: 0 });
    // Tile 4 is the first tile of the second tile-row: row 8.
    expect(patchIndexToCell(4 * 64, g)).toEqual({ col: 0, row: 8 });
  });

  it("returns null for a global-tile token and for an out-of-range index", () => {
    expect(patchIndexToCell(gridTokenCount(g), g)).toBeNull();
    expect(patchIndexToCell(-1, g)).toBeNull();
    expect(patchIndexToCell(10_000, g)).toBeNull();
    expect(patchIndexToCell(1.5, g)).toBeNull();
  });

  it("agrees with patchIndexToBox for every grid token", () => {
    for (let i = 0; i < gridTokenCount(g); i++) {
      expect(cellToBox(patchIndexToCell(i, g)!, g)).toEqual(patchIndexToBox(i, g));
    }
  });

  it("still maps a global-tile token to the whole frame", () => {
    expect(patchIndexToBox(gridTokenCount(g), g)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });
});
