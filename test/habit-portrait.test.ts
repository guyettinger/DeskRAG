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
  fork: null,
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
