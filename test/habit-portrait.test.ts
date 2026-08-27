import { describe, expect, it } from "vitest";
import {
  portraitOf,
  portraitWeek,
  weekCellLabel,
  weekNote,
} from "../app/src/renderer/src/habit-portrait.js";
import type { HabitBindingDTO, HabitDTO, HabitProposalDTO, WalkMarkDTO } from "@shared/types";

/**
 * What the band under `<h1>What you do repeatedly</h1>` says.
 *
 * A `.ts` module so the root suite can reach it — the root tsconfig sets no
 * `jsx`, so a test touching a `.tsx` even for a type breaks `npm run typecheck`.
 */

const walk = (sessionId: string, at = 0): WalkMarkDTO => ({
  sessionId,
  at,
  gained: false,
  fit: null,
  walk: { atSec: 0, throughSec: 1, steps: 2 },
});

/**
 * A LOCAL wall-clock moment, because the grid is local by design — a UTC key
 * would merge two evenings west of Greenwich, which is the rule `localDayKey`
 * states. Built through the `Date` constructor so this fixture and the module
 * under test agree about the machine's zone rather than about a fixed offset.
 */
const local = (day: number, hour: number): number =>
  new Date(2026, 2, 2 + day, hour, 30, 0).getTime(); // 2026-03-02 is a Monday

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
  fork: null,
  droppedEarly: [],
  slots: [],
  timings: null,
  runs: [],
  cautions: [],
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

describe("portraitWeek", () => {
  /** Ten walks over seven days: the author's real store's shape. */
  const library = () => ({
    habits: [
      habit({
        binding: binding({
          recordings: 6,
          walks: [0, 1, 2, 3, 4, 5].map((d) => walk(`h${d}`, local(d, 15))),
        }),
      }),
    ],
    proposals: [
      proposal({ count: 1, walks: [walk("p1", local(6, 9))], sessionIds: ["p1"] }),
      proposal({ count: 1, walks: [walk("p2", local(6, 9))], sessionIds: ["p2"], label: "E → F" }),
    ],
  });

  it("places every walk in the week, one-offs INCLUDED", () => {
    const w = portraitWeek(library());
    if (w.kind !== "grid") throw new Error(w.reason);
    // Six habit walks plus two proposals: the bars this replaces weighed only
    // what recurs, and so could never show that something does not.
    expect(w.grid.walks).toBe(8);
    expect(w.grid.recurring).toBe(6);
    expect(w.grid.days).toBe(7);
  });

  it("fills a cell holding a recurring route and leaves a one-off HOLLOW", () => {
    const w = portraitWeek(library());
    if (w.kind !== "grid") throw new Error(w.reason);
    expect(w.grid.cells[0]![15]).toMatchObject({ count: 1, recurring: true });
    // Sunday 09:00 holds two proposals, each walked once.
    expect(w.grid.cells[6]![9]).toMatchObject({ count: 2, recurring: false });
  });

  it("fills a MIXED hour, because something that repeats happened then", () => {
    const data = library();
    data.proposals.push(
      proposal({ count: 1, walks: [walk("p3", local(0, 15))], sessionIds: ["p3"], label: "G → H" }),
    );
    const w = portraitWeek(data);
    if (w.kind !== "grid") throw new Error(w.reason);
    expect(w.grid.cells[0]![15]).toMatchObject({ count: 2, recurring: true });
  });

  it("names the ROUTE on every walk, which a per-habit cell never has to", () => {
    const w = portraitWeek(library());
    if (w.kind !== "grid") throw new Error(w.reason);
    expect(w.grid.cells[0]![15]!.walks[0]!.routeTitle).toBe("A habit");
    // A proposal falls back to its label when it has no composed name.
    expect(w.grid.cells[6]![9]!.walks.map((x) => x.routeTitle)).toEqual(["C → D", "E → F"]);
  });

  it("counts a KEPT habit as recurring even at one recording", () => {
    // Keeping it is the recurrence claim; a deleted recording must not
    // silently retract it. The same rule the coverage line holds.
    const w = portraitWeek({
      habits: [habit({ binding: binding({ recordings: 1, walks: [walk("s1", local(0, 9))] }) })],
      proposals: [0, 1, 2].map((d) =>
        proposal({ count: 1, walks: [walk(`p${d}`, local(d + 1, 9))], sessionIds: [`p${d}`] }),
      ),
    });
    if (w.kind !== "grid") throw new Error(w.reason);
    expect(w.grid.cells[0]![9]).toMatchObject({ recurring: true });
    expect(w.grid.recurring).toBe(1);
  });

  it("sorts a cell's walks OLDEST FIRST rather than trusting the caller", () => {
    const w = portraitWeek({
      habits: [
        habit({
          binding: binding({
            recordings: 4,
            // Handed newest first on purpose.
            walks: [3, 2, 1, 0].map((d) => walk(`h${d}`, local(d, 15))),
          }),
        }),
      ],
      proposals: [],
    });
    if (w.kind !== "grid") throw new Error(w.reason);
    const monday = w.grid.cells[0]![15]!;
    expect(monday.walks.map((x) => x.walk.sessionId)).toEqual(["h0"]);
  });

  it("withholds the grid under the FLOOR, and says what it has", () => {
    const w = portraitWeek({
      habits: [habit({ binding: binding({ recordings: 2, walks: [walk("s1", local(0, 9))] }) })],
      proposals: [],
    });
    expect(w.kind).toBe("too-few");
    if (w.kind !== "too-few") return;
    expect(w.reason).toBe("1 recording, on 1 day — too few to place in the week.");
  });

  it("refuses four walks inside ONE DAY — the four-in-four-minutes cluster", () => {
    const w = portraitWeek({
      habits: [
        habit({
          binding: binding({
            recordings: 4,
            walks: [0, 1, 2, 3].map((h) => walk(`s${h}`, local(0, 9 + h))),
          }),
        }),
      ],
      proposals: [],
    });
    expect(w.kind).toBe("too-few");
  });

  it("states the FILL RULE in words, at every mix", () => {
    const w = portraitWeek(library());
    if (w.kind !== "grid") throw new Error(w.reason);
    expect(weekNote(w.grid)).toBe(
      "8 recordings across 7 days · 6 on a route walked more than once, 2 seen once.",
    );
  });

  it("says so when NOTHING recurs, rather than printing a zero", () => {
    const w = portraitWeek({
      habits: [],
      proposals: [0, 1, 2, 3].map((d) =>
        proposal({ count: 1, walks: [walk(`p${d}`, local(d, 9))], sessionIds: [`p${d}`] }),
      ),
    });
    if (w.kind !== "grid") throw new Error(w.reason);
    expect(weekNote(w.grid)).toBe(
      "4 recordings across 4 days — none of these routes has been walked twice yet.",
    );
  });

  it("says so when EVERYTHING recurs", () => {
    const w = portraitWeek({
      habits: [
        habit({
          binding: binding({
            recordings: 4,
            walks: [0, 1, 2, 3].map((d) => walk(`s${d}`, local(d, 9))),
          }),
        }),
      ],
      proposals: [],
    });
    if (w.kind !== "grid") throw new Error(w.reason);
    expect(weekNote(w.grid)).toBe(
      "4 recordings across 4 days, every one of them on a route you have walked before.",
    );
  });

  it("gives an empty hour words rather than a bare zero", () => {
    expect(weekCellLabel(2, 0, { count: 0, recurring: false, walks: [] })).toBe(
      "Wednesday 00:00 — no recordings",
    );
  });

  it("says on the CELL that a hollow mark is a route seen once", () => {
    const w = portraitWeek(library());
    if (w.kind !== "grid") throw new Error(w.reason);
    expect(weekCellLabel(6, 9, w.grid.cells[6]![9]!)).toBe(
      "Sunday 09:00 — 2 recordings, on a route seen once",
    );
    expect(weekCellLabel(0, 15, w.grid.cells[0]![15]!)).toBe("Monday 15:00 — 1 recording");
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
