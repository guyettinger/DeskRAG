import { describe, expect, it } from "vitest";
import type { HabitRunDTO, HabitStepDTO, HabitTimingsDTO, HabitWayDTO } from "@shared/types";
import {
  actionSummary,
  appTones,
  liftingRollup,
  rangeText,
  spineRows,
  stripLanes,
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
  app: "TextEdit",
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

/** A step whose fields the spine actually reads, spelled where a test can see them. */
const stepOf = (over: Partial<HabitStepDTO> & { index: number }): HabitStepDTO => ({
  edgeId: `e${over.index}`,
  from: "Calculator",
  to: "TextEdit",
  app: "TextEdit",
  actions: [],
  observations: 1,
  everyRecording: true,
  liftWarnings: [],
  missing: false,
  firstAt: null,
  ...over,
});

const wayOf = (steps: HabitStepDTO[], sessionIds = ["s1"]): HabitWayDTO => ({
  letter: "A",
  sessionIds,
  steps,
  totalsMs: [1000],
});

const timings = (
  steps: HabitTimingsDTO["steps"],
  single = true,
): HabitTimingsDTO => ({ wayLetter: "A", steps, single });

const timed = (
  stepIndex: number,
  runs: { sessionId: string; ms: number }[],
  gapsAfterMs: { sessionId: string; ms: number }[] = [],
): HabitTimingsDTO["steps"][number] => ({
  stepIndex,
  from: "a",
  to: "b",
  runs,
  gapsAfterMs,
});

describe("actions, summarized by kind", () => {
  it("says nothing at all when nothing was recorded, so the caller can", () => {
    expect(actionSummary([])).toBe("");
  });

  it("counts and pluralizes each kind", () => {
    expect(
      actionSummary([
        { action: "click", target: "Button \"1\"" },
        { action: "click", target: "Button \"2\"" },
        { action: "press cmd+v", target: "—" },
      ]),
    ).toBe("2 clicks · 1 key press");
  });

  /**
   * `3× click` IS THREE CLICKS. `graph-view.ts` collapses a repeat into a
   * multiplier before this ever sees it, so reading the string as one action
   * undercounts every rapid sequence — and a tally exists precisely so density
   * stops having to be counted by eye.
   */
  it("reads a multiplier as the count it is", () => {
    expect(actionSummary([{ action: "3× click", target: "Button \"=\"" }])).toBe("3 clicks");
  });

  /** The slot NAME is why a typed step is worth distinguishing; the value is not carried. */
  it("names the slot a type varied, rather than counting the type", () => {
    expect(
      actionSummary([{ action: "type", target: "TextArea", slot: { name: "note" } }]),
    ).toBe("types {note}");
  });

  it("prints a type with no slot as a count, since there is no name to give", () => {
    expect(actionSummary([{ action: "type", target: "TextArea" }])).toBe("1 typed input");
  });

  /** A total order, so a tally cannot reshuffle between two renders. */
  it("prints kinds in one fixed order whatever order they were recorded in", () => {
    const a = actionSummary([
      { action: "wait until app(TextEdit)", target: "—" },
      { action: "click", target: "x" },
    ]);
    const b = actionSummary([
      { action: "click", target: "x" },
      { action: "wait until app(TextEdit)", target: "—" },
    ]);
    expect(a).toBe("1 click · 1 wait");
    expect(b).toBe(a);
  });

  /** An unlisted verb degrades to itself rather than vanishing from the tally. */
  it("keeps a verb it has no noun for", () => {
    expect(actionSummary([{ action: "2× flick", target: "x" }])).toBe("2 flicks");
  });
});

describe("durations, said as durations", () => {
  it("is null with nothing to say, so a caller draws no line at all", () => {
    expect(rangeText([])).toBeNull();
  });

  it("prints one span as one number", () => {
    expect(rangeText([17_500])).toBe("17.5s");
  });

  /** BOTH ENDS ARE REAL. A mean is a number no recording produced. */
  it("prints several spans as their extremes, never their average", () => {
    expect(rangeText([47_800, 41_200, 45_000])).toBe("41.2–47.8s");
  });

  it("collapses to one number when the extremes print the same", () => {
    expect(rangeText([1000, 1040])).toBe("1.0s");
  });
});

describe("applications, as tone slots", () => {
  it("assigns a slot per application, in the order reached", () => {
    const t = appTones(["Calculator", "Finder", "TextEdit"]);
    expect([...t.values()]).toEqual([0, 1, 2]);
  });

  it("gives one application one slot however often it recurs", () => {
    const t = appTones(["Calculator", "Finder", "Calculator"]);
    expect(t.get("Calculator")).toBe(0);
    expect(t.size).toBe(2);
  });

  /** Colour is never the only channel, so wrapping past eight is safe. */
  it("wraps past the palette rather than running out", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `app${i}`);
    expect(appTones(nine).get("app8")).toBe(0);
  });
});

describe("the spine: sequence, cost and trust in one row", () => {
  /**
   * THE DEFECT THIS MERGE EXISTS TO KILL. `habitTimings` DROPS a step carrying
   * no recorded duration, so the timings list is a subset of the Way's steps.
   * The screen used to number the survivors `i + 1` while the step list
   * numbered by `step.index + 1`, so one unmeasured step shifted every number
   * below it and the two lists silently pointed at different steps. Joining on
   * `stepIndex` makes that unrepresentable.
   */
  it("puts a span on the step it actually timed, across a dropped step", () => {
    const view = spineRows(
      wayOf([stepOf({ index: 0 }), stepOf({ index: 1 }), stepOf({ index: 2 })]),
      // Step 1 carries no duration and is absent from `timings.steps`.
      timings([timed(0, [{ sessionId: "s1", ms: 1000 }]), timed(2, [{ sessionId: "s1", ms: 4000 }])]),
      appTones([]),
    );
    expect(view.rows.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(view.rows[0]!.runs.map((r) => r.ms)).toEqual([1000]);
    expect(view.rows[1]!.runs).toEqual([]);
    expect(view.rows[2]!.runs.map((r) => r.ms)).toEqual([4000]);
  });

  it("numbers from the step's own index, never from its position in the list", () => {
    const view = spineRows(wayOf([stepOf({ index: 4 })]), null, appTones([]));
    expect(view.rows[0]!.n).toBe(5);
  });

  /**
   * A PLACE IS PRINTED ONCE. A route of N steps passes through N+1 places, and
   * `from → to` per row prints 2N of them, so consecutive rows read as
   * near-duplicate strings.
   */
  it("prints only the place a step arrives in while the chain holds", () => {
    const view = spineRows(
      wayOf([
        stepOf({ index: 0, from: "Calculator", to: "Finder" }),
        stepOf({ index: 1, from: "Finder", to: "TextEdit" }),
      ]),
      null,
      appTones([]),
    );
    expect(view.origin).toBe("Calculator");
    expect(view.rows.map((r) => r.place)).toEqual(["Finder", "TextEdit"]);
    expect(view.rows.map((r) => r.brokenFrom)).toEqual([null, null]);
  });

  /** Where the chain genuinely breaks it stops pretending, rather than lying by omission. */
  it("falls back to both places where a step does not follow the one before", () => {
    const view = spineRows(
      wayOf([
        stepOf({ index: 0, from: "Calculator", to: "Finder" }),
        stepOf({ index: 1, from: "Safari", to: "TextEdit" }),
      ]),
      null,
      appTones([]),
    );
    expect(view.rows[1]!.brokenFrom).toBe("Safari");
  });

  it("names the origin so the opening place is drawn at all", () => {
    expect(spineRows(wayOf([]), null, appTones([])).origin).toBeNull();
  });

  it("scales every bar against the longest span anywhere in the Way", () => {
    const view = spineRows(
      wayOf([stepOf({ index: 0 }), stepOf({ index: 1 })]),
      timings([timed(0, [{ sessionId: "s1", ms: 1000 }]), timed(1, [{ sessionId: "s1", ms: 4000 }])]),
      appTones([]),
    );
    expect(view.rows[0]!.runs[0]!.share).toBeCloseTo(0.25);
    expect(view.rows[1]!.runs[0]!.share).toBeCloseTo(1);
  });

  /**
   * ONE BAR PER RECORDING, never one from an average or a maximum. Averaging
   * invents a number no recording produced; a single bar drawn from the longest
   * span overstates every other recording of that step.
   */
  it("draws one bar per recording when a step was walked more than once", () => {
    const view = spineRows(
      wayOf([stepOf({ index: 0 })]),
      timings([timed(0, [{ sessionId: "a", ms: 4000 }, { sessionId: "b", ms: 2000 }])], false),
      appTones([]),
    );
    expect(view.rows[0]!.runs.map((r) => r.share)).toEqual([1, 0.5]);
    expect(view.rows[0]!.runs.map((r) => r.sessionId)).toEqual(["a", "b"]);
  });

  it("prints a duration in seconds at one decimal, beside its own bar", () => {
    const view = spineRows(
      wayOf([stepOf({ index: 0 })]),
      timings([timed(0, [{ sessionId: "s1", ms: 17_500 }])]),
      appTones([]),
    );
    expect(view.rows[0]!.runs[0]!.text).toBe("17.5s");
  });

  /**
   * A ZERO IS A MEASUREMENT, not a missing one, and it must stay visible: a
   * step under 50ms rounds to 0.0s and would otherwise draw nothing, which
   * reads as "not measured" rather than "instant".
   */
  it("gives a zero-length span a visible floor rather than nothing", () => {
    const view = spineRows(
      wayOf([stepOf({ index: 0 }), stepOf({ index: 1 })]),
      timings([timed(0, [{ sessionId: "s1", ms: 0 }]), timed(1, [{ sessionId: "s1", ms: 4000 }])]),
      appTones([]),
    );
    expect(view.rows[0]!.runs[0]!.share).toBeGreaterThan(0);
    expect(view.rows[0]!.runs[0]!.text).toBe("0.0s");
  });

  /** Every span zero would divide by zero and paint the whole route full. */
  it("survives every span being zero", () => {
    const view = spineRows(
      wayOf([stepOf({ index: 0 })]),
      timings([timed(0, [{ sessionId: "s1", ms: 0 }])]),
      appTones([]),
    );
    expect(Number.isFinite(view.rows[0]!.runs[0]!.share)).toBe(true);
  });

  /** The sequence is still the sequence with nothing timed against it. */
  it("draws every step with no timings at all", () => {
    const view = spineRows(wayOf([stepOf({ index: 0 }), stepOf({ index: 1 })]), null, appTones([]));
    expect(view.rows).toHaveLength(2);
    expect(view.rows.every((r) => r.runs.length === 0)).toBe(true);
  });

  /** The pause belongs to neither neighbour, so it is reported apart from both. */
  it("reports the idle after a step as a range of its own", () => {
    const view = spineRows(
      wayOf([stepOf({ index: 0 })]),
      timings([
        timed(0, [{ sessionId: "a", ms: 1000 }], [
          { sessionId: "a", ms: 1900 },
          { sessionId: "b", ms: 2400 },
        ]),
      ]),
      appTones([]),
    );
    expect(view.rows[0]!.idleText).toBe("1.9–2.4s");
  });

  it("says nothing about idle where none was measured", () => {
    const view = spineRows(
      wayOf([stepOf({ index: 0 })]),
      timings([timed(0, [{ sessionId: "a", ms: 1000 }])]),
      appTones([]),
    );
    expect(view.rows[0]!.idleText).toBeNull();
  });

  it("carries the destination's tone, and none where the step named no app", () => {
    const tones = appTones(["Calculator", "TextEdit"]);
    const view = spineRows(
      wayOf([stepOf({ index: 0, app: "TextEdit" }), stepOf({ index: 1, app: null })]),
      null,
      tones,
    );
    expect(view.rows[0]!.toneSlot).toBe(1);
    expect(view.rows[1]!.toneSlot).toBeNull();
  });
});

describe("the strip: the shape of each run", () => {
  const runOf = (
    over: Partial<HabitRunDTO> & { sessionId: string; segments: HabitRunDTO["segments"] },
  ): HabitRunDTO => ({
    way: 0,
    wayLetter: "A",
    at: 1000,
    atSec: 5,
    totalMs: over.segments.reduce((n, x) => n + x.ms + x.idleAfterMs, 0),
    ...over,
  });

  /** Absence is DRAWN by the caller, so the projection must say so rather than guess. */
  it("is null with no runs, so the caller can state the reason", () => {
    expect(stripLanes([], [wayOf([stepOf({ index: 0 })])], appTones([]))).toBeNull();
  });

  it("is null when every run drew nothing at all", () => {
    const runs = [runOf({ sessionId: "a", segments: [{ stepIndex: 0, ms: 0, idleAfterMs: 0 }] })];
    expect(stripLanes(runs, [wayOf([stepOf({ index: 0 })])], appTones([]))).toBeNull();
  });

  /**
   * ONE SHARED DOMAIN. Rescaling each lane to its own extent draws a fast run
   * and a slow one identically, which is the exact distinction the strip exists
   * to make — the recurrence ledger's rule one level up.
   */
  it("scales every lane against the longest lane, never against itself", () => {
    const view = stripLanes(
      [
        runOf({ sessionId: "a", segments: [{ stepIndex: 0, ms: 4000, idleAfterMs: 0 }] }),
        runOf({ sessionId: "b", segments: [{ stepIndex: 0, ms: 2000, idleAfterMs: 0 }] }),
      ],
      [wayOf([stepOf({ index: 0 })], ["a", "b"])],
      appTones([]),
    )!;
    expect(view.domainMs).toBe(4000);
    expect(view.lanes[0]!.segments[0]!.widthPct).toBeCloseTo(100);
    expect(view.lanes[1]!.segments[0]!.widthPct).toBeCloseTo(50);
  });

  /** Segments TILE a lane, so they must abut exactly — a width floor would not. */
  it("lays a lane's segments end to end with no gap between them", () => {
    const view = stripLanes(
      [
        runOf({
          sessionId: "a",
          segments: [
            { stepIndex: 0, ms: 1000, idleAfterMs: 500 },
            { stepIndex: 1, ms: 2500, idleAfterMs: 0 },
          ],
        }),
      ],
      [wayOf([stepOf({ index: 0 }), stepOf({ index: 1 })], ["a"])],
      appTones([]),
    )!;
    const segs = view.lanes[0]!.segments;
    expect(segs.map((s) => s.kind)).toEqual(["step", "idle", "step"]);
    expect(segs[1]!.leftPct).toBeCloseTo(segs[0]!.leftPct + segs[0]!.widthPct);
    expect(segs[2]!.leftPct + segs[2]!.widthPct).toBeCloseTo(100);
  });

  /**
   * A ZERO GAP IS NOT A SEGMENT. `min-width: 1px` in the sheet keeps a
   * sub-pixel step visible, and would paint a zero-length gap as a hairline of
   * hatching between two steps that ran back to back — a pause that reads as
   * measured and was not.
   */
  it("draws no idle segment where no idle was measured", () => {
    const view = stripLanes(
      [runOf({ sessionId: "a", segments: [{ stepIndex: 0, ms: 1000, idleAfterMs: 0 }] })],
      [wayOf([stepOf({ index: 0 })], ["a"])],
      appTones([]),
    )!;
    expect(view.lanes[0]!.segments.map((s) => s.kind)).toEqual(["step"]);
  });

  /** The lane's extent is what it DREW, so it can never stop short of its own end. */
  it("totals a lane from its own drawn segments", () => {
    const view = stripLanes(
      [runOf({ sessionId: "a", segments: [{ stepIndex: 0, ms: 1000, idleAfterMs: 500 }] })],
      [wayOf([stepOf({ index: 0 })], ["a"])],
      appTones([]),
    )!;
    expect(view.lanes[0]!.totalMs).toBe(1500);
    expect(view.lanes[0]!.totalText).toBe("1.5s");
  });

  it("carries each recording's wall clock and moment, for the label and the link", () => {
    const view = stripLanes(
      [runOf({ sessionId: "a", segments: [{ stepIndex: 0, ms: 1000, idleAfterMs: 0 }] })],
      [wayOf([stepOf({ index: 0 })], ["a"])],
      appTones([]),
    )!;
    expect(view.lanes[0]!.at).toBe(1000);
    expect(view.lanes[0]!.atSec).toBe(5);
  });

  /**
   * EVERY RECORDING IS DRAWN, which is the whole change. Reading
   * `HabitTimingsDTO` drew the baseline Way alone — measured on the real store,
   * two lanes of six recordings, one of them a 1.0s sliver of a recording that
   * had walked a different Way and shared a single edge.
   */
  it("draws a lane for every run, whichever Way it took", () => {
    const view = stripLanes(
      [
        runOf({ sessionId: "a", way: 0, wayLetter: "A", segments: [{ stepIndex: 0, ms: 1000, idleAfterMs: 0 }] }),
        runOf({ sessionId: "b", way: 1, wayLetter: "B", segments: [{ stepIndex: 0, ms: 3000, idleAfterMs: 0 }] }),
      ],
      [
        wayOf([stepOf({ index: 0, app: "Calculator", to: "Calculator" })], ["a"]),
        { ...wayOf([stepOf({ index: 0, app: "Finder", to: "Finder" })], ["b"]), letter: "B" },
      ],
      appTones(["Calculator", "TextEdit", "Finder"]),
    )!;
    expect(view.lanes.map((l) => l.sessionId)).toEqual(["a", "b"]);
    expect(view.lanes.map((l) => l.wayLetter)).toEqual(["A", "B"]);
    // Finder is reached only by the second Way, and appears now because that
    // Way is drawn. The masthead's app chain named it all along.
    expect(view.legend.map((l) => l.app)).toEqual(["Calculator", "Finder"]);
  });

  /**
   * A step is located by (way, stepIndex), never by its position in
   * `segments` — a step carrying no source is dropped, so the array is a
   * SUBSET of the Way's steps. That is the off-by-one
   * `HabitStepTimingDTO.stepIndex` exists for, one instrument over.
   */
  it("locates a segment by its step INDEX, not by its position", () => {
    const view = stripLanes(
      [runOf({ sessionId: "a", segments: [{ stepIndex: 2, ms: 1000, idleAfterMs: 0 }] })],
      [
        wayOf(
          [
            stepOf({ index: 0, app: "Calculator", to: "Calculator" }),
            stepOf({ index: 1, app: "Calculator", to: "Calculator" }),
            stepOf({ index: 2, app: "Finder", to: "Finder" }),
          ],
          ["a"],
        ),
      ],
      appTones(["Calculator", "TextEdit", "Finder"]),
    )!;
    expect(view.lanes[0]!.segments[0]!.place).toBe("Finder");
    expect(view.lanes[0]!.segments[0]!.toneSlot).toBe(2);
  });

  /**
   * ONE WAY NEEDS NO LETTER — `liftingRollup`'s rule. Labelling it claims a
   * distinction against Ways that are not being drawn.
   */
  it("says whether the letter is worth printing at all", () => {
    const one = stripLanes(
      [runOf({ sessionId: "a", segments: [{ stepIndex: 0, ms: 1000, idleAfterMs: 0 }] })],
      [wayOf([stepOf({ index: 0 })], ["a"])],
      appTones([]),
    )!;
    expect(one.manyWays).toBe(false);

    const two = stripLanes(
      [runOf({ sessionId: "a", segments: [{ stepIndex: 0, ms: 1000, idleAfterMs: 0 }] })],
      [wayOf([stepOf({ index: 0 })], ["a"]), wayOf([stepOf({ index: 0 })], ["b"])],
      appTones([]),
    )!;
    expect(two.manyWays).toBe(true);
  });

  /** A swatch for a colour no lane contains sends a reader looking for nothing. */
  it("names only the applications it actually paints", () => {
    const view = stripLanes(
      [runOf({ sessionId: "a", segments: [{ stepIndex: 0, ms: 1000, idleAfterMs: 0 }] })],
      [wayOf([stepOf({ index: 0, app: "TextEdit" })], ["a"])],
      appTones(["Calculator", "TextEdit"]),
    )!;
    expect(view.legend).toEqual([{ app: "TextEdit", toneSlot: 1 }]);
  });
});
