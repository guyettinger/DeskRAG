import { describe, expect, it } from "vitest";
import { rollupText } from "../src/represent/compose/rollup.js";
import type { ChildSummary } from "../src/represent/compose/types.js";

function kid(i: number, over: Partial<ChildSummary> = {}): ChildSummary {
  return {
    index: i,
    text: `child ${i}`,
    app: "Calculator",
    url: null,
    startSec: i,
    endSec: i + 1,
    barrier: false,
    ...over,
  };
}

describe("rollupText", () => {
  it("names the apps spanned, the child count and the duration", () => {
    const kids = [kid(0), kid(1, { app: "Google Chrome" }), kid(2, { app: "Google Chrome" })];
    expect(rollupText(kids, { start: 0, end: 3 }, 1)).toBe(
      "Calculator, Google Chrome · 3 actions · 3.0s",
    );
  });

  it("says 'groups' above level 1, because its children are not actions", () => {
    expect(rollupText([kid(0), kid(1)], { start: 0, end: 2 }, 2)).toBe(
      "Calculator · 2 groups · 2.0s",
    );
  });

  it("uses the singular for one child", () => {
    expect(rollupText([kid(0)], { start: 0, end: 1 }, 1)).toBe("Calculator · 1 action · 1.0s");
  });

  it("dedupes apps in first-seen order and omits an unknown app", () => {
    const kids = [kid(0, { app: null }), kid(1, { app: "Chrome" }), kid(2, { app: "Chrome" })];
    expect(rollupText(kids, { start: 0, end: 3 }, 1)).toBe("Chrome · 3 actions · 3.0s");
  });

  it("still names the span when NO app is known", () => {
    const kids = [kid(0, { app: null }), kid(1, { app: null })];
    expect(rollupText(kids, { start: 0, end: 2 }, 1)).toBe("2 actions · 2.0s");
  });

  it("summarizes only the range it was given", () => {
    const kids = [kid(0), kid(1, { app: "Chrome" }), kid(2, { app: "Finder" })];
    expect(rollupText(kids, { start: 1, end: 3 }, 1)).toBe("Chrome, Finder · 2 actions · 2.0s");
  });

  it("returns an empty string for an empty range", () => {
    expect(rollupText([kid(0)], { start: 0, end: 0 }, 1)).toBe("");
  });

  it("is translation invariant", () => {
    const base = [kid(0), kid(1)];
    const shifted = base.map((c) => ({ ...c, startSec: c.startSec + 500, endSec: c.endSec + 500 }));
    expect(rollupText(shifted, { start: 0, end: 2 }, 1)).toBe(
      rollupText(base, { start: 0, end: 2 }, 1),
    );
  });
});
