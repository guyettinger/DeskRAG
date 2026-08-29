import { describe, expect, it } from "vitest";
import {
  bandOf,
  bandHabits,
  bindingChip,
  domainAxis,
  droppedEarlyLine,
  evidenceGlyphs,
  fitState,
  generateDisabledReason,
  orderHabits,
  proposalEvidence,
  proposalGlyphs,
  proposalTitle,
  bandProposals,
  ledgerMarks,
  markLabel,
  markReadout,
  markStates,
  walkSpan,
} from "../app/src/renderer/src/habits-view.js";
import type { LedgerMark } from "../app/src/renderer/src/habits-view.js";
import type {
  HabitBindingDTO,
  HabitDTO,
  HabitProposalDTO,
  WalkFitDTO,
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
  fork: null,
  droppedEarly: [],
  slots: [],
  timings: null,
  runs: [],
  cautions: [],
  apps: [],
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

/** A fixed clock. Every band test that does not care about time uses it. */
const NOW = new Date(2026, 7, 23, 12).getTime();

describe("bandOf", () => {
  it("puts anything whose route moved into Needs attention", () => {
    for (const state of ["rebound", "ambiguous", "orphaned"] as const) {
      expect(bandOf(habit({ binding: binding({ state }) }), NOW)).toBe("attention");
    }
  });

  it("leaves an intact habit in Mine", () => {
    expect(bandOf(habit(), NOW)).toBe("mine");
  });

  /**
   * A duplicate's BINDING is exact and correct on both halves — nothing moved.
   * What is unresolved is that two files claim one route, and only a person can
   * resolve it, which is what Needs attention means.
   */
  it("puts a duplicated habit into Needs attention even though its binding is exact", () => {
    expect(bandOf(habit({ duplicates: ["k2"] }), NOW)).toBe("attention");
  });

  it("keeps archived out of the way even when its binding moved", () => {
    expect(bandOf(habit({ state: "archived", binding: binding({ state: "orphaned" }) }), NOW)).toBe(
      "archived",
    );
  });
});

describe("bandHabits", () => {
  it("drops dismissals — they are suppressed proposals, not habits", () => {
    const b = bandHabits([habit({ id: "a" }), habit({ id: "b", state: "dismissed" })], NOW);
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
      fit: null,
      // The clauses beside the sentence, so a card with room can list them and
      // a screen reader still hears one line. Null here, not [] — no standard
      // existed, and an empty list would claim a check that was never run.
      fitParts: null,
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

/** A mark as main hands it over. `fit: null` is the no-standard case. */
const walk = (over: Partial<WalkMarkDTO> = {}): WalkMarkDTO => ({
  sessionId: "s1",
  at: 0,
  gained: false,
  fit: null,
  walk: { atSec: 0, throughSec: 1, steps: 2 },
  ...over,
});

const fit = (over: Partial<WalkFitDTO> = {}): WalkFitDTO => ({
  inserted: 0,
  skipped: 0,
  reordered: 0,
  reachedEnd: true,
  ...over,
});

const marksOf = (walks: readonly WalkMarkDTO[]): LedgerMark[] =>
  ledgerMarks(walks, { from: 0, to: 10_000 });

describe("markStates", () => {
  it("takes the ROW, because lone is a property of the row", () => {
    // A per-mark signature could not see it, which is the same positional
    // coupling `LedgerMark.walk` is carried to avoid.
    const one = marksOf([walk({ sessionId: "s1", at: 0 })]);
    expect(markStates(one)).toEqual(["lone"]);
  });

  it("is null when no standard exists, and null is not canonical", () => {
    const two = marksOf([
      walk({ sessionId: "s1", at: 0, fit: null }),
      walk({ sessionId: "s2", at: 5_000, fit: null }),
    ]);
    expect(markStates(two)).toEqual([null, null]);
  });

  it("calls a clean fit canonical", () => {
    const two = marksOf([
      walk({ sessionId: "s1", at: 0, fit: fit() }),
      walk({ sessionId: "s2", at: 5_000, fit: fit() }),
    ]);
    expect(markStates(two)).toEqual(["canonical", "canonical"]);
  });

  it("calls any non-zero count deviated", () => {
    const two = marksOf([
      walk({ sessionId: "s1", at: 0, fit: fit() }),
      walk({ sessionId: "s2", at: 5_000, fit: fit({ skipped: 1 }) }),
    ]);
    expect(markStates(two)[1]).toBe("deviated");
  });

  it("lets short OUTRANK deviated", () => {
    // Stopping before the end is the larger fact, and a walk that stopped will
    // almost always also show skipped steps — reporting it as merely deviated
    // would bury the reason. The card says both.
    const two = marksOf([
      walk({ sessionId: "s1", at: 0, fit: fit() }),
      walk({ sessionId: "s2", at: 5_000, fit: fit({ skipped: 3, reachedEnd: false }) }),
    ]);
    expect(markStates(two)[1]).toBe("short");
  });

  it("never returns a state for a lone mark, whatever its fit", () => {
    const one = marksOf([walk({ sessionId: "s1", at: 0, fit: fit({ skipped: 2 }) })]);
    expect(markStates(one)).toEqual(["lone"]);
  });
});

describe("the mark says how it compared", () => {
  const readoutOf = (w: WalkMarkDTO) =>
    markReadout(w, { wallClock: () => "18 Aug 2026", timecode: () => "00:00:05" });

  it("says nothing when there is no standard", () => {
    expect(readoutOf(walk({ sessionId: "s1", at: 0, fit: null })).fit).toBeNull();
  });

  it("says it followed the standard when it did", () => {
    expect(readoutOf(walk({ sessionId: "s1", at: 0, fit: fit() })).fit).toMatch(
      /Followed the standard/,
    );
  });

  it("counts what differed, in the record's own words", () => {
    const r = readoutOf(walk({ sessionId: "s1", at: 0, fit: fit({ inserted: 1, skipped: 2 }) }));
    expect(r.fit).toMatch(/1 step not in the standard/);
    expect(r.fit).toMatch(/2 of the standard's steps not taken/);
  });

  it("says it stopped before the end", () => {
    const r = readoutOf(walk({ sessionId: "s1", at: 0, fit: fit({ reachedEnd: false }) }));
    expect(r.fit).toMatch(/Stopped before the end/);
  });

  it("reaches markLabel, so a screen reader hears it too", () => {
    const w = walk({ sessionId: "s1", at: 0, fit: fit({ skipped: 1 }) });
    expect(markLabel(readoutOf(w))).toMatch(/not taken/);
  });

  it("carries no percentage and no grade", () => {
    const r = readoutOf(walk({ sessionId: "s1", at: 0, fit: fit({ skipped: 1 }) }));
    expect(r.fit).not.toMatch(/\d+%/);
    expect(r.fit).not.toMatch(/wrong|failed|bad|worse|poor/i);
  });
});

describe("droppedEarlyLine", () => {
  it("is null when nothing was dropped early", () => {
    expect(droppedEarlyLine(habit())).toBeNull();
  });

  it("says how many times, and stops there", () => {
    // ON THE ROW, where the decision to open is made — the same argument that
    // put RECORDED ONCE into list_habits rather than only into the file.
    const h = habit({ droppedEarly: [{ places: ["Calculator"], count: 2 }] });
    expect(droppedEarlyLine(h)).toBe("also started and dropped early 2 further times");
  });

  it("says it in the singular when it happened once", () => {
    const h = habit({ droppedEarly: [{ places: ["Calculator"], count: 1 }] });
    expect(droppedEarlyLine(h)).toBe("also started and dropped early 1 further time");
  });

  it("sums several prefix routes rather than listing them", () => {
    // The row is not the place for the places. The record already names each
    // one; a row that listed three would push the evidence line off the card.
    const h = habit({
      droppedEarly: [
        { places: ["Calculator"], count: 2 },
        { places: ["Calculator", "TextEdit"], count: 1 },
      ],
    });
    expect(droppedEarlyLine(h)).toBe("also started and dropped early 3 further times");
  });

  it("never touches the recording count", () => {
    // A DISCLOSURE, never a merge: those recordings walked a different route.
    // Asserted against the GLYPHS now, which is where the count is stated.
    const h = habit({ droppedEarly: [{ places: ["Calculator"], count: 5 }] });
    const count = (x: HabitDTO) =>
      evidenceGlyphs(x, NOW).find((g) => g.kind === "recordings");
    expect(count(h)).toEqual(count(habit()));
  });
});

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

/**
 * The evidence line, as glyphs.
 *
 * The line these replaced ran five facts together into one string — `6
 * recordings — 3 recorded since · Aug 17 – Aug 24`, plus a dropped-early clause
 * and a fade clause — in the narrowest column on the screen, under an
 * instrument already drawing three of them. These tests exist to hold the one
 * property that makes compressing it legal: NOTHING IS LOST. Every glyph's
 * `title` is what a pointer and a screen reader are given, so each case below
 * asserts the sentence as well as the figure.
 */
describe("evidenceGlyphs", () => {
  const AUG17 = new Date(2026, 7, 17, 10).getTime();
  const AUG24 = new Date(2026, 7, 24, 10).getTime();
  const NOW_G = new Date(2026, 7, 25, 12).getTime();
  const walks = [
    walk({ sessionId: "w1", at: AUG17 }),
    walk({ sessionId: "w2", at: AUG24 }),
  ];
  const kept = (over: Partial<HabitBindingDTO> = {}): HabitDTO =>
    habit({ binding: binding({ walks, recordings: 2, ...over }) });
  const kind = (g: ReturnType<typeof evidenceGlyphs>, k: string) =>
    g.find((x) => x.kind === k);

  it("says the count and the last date, and nothing else, when nothing moved", () => {
    const g = evidenceGlyphs(kept(), NOW_G);
    expect(g.map((x) => x.kind)).toEqual(["recordings", "last"]);
    expect(kind(g, "recordings")!.value).toBe("2");
    expect(kind(g, "recordings")!.delta).toBeNull();
    expect(kind(g, "last")!.value).toMatch(/24/);
  });

  /**
   * The delta wears `--data-ok` in the sheet because the ledger already rings a
   * gained mark in it. `warn: false` is what selects that class, so this is the
   * assertion that keeps the two instruments telling one story.
   */
  it("folds recordings made since the habit was kept into a gained delta", () => {
    const g = evidenceGlyphs(kept({ gainedSessionIds: ["w2"] }), NOW_G);
    expect(kind(g, "recordings")!.delta).toEqual({ text: "+1", warn: false });
    expect(kind(g, "recordings")!.title).toBe("2 recordings — 1 recorded since you kept this");
  });

  it("folds a LOST recording into an amber delta and keeps the bind-time count in words", () => {
    const g = evidenceGlyphs(
      kept({ lostSessionIds: ["gone"], boundSessionIds: ["w1", "w2", "gone"] }),
      NOW_G,
    );
    expect(kind(g, "recordings")!.delta).toEqual({ text: "−1", warn: true });
    expect(kind(g, "recordings")!.title).toBe("2 recordings — was 3 when this was kept");
  });

  /**
   * LOST OUTRANKS GAINED, `evidenceLine`'s own precedence. A row reading `+1`
   * while it also shed two says the smaller of the two things.
   */
  it("shows the lost delta when a binding both gained and lost", () => {
    const g = evidenceGlyphs(
      kept({ gainedSessionIds: ["w2"], lostSessionIds: ["gone"], boundSessionIds: ["w1", "gone"] }),
      NOW_G,
    );
    expect(kind(g, "recordings")!.delta!.warn).toBe(true);
  });

  /**
   * The count a habit was WRITTEN from, marked, with the whole sentence in its
   * title — the one fact that does not fold, because which orphaned state it is
   * in belongs to `bindingChip` and always has.
   */
  it("marks an orphaned binding and counts what it was written from", () => {
    for (const state of ["orphaned", "ambiguous"] as const) {
      const g = evidenceGlyphs(kept({ state, boundSessionIds: ["a", "b", "c"] }), NOW_G);
      expect(kind(g, "recordings")!.value).toBe("3");
      expect(kind(g, "recordings")!.warn).toBe(true);
      expect(kind(g, "recordings")!.title).toBe(
        "Written from 3 recordings, none of which are in a current route",
      );
    }
  });

  /** Never folded into the count: those recordings walked a DIFFERENT route. */
  it("keeps dropped-early as its own glyph, outside the count", () => {
    const g = evidenceGlyphs(
      habit({
        binding: binding({ walks, recordings: 2 }),
        droppedEarly: [{ places: ["A"], count: 2 }],
      }),
      NOW_G,
    );
    expect(kind(g, "recordings")!.value).toBe("2");
    expect(kind(g, "dropped")!.value).toBe("×2");
    expect(kind(g, "dropped")!.title).toMatch(/walked a different route/);
  });

  /**
   * The cadence is drawn ONLY where it is the point. On a habit still being
   * walked it is a number nobody asked for; on one that stopped it is the half
   * a date cannot say.
   */
  it("draws no cadence on a habit that has not faded", () => {
    expect(evidenceGlyphs(kept(), NOW_G).some((g) => g.kind === "cadence")).toBe(false);
  });

  it("adds an amber cadence and an amber date once a habit has faded", () => {
    const weeklyWalks = [
      walk({ sessionId: "a", at: new Date(2026, 7, 3, 10).getTime() }),
      walk({ sessionId: "b", at: new Date(2026, 7, 10, 10).getTime() }),
      walk({ sessionId: "c", at: new Date(2026, 7, 17, 10).getTime() }),
    ];
    const faded = habit({ binding: binding({ walks: weeklyWalks, recordings: 3 }) });
    const later = new Date(2026, 7, 17, 10).getTime() + 6 * 7 * 24 * 3_600_000;
    const g = evidenceGlyphs(faded, later);
    expect(kind(g, "cadence")!.warn).toBe(true);
    expect(kind(g, "cadence")!.value).toBe("every 7 days");
    expect(kind(g, "cadence")!.title).toMatch(/last walked 6 weeks ago/);
    // The date goes amber with it, so the two halves of "it stopped" agree.
    expect(kind(g, "last")!.warn).toBe(true);
  });

  it("says nothing about a date when there are no walks at all", () => {
    const g = evidenceGlyphs(habit({ binding: binding({ walks: [], recordings: 0 }) }), NOW_G);
    expect(g.map((x) => x.kind)).toEqual(["recordings"]);
  });

  /** Every glyph is a figure plus a sentence. A figure alone is not a fact. */
  it("gives every glyph a non-empty title", () => {
    const g = evidenceGlyphs(
      habit({
        binding: binding({ walks, recordings: 2, gainedSessionIds: ["w2"] }),
        droppedEarly: [{ places: ["A"], count: 1 }],
      }),
      NOW_G,
    );
    expect(g.length).toBeGreaterThan(2);
    for (const item of g) expect(item.title.length).toBeGreaterThan(0);
  });
});

describe("proposalGlyphs", () => {
  const p = (over: Partial<HabitProposalDTO> = {}): HabitProposalDTO => ({
    routeKey: "A \u2192 B",
    name: null,
    label: "A \u2192 B",
    count: 2,
    steps: 3,
    stepSummary: "2 steps",
    variants: 0,
    nameObservations: 0,
    walks: [walk({ sessionId: "a", at: 1 })],
    sessionIds: ["s1", "s2"],
    apps: [],
    preview: "",
    ...over,
  });

  it("carries only the two facts a proposal has — nothing is invented", () => {
    expect(proposalGlyphs(p()).map((g) => g.kind)).toEqual(["recordings", "last"]);
  });

  it("never warns: a proposal has no binding that could have moved", () => {
    expect(proposalGlyphs(p()).every((g) => !g.warn && g.delta === null)).toBe(true);
  });

  it("drops the date when a proposal carries no walks", () => {
    expect(proposalGlyphs(p({ walks: [] })).map((g) => g.kind)).toEqual(["recordings"]);
  });
});

/**
 * The ledger's own scale.
 *
 * It labels the SHARED domain, never the row's extent — the thing that makes a
 * route walked three times last week read differently from one walked three
 * times in March.
 */
describe("domainAxis", () => {
  it("prints the shared domain's ends", () => {
    const a = domainAxis({
      from: new Date(2026, 7, 17, 10).getTime(),
      to: new Date(2026, 7, 24, 10).getTime(),
    })!;
    expect(a.from).toMatch(/17/);
    expect(a.to).toMatch(/24/);
  });

  it("draws nothing with no domain", () => {
    expect(domainAxis(null)).toBeNull();
  });

  /**
   * `ledgerMarks` centres every mark at zero width, so an axis would print one
   * date at both ends and assert a span the library does not have.
   */
  it("draws nothing at zero width, where every mark is centred", () => {
    expect(domainAxis({ from: 5, to: 5 })).toBeNull();
  });
});

/**
 * The fit as clauses AND as a sentence, from one source.
 *
 * The card lists the parts and `markLabel` speaks the join. Re-splitting a
 * joined string on ", " would be a parser over prose, and the first clause to
 * contain a comma would break it silently.
 */
describe("markReadout fitParts", () => {
  const fmt = { wallClock: () => "when", timecode: () => "at" };

  it("is null where no standard exists — not an empty list", () => {
    expect(markReadout(walk(), fmt).fitParts).toBeNull();
  });

  it("says the conforming case in one part", () => {
    expect(markReadout(walk({ fit: fit() }), fmt).fitParts).toEqual(["Followed the standard"]);
  });

  it("gives each count its own part", () => {
    const r = markReadout(walk({ fit: fit({ inserted: 5, skipped: 4 }) }), fmt);
    expect(r.fitParts).toEqual([
      "5 steps not in the standard",
      "4 of the standard's steps not taken",
    ]);
  });

  it("adds stopping short as its own part, never appended to another", () => {
    const r = markReadout(walk({ fit: fit({ skipped: 1, reachedEnd: false }) }), fmt);
    expect(r.fitParts).toEqual([
      "1 of the standard's steps not taken",
      "Stopped before the end",
    ]);
  });

  /** The two shapes are one fact. A card and a screen reader must not diverge. */
  it("joins to exactly the sentence the accessible name carries", () => {
    const r = markReadout(walk({ fit: fit({ inserted: 5, skipped: 4, reachedEnd: false }) }), fmt);
    expect(r.fit).toBe(
      "5 steps not in the standard, 4 of the standard's steps not taken. Stopped before the end.",
    );
    expect(markLabel(r)).toContain(r.fit!);
  });
});

/** One walk's conformance, shared with `markStates` so the two cannot drift. */
describe("fitState", () => {
  it("is null where no standard existed — never canonical", () => {
    expect(fitState(null)).toBeNull();
  });

  it("calls a matching walk canonical", () => {
    expect(fitState(fit())).toBe("canonical");
  });

  it("puts SHORT above deviated, because a stopped walk also shows skips", () => {
    expect(fitState(fit({ skipped: 3, reachedEnd: false }))).toBe("short");
  });

  it("agrees with markStates on every walk of a multi-walk row", () => {
    const rows = [
      walk({ sessionId: "a", at: 1, fit: fit() }),
      walk({ sessionId: "b", at: 2, fit: fit({ inserted: 1 }) }),
      walk({ sessionId: "c", at: 3, fit: fit({ reachedEnd: false }) }),
    ];
    expect(markStates(marksOf(rows))).toEqual(rows.map((r) => fitState(r.fit)));
  });
});
