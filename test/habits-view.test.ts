import { describe, expect, it } from "vitest";
import {
  bandOf,
  bandHabits,
  bindingChip,
  evidenceLine,
  generateDisabledReason,
  orderHabits,
  proposalEvidence,
  proposalTitle,
  bandProposals,
  ledgerMarks,
  markLabel,
  markReadout,
  walkSpan,
} from "../app/src/renderer/src/habits-view.js";
import type {
  HabitBindingDTO,
  HabitDTO,
  HabitProposalDTO,
  WalkMarkDTO,
} from "@shared/types";

/**
 * How the screen orders and labels what main hands it.
 *
 * A `.ts` module so the root suite can reach it — the root tsconfig sets no
 * `jsx`, so a test touching a `.tsx` even for a type breaks `npm run typecheck`.
 */

const binding = (over: Partial<HabitBindingDTO> = {}): HabitBindingDTO => ({
  state: "exact",
  routeKey: "A → B",
  liveRouteKey: "A → B",
  routeLabel: "A → B",
  boundAt: 1_754_000_000_000,
  boundSessionIds: ["s1", "s2"],
  overlap: 2,
  lostSessionIds: [],
  gainedSessionIds: [],
  recordings: 2,
  candidates: [],
  note: null,
  walks: [],
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

describe("bandOf", () => {
  it("puts anything whose route moved into Needs attention", () => {
    for (const state of ["rebound", "ambiguous", "orphaned"] as const) {
      expect(bandOf(habit({ binding: binding({ state }) }))).toBe("attention");
    }
  });

  it("leaves an intact habit in Mine", () => {
    expect(bandOf(habit())).toBe("mine");
  });

  /**
   * A duplicate's BINDING is exact and correct on both halves — nothing moved.
   * What is unresolved is that two files claim one route, and only a person can
   * resolve it, which is what Needs attention means.
   */
  it("puts a duplicated habit into Needs attention even though its binding is exact", () => {
    expect(bandOf(habit({ duplicates: ["k2"] }))).toBe("attention");
  });

  it("keeps archived out of the way even when its binding moved", () => {
    expect(bandOf(habit({ state: "archived", binding: binding({ state: "orphaned" }) }))).toBe(
      "archived",
    );
  });
});

describe("bandHabits", () => {
  it("drops dismissals — they are suppressed proposals, not habits", () => {
    const b = bandHabits([habit({ id: "a" }), habit({ id: "b", state: "dismissed" })]);
    expect([...b.attention, ...b.mine, ...b.archived].map((s) => s.id)).toEqual(["a"]);
  });
});

describe("orderHabits", () => {
  it("puts pinned first, then newest-touched", () => {
    const out = orderHabits([
      habit({ id: "old", updatedAt: 1 }),
      habit({ id: "new", updatedAt: 9 }),
      habit({ id: "pin", updatedAt: 2, pinned: true }),
    ]);
    expect(out.map((s) => s.id)).toEqual(["pin", "new", "old"]);
  });

  it("does not mutate its argument", () => {
    const input = [habit({ id: "a", updatedAt: 1 }), habit({ id: "b", updatedAt: 2 })];
    orderHabits(input);
    expect(input.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("bindingChip", () => {
  it("says nothing when nothing moved", () => {
    expect(bindingChip(habit())).toBeNull();
  });

  /**
   * A route can keep its key and lose a recording — deleting one cascades
   * immediately, without any rebuild. Reading as intact would overstate what is
   * still there.
   */
  it("flags an intact key that lost evidence", () => {
    expect(bindingChip(habit({ binding: binding({ lostSessionIds: ["s2"], recordings: 1 }) }))).toBe(
      "evidence changed",
    );
  });

  it("says `duplicated` FIRST — it is the larger problem, and another habit's too", () => {
    expect(bindingChip(habit({ duplicates: ["k2"] }))).toBe("duplicated");
    expect(bindingChip(habit({ duplicates: ["k2"], binding: binding({ state: "rebound" }) }))).toBe(
      "duplicated",
    );
  });

  it("names each moved state", () => {
    expect(bindingChip(habit({ binding: binding({ state: "rebound" }) }))).toBe("re-bound");
    expect(bindingChip(habit({ binding: binding({ state: "ambiguous" }) }))).toBe("split");
    expect(bindingChip(habit({ binding: binding({ state: "orphaned" }) }))).toBe("orphaned");
  });
});

describe("evidenceLine", () => {
  it("states the live count when it agrees with the bind-time one", () => {
    expect(evidenceLine(habit())).toBe("2 recordings");
  });

  it("prints BOTH counts when they disagree, never just one", () => {
    // Their disagreement is the fact the screen exists to show — the
    // `observations` vs `sources` rule, one level up.
    const s = habit({ binding: binding({ lostSessionIds: ["s2"], recordings: 1 }) });
    expect(evidenceLine(s)).toBe("1 recording — was 2 when this was kept");
  });

  it("reports recordings made since", () => {
    const s = habit({ binding: binding({ gainedSessionIds: ["s3"], recordings: 3 }) });
    expect(evidenceLine(s)).toBe("3 recordings — 1 recorded since");
  });

  it("never claims a live count for an orphan", () => {
    const s = habit({ binding: binding({ state: "orphaned", recordings: 0 }) });
    expect(evidenceLine(s)).toMatch(/written from 2 recordings, none of which are in a current route/);
  });

  it("says 'recording' singular", () => {
    const s = habit({ binding: binding({ boundSessionIds: ["s1"], recordings: 1 }) });
    expect(evidenceLine(s)).toBe("1 recording");
  });
});

describe("generateDisabledReason", () => {
  /**
   * A greyed control with no reason is what `StageSpec.skipReason` exists to
   * prevent one screen over: a control that merely does nothing is
   * indistinguishable from one nobody implemented.
   */
  it("gives a reason in words, and names where to fix it", () => {
    const why = generateDisabledReason({ available: false, model: null });
    expect(why).toMatch(/No summary model is configured/);
    expect(why).toMatch(/Settings/);
  });

  it("is null when a model is available", () => {
    expect(generateDisabledReason({ available: true, model: "ollama m" })).toBeNull();
  });
});

describe("what ×N means, in words", () => {
  const proposal = (over: Partial<HabitProposalDTO> = {}): HabitProposalDTO => ({
    routeKey: "A → B",
    name: null,
    label: "A → B",
    count: 2,
    steps: 3,
    stepSummary: "2 steps",
    variants: 0,
    nameObservations: 0,
    walks: [],
    sessionIds: ["s1", "s2"],
    apps: [],
    preview: "",
    ...over,
  });

  it("states the recurrence at every count, not only at one", () => {
    expect(proposalEvidence(proposal({ count: 4 }))).toBe("4 recordings walked this");
    expect(proposalEvidence(proposal({ count: 2 }))).toBe("2 recordings walked this");
  });

  it("never claims a single walk is a habit", () => {
    const once = proposalEvidence(proposal({ count: 1 }));
    expect(once).toBe("recorded once");
    expect(once).not.toMatch(/habit/i);
  });

  it("says the same thing RouteList's tooltip says about the same route", () => {
    expect(proposalTitle(proposal({ count: 4 }))).toBe("4 recordings took this path");
    expect(proposalTitle(proposal({ count: 1 }))).toBe("1 recording took this path");
  });

  it("REPORTS name disagreement rather than smoothing it over", () => {
    const title = proposalTitle(proposal({ count: 4, name: "File a bug", nameObservations: 2 }));
    expect(title).toMatch(/4 recordings took this path/);
    expect(title).toMatch(/2 of them called it/);
  });

  it("stays silent about agreement when every recording agrees", () => {
    const title = proposalTitle(proposal({ count: 4, name: "File a bug", nameObservations: 4 }));
    expect(title).toBe("4 recordings took this path");
  });
});

describe("an act and a habit are not drawn alike", () => {
  const p = (routeKey: string, count: number): HabitProposalDTO => ({
    routeKey,
    name: null,
    label: routeKey,
    count,
    steps: 2,
    stepSummary: "2 steps",
    variants: 0,
    nameObservations: 0,
    sessionIds: [],
    walks: [],
    apps: [],
    preview: "",
  });

  it("splits on whether anything recurred", () => {
    const out = bandProposals([p("a", 3), p("b", 1), p("c", 2), p("d", 1)]);
    expect(out.repeated.map((x) => x.routeKey)).toEqual(["a", "c"]);
    expect(out.once.map((x) => x.routeKey)).toEqual(["b", "d"]);
  });

  // A partition, never a re-sort: main already decided what "most walked" means.
  it("keeps main's order inside each band", () => {
    const out = bandProposals([p("z", 5), p("y", 9)]);
    expect(out.repeated.map((x) => x.routeKey)).toEqual(["z", "y"]);
  });
});

describe("the recurrence ledger", () => {
  const w = (at: number, gained = false): WalkMarkDTO => ({
    sessionId: `s${at}`,
    at,
    gained,
    fit: null,
    walk: { atSec: 0, throughSec: 1, steps: 2 },
  });

  it("places walks on the SHARED domain, not on their own extent", () => {
    const domain = { from: 0, to: 100 };
    // Two rows whose walks span different fractions of one library must NOT
    // both draw edge to edge — that is the whole reason the domain is shared.
    expect(ledgerMarks([w(0), w(100)], domain).map((m) => m.x)).toEqual([0, 1]);
    expect(ledgerMarks([w(50), w(75)], domain).map((m) => m.x)).toEqual([0.5, 0.75]);
  });

  it("centres a zero-width domain rather than asserting recency", () => {
    expect(ledgerMarks([w(7)], { from: 7, to: 7 }).map((m) => m.x)).toEqual([0.5]);
  });

  /**
   * A MARK ANSWERS WHEN ASKED. Both formatters are injected because `api.ts`
   * reads `window.deskrag` at module scope and this suite cannot import it;
   * fakes here keep the assertions about the SENTENCE rather than about
   * `Intl`'s output on whatever machine runs them.
   */
  const fmt = {
    wallClock: (ms: number) => `wall(${ms})`,
    timecode: (ms: number) => `tc(${ms})`,
  };

  it("says when, where inside the recording, and what it walked", () => {
    const out = markReadout(
      { sessionId: "s1", at: 1000, gained: false, fit: null, walk: { atSec: 4, throughSec: 9, steps: 3 } },
      fmt,
    );
    expect(out).toEqual({
      when: "wall(1000)",
      at: "tc(4000) – tc(9000)",
      steps: "3 steps",
      note: null,
      action: "Open this recording",
    });
  });

  it("counts one step in the singular", () => {
    expect(
      markReadout(
        { sessionId: "s1", at: 1, gained: false, fit: null, walk: { atSec: 0, throughSec: 1, steps: 1 } },
        fmt,
      ).steps,
    ).toBe("1 step");
  });

  // The only evidence on this screen that a habit is still being practised
  // rather than merely written down.
  it("names a recording made since the habit was kept", () => {
    expect(
      markReadout(
        { sessionId: "s1", at: 1, gained: true, fit: null, walk: { atSec: 0, throughSec: 1, steps: 2 } },
        fmt,
      ).note,
    ).toBe("Recorded since you kept this");
  });

  /**
   * WITHHELD, AND IT SAYS WHY. An orphaned habit's marks have no live route, so
   * there is no moment to open — and a control that merely goes grey is
   * indistinguishable from one nobody implemented, the `skipReason` rule.
   */
  it("states the reason rather than offering a dead link", () => {
    const out = markReadout({ sessionId: "s1", at: 1, gained: false, fit: null, walk: null }, fmt);
    expect(out.at).toBeNull();
    expect(out.steps).toBeNull();
    expect(out.action).toBeNull();
    expect(out.note).toBe("Not in a current route, so there is no moment to open");
  });

  // The mark's accessible name IS the card, on one line: an action cannot be
  // hidden from a screen reader, and a position is not a fact anyone should
  // have to see to get.
  it("says the same thing on one line for the label", () => {
    expect(
      markLabel(
        markReadout(
          { sessionId: "s1", at: 1, gained: true, fit: null, walk: { atSec: 0, throughSec: 1, steps: 2 } },
          fmt,
        ),
      ),
    ).toBe("wall(1) · tc(0) – tc(1000) · 2 steps · Recorded since you kept this");
  });

  it("draws nothing with no domain", () => {
    expect(ledgerMarks([w(1)], null)).toEqual([]);
  });

  it("carries `gained` through, because it is the only 'still doing it' signal", () => {
    const marks = ledgerMarks([w(0), w(10, true)], { from: 0, to: 10 });
    expect(marks.map((m) => m.gained)).toEqual([false, true]);
  });

  it("says WHEN, which a count cannot", () => {
    expect(walkSpan([])).toBeNull();
    // One walk names one day rather than a span of it to itself.
    const one = walkSpan([w(Date.UTC(2026, 7, 17, 12))]);
    expect(one).not.toBeNull();
    expect(one).not.toMatch(/–/);
    expect(walkSpan([w(Date.UTC(2026, 7, 17, 12)), w(Date.UTC(2026, 7, 20, 12))])).toMatch(/–/);
  });
});
