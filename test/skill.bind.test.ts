import { describe, expect, it } from "vitest";
import { bindSkill, duplicateSkills, unclaimedRoutes, type SkillBindingDoc } from "../app/src/main/skill-bind.js";
import type { FlowRouteDTO } from "@shared/types";

/**
 * What happens to a kept skill when the graph is rebuilt underneath it.
 *
 * A route's id is the sequence of place labels it passes through, so recording
 * the same task once more through one extra application RENAMES it — and
 * `rebuildGraph` replays every recording from zero on each re-index. Binding a
 * skill to `route.id` would therefore lose the user's prose routinely and
 * silently. These are the four answers, and the third one is the interesting
 * one: it declines rather than guessing.
 */

const route = (id: string, sessionIds: string[]): FlowRouteDTO => ({
  id,
  count: sessionIds.length,
  label: id,
  name: null,
  nameObservations: 0,
  nodeIds: [],
  edgeIds: [],
  sessionIds,
  walks: sessionIds.map((sessionId) => ({ sessionId, edgeIds: [] })),
  variants: [],
});

const doc = (routeKey: string, sessionIds: string[]): SkillBindingDoc => ({
  routeKey,
  routeLabel: routeKey,
  sessionIds,
  boundAt: 1_754_000_000_000,
});

describe("exact", () => {
  it("binds when the key still exists, and says nothing moved", () => {
    const r = route("A → B", ["s1", "s2"]);
    const b = bindSkill(doc("A → B", ["s1", "s2"]), [r]);

    expect(b.state).toBe("exact");
    expect(b.route).toBe(r);
    expect(b.overlap).toBe(2);
    expect(b.lostSessionIds).toEqual([]);
    expect(b.note).toBeNull();
  });

  /**
   * A route can keep its key and lose a recording — deleting one cascades
   * `trace_edge_source` immediately, without any rebuild. That must show rather
   * than reading as intact, or the skill's evidence count silently overstates
   * what is still there.
   */
  it("still reports a lost recording when the key is unchanged", () => {
    const r = route("A → B", ["s1"]);
    const b = bindSkill(doc("A → B", ["s1", "s2"]), [r]);

    expect(b.state).toBe("exact");
    expect(b.overlap).toBe(1);
    expect(b.lostSessionIds).toEqual(["s2"]);
    expect(b.note).toMatch(/1 of the 2 recordings/);
    expect(b.note).toMatch(/is no longer/);
  });

  it("reports recordings the route gained since", () => {
    const b = bindSkill(doc("A → B", ["s1"]), [route("A → B", ["s1", "s2"])]);
    expect(b.gainedSessionIds).toEqual(["s2"]);
  });
});

describe("rebound", () => {
  it("follows a strict majority of the recordings to the renamed route", () => {
    const grown = route("A → B → C", ["s1", "s2", "s3", "s4"]);
    const b = bindSkill(doc("A → B", ["s1", "s2", "s3"]), [grown, route("X", ["s9"])]);

    expect(b.state).toBe("rebound");
    expect(b.route).toBe(grown);
    expect(b.overlap).toBe(3);
    expect(b.note).toMatch(/states this flow passes through changed/);
    expect(b.note).toMatch(/“A → B”/);
    expect(b.note).toMatch(/“A → B → C”/);
  });

  it("does not rebind on a bare plurality below half", () => {
    // 1 of 3 is not a majority. Two routes each holding one recording is exactly
    // the split the majority rule exists to refuse.
    const b = bindSkill(doc("A → B", ["s1", "s2", "s3"]), [
      route("P", ["s1"]),
      route("Q", ["s2"]),
    ]);
    expect(b.state).toBe("orphaned");
  });

  it("treats exactly half as not a majority", () => {
    const b = bindSkill(doc("A → B", ["s1", "s2"]), [route("P", ["s1"])]);
    expect(b.state).toBe("orphaned");
  });
});

/**
 * The tie, and why it cannot happen for more than one reason.
 *
 * `frequentRoutes` gives each recording exactly one route key, so the sessionIds
 * PARTITION — more than half of a set lies in at most one part. A strict
 * majority therefore has at most one winner mathematically. The only way two
 * candidates survive the filter is a degenerate input, and there it declines,
 * for the reason node identity declines to merge on ambiguity: a redundant state
 * is visible and fixable, a wrong one is silent.
 */
describe("ambiguous", () => {
  it("declines rather than picking when two routes both hold a majority", () => {
    const b = bindSkill(doc("A → B", ["s1", "s2"]), [
      route("P", ["s1", "s2"]),
      route("Q", ["s1", "s2"]),
    ]);

    expect(b.state).toBe("ambiguous");
    expect(b.route).toBeNull();
    expect(b.candidates).toEqual(["P", "Q"]);
    expect(b.note).toMatch(/will not choose/);
  });
});

describe("orphaned", () => {
  it("keeps the skill and says the evidence is gone", () => {
    const b = bindSkill(doc("A → B", ["s1", "s2"]), [route("X", ["s8", "s9"])]);

    expect(b.state).toBe("orphaned");
    expect(b.route).toBeNull();
    expect(b.lostSessionIds).toEqual(["s1", "s2"]);
    expect(b.note).toMatch(/None of the 2 recordings/);
    expect(b.note).toMatch(/“A → B”/);
  });

  it("orphans against an empty graph rather than throwing", () => {
    expect(bindSkill(doc("A → B", ["s1"]), []).state).toBe("orphaned");
  });
});

describe("the binding is a reading, never a write", () => {
  it("returns the same answer twice and mutates neither argument", () => {
    const d = doc("A → B", ["s1", "s2", "s3"]);
    const routes = [route("A → B → C", ["s1", "s2", "s3", "s4"])];
    const before = JSON.stringify({ d, routes });

    const a = bindSkill(d, routes);
    const b = bindSkill(d, routes);

    expect(a).toEqual(b);
    // The stored key is only ever changed by an explicit act. If this call
    // adopted the new one, the skill's record of where it came from would be
    // unfalsifiable.
    expect(d.routeKey).toBe("A → B");
    expect(JSON.stringify({ d, routes })).toBe(before);
  });
});

describe("unclaimedRoutes", () => {
  it("excludes routes that already have a skill or a dismissal", () => {
    const routes = [route("A", ["s1"]), route("B", ["s2"]), route("C", ["s3"])];
    expect(unclaimedRoutes(routes, ["A", "C"]).map((r) => r.id)).toEqual(["B"]);
  });

  it("proposes everything when nothing has been answered about", () => {
    const routes = [route("A", ["s1"])];
    expect(unclaimedRoutes(routes, [])).toEqual(routes);
  });
});

describe("duplicateSkills", () => {
  const s = (id: string, liveRouteKey: string | null) => ({ id, liveRouteKey });

  it("reports nothing when every skill answers to its own route", () => {
    expect(duplicateSkills([s("a", "R1"), s("b", "R2")]).size).toBe(0);
  });

  it("pairs two skills that now answer to ONE route", () => {
    const out = duplicateSkills([s("a", "R1"), s("b", "R1")]);
    expect(out.get("a")).toEqual(["b"]);
    expect(out.get("b")).toEqual(["a"]);
  });

  it("names every other member when three collide", () => {
    const out = duplicateSkills([s("a", "R1"), s("b", "R1"), s("c", "R1")]);
    expect(out.get("b")).toEqual(["a", "c"]);
  });

  it("never groups ORPHANS together", () => {
    // They answer to no route, so they duplicate nothing. Grouping them would
    // report every unbindable skill as a duplicate of every other.
    expect(duplicateSkills([s("a", null), s("b", null)]).size).toBe(0);
  });

  it("keys on the LIVE route, not on what each was bound to", () => {
    // The interesting case: two skills bound at different times to keys that
    // have since merged. Comparing stored keys would miss exactly this one.
    const out = duplicateSkills([s("old", "MERGED"), s("new", "MERGED")]);
    expect(out.get("old")).toEqual(["new"]);
  });

  it("does not mutate its input", () => {
    const input = [s("a", "R1"), s("b", "R1")];
    const snapshot = JSON.stringify(input);
    duplicateSkills(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
