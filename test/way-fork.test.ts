import { describe, expect, it } from "vitest";
import { placeKey, spineOf } from "../app/src/main/way-fork.js";
import type { FlowStep, FlowWalk } from "../app/src/main/flow-steps.js";

/**
 * The four Ways below are the REAL ones, read off the store on 2026-08-23:
 * the Calculator → TextEdit route, 4 recordings, 4 Ways, one recording each.
 * They are here rather than as tidy synthetic letters because two of their
 * shapes killed a design — Way C's `n0 — no state` head makes the common
 * PREFIX across all four empty, and Way D repeats `TextEdit → TextEdit` five
 * times in a row.
 */
const step = (index: number, from: string, to: string): FlowStep => ({
  index,
  edgeId: `e${index}`,
  from,
  to,
  actions: [],
  observations: 1,
  everyRecording: false,
  firstAt: null,
  sourcesBelowObservations: false,
  liftWarnings: [],
  missing: false,
});

/** `[["A","B"],["B","C"]]` -> a walk of two steps. */
const way = (index: number, sessionIds: string[], hops: [string, string][]): FlowWalk => ({
  index,
  sessionIds,
  steps: hops.map(([from, to], i) => step(i, from, to)),
});

const CALC = "Calculator";
const TE = "TextEdit";
const FI = "Finder";
const NO = "n0 — no state";

const WAY_A = way(0, ["sA"], [
  [CALC, CALC],
  [CALC, CALC],
  [CALC, TE],
  [TE, TE],
  [TE, TE],
]);
const WAY_B = way(1, ["sB"], [
  [CALC, CALC],
  [CALC, CALC],
  [CALC, TE],
  [TE, TE],
]);
const WAY_C = way(2, ["sC"], [
  [NO, CALC],
  [CALC, CALC],
  [CALC, TE],
  [TE, TE],
]);
const WAY_D = way(3, ["sD"], [
  [CALC, CALC],
  [CALC, CALC],
  [CALC, TE],
  [TE, TE],
  [TE, TE],
  [TE, TE],
  [TE, TE],
  [TE, TE],
  [TE, FI],
  [FI, FI],
  [FI, FI],
  [FI, TE],
  [TE, TE],
]);

describe("spineOf", () => {
  it("is empty for no ways", () => {
    expect(spineOf([])).toEqual([]);
  });

  it("is the whole walk for a single way", () => {
    expect(spineOf([WAY_B])).toEqual([
      placeKey(step(0, CALC, CALC)),
      placeKey(step(0, CALC, CALC)),
      placeKey(step(0, CALC, TE)),
      placeKey(step(0, TE, TE)),
    ]);
  });

  it("drops the step one way lacks", () => {
    // A has a trailing TextEdit step that B does not.
    expect(spineOf([WAY_A, WAY_B])).toHaveLength(4);
  });

  it("finds the three-step spine of the four REAL ways", () => {
    // Calculator work, hand off to TextEdit, TextEdit work.
    expect(spineOf([WAY_A, WAY_B, WAY_C, WAY_D])).toEqual([
      placeKey(step(0, CALC, CALC)),
      placeKey(step(0, CALC, TE)),
      placeKey(step(0, TE, TE)),
    ]);
  });

  it("survives an empty common PREFIX", () => {
    // Way C begins at `n0 — no state` and the others begin at Calculator, so
    // the longest common prefix is empty. A prefix/suffix rule reports
    // "everything differed" here; a subsequence does not.
    const spine = spineOf([WAY_A, WAY_C]);
    expect(spine.length).toBeGreaterThan(0);
    expect(spine[0]).toBe(placeKey(step(0, CALC, CALC)));
  });

  it("does not over-match a place label that repeats", () => {
    // D holds five consecutive TextEdit → TextEdit steps. The spine may claim
    // at most as many as the SHORTEST way has.
    const spine = spineOf([WAY_B, WAY_D]);
    const tt = spine.filter((k) => k === placeKey(step(0, TE, TE))).length;
    expect(tt).toBe(1);
  });

  it("is a subsequence of every way it was folded from", () => {
    const spine = spineOf([WAY_A, WAY_B, WAY_C, WAY_D]);
    for (const w of [WAY_A, WAY_B, WAY_C, WAY_D]) {
      const keys = w.steps.map(placeKey);
      let k = 0;
      for (const key of keys) if (k < spine.length && key === spine[k]) k += 1;
      expect(k).toBe(spine.length);
    }
  });
});
