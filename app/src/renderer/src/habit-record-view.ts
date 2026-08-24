/**
 * The record's blocks, as instruments rather than as a markdown dump.
 *
 * The Habits editor used to end in a `<pre>` holding the generated file from
 * `## What varies` down. Measured in the running app on the author's real
 * store, that well was 835x420 of monospace prose, and its largest section was
 * FIFTY-SIX consecutive lines of this shape:
 *
 *   - Lifting note on Way A step 5: key event at 40598.795916999996 has no
 *     resolved char (keycode 42); no text gesture emitted
 *
 * Fifty-three raw `t_mono` floats and macOS keycodes, under a heading a person
 * reads as "what this evidence does not say", burying the five sentences that
 * actually qualify the evidence. That is the reading this module exists to
 * restore.
 *
 * THE FILE IS NOT REDRAWN HERE. `HABIT.md` is rendered in main and handed out
 * verbatim — `Copy HABIT.md` and `get_habit` return the same string, and none
 * of it passes through this file. This is a SECOND RENDERER of the same facts,
 * the shape `WayForkView` already established: safe only because neither
 * parses the other's output, and both read one projection from main.
 *
 * A `.ts` module, never `.tsx`, so the root suite can reach it — the rule
 * `habit-portrait.ts`, `habit-rhythm.ts` and `way-fork-view.ts` state.
 *
 * NO SCORE. A `share` scales a bar and is never printed; a duration is printed
 * as a duration. Nothing here computes a rate, a percentage or a grade.
 */

import type { HabitTimingsDTO, HabitWayDTO } from "@shared/types";

/** "A", "A and B", "A, B and C" — no Oxford comma, matching the record's prose. */
function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export interface LiftingRollup {
  count: number;
  /** The disclosure's own label: what is behind it, without opening it. */
  summary: string;
  /** Every note, each saying where it came from. Oldest way first. */
  notes: string[];
}

/**
 * The lifting notes, counted and located — the disclosure's contents.
 *
 * NULL when there are none, so the healthy case draws nothing at all rather
 * than an empty toggle. This is the one place in the section where absence is
 * not a withheld reading: a route that lifted cleanly has nothing to disclose,
 * and a control saying "0 lifting notes" would be chrome.
 *
 * Rebuilt HERE from `HabitStepDTO.liftWarnings`, which the renderer already
 * holds, rather than carried on `HabitDTO.cautions` — putting them on the wire
 * would move the burial across the process boundary instead of undoing it.
 */
export function liftingRollup(ways: readonly HabitWayDTO[]): LiftingRollup | null {
  const notes: string[] = [];
  const lettered: string[] = [];
  // ONE way needs no letter. "Way A step 5" claims a distinction against ways
  // that are not being drawn, and the record's own `where` drops it too.
  const many = ways.length > 1;

  for (const way of ways) {
    let any = false;
    for (const step of way.steps) {
      for (const w of step.liftWarnings) {
        // Steps are numbered from ONE, matching the numbers printed beside them
        // — a note pointing at "step 4" that sits under a row labelled 5 is
        // worse than no note.
        const where = many ? `Way ${way.letter} step ${step.index + 1}` : `Step ${step.index + 1}`;
        notes.push(`${where}: ${w}`);
        any = true;
      }
    }
    // A way that lifted cleanly is not named: saying so would report something
    // went wrong there when nothing did.
    if (any) lettered.push(way.letter);
  }

  if (notes.length === 0) return null;

  const across =
    lettered.length > 1 ? `, across Ways ${joinWords(lettered)}` : "";
  return {
    count: notes.length,
    summary: `${plural(notes.length, "lifting note")}${across}`,
    notes,
  };
}

/** One recording's span on one step. `share` scales a bar and is never shown. */
export interface TimingRun {
  ms: number;
  /** 0..1 against the longest span anywhere in the route. NEVER printed. */
  share: number;
  /** "17.5s" — the fact, beside the bar that is the reading. */
  text: string;
}

export interface TimingRow {
  /** 1-based, matching the numbered steps drawn above. */
  n: number;
  from: string;
  to: string;
  runs: TimingRun[];
}

/**
 * A bar per recording, per step, scaled against the longest span in the route.
 *
 * ONE BAR PER RECORDING, never one bar from a mean or a maximum. An average
 * invents a number no recording produced — the reason `cadenceOf` takes a
 * median and the reason `HabitWayDTO.totalsMs` is a list. A single bar drawn
 * from the longest span would silently overstate every other recording of that
 * step, which is the rail's rule that a bar is the signal's TRUE extent.
 */
export function timingRows(timings: HabitTimingsDTO): TimingRow[] {
  const every = timings.steps.flatMap((s) => s.ms);
  const peak = Math.max(...every, 0);

  return timings.steps.map((step, i) => ({
    n: i + 1,
    from: step.from,
    to: step.to,
    runs: step.ms.map((ms) => ({
      ms,
      // A FLOOR, so a span that rounds to 0.0s is still a mark rather than
      // nothing: an invisible bar reads as "not measured" where the number
      // beside it says "instant". The portrait band's 2% floor, same reason.
      // `peak` is 0 only when every span is 0, and then every bar is the floor.
      share: peak <= 0 ? MIN_SHARE : Math.max(ms / peak, MIN_SHARE),
      text: `${(ms / 1000).toFixed(1)}s`,
    })),
  }));
}

/** The smallest bar that is still a bar. See `timingRows`. */
export const MIN_SHARE = 0.02;
