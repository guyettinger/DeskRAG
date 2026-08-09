import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_CAP,
  coherence,
  splitIntoBlocks,
  structuralRanges,
  validatePartition,
} from "../src/represent/compose/agglomerate.js";
import type { ChildSummary } from "../src/represent/compose/types.js";

function kid(i: number, over: Partial<ChildSummary> = {}): ChildSummary {
  return {
    index: i,
    text: `child ${i}`,
    app: "Calculator",
    url: null,
    startSec: i,
    endSec: i + 0.5,
    barrier: false,
    ...over,
  };
}

describe("validatePartition", () => {
  const g = (start: number, end: number) => ({ start, end, summary: "s" });

  it("accepts a contiguous covering partition", () => {
    expect(validatePartition([g(0, 2), g(2, 5)], 0, 5)).toBe(true);
    expect(validatePartition([g(3, 7)], 3, 7)).toBe(true);
  });

  it("rejects a gap, an overlap, an empty group and a short cover", () => {
    expect(validatePartition([g(0, 2), g(3, 5)], 0, 5)).toBe(false); // gap
    expect(validatePartition([g(0, 3), g(2, 5)], 0, 5)).toBe(false); // overlap
    expect(validatePartition([g(0, 0), g(0, 5)], 0, 5)).toBe(false); // empty
    expect(validatePartition([g(0, 4)], 0, 5)).toBe(false); // short
    expect(validatePartition([], 0, 5)).toBe(false); // none
  });

  it("rejects a group that runs past the block", () => {
    expect(validatePartition([g(0, 9)], 0, 5)).toBe(false);
  });

  it("rejects a partition that does not start where the block does", () => {
    expect(validatePartition([g(1, 5)], 0, 5)).toBe(false);
  });

  it("rejects non-integer indices — the model must name children that exist", () => {
    expect(validatePartition([{ start: 0, end: 2.5, summary: "s" }], 0, 5)).toBe(false);
  });
});

describe("splitIntoBlocks", () => {
  it("splits at a barrier — a bookmark outranks every similarity score", () => {
    const kids = [kid(0), kid(1), kid(2, { barrier: true }), kid(3)];
    expect(splitIntoBlocks(kids, DEFAULT_BATCH_CAP)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("returns one block when nothing bars and nothing exceeds the cap", () => {
    expect(splitIntoBlocks([kid(0), kid(1), kid(2)], DEFAULT_BATCH_CAP)).toEqual([
      { start: 0, end: 3 },
    ]);
  });

  it("ignores a barrier on the very first child — there is nothing to its left", () => {
    const kids = [kid(0, { barrier: true }), kid(1)];
    expect(splitIntoBlocks(kids, DEFAULT_BATCH_CAP)).toEqual([{ start: 0, end: 2 }]);
  });

  it("splits an over-cap block at its largest gap", () => {
    const kids = [
      kid(0, { startSec: 0, endSec: 1 }),
      kid(1, { startSec: 1, endSec: 2 }),
      kid(2, { startSec: 2, endSec: 3 }),
      kid(3, { startSec: 40, endSec: 41 }),
      kid(4, { startSec: 41, endSec: 42 }),
    ];
    const blocks = splitIntoBlocks(kids, 2);
    expect(blocks.every((b) => b.end - b.start <= 2)).toBe(true);
    // The 37s gap must be a block edge.
    expect(blocks.some((b) => b.start === 3)).toBe(true);
    // And the blocks still tile the level exactly.
    let cursor = 0;
    for (const b of blocks) {
      expect(b.start).toBe(cursor);
      cursor = b.end;
    }
    expect(cursor).toBe(5);
  });

  it("returns [] for no children", () => {
    expect(splitIntoBlocks([], DEFAULT_BATCH_CAP)).toEqual([]);
  });

  it("is translation invariant — a uniform time shift changes nothing", () => {
    const base = [kid(0), kid(1, { app: "Chrome" }), kid(2), kid(3)];
    const shifted = base.map((c) => ({
      ...c,
      startSec: c.startSec + 987.654,
      endSec: c.endSec + 987.654,
    }));
    expect(splitIntoBlocks(shifted, 2)).toEqual(splitIntoBlocks(base, 2));
  });
});

describe("structuralRanges", () => {
  it("at least halves the block, so recursion always terminates", () => {
    const kids = Array.from({ length: 9 }, (_, i) => kid(i));
    const out = structuralRanges(kids, { start: 0, end: 9 });
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out[0]!.start).toBe(0);
    expect(out[out.length - 1]!.end).toBe(9);
  });

  it("produces a contiguous covering partition of the block", () => {
    const kids = Array.from({ length: 7 }, (_, i) => kid(i));
    const out = structuralRanges(kids, { start: 2, end: 7 });
    let cursor = 2;
    for (const r of out) {
      expect(r.start).toBe(cursor);
      cursor = r.end;
    }
    expect(cursor).toBe(7);
  });

  it("never returns an empty list, even for a single child", () => {
    expect(structuralRanges([kid(0)], { start: 0, end: 1 })).toEqual([{ start: 0, end: 1 }]);
  });

  it("prefers merging same-app neighbours over a cross-app seam", () => {
    const kids = [
      kid(0, { app: "Calculator" }),
      kid(1, { app: "Calculator" }),
      kid(2, { app: "Google Chrome" }),
      kid(3, { app: "Google Chrome" }),
    ];
    expect(structuralRanges(kids, { start: 0, end: 4 })).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("is translation invariant", () => {
    const base = Array.from({ length: 6 }, (_, i) => kid(i));
    const shifted = base.map((c) => ({
      ...c,
      startSec: c.startSec + 4242.4242,
      endSec: c.endSec + 4242.4242,
    }));
    expect(structuralRanges(shifted, { start: 0, end: 6 })).toEqual(
      structuralRanges(base, { start: 0, end: 6 }),
    );
  });
});

describe("coherence", () => {
  it("scores a same-app small-gap seam above a cross-app long-gap one", () => {
    const near = coherence(kid(0), kid(1));
    const far = coherence(
      kid(0, { app: "Calculator", endSec: 1 }),
      kid(1, { app: "Chrome", startSec: 30 }),
    );
    expect(near).toBeGreaterThan(far);
  });

  it("counts a shared url on top of a shared app", () => {
    const withUrl = coherence(
      kid(0, { url: "github.com/x" }),
      kid(1, { url: "github.com/x" }),
    );
    expect(withUrl).toBeGreaterThan(coherence(kid(0), kid(1)));
  });

  it("treats an unknown app as no evidence, never as a match", () => {
    expect(coherence(kid(0, { app: null }), kid(1, { app: null }))).toBeLessThan(
      coherence(kid(0), kid(1)),
    );
  });
});
