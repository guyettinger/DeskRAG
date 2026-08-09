import { describe, expect, it } from "vitest";
import { FakeSummaryProvider } from "../src/embed/summary.js";
import { validatePartition } from "../src/represent/compose/agglomerate.js";
import { composePrompt, parseComposeResponse } from "../src/represent/compose/prompt.js";
import type { ChildSummary } from "../src/represent/compose/types.js";

const kid = (i: number, text: string, app: string | null = "Calculator"): ChildSummary => ({
  index: i,
  text,
  app,
  url: null,
  startSec: i,
  endSec: i + 1,
  barrier: false,
});

describe("composePrompt", () => {
  it("numbers steps from zero and names the app", () => {
    const p = composePrompt([kid(0, "clicked 7"), kid(1, "clicked +")], 1);
    expect(p).toContain("0. [Calculator] clicked 7");
    expect(p).toContain("1. [Calculator] clicked +");
    expect(p).toContain("These are individual actions.");
  });

  it("changes the framing above level 1", () => {
    expect(composePrompt([kid(0, "a")], 2)).toContain("already-grouped");
  });

  it("collapses whitespace so a multi-line caption stays ONE step", () => {
    expect(composePrompt([kid(0, "a\n\n  b")], 1)).toContain("0. [Calculator] a b");
  });

  it("omits the bracket when the app is unknown", () => {
    expect(composePrompt([kid(0, "something", null)], 1)).toContain("0. something");
  });
});

describe("parseComposeResponse", () => {
  it("closes cut points into ranges against the block's size", () => {
    const raw = '{"groups":[{"start":0,"summary":"a"},{"start":2,"summary":"b"}]}';
    expect(parseComposeResponse(raw, 5, 0)).toEqual([
      { start: 0, end: 2, summary: "a" },
      { start: 2, end: 5, summary: "b" },
    ]);
  });

  it("shifts by the block offset", () => {
    const raw = '{"groups":[{"start":0,"summary":"added numbers"}]}';
    expect(parseComposeResponse(raw, 2, 10)).toEqual([
      { start: 10, end: 12, summary: "added numbers" },
    ]);
  });

  /**
   * The measurement this contract exists for. Asked for {start,end} ranges over
   * 24 real steps, the model returned a GOOD three-task grouping that ended at
   * 23 — dropping the last step, so the covering check discarded all of it.
   * Stating only where a run begins makes that mistake unstateable.
   */
  it("cannot express a gap, an overlap or a short cover", () => {
    const raw =
      '{"groups":[{"start":0,"summary":"a"},{"start":2,"summary":"b"},{"start":12,"summary":"c"}]}';
    const out = parseComposeResponse(raw, 24, 0)!;
    let cursor = 0;
    for (const g of out) {
      expect(g.start).toBe(cursor);
      cursor = g.end;
    }
    // The last run reaches the block's end whatever the model said.
    expect(cursor).toBe(24);
  });

  it("finds the object inside prose or a code fence", () => {
    const raw = 'Sure!\n```json\n{"groups":[{"start":0,"summary":"x"}]}\n```';
    expect(parseComposeResponse(raw, 1, 0)).toEqual([{ start: 0, end: 1, summary: "x" }]);
  });

  it("returns undefined for unparseable or wrongly-typed replies", () => {
    expect(parseComposeResponse("no json here", 4, 0)).toBeUndefined();
    expect(parseComposeResponse("{ not json", 4, 0)).toBeUndefined();
    expect(parseComposeResponse('{"groups":"nope"}', 4, 0)).toBeUndefined();
    expect(parseComposeResponse('{"groups":[]}', 4, 0)).toBeUndefined();
    // The real malformed reply these models produce: the wrong key entirely.
    expect(parseComposeResponse('{"groups":[{"partition":1}]}', 4, 0)).toBeUndefined();
  });

  it("defaults a missing summary to empty, letting the caller roll one up", () => {
    expect(parseComposeResponse('{"groups":[{"start":0}]}', 1, 0)).toEqual([
      { start: 0, end: 1, summary: "" },
    ]);
  });

  it("does NOT validate the cut points — that is still the caller's job", () => {
    // Out of order, and past the end: both parse, and validatePartition rejects.
    const raw = '{"groups":[{"start":0,"summary":"a"},{"start":99,"summary":"b"}]}';
    const out = parseComposeResponse(raw, 4, 0);
    expect(out).toHaveLength(2);
    expect(validatePartition(out!, 0, 4)).toBe(false);

    const backwards = '{"groups":[{"start":3,"summary":"a"},{"start":1,"summary":"b"}]}';
    expect(validatePartition(parseComposeResponse(backwards, 4, 0)!, 0, 4)).toBe(false);
  });
});

describe("FakeSummaryProvider", () => {
  it("is deterministic and covers every child exactly once", async () => {
    const kids = [kid(0, "a"), kid(1, "b"), kid(2, "c")];
    const p = new FakeSummaryProvider(2);
    const first = await p.compose(kids, { level: 1 });
    expect(first).toEqual(await p.compose(kids, { level: 1 }));

    let cursor = 0;
    for (const g of first) {
      expect(g.start).toBe(cursor);
      cursor = g.end;
    }
    expect(cursor).toBe(3);
  });
});
