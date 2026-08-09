import { describe, expect, it } from "vitest";
import { FakeSummaryProvider } from "../src/embed/summary.js";
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
  it("parses groups and shifts them by the block offset", () => {
    const raw = '{"groups":[{"start":0,"end":2,"summary":"added numbers"}]}';
    expect(parseComposeResponse(raw, 10)).toEqual([
      { start: 10, end: 12, summary: "added numbers" },
    ]);
  });

  it("finds the object inside prose or a code fence", () => {
    const raw = 'Sure!\n```json\n{"groups":[{"start":0,"end":1,"summary":"x"}]}\n```';
    expect(parseComposeResponse(raw, 0)).toEqual([{ start: 0, end: 1, summary: "x" }]);
  });

  it("returns undefined for unparseable or wrongly-typed replies", () => {
    expect(parseComposeResponse("no json here", 0)).toBeUndefined();
    expect(parseComposeResponse("{ not json", 0)).toBeUndefined();
    expect(parseComposeResponse('{"groups":"nope"}', 0)).toBeUndefined();
    expect(parseComposeResponse('{"groups":[{"start":"a","end":1}]}', 0)).toBeUndefined();
  });

  it("defaults a missing summary to empty, letting the caller roll one up", () => {
    expect(parseComposeResponse('{"groups":[{"start":0,"end":1}]}', 0)).toEqual([
      { start: 0, end: 1, summary: "" },
    ]);
  });

  it("does NOT validate the partition — that is the caller's job", () => {
    // A well-formed reply that is a bad partition must still parse, so the two
    // failures stay distinguishable.
    const raw = '{"groups":[{"start":0,"end":2,"summary":"a"},{"start":5,"end":9,"summary":"b"}]}';
    expect(parseComposeResponse(raw, 0)).toHaveLength(2);
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
