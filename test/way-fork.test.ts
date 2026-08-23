import { describe, expect, it } from "vitest";
import {
  FORK_VERDICT_MIN_WALKS,
  forkRows,
  placeKey,
  runPhrase,
  spineOf,
  verdictFor,
  type WaySummary,
} from "../app/src/main/way-fork.js";
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

describe("forkRows", () => {
  const rows = forkRows([WAY_A, WAY_B, WAY_C, WAY_D], spineOf([WAY_A, WAY_B, WAY_C, WAY_D]));
  const spines = rows.filter((r) => r.kind === "spine");
  const forks = rows.filter((r) => r.kind === "fork");

  it("emits one spine row per spine position, in order", () => {
    expect(spines.map((r) => (r.kind === "spine" ? `${r.from}>${r.to}` : ""))).toEqual([
      `${CALC}>${CALC}`,
      `${CALC}>${TE}`,
      `${TE}>${TE}`,
    ]);
  });

  it("carries EVERY way's own step on a spine row", () => {
    // The step differs per way even where the PLACES agree — this is what lets
    // both surfaces show that one recording pasted where another retyped.
    const first = spines[0];
    expect(first?.kind === "spine" && first.at.map((a) => a.wayIndex)).toEqual([0, 1, 2, 3]);
  });

  it("emits a fork row only where at least one way filled the gap", () => {
    // Gap 0 (Way C's `n0` head), gap 1 (the extra Calculator step), and the
    // trailing gap. The gap between `Calculator → TextEdit` and
    // `TextEdit → TextEdit` is empty in all four and must not be drawn.
    expect(forks.map((r) => (r.kind === "fork" ? r.after : NaN))).toEqual([-1, 0, 2]);
  });

  it("keeps a way with nothing to add PRESENT with an empty run", () => {
    // "B did nothing here" and "B is not in this picture" are different facts.
    const leading = forks[0];
    expect(leading?.kind === "fork" && leading.runs.map((r) => r.steps.length)).toEqual([0, 0, 1, 0]);
  });

  it("attributes the whole Finder excursion to one trailing run", () => {
    const trailing = forks[2];
    const d = trailing?.kind === "fork" ? trailing.runs.find((r) => r.wayIndex === 3) : undefined;
    expect(d?.steps).toHaveLength(9);
  });

  it("draws no fork rows at all when the ways agree", () => {
    const same = forkRows([WAY_B, { ...WAY_B, index: 1, sessionIds: ["sX"] }], spineOf([WAY_B]));
    expect(same.every((r) => r.kind === "spine")).toBe(true);
  });
});

describe("runPhrase", () => {
  it("names both places for a single step, because the FROM is the news", () => {
    // Way C's leading run: the interesting fact is that it came from no state.
    expect(runPhrase({ wayIndex: 2, steps: [step(0, NO, CALC)] }, -1)).toBe(
      `first, 1 step: ${NO} → ${CALC}`,
    );
  });

  it("counts and lists the places for a run of several", () => {
    expect(
      runPhrase({ wayIndex: 3, steps: [step(0, TE, TE), step(1, TE, FI), step(2, FI, TE)] }, 2),
    ).toBe(`then 3 steps, via ${TE}, ${FI}`);
  });

  it("says nothing happened rather than going blank", () => {
    expect(runPhrase({ wayIndex: 1, steps: [] }, 0)).toBe("nothing here");
  });
});

const summary = (letter: string, totalsMs: number[], wayIndex = 0): WaySummary => ({
  wayIndex,
  letter,
  steps: 4,
  sessionIds: totalsMs.map((_, i) => `${letter}${i}`),
  totalsMs,
});

describe("verdictFor", () => {
  it("withholds, with a reason, when there is only one way", () => {
    const v = verdictFor([summary("A", [1000, 2000])]);
    expect(v.kind).toBe("withheld");
    expect(v.kind === "withheld" && v.reason).toMatch(/only one way/i);
  });

  it("withholds below the floor and NAMES the thin ways", () => {
    // This is the real store as of 2026-08-23: four ways, one recording each.
    const v = verdictFor([summary("A", [39300]), summary("B", [24000], 1)]);
    expect(v.kind).toBe("withheld");
    expect(v.kind === "withheld" && v.reason).toBe(
      "Way A, Way B have fewer than 2 timed recordings, so nothing here says one way is better.",
    );
  });

  it("withholds on OVERLAPPING ranges and prints both", () => {
    const v = verdictFor([summary("A", [24000, 39300]), summary("B", [22100, 39900], 1)]);
    expect(v.kind).toBe("withheld");
    expect(v.kind === "withheld" && v.reason).toBe(
      "Their times overlap (B 22.1–39.9s, A 24.0–39.3s), so these recordings do not say one is faster.",
    );
  });

  it("fires only when the SLOWEST of one beat the FASTEST of every other", () => {
    const v = verdictFor([summary("B", [22100, 25900]), summary("D", [60200, 62300], 1)]);
    expect(v).toEqual({
      kind: "named",
      text: "Every recording of Way B (22.1–25.9s) was faster than every recording of Way D (60.2–62.3s).",
    });
  });

  it("lists every other way when there are more than two", () => {
    const v = verdictFor([
      summary("B", [22100, 25900]),
      summary("A", [30000, 39300], 1),
      summary("D", [60200, 62300], 2),
    ]);
    expect(v.kind === "named" && v.text).toBe(
      "Every recording of Way B (22.1–25.9s) was faster than every recording of Way A (30.0–39.3s) and Way D (60.2–62.3s).",
    );
  });

  it("withholds when fewer than two ways have any timed recording", () => {
    const v = verdictFor([summary("A", [22100, 25900]), summary("B", [], 1)]);
    expect(v.kind).toBe("withheld");
    expect(v.kind === "withheld" && v.reason).toMatch(/timed recording/i);
  });

  it("holds the floor at 2", () => {
    expect(FORK_VERDICT_MIN_WALKS).toBe(2);
  });
});
