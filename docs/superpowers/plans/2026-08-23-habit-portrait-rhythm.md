# The Portrait, the Rhythm and the Quiet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Habits screen the two `post.md` lessons it has no surface for — a portrait band answering the `<h1>` it sits under, a 7×24 rhythm strip in phase, and a "Not walked lately" band — with each of the two that a six-day library cannot exercise declaring its own insufficiency instead of merely not appearing.

**Architecture:** All three readings are projections over DTOs already on the wire (walk timestamps, route labels), so they live in the renderer as `.ts` modules the root suite can reach, and main changes by exactly one field. Two new modules: `habit-portrait.ts` (what the head band says) and `habit-rhythm.ts` (what the walk *times* say — grid, cadence and fade together, because all three read `walks[].at` and splitting them would duplicate the "is there enough here" judgement).

**Tech Stack:** TypeScript strict + ESM (NodeNext, `.js` on relative imports), React 18, vitest, Electron. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-23-habit-portrait-rhythm-design.md`

## Global Constraints

- **No score.** No ratio, percentage, streak, grade or fitness float on any of the three surfaces. `"last walked 6 weeks ago"` is a fact; `"6 weeks behind"` would be a scoreboard.
- **Nothing reaches `HABIT.md`.** No new markdown block, no change to `recordedBlocks()`, no new prose, no model call. `npm run probe:habits` staying green is the guard.
- **Colour: `--data-0` (teal) at varying lightness only.** One hue, one ramp, for both the place bars and the grid cells. Never `--data-1..7`, never `--data-warn` / `--data-alarm` / `--data-ok`. C1 owns `--data-2` (violet, deviated) and `--data-3` (clay, short); `styles.css` is one global sheet with no scoping, so a colour's meaning is a repo-wide claim exactly as a class name is.
- **Pure renderer modules are `.ts`, never `.tsx`.** The root `tsconfig.json` sets no `jsx`, so a root test that reaches a `.tsx` — even for a type — breaks `npm run typecheck`.
- **`now` is injected**, never read from the wall clock inside a pure module. Same rule as the `wallClock`/`timecode` formatters threaded into `markReadout`.
- **The rhythm floor is `>= 4` walks across `>= 3` distinct calendar days.** Both halves load-bearing; see Task 2.
- **The fade rule is `walks >= 3 AND quiet > max(3 × median gap, 4 weeks)`.** The 4-week absolute floor is the only thing between this band and the day-one backfire.
- **Both floors ship UNSWEPT and say so** — in each module's own comment and in `docs/todo.md` (Task 7).
- **Fading applies to kept, non-archived habits only.** A proposal has no keeping act to fade from; archiving is a deliberate setting-aside.
- **The gate is three unpiped commands**, run separately. Piping through `tail` returns `tail`'s exit code and hides a failure:
  ```
  npm test
  npm run typecheck
  npm run build && npm --prefix app run typecheck
  ```
  The app imports `dist/`, so the library must be built before the app's typecheck.
- TypeScript is `strict` with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`. `app/tsconfig.json` adds `noUnusedLocals` / `noUnusedParameters`. Index into an array and you get `T | undefined` — write `arr[i]!` or `?? fallback`, never a bare `+=` on an indexed slot.

---

### Task 1: The portrait's readings, and `apps` on the wire

**Files:**
- Create: `app/src/renderer/src/habit-portrait.ts`
- Create: `test/habit-portrait.test.ts`
- Modify: `app/src/shared/types.ts` (add `HabitDTO.apps`, near `ways` at ~line 1451)
- Modify: `app/src/main/deskrag-service.ts` (one line in `toHabitDTO`'s return, beside `ways` at ~line 1923)
- Modify: `test/habits-view.test.ts:53-76` (the `habit()` fixture) and `test/mcp.tools.test.ts:~524` (its habit fixture) — both gain `apps: []`

**Interfaces:**
- Consumes: `HabitDTO`, `HabitProposalDTO` from `@shared/types`; `flowApps(flows, route): string[]` from `app/src/main/flow-steps.ts`, already imported by `deskrag-service.ts` at line 75 and already used for proposals at line 2001.
- Produces:
  ```ts
  interface PortraitPlace { app: string; recordings: number; share: number }
  interface Portrait { places: PortraitPlace[]; coverage: string; empty: boolean }
  function portraitOf(data: { habits: readonly HabitDTO[]; proposals: readonly HabitProposalDTO[] }): Portrait
  function placeLabel(place: PortraitPlace): string
  ```
  Task 5 renders all four.

**Why `apps` is folded into this task rather than its own:** the field exists only to feed the portrait, and main-side code cannot be unit-tested from the root suite (`deskrag-service.ts` imports electron). Its gate is the compile plus the Task 7 probe.

- [ ] **Step 1: Add `apps` to the DTO**

In `app/src/shared/types.ts`, inside `interface HabitDTO`, directly above the existing `/** The record's Ways, structured, so its steps can open their own moment. */` line:

```ts
  /**
   * Every application this habit's route passes through, in order reached.
   *
   * The same `flowApps` projection `HabitProposalDTO.apps` already carries, so
   * the portrait band can weigh a kept habit and an unkept proposal on one
   * scale. Empty when there is no live route — an orphaned habit's places are
   * not knowable, and inventing them from the bind-time label would put a
   * guess in a picture.
   */
  apps: string[];
```

- [ ] **Step 2: Fill it in main**

In `app/src/main/deskrag-service.ts`, in `toHabitDTO`'s return object, directly above the existing `ways:` line:

```ts
      apps: flows !== null && bound.route !== null ? flowApps(flows, bound.route) : [],
```

- [ ] **Step 3: Add `apps: []` to the two habit fixtures**

`test/habits-view.test.ts`, in the `habit()` builder, on the line after `droppedEarly: [],`:

```ts
  apps: [],
```

`test/mcp.tools.test.ts`, in its habit fixture, on the line after its `droppedEarly: [],`:

```ts
  apps: [],
```

- [ ] **Step 4: Write the failing test**

Create `test/habit-portrait.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { placeLabel, portraitOf } from "../app/src/renderer/src/habit-portrait.js";
import type { HabitBindingDTO, HabitDTO, HabitProposalDTO, WalkMarkDTO } from "@shared/types";

/**
 * What the band under `<h1>What you do repeatedly</h1>` says.
 *
 * A `.ts` module so the root suite can reach it — the root tsconfig sets no
 * `jsx`, so a test touching a `.tsx` even for a type breaks `npm run typecheck`.
 */

const walk = (sessionId: string): WalkMarkDTO => ({
  sessionId,
  at: 0,
  gained: false,
  fit: null,
  walk: { atSec: 0, throughSec: 1, steps: 2 },
});

const binding = (over: Partial<HabitBindingDTO> = {}): HabitBindingDTO => ({
  state: "exact",
  routeKey: "A → B",
  liveRouteKey: "A → B",
  routeLabel: "A → B",
  boundAt: 0,
  boundSessionIds: [],
  overlap: 0,
  lostSessionIds: [],
  gainedSessionIds: [],
  recordings: 2,
  candidates: [],
  note: null,
  walks: [walk("s1"), walk("s2")],
  ...over,
});

const habit = (over: Partial<HabitDTO> = {}): HabitDTO => ({
  id: "k1",
  state: "active",
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
  version: "0.1.0",
  history: [],
  duplicates: [],
  ways: [],
  droppedEarly: [],
  apps: ["Calculator", "TextEdit"],
  slug: "a-habit",
  title: "A habit",
  description: "Use when.",
  body: "prose",
  bodySource: "template",
  bodyModel: null,
  edited: false,
  showSamples: false,
  generateNote: null,
  markdown: "---\n",
  binding: binding(),
  ...over,
});

const proposal = (over: Partial<HabitProposalDTO> = {}): HabitProposalDTO => ({
  routeKey: "C → D",
  name: null,
  label: "C → D",
  count: 3,
  steps: 3,
  stepSummary: "3 steps",
  variants: 0,
  nameObservations: 0,
  walks: [walk("s3"), walk("s4"), walk("s5")],
  sessionIds: ["s3", "s4", "s5"],
  apps: ["Chrome"],
  preview: "",
  ...over,
});

describe("portraitOf places", () => {
  it("weighs each application by the recordings of the routes it appears in", () => {
    const p = portraitOf({ habits: [habit()], proposals: [proposal()] });
    expect(p.places).toEqual([
      { app: "Chrome", recordings: 3, share: 1 },
      { app: "Calculator", recordings: 2, share: 2 / 3 },
      { app: "TextEdit", recordings: 2, share: 2 / 3 },
    ]);
  });

  it("sums an application that appears in more than one route", () => {
    const p = portraitOf({
      habits: [habit({ apps: ["Chrome"] })],
      proposals: [proposal()],
    });
    expect(p.places).toEqual([{ app: "Chrome", recordings: 5, share: 1 }]);
  });

  /**
   * The h1 asks what you do REPEATEDLY. A route seen once is an observation,
   * and letting it colour the portrait would answer a different question.
   */
  it("excludes a route walked only once", () => {
    const p = portraitOf({ habits: [], proposals: [proposal({ count: 1, apps: ["Mail"] })] });
    expect(p.places).toEqual([]);
    expect(p.empty).toBe(true);
  });

  it("keeps a kept habit even when its evidence dropped to one recording", () => {
    // Being written down IS the recurrence claim, and a deleted recording must
    // not silently retract it. `lostSessionIds` exists precisely for this case.
    const p = portraitOf({
      habits: [habit({ binding: binding({ recordings: 1, walks: [walk("s1")] }) })],
      proposals: [],
    });
    expect(p.places.map((x) => x.app)).toEqual(["Calculator", "TextEdit"]);
  });

  it("drops an archived or dismissed habit from the picture", () => {
    for (const state of ["archived", "dismissed"] as const) {
      expect(portraitOf({ habits: [habit({ state })], proposals: [] }).empty).toBe(true);
    }
  });

  it("breaks a weight tie on first appearance, so the order is stable", () => {
    const p = portraitOf({
      habits: [habit({ apps: ["Zed", "Alfred"] })],
      proposals: [],
    });
    expect(p.places.map((x) => x.app)).toEqual(["Zed", "Alfred"]);
  });
});

describe("portraitOf coverage", () => {
  it("counts DISTINCT recordings, never the sum of route counts", () => {
    // s1 walks both routes. Summing would report 4 recordings from 3.
    const p = portraitOf({
      habits: [habit()],
      proposals: [proposal({ sessionIds: ["s1", "s2"], count: 2, walks: [walk("s1"), walk("s2")] })],
    });
    expect(p.coverage).toBe("2 recordings walked a route · 2 routes · 2 walked again · 1 written down");
  });

  /** Never "the library holds N recordings" — some recordings walk no route. */
  it("says what the number is a count OF", () => {
    expect(portraitOf({ habits: [habit()], proposals: [] }).coverage).toMatch(
      /^2 recordings walked a route/,
    );
  });

  it("counts walked-again rather than restating the route count", () => {
    // A kept habit down to one recording is a route, and is not walked again.
    const p = portraitOf({
      habits: [habit({ binding: binding({ recordings: 1, walks: [walk("s1")] }) })],
      proposals: [proposal()],
    });
    expect(p.coverage).toBe("4 recordings walked a route · 2 routes · 1 walked again · 1 written down");
  });

  it("says one recording and one route in the singular", () => {
    const p = portraitOf({
      habits: [habit({ binding: binding({ recordings: 1, walks: [walk("s1")] }) })],
      proposals: [],
    });
    expect(p.coverage).toBe("1 recording walked a route · 1 route · 0 walked again · 1 written down");
  });
});

describe("placeLabel", () => {
  /**
   * A bar carries no printed number, exactly as a ledger mark carries no
   * printed timestamp: the words are the fact and the picture is the metaphor.
   */
  it("says the count in words, with its unit", () => {
    expect(placeLabel({ app: "Calculator", recordings: 3, share: 1 })).toBe(
      "Calculator · 3 recordings of repeated work",
    );
    expect(placeLabel({ app: "Mail", recordings: 1, share: 0.5 })).toBe(
      "Mail · 1 recording of repeated work",
    );
  });
});
```

- [ ] **Step 5: Run the test and watch it fail**

Run: `npx vitest run test/habit-portrait.test.ts`
Expected: FAIL — `Failed to resolve import "../app/src/renderer/src/habit-portrait.js"`.

- [ ] **Step 6: Write the module**

Create `app/src/renderer/src/habit-portrait.ts`:

```ts
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
 * NO SCORE. There is no ratio, no percentage and no grade here. `share` is a
 * bar WIDTH against the top bar and is never printed; the counts are printed
 * only in words, through `placeLabel`, for the same reason a ledger mark
 * carries no timestamp on its face.
 *
 * There is deliberately no insufficiency state. The coverage line IS this
 * band's honesty: on a thin library it says something true and small, and its
 * smallness is the disclosure. That is what makes the portrait the one of C2's
 * three surfaces that can fire on a six-day store.
 */

import type { HabitDTO, HabitProposalDTO } from "@shared/types";

/** One application, and how much repeated work happens in it. */
export interface PortraitPlace {
  app: string;
  /** Recordings of recurring routes that pass through this application. */
  recordings: number;
  /** 0..1 against the TOP place — a bar width, never shown as a number. */
  share: number;
}

export interface Portrait {
  /** Heaviest first; ties on first appearance, so reloads do not reshuffle. */
  places: PortraitPlace[];
  /** One line: distinct recordings, routes, walked-again, written-down. */
  coverage: string;
  /** Nothing recurs, so the band draws nothing at all. */
  empty: boolean;
}

/** One recurring route, flattened so a habit and a proposal weigh the same. */
interface Source {
  apps: readonly string[];
  recordings: number;
  sessionIds: readonly string[];
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

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

export function portraitOf(data: {
  habits: readonly HabitDTO[];
  proposals: readonly HabitProposalDTO[];
}): Portrait {
  const sources = sourcesOf(data);

  const weight = new Map<string, number>();
  for (const s of sources) {
    for (const app of s.apps) weight.set(app, (weight.get(app) ?? 0) + s.recordings);
  }
  // `Array.prototype.sort` is stable, and a Map iterates in insertion order, so
  // a tie keeps first appearance without a second key.
  const ranked = [...weight].sort((a, b) => b[1] - a[1]);
  const peak = ranked[0]?.[1] ?? 0;

  // DISTINCT ids, never the sum of route counts: one recording can walk two
  // routes, and summing would report more recordings than the library holds.
  const ids = new Set<string>();
  for (const s of sources) for (const id of s.sessionIds) ids.add(id);

  // COMPUTED, not restated as the route count. The spec expected these to be
  // equal by construction; they are equal only while every kept habit still
  // holds two recordings, and `lostSessionIds` exists because that can end.
  const walkedAgain = sources.filter((s) => s.recordings > 1).length;
  const written = data.habits.filter((h) => h.state === "active").length;

  return {
    places: ranked.map(([app, recordings]) => ({
      app,
      recordings,
      share: peak <= 0 ? 0 : recordings / peak,
    })),
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
    empty: sources.length === 0,
  };
}

/** What one bar says when a reader asks it. Words, never a bare number. */
export function placeLabel(place: PortraitPlace): string {
  return `${place.app} · ${plural(place.recordings, "recording")} of repeated work`;
}
```

- [ ] **Step 7: Run the test and watch it pass**

Run: `npx vitest run test/habit-portrait.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 8: Run the whole gate**

Three separate commands — never piped:

```
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

Expected: all green. `npm test` should report 2 more test files than before and every existing test still passing; the two fixture edits in Step 3 are what keep `test/habits-view.test.ts` and `test/mcp.tools.test.ts` compiling.

- [ ] **Step 9: Commit**

```bash
git add app/src/shared/types.ts app/src/main/deskrag-service.ts \
        app/src/renderer/src/habit-portrait.ts \
        test/habit-portrait.test.ts test/habits-view.test.ts test/mcp.tools.test.ts
git commit -m "feat(habits): what you do repeatedly, as places and coverage

The h1 has asked a question since Habits shipped and been answered by a
file list. portraitOf answers it: which applications your recurring work
actually lives in, weighted by recordings, and how much of what you
record recurs at all.

Counts are DISTINCT session ids, never the sum of route counts -- one
recording can walk two routes. Walked-again is computed rather than
restated as the route count: the two are equal only while every kept
habit still holds two recordings, and lostSessionIds exists because that
can end.

No number is printed on a bar. share is a width; placeLabel says the
count in words, the same split the ledger already makes between the
picture and the fact.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The phase grid and its floor

**Files:**
- Create: `app/src/renderer/src/habit-rhythm.ts`
- Create: `test/habit-rhythm.test.ts`

**Interfaces:**
- Consumes: `WalkMarkDTO` from `@shared/types` (`at` is wall-clock ms, display-only by contract).
- Produces:
  ```ts
  const DAYS: readonly ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]
  const RHYTHM_MIN_WALKS = 4
  const RHYTHM_MIN_DAYS = 3
  interface PhaseGrid { cells: number[][]; peak: number; walks: number; days: number }
  type Rhythm = { kind: "grid"; grid: PhaseGrid } | { kind: "too-few"; walks: number; days: number; reason: string }
  function rhythmOf(walks: readonly WalkMarkDTO[]): Rhythm
  function rhythmNote(grid: PhaseGrid): string
  function rhythmLabel(grid: PhaseGrid): string
  ```
  Task 3 adds the cadence and fade exports to this same file. Task 6 renders all of the above.

- [ ] **Step 1: Write the failing test**

Create `test/habit-rhythm.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DAYS,
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
    expect(r.grid.cells[5]![21]).toBe(1);
    expect(r.grid.cells[6]![21]).toBe(0);
  });

  it("counts two walks in the same hour of the week into one cell", () => {
    const r = rhythmOf(fourAcrossThree);
    if (r.kind !== "grid") throw new Error("unreachable");
    expect(r.grid.cells[0]![9]).toBe(2);
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/habit-rhythm.test.ts`
Expected: FAIL — `Failed to resolve import "../app/src/renderer/src/habit-rhythm.js"`.

- [ ] **Step 3: Write the module**

Create `app/src/renderer/src/habit-rhythm.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/habit-rhythm.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Run the whole gate**

```
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/src/habit-rhythm.ts test/habit-rhythm.test.ts
git commit -m "feat(habits): where in the week, and when there is too little to say

The ledger answers when in your life. This answers where in the week,
which is the question automaticity actually turns on -- a habit done
every Tuesday at 9am currently draws exactly like one done at random.

The floor is >= 4 walks across >= 3 distinct calendar days, and the day
half is not taste. The real store holds four recordings inside four
minutes; they pass any walk-count floor, and a grid drawn from them
reads 'you do this Thursdays at 11am' from one sitting. Both halves are
in the test as named cases, and both values ship UNSWEPT -- a six-day
library cannot falsify them.

Below the floor the strip states what it has rather than vanishing, and
a grid where nothing repeats says so: recurring but not in phase is a
finding, not a failure.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The cadence and the fade rule

**Files:**
- Modify: `app/src/renderer/src/habit-rhythm.ts` (append — the module already exists from Task 2)
- Modify: `test/habit-rhythm.test.ts` (append two `describe` blocks; extend the import list)

**Interfaces:**
- Consumes: `WalkMarkDTO`; the module comment and the `plural` helper already in `habit-rhythm.ts` from Task 2.
- Produces:
  ```ts
  const FADE_FLOOR_MS: number   // 4 weeks
  const FADE_MULTIPLE = 3
  const FADE_MIN_WALKS = 3
  interface Cadence { medianGapMs: number | null; quietMs: number | null }
  function cadenceOf(walks: readonly WalkMarkDTO[], now: number): Cadence
  function hasFaded(walks: readonly WalkMarkDTO[], now: number): boolean
  function fadeLine(walks: readonly WalkMarkDTO[], now: number): string | null
  function approxDuration(ms: number): string
  ```
  Task 4 consumes `hasFaded`; Task 4 also renders `fadeLine`.

- [ ] **Step 1: Write the failing test**

In `test/habit-rhythm.test.ts`, extend the import from `habit-rhythm.js` to also bring in the new names — the whole import statement becomes:

```ts
import {
  approxDuration,
  cadenceOf,
  DAYS,
  fadeLine,
  FADE_FLOOR_MS,
  FADE_MIN_WALKS,
  FADE_MULTIPLE,
  hasFaded,
  RHYTHM_MIN_DAYS,
  RHYTHM_MIN_WALKS,
  rhythmLabel,
  rhythmNote,
  rhythmOf,
} from "../app/src/renderer/src/habit-rhythm.js";
```

Then append to the end of the file:

```ts
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/habit-rhythm.test.ts`
Expected: FAIL — the import of `approxDuration`, `cadenceOf`, `fadeLine`, `FADE_FLOOR_MS`, `FADE_MIN_WALKS`, `FADE_MULTIPLE`, `hasFaded` does not resolve.

- [ ] **Step 3: Implement, appended to `habit-rhythm.ts`**

Append to `app/src/renderer/src/habit-rhythm.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/habit-rhythm.test.ts`
Expected: PASS, 32 tests.

- [ ] **Step 5: Run the whole gate**

```
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/src/habit-rhythm.ts test/habit-rhythm.test.ts
git commit -m "feat(habits): a cadence, a quiet, and the floor that keeps them honest

fading <=> walks >= 3 AND quiet > max(3 x median gap, 4 weeks).

Every term is there to refuse a specific wrong answer. Three walks
because two give one gap and one gap is not a cadence. The MEDIAN
because the four-in-four-minutes cluster is exactly the shape that drags
a mean toward zero. Three times because one cycle late is due, not
fading. And the four absolute weeks because without them the rule marks
the author's real three-day-old habit as fading within two days -- its
median gap is 36h and it had been quiet 72h. That case is in the test by
name.

fadeLine states facts: 'about every 7 days, last walked 6 weeks ago'.
Not 'behind', not a countdown, not a grade.

The floor ships UNSWEPT; a six-day library cannot falsify it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The "Not walked lately" band

**Files:**
- Modify: `app/src/renderer/src/habits-view.ts:18-62` (`HabitBand`, `bandOf`, `HabitBands`, `bandHabits`) and its import block at line 8
- Modify: `app/src/renderer/src/screens/HabitsScreen.tsx:127` (the `bandHabits` call), the band list around lines 190-201, and `HabitRow` around lines 627-661
- Modify: `test/habits-view.test.ts` — the five `bandOf`/`bandHabits` call sites at lines 81, 86, 95, 99, 107, plus a new `describe`

**Interfaces:**
- Consumes: `hasFaded(walks, now): boolean` and `fadeLine(walks, now): string | null` from `./habit-rhythm.js` (Task 3).
- Produces:
  ```ts
  type HabitBand = "attention" | "mine" | "fading" | "archived"
  function bandOf(habit: HabitDTO, now: number): HabitBand
  interface HabitBands { attention: HabitDTO[]; mine: HabitDTO[]; fading: HabitDTO[]; archived: HabitDTO[] }
  function bandHabits(habits: readonly HabitDTO[], now: number): HabitBands
  ```

**Why the screen edit is in this task and not a later one:** changing `bandHabits`'s arity breaks `HabitsScreen.tsx` at compile time, so the tree is not green until both move together.

- [ ] **Step 1: Write the failing test**

In `test/habits-view.test.ts`, update the five existing call sites to pass a clock. Add this constant directly above `describe("bandOf", …)` (around line 77):

```ts
/** A fixed clock. Every band test that does not care about time uses it. */
const NOW = new Date(2026, 7, 23, 12).getTime();
```

Then change the five call sites to:

```ts
expect(bandOf(habit({ binding: binding({ state }) }), NOW)).toBe("attention");
```
```ts
expect(bandOf(habit(), NOW)).toBe("mine");
```
```ts
expect(bandOf(habit({ duplicates: ["k2"] }), NOW)).toBe("attention");
```
```ts
    expect(bandOf(habit({ state: "archived", binding: binding({ state: "orphaned" }) }), NOW)).toBe(
```
```ts
    const b = bandHabits([habit({ id: "a" }), habit({ id: "b", state: "dismissed" })], NOW);
```

Then append a new `describe` at the end of the file:

```ts
describe("the Not walked lately band", () => {
  /** Three walks a week apart, ending 2026-08-17. */
  const weekly = [
    walk({ sessionId: "w1", at: new Date(2026, 7, 3, 10).getTime() }),
    walk({ sessionId: "w2", at: new Date(2026, 7, 10, 10).getTime() }),
    walk({ sessionId: "w3", at: new Date(2026, 7, 17, 10).getTime() }),
  ];
  const quiet = (weeks: number): number =>
    new Date(2026, 7, 17, 10).getTime() + weeks * 7 * 24 * 3_600_000;

  const kept = habit({ binding: binding({ walks: weekly, recordings: 3 }) });

  it("leaves a habit walked recently in Kept", () => {
    expect(bandOf(kept, quiet(1))).toBe("mine");
  });

  it("moves a habit that has gone quiet past both guards", () => {
    expect(bandOf(kept, quiet(6))).toBe("fading");
  });

  /**
   * A moved binding is the one thing on this screen that can be silently
   * WRONG. A habit that is both unresolved and quiet reads better as
   * unresolved: fixing the binding may well reveal it was walked last week.
   */
  it("puts a habit that is both re-bound and quiet into Needs attention", () => {
    const both = habit({
      binding: binding({ state: "rebound", walks: weekly, recordings: 3 }),
    });
    expect(bandOf(both, quiet(6))).toBe("attention");
  });

  /** Archiving is a deliberate setting-aside. Calling it fading relitigates it. */
  it("never fades an archived habit", () => {
    const shelved = habit({ state: "archived", binding: binding({ walks: weekly }) });
    expect(bandOf(shelved, quiet(52))).toBe("archived");
  });

  it("gives bandHabits a fading bucket, and drops dismissals from all of them", () => {
    const b = bandHabits(
      [kept, habit({ id: "d", state: "dismissed", binding: binding({ walks: weekly }) })],
      quiet(6),
    );
    expect(b.fading.map((h) => h.id)).toEqual(["k1"]);
    expect(b.mine).toEqual([]);
    expect(b.attention).toEqual([]);
    expect(b.archived).toEqual([]);
  });

  it("leaves a habit with too few walks to have a cadence in Kept forever", () => {
    const twice = habit({
      binding: binding({
        walks: [weekly[0]!, weekly[1]!],
        recordings: 2,
      }),
    });
    expect(bandOf(twice, quiet(52))).toBe("mine");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/habits-view.test.ts`
Expected: FAIL. TypeScript will object that `bandOf` takes one argument, and the new `describe` will fail on `"fading"` not being a `HabitBand`.

- [ ] **Step 3: Widen the band type and the two functions**

In `app/src/renderer/src/habits-view.ts`, add to the import block (after the existing `import type { … } from "@shared/types";`):

```ts
import { hasFaded } from "./habit-rhythm.js";
```

Replace the `HabitBand` type and its doc comment with:

```ts
/**
 * Which band a habit is drawn in.
 *
 * "Needs attention" leads, because a habit whose evidence moved is the only
 * thing on this screen that can be silently wrong, and a band that sorts below
 * the ones that are fine would hide exactly that.
 *
 * "Not walked lately" sits BELOW Kept and is checked after attention: a habit
 * that is both unresolved and quiet reads better as unresolved, because fixing
 * the binding may reveal it was walked last week.
 */
export type HabitBand = "attention" | "mine" | "fading" | "archived";
```

Replace `bandOf` with:

```ts
export function bandOf(habit: HabitDTO, now: number): HabitBand {
  if (habit.state === "archived") return "archived";
  // A duplicate needs attention for the same reason a re-bind does: something
  // about this habit is unresolved and only a person can resolve it. It is not
  // a binding STATE — the binding is exact and correct on both halves — so it
  // is checked separately rather than folded into `HabitBindState`.
  if (habit.duplicates.length > 0) return "attention";
  if (NEEDS_ATTENTION.includes(habit.binding.state)) return "attention";
  // `now` is INJECTED rather than read here, so a root test can place a habit
  // six weeks in the past without touching the wall clock.
  return hasFaded(habit.binding.walks, now) ? "fading" : "mine";
}
```

Replace the `HabitBands` interface and `bandHabits` with:

```ts
export interface HabitBands {
  attention: HabitDTO[];
  mine: HabitDTO[];
  fading: HabitDTO[];
  archived: HabitDTO[];
}

/** Active, quiet and archived split, dismissals dropped — they are not habits. */
export function bandHabits(habits: readonly HabitDTO[], now: number): HabitBands {
  const out: HabitBands = { attention: [], mine: [], fading: [], archived: [] };
  for (const s of orderHabits(habits)) {
    if (s.state === "dismissed") continue;
    out[bandOf(s, now)].push(s);
  }
  return out;
}
```

- [ ] **Step 4: Wire the screen**

In `app/src/renderer/src/screens/HabitsScreen.tsx`:

Add `fadeLine` to the import from `../habit-rhythm.js` — a new import statement, placed directly after the existing `import { clampTip } from "./hover-card.js";`:

```ts
import { fadeLine } from "../habit-rhythm.js";
```

Change line 127 from `const bands = bandHabits(data.habits);` to:

```ts
  // Read once per render. The threshold is four weeks, so a stale read cannot
  // move a row; a `useMemo` keyed on nothing would be the thing that could.
  const now = Date.now();
  const bands = bandHabits(data.habits, now);
```

Insert a new band directly after the closing `)}` of the `bands.mine` block and before the `{/* Split on whether anything RECURRED … */}` comment:

```tsx
          {/* Below Kept, because these ARE kept — what changed is that they
              stopped. The head states the fact and declines the verdict:
              a standard that moves is not a streak that broke. */}
          {bands.fading.length > 0 && (
            <Band title="Not walked lately">
              {bands.fading.map((s) => (
                <HabitRow
                  key={s.id}
                  habit={s}
                  domain={data.domain}
                  active={habit?.id === s.id}
                  onSelect={() => setSelected({ kind: "habit", id: s.id })}
                />
              ))}
            </Band>
          )}
```

In `HabitRow`, directly after the existing `const dropped = droppedEarlyLine(habit);`:

```ts
  // Null unless this row is in the "Not walked lately" band, so the band head
  // and the line can never disagree — both ask `hasFaded`.
  const faded = fadeLine(habit.binding.walks, Date.now());
```

and in the `habit__meta` span, directly after the `{dropped !== null && …}` line:

```tsx
          {faded !== null && <span className="mono">{faded}</span>}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run test/habits-view.test.ts`
Expected: PASS — the six new tests plus every existing one.

- [ ] **Step 6: Run the whole gate**

```
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

Expected: all green. The app typecheck is what proves the `bandHabits` arity change reached every caller.

- [ ] **Step 7: Commit**

```bash
git add app/src/renderer/src/habits-view.ts app/src/renderer/src/screens/HabitsScreen.tsx \
        test/habits-view.test.ts
git commit -m "feat(habits): a fourth band for the work that stopped

post.md's third lesson -- that habits are what you change -- has had no
surface at all. This is it: kept habits that had a cadence and went
quiet, banded below Kept.

Checked AFTER attention, deliberately. A habit that is both re-bound and
quiet reads better as unresolved, because fixing the binding may reveal
it was walked last week. Archived never fades: archiving is a deliberate
setting-aside and calling it fading relitigates a decision already made.

The row states the fact -- 'about every 7 days, last walked 6 weeks ago'
-- and the head declines the verdict. 'Not walked lately', not 'Fading':
a standard that moves is not a streak that broke.

bandOf and bandHabits now take `now`, so a root test can place a habit
six weeks in the past without touching the wall clock.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The portrait band on screen

**Files:**
- Modify: `app/src/renderer/src/screens/HabitsScreen.tsx` (a `Portrait` component, and one line in the page body after `</Head>`)
- Modify: `app/src/renderer/src/styles.css` (append after the `.habits__bar` rule at line 4061)

**Interfaces:**
- Consumes: `portraitOf`, `placeLabel`, `PortraitPlace` from `../habit-portrait.js` (Task 1); `HabitsDTO` from `@shared/types`.
- Produces: nothing other tasks consume. New CSS classes, all newly minted and checked for collisions: `.portrait`, `.portrait__places`, `.portrait__place`, `.portrait__app`, `.portrait__bar`, `.portrait__fill`, `.portrait__coverage`.

- [ ] **Step 1: Confirm the class names are unclaimed**

`styles.css` is one global sheet with no scoping, so a class name is a repo-wide identifier. Run:

```bash
grep -n "portrait" app/src/renderer/src/styles.css app/src/renderer/src/**/*.tsx
```

Expected: no output. If anything matches, prefix the new names differently rather than reusing.

- [ ] **Step 2: Add the component**

In `app/src/renderer/src/screens/HabitsScreen.tsx`, add to the imports:

```ts
import { placeLabel, portraitOf } from "../habit-portrait.js";
```

Add this component directly above `function Band(` (around line 616):

```tsx
/**
 * The answer to the question the `<h1>` has always asked.
 *
 * "What you do repeatedly" has headed a file list since Habits shipped. This
 * says where that repeated work actually happens, and how much of what you
 * record recurs at all — `post.md`'s second lesson, made glanceable.
 *
 * A BAR CARRIES NO PRINTED NUMBER. The bar length is the reading and
 * `placeLabel` is the fact, exactly as a ledger mark is a position and
 * `markLabel` is the sentence — so a pointer and a screen reader are told the
 * same thing. A count in the gutter would be the `×N` glyph again, which was
 * deleted for being the one of three statements that could only be read as a
 * number.
 *
 * ONE HUE at varying lightness, never the indexed palette: C1 owns `--data-2`
 * and `--data-3` for conformance, and a violet app bar a few hundred pixels
 * above a violet "went another way" mark would assert a relationship that does
 * not exist.
 */
function Portrait({ data }: { data: HabitsDTO }): React.JSX.Element | null {
  const portrait = portraitOf(data);
  // Nothing recurs. The band draws nothing rather than an empty frame — this
  // is not an insufficiency state, because there is no reading being withheld.
  if (portrait.empty) return null;
  return (
    <section className="portrait" aria-label="Where your repeated work happens">
      <ul className="portrait__places">
        {portrait.places.map((place) => {
          const label = placeLabel(place);
          return (
            <li key={place.app} className="portrait__place" title={label} aria-label={label}>
              <span className="portrait__app">{place.app}</span>
              <span className="portrait__bar">
                <span
                  className="portrait__fill"
                  style={{
                    // A floor of 2%, so the lightest place is still a mark
                    // rather than nothing. It never reaches zero because a
                    // place with no recordings is not in `places` at all.
                    width: `${Math.max(place.share * 100, 2)}%`,
                    background: `color-mix(in oklab, var(--data-0) ${25 + Math.round(65 * place.share)}%, transparent)`,
                  }}
                />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="portrait__coverage mono">{portrait.coverage}</p>
    </section>
  );
}
```

- [ ] **Step 3: Place it in the page**

In the returned JSX of `HabitsScreen`, directly after the `</Head>` closing tag and before `<div className="habits__stage">`:

```tsx
      <Portrait data={data} />
```

A sibling of `.habits__head`, not a child: `.habits__headtext` is `min-width: 0` inside a flex row with `.habits__bar`, so a full-width band nested there would be squeezed by the prose beside it.

- [ ] **Step 4: Add the styles**

In `app/src/renderer/src/styles.css`, directly after the `.habits__bar { … }` line (4061):

```css
/* The band under the h1. NOTHING TRUNCATES: an app name either fits its column
   or wraps, and the column is sized from the longest name rather than clipped.
   ONE HUE — `--data-0` at varying lightness — because C1 owns `--data-2` and
   `--data-3` for conformance and a colour's meaning is a repo-wide claim. */
.portrait { margin-top: var(--s3); display: flex; flex-direction: column; gap: var(--s2); }
.portrait__places {
  list-style: none; margin: 0; padding: 0;
  display: grid; grid-template-columns: max-content 1fr; gap: var(--s1) var(--s2);
  align-items: center; max-width: 520px;
}
.portrait__place { display: contents; }
.portrait__app { font-size: var(--t-meta); color: var(--text); overflow-wrap: anywhere; }
.portrait__bar {
  display: block; height: 6px; border-radius: var(--radius-sm);
  background: var(--sunken);
}
.portrait__fill { display: block; height: 100%; border-radius: var(--radius-sm); }
.portrait__coverage { font-size: var(--t-meta); color: var(--muted); margin: 0; }
```

- [ ] **Step 5: Build and drive the app**

```
npm run build && npm --prefix app run build
```

Then, from the repo root, with any dev instance quit:

```bash
node -e '
import("./.claude/skills/run-app/scripts/launch.mjs").then(async ({ launchApp, gotoScreen }) => {
  const { app, page } = await launchApp();
  await gotoScreen(page, "Habits");
  await page.waitForSelector(".habits__stage", { timeout: 20000 });
  const out = await page.evaluate(() => {
    const bars = [...document.querySelectorAll(".portrait__place")];
    return {
      places: bars.map((li) => ({
        label: li.getAttribute("aria-label"),
        app: li.querySelector(".portrait__app")?.textContent,
        fillPct: (li.querySelector(".portrait__fill")).getBoundingClientRect().width /
                 (li.querySelector(".portrait__bar")).getBoundingClientRect().width,
      })),
      coverage: document.querySelector(".portrait__coverage")?.textContent,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      truncated: [...document.querySelectorAll(".portrait__app")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1).length,
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await page.screenshot({ path: "/tmp/portrait.png" });
  await app.close();
});'
```

Expected: `places` non-empty with a label per bar reading `"<App> · N recordings of repeated work"`, `coverage` a `·`-joined line starting with a recording count, `overflowX` false, `truncated` 0. **Read `/tmp/portrait.png`** — an unread screenshot proves nothing, and a blank frame means the launch failed.

- [ ] **Step 6: Run the whole gate**

```
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add app/src/renderer/src/screens/HabitsScreen.tsx app/src/renderer/src/styles.css
git commit -m "feat(habits): draw the portrait, because the h1 asked

'What you do repeatedly' has headed a file list since Habits shipped.
Now it is answered above the list: which applications the repeated work
lives in, weighted by recordings, and one line saying how much of what
you record recurs at all.

No number is printed on a bar. The length is the reading and placeLabel
is the fact -- a pointer and a screen reader get the same sentence,
which is the split the ledger already makes. A count in the gutter would
be the xN glyph again.

One hue, --data-0 at varying lightness. C1 owns --data-2 and --data-3
for conformance, and styles.css has no scoping, so a violet app bar
above a violet 'went another way' mark would assert a relationship that
does not exist.

A sibling of .habits__head, not a child: .habits__headtext is
min-width:0 in a flex row with the bar, and nesting would squeeze it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The rhythm strip on screen

**Files:**
- Modify: `app/src/renderer/src/screens/HabitsScreen.tsx` (a `Rhythm` component, and one line in `HabitEditor`'s `.habitedit__evidence` block around line 827)
- Modify: `app/src/renderer/src/styles.css` (append after the `.ledger-legend__note { … }` rule at line 4218)

**Interfaces:**
- Consumes: `DAYS`, `rhythmOf`, `rhythmLabel`, `rhythmNote` from `../habit-rhythm.js` (Task 2); `WalkMarkDTO` from `@shared/types`.
- Produces: nothing other tasks consume. New CSS classes: `.rhythm`, `.rhythm__grid`, `.rhythm__day`, `.rhythm__cell`, `.rhythm__note`.

- [ ] **Step 1: Confirm the class names are unclaimed**

```bash
grep -n "rhythm" app/src/renderer/src/styles.css app/src/renderer/src/**/*.tsx
```

Expected: no output.

- [ ] **Step 2: Add the component**

In `app/src/renderer/src/screens/HabitsScreen.tsx`, extend the `habit-rhythm.js` import added in Task 4 to:

```ts
import { DAYS, fadeLine, rhythmLabel, rhythmNote, rhythmOf } from "../habit-rhythm.js";
```

Add this component directly above `function LedgerLegend(` (around line 506):

```tsx
/**
 * Where in the WEEK, beside the ledger's where in your life.
 *
 * The ledger draws an absolute wall clock shared by every row, which is what
 * makes a habit practised last week read differently from one practised in
 * March. It cannot say that a habit happens every Tuesday at 9am — and context
 * stability is the measured driver of automaticity, so a habit in phase and one
 * at random currently draw identically.
 *
 * BELOW THE FLOOR IT DRAWS NOTHING AND SAYS WHY. Three walks in 168 cells is
 * decoration, and the author's real kept habit is exactly that case. A strip
 * that merely never appeared would be indistinguishable from one nobody
 * implemented — the `StageSpec.skipReason` rule, one screen over.
 *
 * One hue, `--data-0`, for the reason `Portrait` uses one.
 */
function Rhythm({ walks }: { walks: readonly WalkMarkDTO[] }): React.JSX.Element | null {
  // Nothing to place at all. Rendered as nothing, exactly as `Ledger` returns
  // null at zero marks — the editor is already saying there are no recordings.
  if (walks.length === 0) return null;
  const rhythm = rhythmOf(walks);
  return (
    <div className="rhythm">
      <span className="eyebrow">In phase</span>
      {rhythm.kind === "too-few" ? (
        <p className="rhythm__note">{rhythm.reason}</p>
      ) : (
        <>
          <div className="rhythm__grid" role="img" aria-label={rhythmLabel(rhythm.grid)}>
            {rhythm.grid.cells.map((row, day) => (
              <React.Fragment key={DAYS[day]}>
                <span className="rhythm__day mono">{DAYS[day]}</span>
                {row.map((count, hour) => (
                  <span
                    key={hour}
                    className="rhythm__cell"
                    style={
                      count === 0
                        ? undefined
                        : {
                            background: `color-mix(in oklab, var(--data-0) ${25 + Math.round(65 * (count / rhythm.grid.peak))}%, transparent)`,
                          }
                    }
                  />
                ))}
              </React.Fragment>
            ))}
          </div>
          <p className="rhythm__note">{rhythmNote(rhythm.grid)}</p>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Place it beside the ledger**

In `HabitEditor`'s `.habitedit__evidence` block, directly after the `{b.walks.some((w) => w.fit !== null) && <LedgerLegend />}` line:

```tsx
          <Rhythm walks={b.walks} />
```

After the legend, not before: the legend explains the ledger immediately above it, and separating the two with a second instrument would leave each key further from the thing it keys.

- [ ] **Step 4: Add the styles**

In `app/src/renderer/src/styles.css`, directly after the `.ledger-legend__note { … }` rule:

```css
/* Where in the WEEK. 7 rows of 24, Monday first, beside the lead ledger's
   absolute wall clock. Cells are set into `--sunken` so an empty week reads as
   an instrument with nothing in it rather than as a missing element. */
.rhythm { display: flex; flex-direction: column; gap: var(--s1); margin-top: var(--s2); }
.rhythm__grid {
  display: grid; grid-template-columns: max-content repeat(24, 1fr);
  gap: 2px; align-items: center; max-width: 400px;
}
.rhythm__day {
  font-size: var(--t-nano); color: var(--muted); padding-right: var(--s1);
  text-align: right;
}
.rhythm__cell {
  aspect-ratio: 1; border-radius: 2px; background: var(--sunken);
}
.rhythm__note { margin: 0; font-size: var(--t-meta); color: var(--muted); }
```

- [ ] **Step 5: Build and drive the app**

```
npm run build && npm --prefix app run build
```

```bash
node -e '
import("./.claude/skills/run-app/scripts/launch.mjs").then(async ({ launchApp, gotoScreen }) => {
  const { app, page } = await launchApp();
  await gotoScreen(page, "Habits");
  await page.waitForSelector(".habits__items .habit", { timeout: 20000 });
  await page.locator(".habits__items .habit").first().click();
  await page.waitForSelector(".habitedit__evidence", { timeout: 20000 });
  const out = await page.evaluate(() => {
    const strip = document.querySelector(".rhythm");
    const grid = document.querySelector(".rhythm__grid");
    return {
      present: strip !== null,
      note: document.querySelector(".rhythm__note")?.textContent,
      gridDrawn: grid !== null,
      cells: document.querySelectorAll(".rhythm__cell").length,
      stripRect: strip ? strip.getBoundingClientRect().width : null,
      evidenceRect: document.querySelector(".habitedit__evidence")?.getBoundingClientRect().width,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await page.screenshot({ path: "/tmp/rhythm.png" });
  await app.close();
});'
```

Expected on the author's store as it stands: `present` true, `gridDrawn` **false**, `cells` 0, and `note` reading `"3 walks, on 2 days — too few to place in the week."` — that refusal is the spec's prediction and seeing it is the test. `overflowX` false. **Read `/tmp/rhythm.png`.**

If `gridDrawn` is true, the library has grown past the floor since the spec was measured; check `cells` is 168 and that `stripRect` does not exceed `evidenceRect`.

- [ ] **Step 6: Run the whole gate**

```
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add app/src/renderer/src/screens/HabitsScreen.tsx app/src/renderer/src/styles.css
git commit -m "feat(habits): draw where in the week, or say why not

The ledger draws an absolute wall clock, which is what makes a habit
practised last week read differently from one practised in March. It
cannot say a habit happens every Tuesday at 9am, and context stability
is the measured driver of automaticity -- so in phase and at random draw
identically today.

Seven rows of 24, Monday first, beside the ledger. Below the floor it
draws NOTHING and states what it has, which on the author's real store
is the only thing it can currently say: three walks, on two days. A
strip that merely never appeared would be indistinguishable from one
nobody implemented.

After the legend rather than before, so each key stays next to the thing
it keys.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The committed probe, and what goes in the ledger of unswept things

**Files:**
- Create: `.claude/skills/run-app/scripts/habits-screen-probe.mjs`
- Modify: `.claude/skills/run-app/SKILL.md` (the "Related" list at the end)
- Modify: `docs/todo.md` (append one C2 entry)

**Interfaces:**
- Consumes: `launchApp`, `gotoScreen` from `./launch.mjs`; the DOM contracts from Tasks 4, 5 and 6 — `.portrait__place`, `.portrait__app`, `.portrait__fill`, `.portrait__bar`, `.portrait__coverage`, `.rhythm`, `.rhythm__grid`, `.rhythm__cell`, `.rhythm__note`, `.habits__bandhead .eyebrow`.
- Produces: nothing consumed by other tasks. This is the last task.

**Why this exists:** C1's screen verification was done with throwaway scratchpad scripts and left nothing behind. The three assertions below cannot be reached by `npm test` — there is no renderer and no Electron in the suite — and one of them (that no fading band renders) is a *prediction the spec makes*, which is only a test if something checks it.

- [ ] **Step 1: Write the probe**

Create `.claude/skills/run-app/scripts/habits-screen-probe.mjs`:

```js
/**
 * habits-screen-probe.mjs — C2's three readings, against the REAL store.
 *
 * READ-ONLY. It navigates, clicks the first habit row, and reads the DOM. It
 * never writes a habit, never re-indexes and never records, so it is safe
 * against the author's own library — which is the point: a fixture agrees with
 * whatever the code assumes, and every rule in this file's subject was derived
 * from what a six-day, one-habit store actually contains.
 *
 * It asserts three things `npm test` structurally cannot reach:
 *
 *   1. the portrait band draws, nothing truncates, and no bar prints a number;
 *   2. the rhythm strip either draws 168 cells or STATES why it cannot;
 *   3. whatever the "Not walked lately" band does, it agrees with the rows.
 *
 * (3) is the interesting one. The spec PREDICTS the band is silent on this
 * store — quiet 72h against a 4-week floor — and a prediction nothing checks is
 * not a test. It is written as an agreement check rather than as "expect zero"
 * so that it keeps working, rather than starting to fail, once the library is
 * old enough for the band to speak.
 */

import { launchApp, gotoScreen } from "./launch.mjs";

const problems = [];
const check = (ok, message) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${message}`);
  if (!ok) problems.push(message);
};

const { app, page } = await launchApp();
try {
  await gotoScreen(page, "Habits");
  await page.waitForSelector(".habits__stage, .empty", { timeout: 20_000 });

  const empty = await page.locator(".habits__stage").count();
  if (empty === 0) {
    console.log("The store holds no habits and no proposals — nothing to read.");
    console.log("Record and index a session, then run this again.");
    process.exit(0);
  }

  // ---- the corpus FIRST, before any assertion, so a number below is read
  // against the library that produced it. probe:routes' rule.
  const corpus = await page.evaluate(() => ({
    bands: [...document.querySelectorAll(".habits__bandhead .eyebrow")].map((e) => e.textContent),
    rows: document.querySelectorAll(".habits__items .habit").length,
  }));
  console.log(`\nCorpus: ${corpus.rows} rows across bands [${corpus.bands.join(", ")}]\n`);

  // ---- 1. the portrait
  const portrait = await page.evaluate(() => {
    const places = [...document.querySelectorAll(".portrait__place")];
    return {
      present: document.querySelector(".portrait") !== null,
      places: places.map((li) => ({
        label: li.getAttribute("aria-label"),
        app: li.querySelector(".portrait__app")?.textContent ?? "",
        // A bar must never PRINT its count — the ×N rule.
        printed: (li.textContent ?? "").replace(li.querySelector(".portrait__app")?.textContent ?? "", "").trim(),
        share:
          li.querySelector(".portrait__fill").getBoundingClientRect().width /
          li.querySelector(".portrait__bar").getBoundingClientRect().width,
      })),
      coverage: document.querySelector(".portrait__coverage")?.textContent ?? "",
      truncated: [...document.querySelectorAll(".portrait__app")].filter(
        (el) => el.scrollWidth > el.clientWidth + 1,
      ).length,
    };
  });

  console.log("Portrait:");
  for (const p of portrait.places) {
    console.log(`  ${p.app.padEnd(18)} ${"█".repeat(Math.max(1, Math.round(p.share * 24)))}`);
  }
  console.log(`  ${portrait.coverage}\n`);

  check(portrait.present, "the portrait band is on the screen");
  check(portrait.places.length > 0, "it names at least one place");
  check(portrait.truncated === 0, `no place name is truncated — ${portrait.truncated} were`);
  check(
    portrait.places.every((p) => p.printed === ""),
    "no bar prints a number on its face",
  );
  check(
    portrait.places.every((p) => /· \d+ recordings? of repeated work$/.test(p.label ?? "")),
    "every bar says its count in words, for a screen reader",
  );
  check(
    /^\d+ recordings? walked a route · /.test(portrait.coverage),
    "the coverage line says what its number is a count OF",
  );
  check(
    !/%|score|streak/i.test(portrait.coverage),
    "the coverage line prints no score",
  );
  // Descending, which is what makes the picture readable at a glance.
  const shares = portrait.places.map((p) => p.share);
  check(
    shares.every((s, i) => i === 0 || s <= shares[i - 1] + 0.001),
    "the bars descend",
  );

  // ---- 2. the rhythm strip
  await page.locator(".habits__items .habit").first().click();
  await page.waitForSelector(".habitedit__evidence", { timeout: 20_000 });

  const rhythm = await page.evaluate(() => ({
    present: document.querySelector(".rhythm") !== null,
    gridDrawn: document.querySelector(".rhythm__grid") !== null,
    cells: document.querySelectorAll(".rhythm__cell").length,
    filled: [...document.querySelectorAll(".rhythm__cell")].filter(
      (c) => getComputedStyle(c).backgroundColor !== getComputedStyle(document.body).getPropertyValue("--sunken"),
    ).length,
    note: document.querySelector(".rhythm__note")?.textContent ?? "",
    label: document.querySelector(".rhythm__grid")?.getAttribute("aria-label") ?? null,
    fitsEvidence:
      (document.querySelector(".rhythm")?.getBoundingClientRect().right ?? 0) <=
      (document.querySelector(".habitedit__evidence")?.getBoundingClientRect().right ?? 0) + 1,
  }));

  console.log(`\nRhythm: ${rhythm.gridDrawn ? "grid drawn" : "below the floor"}`);
  console.log(`  ${rhythm.note}\n`);

  check(rhythm.present, "the rhythm strip is on the screen");
  check(rhythm.note !== "", "it says something in words, whichever state it is in");
  check(rhythm.fitsEvidence, "it does not overflow the evidence column");
  if (rhythm.gridDrawn) {
    check(rhythm.cells === 168, `the grid is 7x24 — found ${rhythm.cells} cells`);
    check(rhythm.label !== null, "the picture has an accessible name");
  } else {
    check(rhythm.cells === 0, "below the floor it draws no cells at all");
    check(
      /too few to place in the week\.$/.test(rhythm.note),
      "below the floor it states its reason, with the numbers it has",
    );
  }

  // ---- 3. the band and the rows agree
  const quiet = await page.evaluate(() => {
    const heads = [...document.querySelectorAll(".habits__band")];
    const band = heads.find(
      (b) => b.querySelector(".habits__bandhead .eyebrow")?.textContent === "Not walked lately",
    );
    return {
      bandPresent: band !== undefined,
      bandRows: band ? band.querySelectorAll(".habit").length : 0,
      // The fade line renders in HabitRow, so it must appear on exactly the
      // rows that are in the band and on no others.
      rowsWithLine: [...document.querySelectorAll(".habits__items .habit")].filter((r) =>
        /last walked .* ago/.test(r.textContent ?? ""),
      ).length,
    };
  });

  console.log(
    `\nNot walked lately: ${quiet.bandPresent ? `${quiet.bandRows} rows` : "band absent"}\n`,
  );
  check(
    quiet.rowsWithLine === quiet.bandRows,
    `the fade line appears on exactly the banded rows — ${quiet.rowsWithLine} lines, ${quiet.bandRows} rows`,
  );
  if (!quiet.bandPresent) {
    console.log(
      "  (The spec predicts this on a library younger than the four-week floor.\n" +
        "   Its absence here is the prediction holding, not a missing feature.)",
    );
  }

  await page.screenshot({ path: "/tmp/habits-screen-probe.png" });
  console.log("\nScreenshot: /tmp/habits-screen-probe.png — READ IT.");
} finally {
  await app.close();
}

if (problems.length > 0) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
```

- [ ] **Step 2: Build and run it**

```
npm run build && npm --prefix app run build
node .claude/skills/run-app/scripts/habits-screen-probe.mjs
```

Expected: exit 0, every check `ok`. On the store as measured for the spec, the rhythm section reports "below the floor" and the fade section reports "band absent" with its explanatory note. **Read `/tmp/habits-screen-probe.png`.**

If a check fails, fix the code rather than the probe — these are the assertions `npm test` cannot make, which is what makes them worth having.

- [ ] **Step 3: Register the probe in the skill**

In `.claude/skills/run-app/SKILL.md`, append to the `## Related` bullet list, after the `queue-handoff-probe.mjs` entry:

```markdown
- `scripts/habits-screen-probe.mjs` reads C2's three habit readings off the
  REAL store: the portrait band, the rhythm strip, and the "Not walked lately"
  band. Read-only — it navigates and clicks one row, and writes nothing. Two of
  its three subjects are expected to be SILENT on a young library, and it
  checks the silence rather than skipping it: the rhythm strip must state its
  reason, and the fade line must appear on exactly the banded rows and no
  others. It prints the corpus FIRST, so every number below is read against the
  library that produced it.
```

- [ ] **Step 4: Record the unswept things**

Append to `docs/todo.md`:

```markdown
- HABIT INSIGHT, SUB-PROJECT C2 — SHIPPED 2026-08-23 (`design/habit-portrait-rhythm`). The h1 is answered: a portrait band names the applications recurring routes pass through, weighted by recordings, with one line saying how much of what is recorded recurs at all. A 7×24 phase grid sits beside the lead ledger, and a fourth band, "Not walked lately", holds kept habits that had a cadence and stopped. TWO UNSWEPT FLOORS ship with it and both need a bigger library to falsify. The RHYTHM floor is `>= 4` walks across `>= 3` distinct calendar days (`RHYTHM_MIN_WALKS` / `RHYTHM_MIN_DAYS` in `habit-rhythm.ts`); the day half is not taste — this store holds FOUR RECORDINGS INSIDE FOUR MINUTES (2026-08-20 11:00–11:04), which passes any walk-count floor and is one sitting. The FADE floor is `quiet > max(3 × median gap, 4 weeks)` (`FADE_MULTIPLE` / `FADE_FLOOR_MS`); the absolute four weeks is the whole rule — without it the real kept habit, median gap ~36h and quiet 72h, is called fading within two days, which is post.md's measured backfire on day one. TWO FIRING PATHS SHIP FIXTURE-TESTED AND UNEXERCISED, joining B's `droppedEarly` and idle line and C1's two: the grid has never drawn on real data (3 walks, 2 days) and the fade band has never spoken (the library is six days old). `node .claude/skills/run-app/scripts/habits-screen-probe.mjs` checks both SILENCES against the real store and will start checking the drawn forms the moment the library outgrows them. Nothing here reaches HABIT.md. NOT DONE, still C3 (the Way A/B fork diff) and D (the agent surface).
```

- [ ] **Step 5: Prove the record did not move**

```
npm run probe:habits
```

Expected: fully green, including `get_habit === clipboard, byte for byte`. This is the guard that none of C2 reached `HABIT.md`. It writes one thing and discloses it (it keeps the top proposal); that is its normal behaviour, not a side effect of this change.

- [ ] **Step 6: Run the whole gate one last time**

```
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/run-app/scripts/habits-screen-probe.mjs \
        .claude/skills/run-app/SKILL.md docs/todo.md
git commit -m "test(habits): check the silences, and write down what is unswept

C1 verified its screen with throwaway scratchpad scripts and left nothing
behind. This one is committed, because two of C2's three readings are
expected to say nothing on a six-day library and a prediction nothing
checks is not a test.

So the probe checks the silence rather than skipping it: the rhythm strip
must STATE its reason with the numbers it has, and the fade line must
appear on exactly the banded rows and no others -- written as an
agreement check, so it keeps working rather than starting to fail once
the library is old enough for the band to speak. It prints the corpus
first, probe:routes' rule.

docs/todo.md gains both unswept floors with the corpus that would
falsify them, and both firing paths that ship fixture-tested and
unexercised.

Read-only: it navigates, clicks one row, and writes nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After the plan

- [ ] Run the full gate one final time on the finished branch, as three unpiped commands.
- [ ] Run `node .claude/skills/run-app/scripts/habits-screen-probe.mjs` once more against a freshly built app and read its screenshot.
- [ ] Use **superpowers:finishing-a-development-branch** to close the branch out.
