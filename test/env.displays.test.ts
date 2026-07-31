import { describe, expect, it } from "vitest";
import { displayIdAt, outsideKnownDisplays } from "../src/capture/env/displays.js";
import type { DisplayInfo } from "../src/capture/env/types.js";

const primary: DisplayInfo = { id: "1", x: 0, y: 0, w: 2560, h: 1440, scale: 2, primary: true };
const right: DisplayInfo = { id: "2", x: 2560, y: 0, w: 1920, h: 1080, scale: 1, primary: false };
const both = [primary, right];

describe("displayIdAt", () => {
  it("finds the containing display", () => {
    expect(displayIdAt(both, { x: 100, y: 100 })).toBe("1");
    expect(displayIdAt(both, { x: 3000, y: 500 })).toBe("2");
  });

  it("treats the left/top edge as inside and the right/bottom edge as the next display", () => {
    // Half-open intervals, or the seam between adjacent displays is ambiguous.
    expect(displayIdAt(both, { x: 2560, y: 0 })).toBe("2");
    expect(displayIdAt(both, { x: 2559, y: 0 })).toBe("1");
  });

  it("falls back to the primary display for a point on no display", () => {
    expect(displayIdAt(both, { x: -500, y: -500 })).toBe("1");
    expect(displayIdAt(both, { x: 9999, y: 9999 })).toBe("1");
  });

  it("falls back to the first display when none is flagged primary", () => {
    expect(displayIdAt([{ ...right, primary: false }], { x: -1, y: -1 })).toBe("2");
  });

  it("returns D0 with no displays at all — the same default lift already uses", () => {
    expect(displayIdAt([], { x: 0, y: 0 })).toBe("D0");
  });
});

describe("outsideKnownDisplays", () => {
  it("is false for a window on a known display", () => {
    expect(outsideKnownDisplays(both, { x: 100, y: 100, w: 800, h: 600 })).toBe(false);
    expect(outsideKnownDisplays(both, { x: 2600, y: 50, w: 400, h: 300 })).toBe(false);
  });

  it("is false for a window straddling two displays", () => {
    expect(outsideKnownDisplays(both, { x: 2400, y: 100, w: 400, h: 300 })).toBe(false);
  });

  it("is TRUE for a window wholly outside every display — the re-query signal", () => {
    expect(outsideKnownDisplays(both, { x: 6000, y: 0, w: 800, h: 600 })).toBe(true);
    expect(outsideKnownDisplays(both, { x: 0, y: -2000, w: 800, h: 600 })).toBe(true);
  });

  it("is false with no known displays — nothing to contradict, so do not thrash", () => {
    expect(outsideKnownDisplays([], { x: 0, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it("ignores a degenerate window rather than treating it as a signal", () => {
    expect(outsideKnownDisplays(both, { x: 9999, y: 9999, w: 0, h: 0 })).toBe(false);
  });
});
