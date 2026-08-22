/**
 * Where a hover card lands.
 *
 * Extracted from `TrackRail`'s readout card so the Habits ledger's card can use
 * the same rule — two copies of one clamp is the `ax-dump`/`ax-exec` drift
 * hazard, and the failure mode is a card half off the screen on one surface
 * only. The measurement behind it: the rail's card flipped on a 336x260
 * ESTIMATE while the real thing is ~550px tall with sixteen lanes, so it ran
 * off the bottom of the window exactly when the reader had asked for
 * everything.
 */

import { describe, expect, it } from "vitest";
import { clampTip } from "../app/src/renderer/src/screens/hover-card.js";

describe("clampTip", () => {
  const view = { width: 1000, height: 800 };
  const opts = { offset: 10, margin: 8 };

  it("sits off the cursor when there is room", () => {
    expect(clampTip({ x: 100, y: 100 }, { width: 200, height: 120 }, view, opts)).toEqual({
      left: 110,
      top: 110,
    });
  });

  /**
   * FLIPPED sideways: a card that would overflow the right edge has the whole
   * left of the cursor to live in, so it moves there whole rather than being
   * squeezed against the edge.
   */
  it("flips to the left of the cursor at the right edge", () => {
    expect(clampTip({ x: 950, y: 100 }, { width: 200, height: 120 }, view, opts)).toEqual({
      left: 740,
      top: 110,
    });
  });

  /**
   * CLAMPED vertically, never flipped: a card taller than the space on either
   * side has no good anchor at all, so it is pinned inside the window.
   */
  it("clamps at the bottom rather than flipping above the cursor", () => {
    expect(clampTip({ x: 100, y: 780 }, { width: 200, height: 120 }, view, opts)).toEqual({
      left: 110,
      top: 672,
    });
  });

  it("keeps the margin when the card is bigger than the window", () => {
    const out = clampTip({ x: 990, y: 790 }, { width: 1200, height: 900 }, view, opts);
    expect(out).toEqual({ left: 8, top: 8 });
  });
});
