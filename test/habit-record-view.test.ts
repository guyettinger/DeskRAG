import { describe, expect, it } from "vitest";
import type { HabitStepDTO, HabitTimingsDTO, HabitWayDTO } from "@shared/types";
import {
  liftingRollup,
  timingRows,
} from "../app/src/renderer/src/habit-record-view.js";

/**
 * The record, as instruments rather than as a markdown dump.
 *
 * The Habits editor used to end in a `<pre>` holding the generated file from
 * `## What varies` down. Measured in the running app on the author's real
 * store, that well was 835x420 of monospace prose whose largest section was
 * FIFTY-SIX lines of this shape:
 *
 *   - Lifting note on Way A step 5: key event at 40598.795916999996 has no
 *     resolved char (keycode 42); no text gesture emitted
 *
 * A `.ts` module, never `.tsx`, so the root suite can reach it — the rule
 * `habit-portrait.ts`, `habit-rhythm.ts` and `way-fork-view.ts` already state.
 *
 * NO SCORE. Shares scale a bar and are never printed; durations are printed as
 * durations. Nothing here computes a rate, a percentage or a grade.
 */

const step = (index: number, liftWarnings: string[] = []): HabitStepDTO => ({
  index,
  edgeId: `e${index}`,
  from: "Calculator",
  to: "TextEdit",
  actions: [],
  observations: 1,
  everyRecording: true,
  liftWarnings,
  missing: false,
  firstAt: null,
});

const way = (letter: string, steps: HabitStepDTO[]): HabitWayDTO => ({
  letter,
  sessionIds: [`s${letter}`],
  steps,
  totalsMs: [1000],
});

describe("the lifting notes, rolled up", () => {
  it("is null when nothing was lifted badly — the healthy case draws nothing", () => {
    expect(liftingRollup([way("A", [step(0), step(1)])])).toBeNull();
    expect(liftingRollup([])).toBeNull();
  });

  it("counts every note across every way", () => {
    const r = liftingRollup([
      way("A", [step(0, ["no resolved char (keycode 42)", "no resolved char (keycode 20)"])]),
      way("B", [step(0, ["mouse_down had no matching mouse_up"])]),
    ]);
    expect(r!.count).toBe(3);
    expect(r!.notes).toHaveLength(3);
  });

  /**
   * WHERE, on every note. `cautionsFor` prefixes them the same way and for the
   * same reason: a bare "keycode 42" is not locatable, and the disclosure is
   * useless if opening it cannot tell you which step to look at.
   */
  it("says which way and which step a note came from", () => {
    const r = liftingRollup([
      way("A", [step(0), step(4, ["key event has no resolved char"])]),
      way("B", [step(0, ["mouse_down had no matching mouse_up"])]),
    ]);
    expect(r!.notes).toEqual([
      "Way A step 5: key event has no resolved char",
      "Way B step 1: mouse_down had no matching mouse_up",
    ]);
  });

  /** ONE way needs no letter — "Way A step 5" claims a distinction that is not
      being drawn anywhere else on the screen when there is only one way. */
  it("drops the way letter when there is only one way", () => {
    const r = liftingRollup([way("A", [step(2, ["dropped a wait"])])]);
    expect(r!.notes).toEqual(["Step 3: dropped a wait"]);
  });

  it("numbers steps from one, matching the numbers the record prints", () => {
    const r = liftingRollup([way("A", [step(0, ["x"])])]);
    expect(r!.notes[0]).toBe("Step 1: x");
  });

  describe("the summary line", () => {
    it("names the ways it spans, and pluralises", () => {
      const r = liftingRollup([
        way("A", [step(0, ["x", "y"])]),
        way("B", [step(0, ["z"])]),
      ]);
      expect(r!.summary).toBe("3 lifting notes, across Ways A and B");
    });

    it("uses an Oxford-free list for three or more ways", () => {
      const r = liftingRollup([
        way("A", [step(0, ["x"])]),
        way("B", [step(0, ["y"])]),
        way("C", [step(0, ["z"])]),
      ]);
      expect(r!.summary).toBe("3 lifting notes, across Ways A, B and C");
    });

    it("says nothing about ways when there is only one", () => {
      const r = liftingRollup([way("A", [step(0, ["x"])])]);
      expect(r!.summary).toBe("1 lifting note");
    });

    /** A way with no notes is not in the list: naming it would say something
        was lifted badly there when nothing was. */
    it("omits a way that produced no notes", () => {
      const r = liftingRollup([
        way("A", [step(0, ["x"])]),
        way("B", [step(0)]),
        way("C", [step(0, ["y"])]),
      ]);
      expect(r!.summary).toBe("2 lifting notes, across Ways A and C");
    });

    it("never prints a rate, a percentage or a grade", () => {
      const r = liftingRollup([way("A", [step(0, ["x"])])]);
      expect(r!.summary).not.toMatch(/%|score|rate|quality|bad/i);
    });
  });
});

describe("where the time goes, as bars", () => {
  const timings = (steps: HabitTimingsDTO["steps"], single = true): HabitTimingsDTO => ({
    wayLetter: "C",
    steps,
    single,
  });

  it("scales every bar against the longest span anywhere in the route", () => {
    const rows = timingRows(
      timings([
        { from: "a", to: "b", ms: [1000] },
        { from: "b", to: "c", ms: [4000] },
      ]),
    );
    expect(rows[0]!.runs[0]!.share).toBeCloseTo(0.25);
    expect(rows[1]!.runs[0]!.share).toBeCloseTo(1);
  });

  /**
   * ONE BAR PER RECORDING, never one bar from an average or a maximum.
   * Averaging invents a number no recording produced, and a single bar drawn
   * from the longest span silently overstates every other recording of that
   * step — the rail's rule that a bar is the signal's TRUE extent.
   */
  it("draws one bar per recording when a step was walked more than once", () => {
    const rows = timingRows(timings([{ from: "a", to: "b", ms: [4000, 2000] }], false));
    expect(rows[0]!.runs.map((r) => r.share)).toEqual([1, 0.5]);
  });

  it("prints a duration in seconds at one decimal, beside its own bar", () => {
    const rows = timingRows(timings([{ from: "a", to: "b", ms: [17_500] }]));
    expect(rows[0]!.runs[0]!.text).toBe("17.5s");
  });

  it("carries the step's own places, so a row can be read without a legend", () => {
    const rows = timingRows(timings([{ from: "Calculator", to: "TextEdit", ms: [1000] }]));
    expect(rows[0]!.from).toBe("Calculator");
    expect(rows[0]!.to).toBe("TextEdit");
  });

  it("numbers rows from one, matching the numbered steps above them", () => {
    const rows = timingRows(
      timings([
        { from: "a", to: "b", ms: [1000] },
        { from: "b", to: "c", ms: [2000] },
      ]),
    );
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
  });

  /**
   * A ZERO IS A MEASUREMENT, not a missing one, and it must still be visible:
   * a step recorded at under 50ms rounds to 0.0s and would otherwise draw
   * nothing at all, which reads as "not measured" rather than "instant". The
   * portrait band's 2% floor, for the same reason.
   */
  it("gives a zero-length span a visible floor rather than nothing", () => {
    const rows = timingRows(
      timings([
        { from: "a", to: "b", ms: [0] },
        { from: "b", to: "c", ms: [4000] },
      ]),
    );
    expect(rows[0]!.runs[0]!.share).toBeGreaterThan(0);
    expect(rows[0]!.runs[0]!.text).toBe("0.0s");
  });

  /** Every span zero would divide by zero and paint the whole route full. */
  it("survives every span being zero", () => {
    const rows = timingRows(timings([{ from: "a", to: "b", ms: [0] }]));
    expect(Number.isFinite(rows[0]!.runs[0]!.share)).toBe(true);
  });

  it("is empty for a timings block with no steps, rather than throwing", () => {
    expect(timingRows(timings([]))).toEqual([]);
  });
});
