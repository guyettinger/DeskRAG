/**
 * What a habit's walk TIMES say — the phase grid, the cadence, and the fade.
 *
 * The ledger answers WHEN IN YOUR LIFE, on an absolute wall clock shared by
 * every row on the screen. This answers WHERE IN THE WEEK, which is a different
 * question and the one that matters for automaticity: context stability is the
 * measured driver, so a habit done every Tuesday at 9am must not draw
 * identically to one done at random. Today it does.
 *
 * ONE MODULE for the grid, the cadence and the fade, because all three read
 * `walks[].at` and splitting them would put the "is there enough here to say
 * anything" judgement in two places — the `ax-dump`/`ax-exec` drift hazard by
 * name, one layer up.
 *
 * A `.ts` module, never `.tsx`, so the root suite can reach it.
 *
 * NO SCORE, on any of it. Counts and durations, never a rate, a percentage or a
 * grade. `peak` exists to scale a colour ramp and is never printed.
 *
 * `now` is INJECTED wherever it is needed. Same rule as the `wallClock` and
 * `timecode` formatters threaded into `markReadout`: a fade rule read against
 * the live clock is untestable by construction.
 */

import type { WalkMarkDTO } from "@shared/types";

/** Monday first, because a week of work reads Monday to Sunday. */
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export interface PhaseGrid {
  /** 7 rows (0 = Monday) × 24 columns of counts. */
  cells: number[][];
  /** The largest count in any cell — the ramp's top. NEVER printed. */
  peak: number;
  walks: number;
  days: number;
}

export type Rhythm =
  | { kind: "grid"; grid: PhaseGrid }
  | { kind: "too-few"; walks: number; days: number; reason: string };

/**
 * THE FLOOR, and both halves are load-bearing.
 *
 * The walk count alone is not enough, and the counter-example is not
 * hypothetical: the author's store holds FOUR RECORDINGS INSIDE FOUR MINUTES
 * (2026-08-20, 11:00–11:04). Those pass any walk-count floor and are one
 * sitting, and a grid drawn from them reads "you do this Thursdays at 11am".
 * `RHYTHM_MIN_DAYS` is what refuses that. `RHYTHM_MIN_WALKS` is what keeps
 * three dots out of 168 cells.
 *
 * BOTH VALUES SHIP UNSWEPT and are recorded as such in `docs/todo.md`. A
 * six-day library cannot falsify them; sweep them when it can.
 */
export const RHYTHM_MIN_WALKS = 4;
export const RHYTHM_MIN_DAYS = 3;

/** `Date.getDay()` is Sunday-first; the grid is Monday-first. */
const dayIndex = (d: Date): number => (d.getDay() + 6) % 7;

/** LOCAL calendar day. A UTC key would merge two evenings west of Greenwich. */
const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function rhythmOf(walks: readonly WalkMarkDTO[]): Rhythm {
  const dates = walks.map((w) => new Date(w.at));
  const days = new Set(dates.map(dayKey)).size;

  if (walks.length < RHYTHM_MIN_WALKS || days < RHYTHM_MIN_DAYS) {
    return {
      kind: "too-few",
      walks: walks.length,
      days,
      // States what it HAS, in the shape of the numbers it holds. Never
      // "unknown", never absent: an absent strip is indistinguishable from one
      // nobody implemented — the `StageSpec.skipReason` rule, one screen over.
      reason: `${plural(walks.length, "walk")}, on ${plural(days, "day")} — too few to place in the week.`,
    };
  }

  const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const d of dates) {
    const row = cells[dayIndex(d)]!;
    const hour = d.getHours();
    row[hour] = (row[hour] ?? 0) + 1;
  }
  return {
    kind: "grid",
    grid: { cells, peak: Math.max(...cells.flat()), walks: walks.length, days },
  };
}

/**
 * The grid's claim, in words — because a picture that cannot be said is not a
 * reading, it is decoration.
 *
 * A grid where nothing repeats is a FINDING, not a failure: the habit recurs
 * but not in phase, which is exactly the distinction the strip exists to draw.
 */
export function rhythmNote(grid: PhaseGrid): string {
  const repeated = grid.cells.flat().filter((c) => c > 1).length;
  if (repeated === 0) {
    return `${plural(grid.walks, "walk")} across ${plural(grid.days, "day")}, no two in the same hour of the week.`;
  }
  return `${plural(repeated, "hour")} of the week ${repeated === 1 ? "holds" : "hold"} more than one walk.`;
}

/** The same claim as the picture's accessible name. */
export function rhythmLabel(grid: PhaseGrid): string {
  return `Walks by hour of the week. ${rhythmNote(grid)}`;
}
