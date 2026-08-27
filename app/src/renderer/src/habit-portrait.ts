/**
 * What the band under `<h1>What you do repeatedly</h1>` says.
 *
 * The h1 has always asked a question and been answered by a file list. This is
 * the answer: WHERE your repeated work happens, and HOW MUCH of what you record
 * recurs at all — `post.md`'s second lesson, that routines are proof of who you
 * are, made into something a glance can read.
 *
 * A `.ts` module, never `.tsx`: the root `tsconfig.json` sets no `jsx`, so a
 * root test that reaches into a `.tsx` — even for a type — breaks
 * `npm run typecheck`. Main decides what a route MEANS; this decides how the
 * library reads as a whole.
 *
 * NO SCORE. There is no ratio, no percentage and no grade here. Counts are
 * printed only in words, for the same reason a ledger mark carries no timestamp
 * on its face.
 *
 * The coverage line IS this band's honesty: on a thin library it says something
 * true and small, and its smallness is the disclosure. That is what makes the
 * portrait the one of C2's three surfaces that can fire on a six-day store.
 *
 * WHY THE BARS ARE GONE. `portraitOf` weighed each application by the
 * recordings of recurring routes passing through it, and drew a bar per
 * application against the heaviest. On the author's real store all three bars
 * were FULL WIDTH and always would be: one kept habit walks Calculator,
 * TextEdit and Finder, so each weighs 6, and all four proposals are ×1 and are
 * excluded by the recurrence gate. The chart could only differentiate on a
 * library holding several DIFFERENT recurring routes — it degenerated on
 * exactly the library that exists, and said nothing about time at all.
 *
 * `portraitWeek` answers WHERE IN THE WEEK instead, over the whole library, on
 * the grid `habit-rhythm.ts` already draws per habit. What makes it more than a
 * bigger copy of that grid is the one distinction the per-habit grid
 * STRUCTURALLY CANNOT make — every walk it holds belongs to one route:
 *
 *   A FILLED CELL IS A ROUTE THAT RECURS. A HOLLOW RING IS ONE WALKED ONCE.
 *
 * That is the ledger's `is-lone` rule lifted one instrument up, and it is the
 * screen's whole thesis said in the picture rather than only in the lede: an
 * act done once is an observation, and repetition is what makes it a habit.
 */

import type { HabitDTO, HabitProposalDTO, WalkMarkDTO } from "@shared/types";
import {
  RHYTHM_MIN_DAYS,
  RHYTHM_MIN_WALKS,
  localDayKey,
  placeInWeek,
} from "./habit-rhythm.js";

export interface Portrait {
  /** One line: distinct recordings, routes, walked-again, written-down. */
  coverage: string;
  /** Nothing has been walked at all, so the band draws nothing. */
  empty: boolean;
}

/** One recurring route, flattened so a habit and a proposal weigh the same. */
interface Source {
  apps: readonly string[];
  recordings: number;
  sessionIds: readonly string[];
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Two digits, so a label agrees with the axis it sits under: 00:00, not 0:00. */
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The days spelled out, for the WORDS. The picture's labels live in `DAYS`. */
const DAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
] as const;

/**
 * The recurring routes, from both halves of the screen.
 *
 * A KEPT habit is included at any recording count, because keeping it is a
 * human act asserting the recurrence and a deleted recording must not silently
 * retract it. An unkept proposal needs `count > 1` to be in the picture at all —
 * nobody has claimed it, so the only evidence it is a habit is that it recurred.
 */
function sourcesOf(data: {
  habits: readonly HabitDTO[];
  proposals: readonly HabitProposalDTO[];
}): Source[] {
  return [
    ...data.habits
      .filter((h) => h.state === "active")
      .map((h) => ({
        apps: h.apps,
        recordings: h.binding.recordings,
        sessionIds: h.binding.walks.map((w) => w.sessionId),
      })),
    ...data.proposals
      .filter((p) => p.count > 1)
      .map((p) => ({ apps: p.apps, recordings: p.count, sessionIds: p.sessionIds })),
  ];
}

/* ------------------------------------------------------------------------- *
 * The library's week
 * ------------------------------------------------------------------------- */

/**
 * One walk, carrying the two things a global cell needs and a per-habit cell
 * never does: WHICH ROUTE it belongs to, and whether that route recurs.
 *
 * The per-habit grid can leave both implicit — every walk in it is one route,
 * and the row above already says whether that route was kept. A cell drawn over
 * the whole library can hold walks from different routes in the same hour, so a
 * card that did not name them would offer several Open buttons and no way to
 * tell which recording each one leads to.
 */
export interface PortraitWalk {
  walk: WalkMarkDTO;
  /** The habit's title, or the proposal's name falling back to its label. */
  routeTitle: string;
  /** This route has been walked more than once. See the module header. */
  recurring: boolean;
}

export interface PortraitCell {
  count: number;
  /**
   * ANY walk here belongs to a route that recurs — the cell fills.
   *
   * A mixed hour is filled rather than hollow: something that repeats happened
   * then, and that is the claim the fill makes. The card lists what is in it.
   */
  recurring: boolean;
  /** OLDEST FIRST. Sorted here, never trusted — the `rhythmOf` rule. */
  walks: PortraitWalk[];
}

export interface PortraitGrid {
  /** 7 rows (0 = Monday) × 24 columns. */
  cells: PortraitCell[][];
  /** The largest count in any cell — the ramp's top. NEVER printed. */
  peak: number;
  /** Every walk drawn, and how many of them belong to a recurring route. */
  walks: number;
  recurring: number;
  days: number;
}

export type PortraitWeek =
  | { kind: "grid"; grid: PortraitGrid }
  | { kind: "too-few"; walks: number; days: number; reason: string };

/**
 * WHERE IN THE WEEK the whole library's work happens.
 *
 * It draws EVERY walk, not only the recurring ones, which is the difference
 * between this and the bars it replaces. A band that showed only what recurs
 * cannot show that something does not — and the contrast between a filled cell
 * and a hollow one is the reading. The counts are separated on `PortraitGrid`
 * so the note can state both without recomputing either.
 *
 * The FLOOR is `habit-rhythm.ts`'s, unchanged and imported rather than
 * restated: four walks across three days. Globally it is easier to clear than
 * per habit — the author's store has ten walks across seven days where the kept
 * habit alone has six — which is exactly why the band can say something on a
 * library where every per-habit grid still says "too few".
 */
export function portraitWeek(data: {
  habits: readonly HabitDTO[];
  proposals: readonly HabitProposalDTO[];
}): PortraitWeek {
  const all: PortraitWalk[] = [
    ...data.habits
      .filter((h) => h.state === "active")
      .flatMap((h) =>
        h.binding.walks.map((walk) => ({
          walk,
          routeTitle: h.title,
          // A KEPT habit recurs at any count, for `sourcesOf`'s reason: keeping
          // it is a human act asserting the recurrence, and a deleted recording
          // must not silently retract it.
          recurring: true,
        })),
      ),
    ...data.proposals.flatMap((p) =>
      p.walks.map((walk) => ({
        walk,
        routeTitle: p.name ?? p.label,
        recurring: p.count > 1,
      })),
    ),
  ];

  const days = new Set(all.map((w) => localDayKey(w.walk.at))).size;
  if (all.length < RHYTHM_MIN_WALKS || days < RHYTHM_MIN_DAYS) {
    return {
      kind: "too-few",
      walks: all.length,
      days,
      // States what it HAS, never "unknown" and never absent: an absent band is
      // indistinguishable from one nobody implemented — the `skipReason` rule.
      reason: `${plural(all.length, "recording")}, on ${plural(days, "day")} — too few to place in the week.`,
    };
  }

  const cells: PortraitCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ count: 0, recurring: false, walks: [] as PortraitWalk[] })),
  );
  // SORTED, not trusted, for `rhythmOf`'s reason: the card lists walks in the
  // order it is handed them, so an unsorted cell reads oldest-last in a screen
  // whose every other instrument reads oldest-first.
  for (const w of [...all].sort((a, b) => a.walk.at - b.walk.at)) {
    const { day, hour } = placeInWeek(w.walk.at);
    cells[day]![hour]!.walks.push(w);
  }
  for (const row of cells) {
    for (const cell of row) {
      cell.count = cell.walks.length;
      cell.recurring = cell.walks.some((w) => w.recurring);
    }
  }

  return {
    kind: "grid",
    grid: {
      cells,
      peak: Math.max(...cells.flat().map((c) => c.count)),
      walks: all.length,
      recurring: all.filter((w) => w.recurring).length,
      days,
    },
  };
}

/**
 * The grid's claim, in words — because a picture that cannot be said is not a
 * reading, it is decoration.
 *
 * It states the FILL RULE rather than a summary of the shape, because the fill
 * is the one thing about this grid a reader cannot infer: a hollow ring and a
 * faint square are not obviously different claims until someone says so.
 */
export function weekNote(grid: PortraitGrid): string {
  const once = grid.walks - grid.recurring;
  if (grid.recurring === 0) {
    return `${plural(grid.walks, "recording")} across ${plural(grid.days, "day")} — none of these routes has been walked twice yet.`;
  }
  if (once === 0) {
    return `${plural(grid.walks, "recording")} across ${plural(grid.days, "day")}, every one of them on a route you have walked before.`;
  }
  return `${plural(grid.walks, "recording")} across ${plural(grid.days, "day")} · ${grid.recurring} on a route walked more than once, ${once} seen once.`;
}

/** The same claim as the picture's accessible name. */
export function weekLabel(grid: PortraitGrid): string {
  return `Recordings by hour of the week. ${weekNote(grid)}`;
}

/**
 * What ONE cell says when a pointer asks it.
 *
 * The `cellLabel` rule one instrument down: the picture is the reading and the
 * words are the fact, so a pointer and a screen reader are told the same thing.
 * An empty hour says it is empty rather than printing a bare zero, which reads
 * as a measurement of nothing.
 */
export function weekCellLabel(day: number, hour: number, cell: PortraitCell): string {
  const when = `${DAY_NAMES[day] ?? "?"} ${pad2(hour)}:00`;
  if (cell.count === 0) return `${when} — no recordings`;
  const what = plural(cell.count, "recording");
  // The FILL RULE, said on the cell that carries it. A hollow ring is the only
  // mark on this band whose meaning is not its position, so it says so here.
  return `${when} — ${what}${cell.recurring ? "" : ", on a route seen once"}`;
}

/* ------------------------------------------------------------------------- *
 * The coverage line
 * ------------------------------------------------------------------------- */

export function portraitOf(data: {
  habits: readonly HabitDTO[];
  proposals: readonly HabitProposalDTO[];
}): Portrait {
  const sources = sourcesOf(data);

  // DISTINCT ids, never the sum of route counts: one recording can walk two
  // routes, and summing would report more recordings than the library holds.
  const ids = new Set<string>();
  for (const s of sources) for (const id of s.sessionIds) ids.add(id);

  // COMPUTED, not restated as the route count. The spec expected these to be
  // equal by construction; they are equal only while every kept habit still
  // holds two recordings, and `lostSessionIds` exists because that can end.
  const walkedAgain = sources.filter((s) => s.recordings > 1).length;
  const written = data.habits.filter((h) => h.state === "active").length;

  // EMPTY is now "nothing has been walked at all", not "nothing recurs". The
  // grid draws single observations as hollow rings, so a library holding only
  // one-off routes has a picture to draw and a true thing to say about it —
  // where the bars, which weighed only recurring routes, had neither.
  const anyWalk =
    data.habits.some((h) => h.state === "active" && h.binding.walks.length > 0) ||
    data.proposals.some((p) => p.walks.length > 0);

  return {
    coverage: [
      // WORDED as a count of recordings that walked a route, never as the
      // library total: some recordings walk nothing, and this band cannot see
      // them. Deriving it from the walks already on the wire also means it can
      // never disagree with the ledgers drawn below it.
      `${plural(ids.size, "recording")} walked a route`,
      plural(sources.length, "route"),
      `${walkedAgain} walked again`,
      `${written} written down`,
    ].join(" · "),
    empty: !anyWalk,
  };
}
