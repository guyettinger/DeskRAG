import { describe, expect, it } from "vitest";
import { MAX_ROLLUP_CHARS, rollupText } from "../src/represent/compose/rollup.js";
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

  /**
   * The chain that a tally used to sever. Measured on a real library, levels 3
   * and 4 were 100% structural, so every root was named from strings like
   * "Electron · 2 groups · 25.1s" — and the root's naming call had nothing but
   * app names in a tally to abstract.
   */
  it("ABOVE LEVEL 1 it composes from the children's own names", () => {
    const kids = [kid(0, { text: "Start calculator" }), kid(1, { text: "Copy result" })];
    expect(rollupText(kids, { start: 0, end: 2 }, 2)).toBe("Start calculator; Copy result");
  });

  it("dedupes repeated child names in first-seen order", () => {
    const kids = [
      kid(0, { text: "Record screen" }),
      kid(1, { text: "Add numbers" }),
      kid(2, { text: "Record screen" }),
    ];
    expect(rollupText(kids, { start: 0, end: 3 }, 2)).toBe("Record screen; Add numbers");
  });

  it("caps a deep composition, since names concatenate up the tree", () => {
    const kids = Array.from({ length: 40 }, (_, i) =>
      kid(i, { text: `a reasonably wordy child summary number ${i}` }),
    );
    const out = rollupText(kids, { start: 0, end: 40 }, 3);
    expect(out.length).toBeLessThanOrEqual(MAX_ROLLUP_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to the tally above level 1 when every child is unnamed", () => {
    const kids = [kid(0, { text: "" }), kid(1, { text: "   " })];
    // Better a tally than an empty summary: absence must not look like silence.
    expect(rollupText(kids, { start: 0, end: 2 }, 2)).toBe("Calculator · 2 groups · 2.0s");
  });

  it("LEVEL 1 keeps the tally — its children are whole VLM captions", () => {
    const kids = [
      kid(0, { text: "A long screenshot description of the calculator window and its state" }),
      kid(1, { text: "Another long screenshot description of a text editor window" }),
    ];
    expect(rollupText(kids, { start: 0, end: 2 }, 1)).toBe("Calculator · 2 actions · 2.0s");
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
