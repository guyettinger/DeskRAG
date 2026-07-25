import { describe, expect, it } from "vitest";
import {
  DEFAULT_TILE_CONFIG,
  computeTileGeometry,
  expectedTokenCount,
  patchIndexToBox,
} from "../src/embed/onnx/geometry.js";

describe("computeTileGeometry", () => {
  it("derives 64 tokens per tile in an 8x8 grid from the ColSmol config", () => {
    const g = computeTileGeometry(1280, 800);
    expect(g.tokensPerTile).toBe(64);
    expect(g.tokenGrid).toBe(8);
  });

  it("tiles a 1280x800 frame into 3x2 plus a global view", () => {
    const g = computeTileGeometry(1280, 800);
    expect(g.scale).toBe(1); // under the 2048 cap
    expect([g.cols, g.rows]).toEqual([3, 2]);
    expect(g.hasGlobalTile).toBe(true);
    expect(expectedTokenCount(g)).toBe((3 * 2 + 1) * 64); // 448
  });

  it("downscales past the 2048 long-edge cap before tiling", () => {
    const g = computeTileGeometry(4096, 2048);
    expect(g.scale).toBe(0.5);
    expect([g.scaledWidth, g.scaledHeight]).toEqual([2048, 1024]);
    expect([g.cols, g.rows]).toEqual([4, 2]);
  });

  it("omits the global tile when the image is a single tile", () => {
    const g = computeTileGeometry(400, 300);
    expect([g.cols, g.rows]).toEqual([1, 1]);
    expect(g.hasGlobalTile).toBe(false);
    expect(expectedTokenCount(g)).toBe(64);
  });
});

describe("patchIndexToBox", () => {
  const g = computeTileGeometry(1280, 800);

  it("maps token 0 to the top-left 64px cell", () => {
    expect(patchIndexToBox(0, g)).toEqual({ x: 0, y: 0, w: 64, h: 64 });
  });

  it("maps within-tile position by an 8x8 grid", () => {
    // token 9 = row 1, col 1 of tile 0
    expect(patchIndexToBox(9, g)).toEqual({ x: 64, y: 64, w: 64, h: 64 });
  });

  it("offsets by tile column", () => {
    // tile 1 is the second column: full width, so cells stay 64 wide
    expect(patchIndexToBox(64, g)).toEqual({ x: 512, y: 0, w: 64, h: 64 });
  });

  it("shrinks cells in a SHORT bottom-row tile rather than overflowing", () => {
    // tile 3 = row 1, col 0. That row is only 800-512=288 tall in scaled space,
    // and the preprocessor stretched it to 512 before encoding, so each of the
    // 8 token rows covers 288/8 = 36px of source, not 64.
    expect(patchIndexToBox(3 * 64, g)).toEqual({ x: 0, y: 512, w: 64, h: 36 });
  });

  it("lands the last token row exactly on the bottom edge", () => {
    // tile 4, token 56 -> gx 0, gy 7 -> y = 512 + 7*36 = 764, h = 36 -> 800
    const box = patchIndexToBox(4 * 64 + 56, g)!;
    expect(box.y + box.h).toBeCloseTo(800, 6);
    expect(box.h).toBeGreaterThan(0); // never a degenerate highlight
  });

  it("keeps every token box inside the frame", () => {
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

  it("maps a global-tile token to the whole frame", () => {
    const box = patchIndexToBox(6 * 64, g); // tile index 6 == cols*rows
    expect(box).toEqual({ x: 0, y: 0, w: 1280, h: 800 });
  });

  it("returns null past the end or below zero", () => {
    expect(patchIndexToBox(expectedTokenCount(g), g)).toBeNull();
    expect(patchIndexToBox(-1, g)).toBeNull();
    expect(patchIndexToBox(1.5, g)).toBeNull();
  });

  it("rescales back to source pixels when the image was downscaled", () => {
    const big = computeTileGeometry(4096, 2048); // scale 0.5
    // token 0 covers 64px in scaled space -> 128px in source space
    expect(patchIndexToBox(0, big)).toEqual({ x: 0, y: 0, w: 128, h: 128 });
  });

  it("derives token count from the config, not a hardcoded 64", () => {
    expect(DEFAULT_TILE_CONFIG.tileSize).toBe(512);
    // (256/16)^2 / 4^2 = 256/16 = 16 tokens, a 4x4 grid, so cells are 256/4=64.
    const g2 = computeTileGeometry(256, 256, { ...DEFAULT_TILE_CONFIG, tileSize: 256 });
    expect(g2.tokensPerTile).toBe(16);
    expect(g2.tokenGrid).toBe(4);
    expect(expectedTokenCount(g2)).toBe(16); // single tile, no global view
    expect(patchIndexToBox(0, g2)).toEqual({ x: 0, y: 0, w: 64, h: 64 });
  });

  it("tracks a smaller patch size", () => {
    // (512/8)^2 / 4^2 = 4096/16 = 256 tokens, a 16x16 grid -> 32px cells.
    const g3 = computeTileGeometry(512, 512, { ...DEFAULT_TILE_CONFIG, patchSize: 8 });
    expect(g3.tokensPerTile).toBe(256);
    expect(g3.tokenGrid).toBe(16);
    expect(patchIndexToBox(0, g3)).toEqual({ x: 0, y: 0, w: 32, h: 32 });
  });
});
