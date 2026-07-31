import { describe, expect, it } from "vitest";
import { agreement, LAYER_CEILING } from "../src/replay/types.js";

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
  // Label outranks path because a positional path's reliability collapses with
  // depth: measured web-content paths run 11-17 levels deep (a Chrome TextField
  // averages 13) against 1-4 for native controls, and any sibling insertion at
  // any level shifts the ordinal. A label is content-dependent but flat.
  it("ranks identifier > label > path > visual > point", () => {
    expect(LAYER_CEILING.identifier).toBeGreaterThan(LAYER_CEILING.label);
    expect(LAYER_CEILING.label).toBeGreaterThan(LAYER_CEILING.path);
    expect(LAYER_CEILING.path).toBeGreaterThan(LAYER_CEILING.visual);
    expect(LAYER_CEILING.visual).toBeGreaterThan(LAYER_CEILING.point);
  });
});
