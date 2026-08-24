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

/**
 * The same seven days, spelled out — for the WORDS, never for the picture.
 *
 * A three-letter row label is a column heading a reader scans; a label read
 * aloud, or shown on hover, is a sentence, and "Mon 09:00 — 2 recordings" reads
 * as an abbreviation of something rather than as a fact.
 */
const DAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
] as const;

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Two digits, so a label agrees with the axis it sits under: 00:00, not 0:00. */
const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * One hour of one weekday, and the walks that landed in it.
 *
 * The grid used to hold a bare count, which is exactly enough to paint a square
 * and not enough to open anything — the same gap the ledger closed when its
 * marks gained `walk`. A count can say "twice on Monday morning"; only the walk
 * itself can take you there.
 *
 * `count` is `walks.length` and is kept only so the colour ramp reads one field
 * rather than a length. The two can never disagree because nothing writes them
 * separately.
 */
export interface PhaseCell {
  count: number;
  /** OLDEST FIRST. Sorted here, never trusted — see `rhythmOf`. */
  walks: WalkMarkDTO[];
}

export interface PhaseGrid {
  /** 7 rows (0 = Monday) × 24 columns. */
  cells: PhaseCell[][];
  /** The largest count in any cell — the ramp's top. NEVER printed. */
  peak: number;
  walks: number;
  days: number;
}

/**
 * How many columns one hour label spans. See `HOUR_TICKS`.
 *
 * Three, so a two-digit label always has three cells of width to sit in even
 * when the pane is narrow — the `labelFits` rule reached structurally rather
 * than by measuring. A label that cannot truncate needs no truncation guard.
 */
export const HOUR_TICK_SPAN = 3;

/**
 * THE HOUR AXIS, which the grid shipped without.
 *
 * Seven rows of twenty-four unlabelled cells cannot answer the question the
 * strip exists to ask: it could say a habit repeats somewhere mid-week, and
 * never that it happens at 9am. Measured in the running app — 168 cells and no
 * hour anywhere on screen.
 *
 * These TILE the 24 columns exactly. A gap or an overlap would put every label
 * to the right of it under the wrong cell, which is a picture that lies rather
 * than one that is merely sparse.
 */
export const HOUR_TICKS: readonly { hour: number; label: string }[] = Array.from(
  { length: 24 / HOUR_TICK_SPAN },
  (_, i) => ({ hour: i * HOUR_TICK_SPAN, label: pad2(i * HOUR_TICK_SPAN) }),
);

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

  const cells: PhaseCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ count: 0, walks: [] as WalkMarkDTO[] })),
  );
  // SORTED, not trusted. `binding.walks` is documented oldest-first and
  // `cadenceOf` still sorts it for the same reason: the click target is the
  // EARLIEST walk in an hour, so an unsorted cell silently opens the wrong
  // recording — a defect that looks like working navigation.
  for (const w of [...walks].sort((a, b) => a.at - b.at)) {
    const d = new Date(w.at);
    cells[dayIndex(d)]![d.getHours()]!.walks.push(w);
  }
  for (const row of cells) for (const cell of row) cell.count = cell.walks.length;

  return {
    kind: "grid",
    grid: {
      cells,
      peak: Math.max(...cells.flat().map((c) => c.count)),
      walks: walks.length,
      days,
    },
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
  const repeated = grid.cells.flat().filter((c) => c.count > 1).length;
  if (repeated === 0) {
    return `${plural(grid.walks, "walk")} across ${plural(grid.days, "day")}, no two in the same hour of the week.`;
  }
  return `${plural(repeated, "hour")} of the week ${repeated === 1 ? "holds" : "hold"} more than one walk.`;
}

/** The same claim as the picture's accessible name. */
export function rhythmLabel(grid: PhaseGrid): string {
  return `Walks by hour of the week. ${rhythmNote(grid)}`;
}

/**
 * What ONE cell says when a pointer asks it.
 *
 * The `placeLabel` / `markLabel` rule, one screen over: the picture is the
 * reading and the words are the fact, so a pointer and a screen reader are told
 * the same thing. An empty hour says it is empty rather than printing a bare
 * zero, which reads as a measurement of nothing.
 */
export function cellLabel(day: number, hour: number, cell: PhaseCell): string {
  const what = cell.count === 0 ? "no recordings" : plural(cell.count, "recording");
  return `${DAY_NAMES[day] ?? DAYS[day] ?? "?"} ${pad2(hour)}:00 — ${what}`;
}

const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MIN;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/**
 * THE ABSOLUTE FLOOR, and the only thing between this band and the day-one
 * backfire `post.md` warns about.
 *
 * A rule made purely of a habit's own cadence adapts to any rhythm and needs no
 * arbitrary constant — and on the author's real store it calls a healthy
 * three-day-old habit fading within about two days, because its median gap is
 * ~36h. The four-recordings-in-four-minutes cluster sets a ~1-minute cadence
 * and would have that route marked fading by lunch.
 *
 * SHIPS UNSWEPT, and is recorded as such in `docs/todo.md`. A six-day library
 * cannot falsify it.
 */
export const FADE_FLOOR_MS = 4 * MS_PER_WEEK;

/** Multiples of its OWN rhythm a habit must exceed. One cycle late is DUE. */
export const FADE_MULTIPLE = 3;

/** Two walks give ONE gap, and one gap is not a cadence. */
export const FADE_MIN_WALKS = 3;

export interface Cadence {
  /** Median gap between consecutive walks. Null below `FADE_MIN_WALKS`. */
  medianGapMs: number | null;
  /** Time since the LAST walk. Null with no walks. */
  quietMs: number | null;
}

/**
 * MEDIAN, never mean. The four-in-four-minutes cluster is exactly the shape
 * that drags a mean toward zero, and a manufactured cadence is a manufactured
 * verdict. Sorted first: `binding.walks` is documented oldest-first, and a
 * rule this consequential should not depend on a caller honouring that.
 */
export function cadenceOf(walks: readonly WalkMarkDTO[], now: number): Cadence {
  if (walks.length === 0) return { medianGapMs: null, quietMs: null };
  const at = walks.map((w) => w.at).sort((a, b) => a - b);
  const quietMs = now - at[at.length - 1]!;
  if (walks.length < FADE_MIN_WALKS) return { medianGapMs: null, quietMs };

  const gaps: number[] = [];
  for (let i = 1; i < at.length; i += 1) gaps.push(at[i]! - at[i - 1]!);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return {
    medianGapMs: gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2,
    quietMs,
  };
}

/** Both guards, and both are load-bearing. See `FADE_FLOOR_MS`. */
export function hasFaded(walks: readonly WalkMarkDTO[], now: number): boolean {
  const { medianGapMs, quietMs } = cadenceOf(walks, now);
  if (medianGapMs === null || quietMs === null) return false;
  return quietMs > Math.max(FADE_MULTIPLE * medianGapMs, FADE_FLOOR_MS);
}

/**
 * A duration in ONE unit at one decimal.
 *
 * Mechanical on purpose, so a test can pin every boundary. "about every day and
 * a half" reads better and cannot be pinned; the mono meta line this sits in
 * already prints digits everywhere else (`evidenceLine`, `walkSpan`).
 */
export function approxDuration(ms: number): string {
  const scale = (n: number, unit: string): string => {
    const r = Number(n.toFixed(1));
    return `${r} ${unit}${r === 1 ? "" : "s"}`;
  };
  if (ms < MS_PER_HOUR) return scale(ms / MS_PER_MIN, "minute");
  if (ms < 2 * MS_PER_DAY) return scale(ms / MS_PER_HOUR, "hour");
  if (ms < 2 * MS_PER_WEEK) return scale(ms / MS_PER_DAY, "day");
  return scale(ms / MS_PER_WEEK, "week");
}

/**
 * The FACT, never a verdict: what its rhythm was, and how long it has been.
 *
 * "last walked 6 weeks ago" is a fact; "6 weeks behind" would be a scoreboard,
 * and this repo prints no score. Null when the habit has not faded.
 */
export function fadeLine(walks: readonly WalkMarkDTO[], now: number): string | null {
  if (!hasFaded(walks, now)) return null;
  const { medianGapMs, quietMs } = cadenceOf(walks, now);
  return `about every ${approxDuration(medianGapMs!)} · last walked ${approxDuration(quietMs!)} ago`;
}
