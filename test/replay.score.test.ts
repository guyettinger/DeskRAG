import { describe, expect, it } from "vitest";
import { agreement, LAYER_CEILING, pathCeiling, pathDepth } from "../src/replay/types.js";

describe("agreement", () => {
  const box = { x: 100, y: 100, w: 80, h: 40 };

  it("is 1 for an identical box", () => {
    expect(agreement(box, { ...box })).toBe(1);
  });

  it("falls off as the centre moves away", () => {
    const near = agreement(box, { x: 104, y: 100, w: 80, h: 40 });
    const far = agreement(box, { x: 160, y: 100, w: 80, h: 40 });
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThan(1);
  });

  it("falls off as the area diverges, even with the same centre", () => {
    // Same centre (140,120), quarter the area.
    expect(agreement(box, { x: 120, y: 110, w: 40, h: 20 })).toBeLessThan(1);
  });

  it("is 0 when the boxes are disjoint and far apart", () => {
    expect(agreement(box, { x: 3000, y: 2000, w: 80, h: 40 })).toBe(0);
  });

  it("never returns a value outside [0,1]", () => {
    for (const other of [
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 100, y: 100, w: 8000, h: 4000 },
      { x: -500, y: -500, w: 80, h: 40 },
    ]) {
      const a = agreement(box, other);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it("tolerates a degenerate recorded box without dividing by zero", () => {
    expect(Number.isFinite(agreement({ x: 0, y: 0, w: 0, h: 0 }, box))).toBe(true);
  });
});

describe("LAYER_CEILING", () => {
  it("ranks the fixed rungs identifier > label > visual > point", () => {
    expect(LAYER_CEILING.identifier).toBeGreaterThan(LAYER_CEILING.label);
    expect(LAYER_CEILING.label).toBeGreaterThan(LAYER_CEILING.visual);
    expect(LAYER_CEILING.visual).toBeGreaterThan(LAYER_CEILING.point);
  });
});

describe("pathDepth", () => {
  it("counts the steps in an ancestor chain", () => {
    expect(pathDepth("Window[0]")).toBe(1);
    expect(pathDepth("Window[0]>Group[0]>Button[1]")).toBe(3);
  });

  it("treats an empty path as depth 0", () => {
    expect(pathDepth("")).toBe(0);
  });
});

/**
 * A path's reliability is not a constant — it collapses with depth, and the
 * three AX implementations measured disagree about which of label/path to
 * prefer precisely because their depths differ. A fixed order cannot satisfy
 * both AppKit (mean depth 4) and Chromium (mean 11.4, max 17).
 */
describe("pathCeiling", () => {
  it("puts a shallow native path above a label", () => {
    // TextEdit measured mean depth 4.0.
    expect(pathCeiling(1)).toBeGreaterThan(LAYER_CEILING.label);
    expect(pathCeiling(4)).toBeGreaterThan(LAYER_CEILING.label);
  });

  it("puts a deep web path below a label", () => {
    // Chrome measured mean 11.4, max 17.
    expect(pathCeiling(11)).toBeLessThan(LAYER_CEILING.label);
    expect(pathCeiling(17)).toBeLessThan(LAYER_CEILING.label);
  });

  it("never decays below the visual rung, so path is always tried first", () => {
    expect(pathCeiling(50)).toBeGreaterThan(LAYER_CEILING.visual);
  });

  it("is monotonically non-increasing in depth", () => {
    for (let d = 1; d < 30; d++) {
      expect(pathCeiling(d + 1)).toBeLessThanOrEqual(pathCeiling(d));
    }
  });

  it("stays within [0,1]", () => {
    for (const d of [0, 1, 5, 20, 100]) {
      expect(pathCeiling(d)).toBeGreaterThanOrEqual(0);
      expect(pathCeiling(d)).toBeLessThanOrEqual(1);
    }
  });
});
