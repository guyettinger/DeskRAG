import { describe, expect, it } from "vitest";
import {
  bandOf,
  bandSkills,
  bindingChip,
  evidenceLine,
  generateDisabledReason,
  orderSkills,
} from "../app/src/renderer/src/skills-view.js";
import type { SkillBindingDTO, SkillDTO } from "@shared/types";

/**
 * How the screen orders and labels what main hands it.
 *
 * A `.ts` module so the root suite can reach it — the root tsconfig sets no
 * `jsx`, so a test touching a `.tsx` even for a type breaks `npm run typecheck`.
 */

const binding = (over: Partial<SkillBindingDTO> = {}): SkillBindingDTO => ({
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
  ...over,
});

const skill = (over: Partial<SkillDTO> = {}): SkillDTO => ({
  id: "k1",
  state: "active",
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
  version: "0.1.0",
  history: [],
  duplicates: [],
  slug: "a-skill",
  title: "A skill",
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
      expect(bandOf(skill({ binding: binding({ state }) }))).toBe("attention");
    }
  });

  it("leaves an intact skill in Mine", () => {
    expect(bandOf(skill())).toBe("mine");
  });

  /**
   * A duplicate's BINDING is exact and correct on both halves — nothing moved.
   * What is unresolved is that two files claim one route, and only a person can
   * resolve it, which is what Needs attention means.
   */
  it("puts a duplicated skill into Needs attention even though its binding is exact", () => {
    expect(bandOf(skill({ duplicates: ["k2"] }))).toBe("attention");
  });

  it("keeps archived out of the way even when its binding moved", () => {
    expect(bandOf(skill({ state: "archived", binding: binding({ state: "orphaned" }) }))).toBe(
      "archived",
    );
  });
});

describe("bandSkills", () => {
  it("drops dismissals — they are suppressed proposals, not skills", () => {
    const b = bandSkills([skill({ id: "a" }), skill({ id: "b", state: "dismissed" })]);
    expect([...b.attention, ...b.mine, ...b.archived].map((s) => s.id)).toEqual(["a"]);
  });
});

describe("orderSkills", () => {
  it("puts pinned first, then newest-touched", () => {
    const out = orderSkills([
      skill({ id: "old", updatedAt: 1 }),
      skill({ id: "new", updatedAt: 9 }),
      skill({ id: "pin", updatedAt: 2, pinned: true }),
    ]);
    expect(out.map((s) => s.id)).toEqual(["pin", "new", "old"]);
  });

  it("does not mutate its argument", () => {
    const input = [skill({ id: "a", updatedAt: 1 }), skill({ id: "b", updatedAt: 2 })];
    orderSkills(input);
    expect(input.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("bindingChip", () => {
  it("says nothing when nothing moved", () => {
    expect(bindingChip(skill())).toBeNull();
  });

  /**
   * A route can keep its key and lose a recording — deleting one cascades
   * immediately, without any rebuild. Reading as intact would overstate what is
   * still there.
   */
  it("flags an intact key that lost evidence", () => {
    expect(bindingChip(skill({ binding: binding({ lostSessionIds: ["s2"], recordings: 1 }) }))).toBe(
      "evidence changed",
    );
  });

  it("says `duplicated` FIRST — it is the larger problem, and another skill's too", () => {
    expect(bindingChip(skill({ duplicates: ["k2"] }))).toBe("duplicated");
    expect(bindingChip(skill({ duplicates: ["k2"], binding: binding({ state: "rebound" }) }))).toBe(
      "duplicated",
    );
  });

  it("names each moved state", () => {
    expect(bindingChip(skill({ binding: binding({ state: "rebound" }) }))).toBe("re-bound");
    expect(bindingChip(skill({ binding: binding({ state: "ambiguous" }) }))).toBe("split");
    expect(bindingChip(skill({ binding: binding({ state: "orphaned" }) }))).toBe("orphaned");
  });
});

describe("evidenceLine", () => {
  it("states the live count when it agrees with the bind-time one", () => {
    expect(evidenceLine(skill())).toBe("2 recordings");
  });

  it("prints BOTH counts when they disagree, never just one", () => {
    // Their disagreement is the fact the screen exists to show — the
    // `observations` vs `sources` rule, one level up.
    const s = skill({ binding: binding({ lostSessionIds: ["s2"], recordings: 1 }) });
    expect(evidenceLine(s)).toBe("1 recording — was 2 when this was kept");
  });

  it("reports recordings made since", () => {
    const s = skill({ binding: binding({ gainedSessionIds: ["s3"], recordings: 3 }) });
    expect(evidenceLine(s)).toBe("3 recordings — 1 recorded since");
  });

  it("never claims a live count for an orphan", () => {
    const s = skill({ binding: binding({ state: "orphaned", recordings: 0 }) });
    expect(evidenceLine(s)).toMatch(/written from 2 recordings, none of which are in a current route/);
  });

  it("says 'recording' singular", () => {
    const s = skill({ binding: binding({ boundSessionIds: ["s1"], recordings: 1 }) });
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
