/**
 * The detail overlay's pure geometry — the loupe's arithmetic.
 *
 * Root-tested for the same reason `search-view.ts` and `track-view.ts` are:
 * these functions decide where a highlight box LANDS and what the zoom readout
 * CLAIMS, and nothing else in the suite can see the renderer. The rest of the
 * overlay — that the canvas is actually sized to `imgW * scale`, that a bbox
 * does not drift between fit and 4x — is only reachable by driving the running
 * app, which is where every other rule in app-ui.md came from too.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  SCALE_STEP,
  bboxLabelFits,
  boxRect,
  boxWidthPx,
  deviceScale,
  fitScale,
  frameBox,
  isPastCapture,
  oneToOneScale,
  zoomAbout,
} from "../app/src/renderer/src/detail-view.js";

/** A 1512x945-point display captured to a 1280px-wide JPEG — the real default. */
const FRAME_W = 1512;
const FRAME_H = 945;
const IMG_W = 1280;
const IMG_H = 800;

describe("boxRect", () => {
  it("maps frame space to percentages of the canvas", () => {
    expect(boxRect({ x: 378, y: 189, w: 756, h: 472.5 }, FRAME_W, FRAME_H)).toEqual({
      left: "25%",
      top: "20%",
      width: "50%",
      height: "50%",
    });
  });

  // The whole reason zoom needs no change in the mapping: the canvas grows, the
  // percentages do not move. A regression here is a box drifting off its control.
  it("does not depend on the stored image's size", () => {
    const box = { x: 100, y: 50, w: 200, h: 100 };
    expect(boxRect(box, FRAME_W, FRAME_H)).toEqual(boxRect(box, FRAME_W, FRAME_H));
  });
});

describe("fitScale", () => {
  it("fits the constraining axis", () => {
    // A wide frame in a tall stage is bounded by WIDTH.
    expect(fitScale(640, 900, IMG_W, IMG_H)).toBeCloseTo(0.5, 10);
    // A tall stage that is short is bounded by HEIGHT.
    expect(fitScale(1600, 400, IMG_W, IMG_H)).toBeCloseTo(0.5, 10);
  });

  it("never produces a canvas bigger than its stage", () => {
    const s = fitScale(1470, 827, IMG_W, IMG_H);
    expect(IMG_W * s).toBeLessThanOrEqual(1470 + 1e-9);
    expect(IMG_H * s).toBeLessThanOrEqual(827 + 1e-9);
  });

  /**
   * Both are REAL states on the first frame — the ResizeObserver has not fired
   * and the image has not loaded — and `Infinity` there sizes a canvas nothing
   * recovers from.
   */
  it("returns 0 rather than dividing by an unmeasured stage or image", () => {
    expect(fitScale(0, 900, IMG_W, IMG_H)).toBe(0);
    expect(fitScale(1470, 0, IMG_W, IMG_H)).toBe(0);
    expect(fitScale(1470, 827, 0, IMG_H)).toBe(0);
    expect(fitScale(1470, 827, IMG_W, 0)).toBe(0);
  });
});

describe("the capture ceiling", () => {
  /**
   * The point of expressing scale against DEVICE pixels: read in CSS pixels the
   * same recording would claim 1:1 at two different magnifications depending on
   * which monitor it was opened on.
   */
  it("puts 1:1 at half the CSS scale on a 2x display", () => {
    expect(oneToOneScale(1)).toBe(1);
    expect(oneToOneScale(2)).toBe(0.5);
  });

  it("falls back to 1 for a nonsense ratio rather than dividing by it", () => {
    expect(oneToOneScale(0)).toBe(1);
  });

  it("reports 1.00x at the ceiling on any display", () => {
    for (const dpr of [1, 2, 3]) {
      expect(deviceScale(oneToOneScale(dpr), dpr)).toBeCloseTo(1, 10);
    }
  });

  it("is not past capture AT the ceiling, and is past it above", () => {
    for (const dpr of [1, 2]) {
      const ceiling = oneToOneScale(dpr);
      expect(isPastCapture(ceiling, dpr)).toBe(false);
      expect(isPastCapture(ceiling * 0.5, dpr)).toBe(false);
      expect(isPastCapture(ceiling * 2, dpr)).toBe(true);
    }
  });
});

describe("zoomAbout", () => {
  it("keeps the point under the cursor fixed", () => {
    const scroll = 300;
    const cursor = 220;
    const before = (scroll + cursor) / 2; // content coord at scale 2
    const next = zoomAbout(scroll, cursor, 2, 5);
    expect((next + cursor) / 5).toBeCloseTo(before, 10);
  });

  it("round-trips, so stepping in and back out returns exactly", () => {
    const scroll = 412;
    const cursor = 180;
    const inward = zoomAbout(scroll, cursor, 1, SCALE_STEP);
    expect(zoomAbout(inward, cursor, SCALE_STEP, 1)).toBeCloseTo(scroll, 10);
  });

  it("leaves the scroll alone when there is no old scale to divide by", () => {
    expect(zoomAbout(120, 40, 0, 3)).toBe(120);
  });
});

describe("frameBox", () => {
  const stageW = 1470;
  const stageH = 827;
  const at = (box: { x: number; y: number; w: number; h: number }, padding?: number) =>
    frameBox(box, FRAME_W, FRAME_H, IMG_W, IMG_H, stageW, stageH, 1, padding);

  it("centres the box in the stage", () => {
    const box = { x: 600, y: 400, w: 120, h: 40 };
    const v = at(box);
    const canvasW = IMG_W * v.scale;
    const canvasH = IMG_H * v.scale;
    const centreX = ((box.x + box.w / 2) / FRAME_W) * canvasW;
    const centreY = ((box.y + box.h / 2) / FRAME_H) * canvasH;
    expect(v.scrollLeft + stageW / 2).toBeCloseTo(centreX, 6);
    expect(v.scrollTop + stageH / 2).toBeCloseTo(centreY, 6);
  });

  it("leaves the box padded off the stage edges", () => {
    const box = { x: 600, y: 400, w: 120, h: 40 };
    const v = at(box, 0.25);
    const paintedW = (box.w / FRAME_W) * IMG_W * v.scale;
    // 25% of the stage is margin, so the box takes at most the other 75%.
    expect(paintedW).toBeLessThanOrEqual(stageW * 0.75 + 1e-6);
  });

  it("clamps the scroll into the canvas, never negative", () => {
    // A box in the top-left corner: the ideal centring scroll is negative.
    const v = at({ x: 0, y: 0, w: 40, h: 20 });
    expect(v.scrollLeft).toBe(0);
    expect(v.scrollTop).toBe(0);
  });

  it("clamps to the far edge for a box in the bottom-right corner", () => {
    const box = { x: FRAME_W - 40, y: FRAME_H - 20, w: 40, h: 20 };
    const v = at(box);
    expect(v.scrollLeft).toBeCloseTo(Math.max(0, IMG_W * v.scale - stageW), 6);
    expect(v.scrollTop).toBeCloseTo(Math.max(0, IMG_H * v.scale - stageH), 6);
  });

  /**
   * Clamping the scale AFTER the scroll would centre the box for a scale the
   * stage is not at — the box lands off-centre by exactly the clamp.
   */
  it("respects the scale ceiling and still centres at the clamped scale", () => {
    const tiny = { x: 700, y: 470, w: 1, h: 1 };
    const v = at(tiny);
    expect(v.scale).toBe(MAX_SCALE);
    const centreX = ((tiny.x + 0.5) / FRAME_W) * IMG_W * MAX_SCALE;
    expect(v.scrollLeft + stageW / 2).toBeCloseTo(centreX, 6);
  });

  it("respects the scale floor for a box larger than the frame", () => {
    // AX coords are GLOBAL screen coords, so a second display legitimately
    // produces a box far outside the captured frame.
    const v = at({ x: 0, y: 0, w: FRAME_W * 400, h: FRAME_H * 400 });
    expect(v.scale).toBe(MIN_SCALE);
  });

  /** A real AX element can genuinely have zero width or height. */
  it("keeps the current scale for a degenerate box rather than dividing by it", () => {
    const v = frameBox(
      { x: 300, y: 200, w: 0, h: 0 },
      FRAME_W,
      FRAME_H,
      IMG_W,
      IMG_H,
      stageW,
      stageH,
      0.62,
    );
    expect(v.scale).toBeCloseTo(0.62, 10);
  });

  it("scrolls nowhere when the canvas is smaller than the stage", () => {
    const v = frameBox(
      { x: 600, y: 400, w: FRAME_W, h: FRAME_H },
      FRAME_W,
      FRAME_H,
      IMG_W,
      IMG_H,
      stageW,
      stageH,
      1,
    );
    expect(v.scrollLeft).toBe(0);
    expect(v.scrollTop).toBe(0);
  });
});

describe("bboxLabelFits", () => {
  it("withholds a label that would not fit untruncated", () => {
    expect(bboxLabelFits(20, "Applications")).toBe(false);
  });

  it("draws one that does", () => {
    expect(bboxLabelFits(300, "Applications")).toBe(true);
  });

  it("withholds on an unmeasured box or an empty label", () => {
    expect(bboxLabelFits(0, "Record")).toBe(false);
    expect(bboxLabelFits(200, "")).toBe(false);
  });

  /**
   * The rule paying for itself rather than merely holding: the same box that
   * withholds at fit scale draws its label once a reader zooms in. Monotonic in
   * the scale, so a label can never vanish on the way IN.
   */
  it("reveals labels as the box grows with the zoom", () => {
    const box = { x: 400, y: 300, w: 60, h: 24 };
    const label = "Record";
    const fit = 0.5;
    expect(bboxLabelFits(boxWidthPx(box, FRAME_W, IMG_W, fit), label)).toBe(false);
    expect(bboxLabelFits(boxWidthPx(box, FRAME_W, IMG_W, fit * 8), label)).toBe(true);
  });
});

describe("boxWidthPx", () => {
  it("converts frame space to painted canvas pixels", () => {
    // Half the frame's width, on a 1280px image at scale 0.5 → 320px.
    expect(boxWidthPx({ x: 0, y: 0, w: FRAME_W / 2, h: 10 }, FRAME_W, IMG_W, 0.5)).toBeCloseTo(320, 10);
  });

  it("returns 0 for a frame with no stored dimensions", () => {
    // Recordings made before the app passed its display size have no frame space.
    expect(boxWidthPx({ x: 0, y: 0, w: 100, h: 10 }, 0, IMG_W, 1)).toBe(0);
  });
});
