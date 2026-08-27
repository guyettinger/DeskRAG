import { describe, expect, it } from "vitest";
import {
  approxDuration,
  cadenceOf,
  cellLabel,
  DAYS,
  fadeLine,
  FADE_FLOOR_MS,
  FADE_MIN_WALKS,
  FADE_MULTIPLE,
  hasFaded,
  HOUR_TICK_SPAN,
  HOUR_TICKS,
  RHYTHM_MIN_DAYS,
  RHYTHM_MIN_WALKS,
  rhythmLabel,
  rhythmNote,
  rhythmOf,
} from "../app/src/renderer/src/habit-rhythm.js";
import type { WalkMarkDTO } from "@shared/types";

/**
 * What the walk TIMES say.
 *
 * Every date here is built with `new Date(y, m, d, h)` — LOCAL time, which is
 * what the grid buckets by, so the test says the same thing in every timezone
 * a contributor runs it in. A UTC epoch literal would pass in London and shift
 * a row in Auckland.
 */

const at = (y: number, m: number, d: number, h: number, min = 0): number =>
  new Date(y, m, d, h, min).getTime();

const walk = (ms: number): WalkMarkDTO => ({
  sessionId: `s${ms}`,
  at: ms,
  gained: false,
  fit: null,
  walk: { atSec: 0, throughSec: 1, steps: 2 },
});

/** 2026-08-17 is a Monday. Every date below is relative to that. */
const MON = 17;

describe("the floor", () => {
  it("is 4 walks across 3 distinct days", () => {
    expect(RHYTHM_MIN_WALKS).toBe(4);
    expect(RHYTHM_MIN_DAYS).toBe(3);
  });

  /**
   * The REAL kept habit on the author's store as of 2026-08-23: three walks,
   * two days. The grid must refuse it and say what it has.
   */
  it("refuses three walks on two days and states both numbers", () => {
    const r = rhythmOf([
      walk(at(2026, 7, MON, 11, 14)),
      walk(at(2026, 7, MON, 20, 45)),
      walk(at(2026, 7, MON + 3, 11, 0)),
    ]);
    expect(r.kind).toBe("too-few");
    if (r.kind !== "too-few") throw new Error("unreachable");
    expect(r.walks).toBe(3);
    expect(r.days).toBe(2);
    expect(r.reason).toBe("3 walks, on 2 days — too few to place in the week.");
  });

  /**
   * THE CLUSTER. The author's store holds four recordings inside four minutes.
   * A walk-count floor alone passes them, and a grid drawn from them reads
   * "you do this Thursdays at 11am" from one sitting. The day half refuses it.
   */
  it("refuses four walks inside four minutes, on the day half", () => {
    const r = rhythmOf([
      walk(at(2026, 7, MON + 3, 11, 0)),
      walk(at(2026, 7, MON + 3, 11, 1)),
      walk(at(2026, 7, MON + 3, 11, 3)),
      walk(at(2026, 7, MON + 3, 11, 4)),
    ]);
    expect(r.kind).toBe("too-few");
    if (r.kind !== "too-few") throw new Error("unreachable");
    expect(r.walks).toBe(4);
    expect(r.days).toBe(1);
  });

  it("refuses three walks on three days, on the walk half", () => {
    const r = rhythmOf([
      walk(at(2026, 7, MON, 9)),
      walk(at(2026, 7, MON + 1, 9)),
      walk(at(2026, 7, MON + 2, 9)),
    ]);
    expect(r.kind).toBe("too-few");
  });

  it("draws at exactly four walks across exactly three days", () => {
    const r = rhythmOf([
      walk(at(2026, 7, MON, 9)),
      walk(at(2026, 7, MON, 14)),
      walk(at(2026, 7, MON + 1, 9)),
      walk(at(2026, 7, MON + 2, 9)),
    ]);
    expect(r.kind).toBe("grid");
  });

  it("says one walk on one day in the singular", () => {
    const r = rhythmOf([walk(at(2026, 7, MON, 9))]);
    if (r.kind !== "too-few") throw new Error("unreachable");
    expect(r.reason).toBe("1 walk, on 1 day — too few to place in the week.");
  });

  it("has something to say about no walks at all rather than throwing", () => {
    const r = rhythmOf([]);
    if (r.kind !== "too-few") throw new Error("unreachable");
    expect(r.reason).toBe("0 walks, on 0 days — too few to place in the week.");
  });
});

describe("the grid", () => {
  const fourAcrossThree = [
    walk(at(2026, 7, MON, 9)),
    walk(at(2026, 7, MON, 9, 30)),
    walk(at(2026, 7, MON + 1, 14)),
    walk(at(2026, 7, MON + 5, 21)),
  ];

  it("is 7 rows of 24, Monday first", () => {
    const r = rhythmOf(fourAcrossThree);
    if (r.kind !== "grid") throw new Error("unreachable");
    expect(r.grid.cells).toHaveLength(7);
    for (const row of r.grid.cells) expect(row).toHaveLength(24);
    expect(DAYS[0]).toBe("Mon");
    expect(DAYS[6]).toBe("Sun");
  });

  /** Saturday is row 5 Monday-first, and row 6 in `Date.getDay()` terms. */
  it("places a Saturday walk on the Saturday row, not the Sunday one", () => {
    const r = rhythmOf(fourAcrossThree);
    if (r.kind !== "grid") throw new Error("unreachable");
    expect(r.grid.cells[5]![21]!.count).toBe(1);
    expect(r.grid.cells[6]![21]!.count).toBe(0);
  });

  it("counts two walks in the same hour of the week into one cell", () => {
    const r = rhythmOf(fourAcrossThree);
    if (r.kind !== "grid") throw new Error("unreachable");
    expect(r.grid.cells[0]![9]!.count).toBe(2);
    expect(r.grid.peak).toBe(2);
    expect(r.grid.walks).toBe(4);
    expect(r.grid.days).toBe(3);
  });
});

describe("what the grid claims, in words", () => {
  it("names the hours of the week that repeat", () => {
    const r = rhythmOf([
      walk(at(2026, 7, MON, 9)),
      walk(at(2026, 7, MON, 9, 30)),
      walk(at(2026, 7, MON + 1, 14)),
      walk(at(2026, 7, MON + 2, 16)),
    ]);
    if (r.kind !== "grid") throw new Error("unreachable");
    expect(rhythmNote(r.grid)).toBe("1 hour of the week holds more than one walk.");
  });

  /**
   * The honest reading when a habit recurs but never in phase. It is a finding,
   * not a failure, and the strip says it rather than showing an empty picture.
   */
  it("says so when no two walks share an hour of the week", () => {
    const r = rhythmOf([
      walk(at(2026, 7, MON, 9)),
      walk(at(2026, 7, MON + 1, 14)),
      walk(at(2026, 7, MON + 2, 16)),
      walk(at(2026, 7, MON + 3, 18)),
    ]);
    if (r.kind !== "grid") throw new Error("unreachable");
    expect(rhythmNote(r.grid)).toBe(
      "4 walks across 4 days, no two in the same hour of the week.",
    );
  });

  it("gives the picture an accessible name carrying that same claim", () => {
    const r = rhythmOf([
      walk(at(2026, 7, MON, 9)),
      walk(at(2026, 7, MON, 9, 30)),
      walk(at(2026, 7, MON + 1, 14)),
      walk(at(2026, 7, MON + 2, 16)),
    ]);
    if (r.kind !== "grid") throw new Error("unreachable");
    expect(rhythmLabel(r.grid)).toBe(
      "Walks by hour of the week. 1 hour of the week holds more than one walk.",
    );
  });

  it("never prints a rate, a percentage or a grade", () => {
    const r = rhythmOf([
      walk(at(2026, 7, MON, 9)),
      walk(at(2026, 7, MON, 9, 30)),
      walk(at(2026, 7, MON + 1, 14)),
      walk(at(2026, 7, MON + 2, 16)),
    ]);
    if (r.kind !== "grid") throw new Error("unreachable");
    expect(rhythmNote(r.grid)).not.toMatch(/%|score|rate|consistent|streak/i);
  });
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe("approxDuration", () => {
  it("uses one unit at one decimal, and drops a trailing zero", () => {
    expect(approxDuration(30 * 60_000)).toBe("30 minutes");
    expect(approxDuration(36 * HOUR)).toBe("36 hours");
    expect(approxDuration(3.5 * DAY)).toBe("3.5 days");
    expect(approxDuration(6 * WEEK)).toBe("6 weeks");
  });

  it("says one of each unit in the singular", () => {
    expect(approxDuration(60_000)).toBe("1 minute");
    expect(approxDuration(3 * DAY)).toBe("3 days");
    expect(approxDuration(2 * WEEK)).toBe("2 weeks");
  });
});

describe("cadenceOf", () => {
  const now = at(2026, 7, MON + 6, 12);

  it("has nothing to say about no walks", () => {
    expect(cadenceOf([], now)).toEqual({ medianGapMs: null, quietMs: null });
  });

  /** Two walks give ONE gap, and one gap is not a cadence. */
  it("reports quiet but no cadence below three walks", () => {
    const c = cadenceOf([walk(at(2026, 7, MON, 12)), walk(at(2026, 7, MON + 1, 12))], now);
    expect(c.medianGapMs).toBeNull();
    expect(c.quietMs).toBe(5 * DAY);
    expect(FADE_MIN_WALKS).toBe(3);
  });

  /**
   * MEDIAN, NOT MEAN, and the cluster is why. Four back-to-back walks plus one
   * distant one has a mean gap a fraction of its median, and a mean would
   * manufacture a tiny cadence out of a single sitting.
   */
  it("takes the median gap, so a cluster cannot manufacture a tiny cadence", () => {
    const walks = [
      walk(at(2026, 7, MON, 11, 0)),
      walk(at(2026, 7, MON, 11, 1)),
      walk(at(2026, 7, MON, 11, 3)),
      walk(at(2026, 7, MON + 4, 11, 0)),
    ];
    const c = cadenceOf(walks, now);
    // Three gaps, sorted: 1min, 2min, ~4 days. The middle one is 2 minutes.
    expect(c.medianGapMs).toBe(2 * 60_000);
    // The MEAN would be about 1.33 days — 960× larger, and the wrong direction
    // is not the point: it is that one sitting decides it either way.
    expect(c.medianGapMs).toBeLessThan(DAY);
  });

  it("averages the two middle gaps when there is an even number of them", () => {
    const walks = [
      walk(at(2026, 7, MON, 12)),
      walk(at(2026, 7, MON + 1, 12)),
      walk(at(2026, 7, MON + 3, 12)),
    ];
    // gaps: 1 day, 2 days → median 1.5 days
    expect(cadenceOf(walks, now).medianGapMs).toBe(1.5 * DAY);
  });

  it("measures quiet from the LAST walk, never from the first", () => {
    const walks = [
      walk(at(2026, 7, MON, 12)),
      walk(at(2026, 7, MON + 1, 12)),
      walk(at(2026, 7, MON + 2, 12)),
    ];
    expect(cadenceOf(walks, now).quietMs).toBe(4 * DAY);
  });

  it("sorts before measuring, so an out-of-order list still reads right", () => {
    const walks = [
      walk(at(2026, 7, MON + 2, 12)),
      walk(at(2026, 7, MON, 12)),
      walk(at(2026, 7, MON + 1, 12)),
    ];
    expect(cadenceOf(walks, now).quietMs).toBe(4 * DAY);
    expect(cadenceOf(walks, now).medianGapMs).toBe(DAY);
  });
});

describe("hasFaded", () => {
  it("declares its constants", () => {
    expect(FADE_MULTIPLE).toBe(3);
    expect(FADE_FLOOR_MS).toBe(4 * WEEK);
  });

  const weekly = [
    walk(at(2026, 7, 3, 10)),
    walk(at(2026, 7, 10, 10)),
    walk(at(2026, 7, MON, 10)),
  ];

  /**
   * THE DAY-ONE BACKFIRE, refused. The author's real kept habit has a ~36h
   * median gap and had been quiet 72h when this was written. Three times its
   * own cadence is 108h, which it had already passed. Only the absolute floor
   * keeps the band silent, which is the whole reason the floor exists.
   */
  it("stays silent on a habit that passed 3x its cadence but not four weeks", () => {
    const real = [
      walk(at(2026, 7, MON, 11, 14)),
      walk(at(2026, 7, MON, 20, 45)),
      walk(at(2026, 7, MON + 3, 11, 0)),
    ];
    const now = at(2026, 7, MON + 9, 12);
    const c = cadenceOf(real, now);
    expect(c.quietMs!).toBeGreaterThan(FADE_MULTIPLE * c.medianGapMs!);
    expect(hasFaded(real, now)).toBe(false);
  });

  it("stays silent below three walks however long the quiet", () => {
    const two = [walk(at(2026, 7, 3, 10)), walk(at(2026, 7, 10, 10))];
    expect(hasFaded(two, at(2027, 7, 10, 10))).toBe(false);
  });

  it("stays silent inside four weeks even for a fast cadence", () => {
    expect(hasFaded(weekly, at(2026, 7, MON, 10) + 3 * WEEK)).toBe(false);
  });

  /** One cycle late is DUE, not fading — that is what the multiple is for. */
  it("stays silent for a monthly habit one cycle late", () => {
    const monthly = [
      walk(at(2026, 3, 1, 10)),
      walk(at(2026, 4, 1, 10)),
      walk(at(2026, 5, 1, 10)),
    ];
    // ~30 day cadence, quiet ~35 days: past the absolute floor, inside 3x.
    expect(hasFaded(monthly, at(2026, 6, 5, 10))).toBe(false);
  });

  it("speaks once BOTH the cadence multiple and the four weeks are exceeded", () => {
    // weekly cadence: 3x is 21 days, so the four-week floor binds.
    expect(hasFaded(weekly, at(2026, 7, MON, 10) + 5 * WEEK)).toBe(true);
  });

  it("is exclusive at the boundary, so exactly four weeks is not yet fading", () => {
    expect(hasFaded(weekly, at(2026, 7, MON, 10) + FADE_FLOOR_MS)).toBe(false);
    expect(hasFaded(weekly, at(2026, 7, MON, 10) + FADE_FLOOR_MS + 1)).toBe(true);
  });
});

describe("fadeLine", () => {
  const weekly = [
    walk(at(2026, 7, 3, 10)),
    walk(at(2026, 7, 10, 10)),
    walk(at(2026, 7, MON, 10)),
  ];

  it("is null for a habit that has not faded", () => {
    expect(fadeLine(weekly, at(2026, 7, MON, 10) + WEEK)).toBeNull();
  });

  it("states the cadence and the quiet, as facts", () => {
    expect(fadeLine(weekly, at(2026, 7, MON, 10) + 6 * WEEK)).toBe(
      "about every 7 days · last walked 6 weeks ago",
    );
  });

  it("never grades, never counts down, never says behind", () => {
    const line = fadeLine(weekly, at(2026, 7, MON, 10) + 6 * WEEK)!;
    expect(line).not.toMatch(/%|behind|overdue|streak|score|should/i);
  });
});

/**
 * A CELL CARRIES ITS WALKS, because a cell you can point at is a cell you must
 * be able to follow.
 *
 * The grid used to hold bare counts, which is exactly enough to paint a square
 * and not enough to open anything — the same gap the ledger closed when its
 * marks gained `walk`. A count can say "you did this twice on Monday morning";
 * only the walk itself can take you there.
 */
describe("a cell carries the walks it counts", () => {
  const nine = at(2026, 7, MON, 9);
  const halfNine = at(2026, 7, MON, 9, 30);

  const fourAcrossThree = [
    walk(nine),
    walk(halfNine),
    walk(at(2026, 7, MON + 1, 14)),
    walk(at(2026, 7, MON + 5, 21)),
  ];

  it("puts both walks of a shared hour in that cell, and none in its neighbours", () => {
    const r = rhythmOf(fourAcrossThree);
    if (r.kind !== "grid") throw new Error("unreachable");
    const cell = r.grid.cells[0]![9]!;
    expect(cell.walks.map((w) => w.at)).toEqual([nine, halfNine]);
    expect(r.grid.cells[0]![8]!.walks).toEqual([]);
    expect(r.grid.cells[0]![10]!.walks).toEqual([]);
  });

  /** `count` is `walks.length`, in every cell. Two numbers that can disagree
      are one bug waiting; the paint and the link must come from one fact. */
  it("never lets the count and the walks disagree", () => {
    const r = rhythmOf(fourAcrossThree);
    if (r.kind !== "grid") throw new Error("unreachable");
    for (const row of r.grid.cells) {
      for (const cell of row) expect(cell.count).toBe(cell.walks.length);
    }
  });

  /**
   * OLDEST FIRST inside a cell, and sorted here rather than trusted.
   * `binding.walks` is documented oldest-first and `cadenceOf` still sorts it —
   * a rule this consequential should not depend on a caller honouring that.
   * The click target is the earliest walk in the hour, so an unsorted cell
   * silently opens the wrong recording.
   */
  it("sorts a cell's walks oldest first even when handed them backwards", () => {
    const r = rhythmOf([
      walk(halfNine),
      walk(nine),
      walk(at(2026, 7, MON + 1, 14)),
      walk(at(2026, 7, MON + 5, 21)),
    ]);
    if (r.kind !== "grid") throw new Error("unreachable");
    expect(r.grid.cells[0]![9]!.walks.map((w) => w.at)).toEqual([nine, halfNine]);
  });

  it("keeps peak reading the counts, so the ramp is unchanged", () => {
    const r = rhythmOf(fourAcrossThree);
    if (r.kind !== "grid") throw new Error("unreachable");
    expect(r.grid.peak).toBe(2);
  });
});

/**
 * What a cell says when a pointer asks it — the `weekCellLabel` / `markLabel`
 * rule, one screen over: the picture is the reading and the words are the fact,
 * so a pointer and a screen reader are told the same thing.
 */
describe("what one cell says", () => {
  it("names the day and the hour, and counts in words", () => {
    expect(cellLabel(0, 9, { count: 2, walks: [] })).toBe("Monday 09:00 — 2 recordings");
    expect(cellLabel(6, 21, { count: 1, walks: [] })).toBe("Sunday 21:00 — 1 recording");
  });

  /** Midnight is 00:00, not 0:00 — the grid's axis prints two digits and the
      label must agree with the axis it sits under. */
  it("pads the hour to two digits", () => {
    expect(cellLabel(1, 0, { count: 1, walks: [] })).toBe("Tuesday 00:00 — 1 recording");
  });

  it("says an empty hour is empty rather than printing a zero on its own", () => {
    expect(cellLabel(3, 15, { count: 0, walks: [] })).toBe("Thursday 15:00 — no recordings");
  });

  it("never prints a rate, a percentage or a grade", () => {
    expect(cellLabel(0, 9, { count: 2, walks: [] })).not.toMatch(/%|score|rate|streak/i);
  });
});

/**
 * THE HOUR AXIS, which the grid shipped without.
 *
 * Seven rows of twenty-four unlabelled cells cannot answer the question the
 * strip exists to ask: it could say a habit repeats somewhere mid-week and
 * never that it happens at 9am. Measured in the running app — 168 cells, no
 * hour anywhere on screen.
 *
 * EVERY THIRD HOUR, never all 24. A tick spans three columns, so even in a
 * narrow pane a two-digit label has three cells of width to sit in — the
 * `labelFits` rule reached structurally rather than by measuring: a label that
 * cannot truncate needs no truncation guard.
 */
describe("the hour axis", () => {
  it("ticks every third hour, so 24 columns carry 8 labels", () => {
    expect(HOUR_TICK_SPAN).toBe(3);
    expect(HOUR_TICKS).toHaveLength(8);
  });

  it("starts at midnight and ends at 21:00, two digits throughout", () => {
    expect(HOUR_TICKS.map((t) => t.label)).toEqual([
      "00", "03", "06", "09", "12", "15", "18", "21",
    ]);
  });

  /** The ticks must TILE the 24 columns exactly: a gap or an overlap puts every
      label to the right of it under the wrong cell, which is a picture that
      lies rather than one that is merely sparse. */
  it("tiles all 24 columns exactly, with no gap and no overlap", () => {
    expect(HOUR_TICKS.map((t) => t.hour)).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
    expect(HOUR_TICKS.length * HOUR_TICK_SPAN).toBe(24);
  });
});
