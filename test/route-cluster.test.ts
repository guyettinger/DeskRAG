import { describe, expect, it } from "vitest";
import {
  clusterRoutes,
  compatible,
  insertionGap,
  jaccard,
  lcsLength,
  lcsRatio,
  DEFAULT_CLUSTER_RULE,
  type RouteShape,
} from "../app/src/main/route-cluster.js";

/** A route, named by its places, walked `count` times. */
const r = (count: number, ...places: string[]): RouteShape => ({
  key: places.join(" → "),
  places,
  count,
});

describe("lcsLength", () => {
  it("is the length of the longer sequence when one contains the other", () => {
    expect(lcsLength(["A", "B"], ["A", "X", "B"])).toBe(2);
  });

  it("is order-sensitive — a swap is not a containment", () => {
    expect(lcsLength(["A", "B"], ["B", "A"])).toBe(1);
  });

  it("handles empty on either side", () => {
    expect(lcsLength([], ["A"])).toBe(0);
    expect(lcsLength(["A"], [])).toBe(0);
  });
});

describe("insertionGap", () => {
  it("counts the extra hops when one walk contains the other", () => {
    expect(insertionGap(["A", "B", "C"], ["A", "B", "Finder", "C"])).toBe(1);
  });

  it("is symmetric", () => {
    expect(insertionGap(["A", "B", "Finder", "C"], ["A", "B", "C"])).toBe(1);
  });

  it("is zero for identical walks", () => {
    expect(insertionGap(["A", "B"], ["A", "B"])).toBe(0);
  });

  it("returns null — not a big number — when neither contains the other", () => {
    // "Not the same walk" is a different fact from "far apart", and smoothing
    // the two together is how a threshold starts absorbing unrelated work.
    expect(insertionGap(["A", "B"], ["B", "A"])).toBeNull();
    expect(insertionGap(["A", "B"], ["A", "C"])).toBeNull();
  });
});

describe("jaccard and lcsRatio", () => {
  it("jaccard ignores order, lcsRatio does not", () => {
    expect(jaccard(["A", "B"], ["B", "A"])).toBe(1);
    expect(lcsRatio(["A", "B"], ["B", "A"])).toBe(0.5);
  });

  it("both are 1 for identical sequences", () => {
    expect(jaccard(["A", "B"], ["A", "B"])).toBe(1);
    expect(lcsRatio(["A", "B"], ["A", "B"])).toBe(1);
  });
});

describe("compatible", () => {
  it("exact merges nothing that is not byte-identical — today's behaviour", () => {
    const rule = { kind: "exact" } as const;
    expect(compatible(["A", "B"], ["A", "B"], rule)).toBe(true);
    expect(compatible(["A", "B"], ["A", "B", "C"], rule)).toBe(false);
  });

  it("insertions admits a DETOUR, which costs two — measured, not assumed", () => {
    // The real shape, from `npm run probe:routes` on a six-recording corpus:
    // a side trip through Finder inserts Finder AND a second TextEdit, because
    // the walk comes back. A budget of 1 merges nothing here, and reads as "the
    // rule does not fire" rather than "the rule is off by one".
    const straight = ["Calculator", "TextEdit", "Electron"];
    const detour = ["Calculator", "TextEdit", "Finder", "TextEdit", "Electron"];
    expect(insertionGap(straight, detour)).toBe(2);
    expect(compatible(straight, detour, DEFAULT_CLUSTER_RULE)).toBe(true);
    expect(compatible(straight, detour, { kind: "insertions", budget: 1 })).toBe(false);
  });

  it("refuses a TRUNCATION: a walk that stopped early is not the same work", () => {
    // Containment alone cannot tell this from a detour, and folding it in would
    // publish a route as walked N times when one of the N never finished.
    expect(insertionGap(["A", "B"], ["A", "B", "C"])).toBe(1);
    expect(compatible(["A", "B"], ["A", "B", "C"], DEFAULT_CLUSTER_RULE)).toBe(false);
  });

  it("refuses a walk that started somewhere else", () => {
    expect(compatible(["A", "B", "C"], ["Z", "A", "B", "C"], DEFAULT_CLUSTER_RULE)).toBe(false);
  });

  it("insertions still refuses a third inserted hop", () => {
    expect(compatible(["A", "B"], ["A", "X", "Y", "Z", "B"], DEFAULT_CLUSTER_RULE)).toBe(false);
  });

  it("insertions refuses a REORDER at any budget — same places is not same work", () => {
    expect(compatible(["A", "B"], ["B", "A"], { kind: "insertions", budget: 9 })).toBe(false);
  });
});

describe("clusterRoutes", () => {
  it("collapses the same work walked with one extra hop into ONE route", () => {
    // The acceptance test from docs/research/optimal-path.md, P1.
    const out = clusterRoutes([
      r(1, "TextEdit", "Chrome", "github.com"),
      r(1, "TextEdit", "Finder", "TextEdit", "Chrome", "github.com"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.members).toHaveLength(2);
  });

  it("names the cluster after the FIRST route given, which is the most-walked", () => {
    const out = clusterRoutes([r(5, "A", "B"), r(1, "A", "X", "B")]);
    expect(out[0]!.canonical.count).toBe(5);
    expect(out[0]!.canonical.key).toBe("A → B");
  });

  it("discloses the variant and how many hops it added", () => {
    const out = clusterRoutes([r(2, "A", "B"), r(1, "A", "Finder", "B")]);
    expect(out[0]!.variants).toEqual([{ key: "A → Finder → B", count: 1, extraHops: 1 }]);
  });

  it("leaves a route that shares nothing alone", () => {
    const out = clusterRoutes([r(1, "A", "B"), r(1, "P", "Q")]);
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.variants.length === 0)).toBe(true);
  });

  it("does not CHAIN: A~B and B~C never puts A and C together", () => {
    // Single-linkage would merge all three, and nothing ever compared A to C.
    // Spaced by the default budget so each neighbour pair is admissible and the
    // ends are not.
    const out = clusterRoutes([
      r(1, "P", "Z"),
      r(1, "P", "a", "b", "Z"),
      r(1, "P", "a", "b", "c", "d", "Z"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.members.map((m) => m.key)).toEqual(["P → Z", "P → a → b → Z"]);
    expect(out[1]!.members.map((m) => m.key)).toEqual(["P → a → b → c → d → Z"]);
  });

  it("DECLINES when a route fits two clusters, and says which wanted it", () => {
    // `trace/identity.ts` refuses to merge on an ambiguous match; so does this.
    // Two detours from P to Q that took different middles — neither contains
    // the other — and a direct walk that is a near-miss of BOTH.
    const out = clusterRoutes([r(1, "P", "a", "Q"), r(1, "P", "b", "Q"), r(1, "P", "Q")]);
    expect(out).toHaveLength(3);
    expect(out[2]!.members.map((m) => m.key)).toEqual(["P → Q"]);
    expect(out[0]!.declined).toEqual(["P → Q"]);
    expect(out[1]!.declined).toEqual(["P → Q"]);
  });

  it("PARTITIONS: every input lands in exactly one cluster", () => {
    // This is what keeps `bindHabit`'s strict-majority proof true. Nothing else
    // enforces it, so it is asserted here rather than assumed.
    const input = [
      r(3, "A", "B"),
      r(1, "A", "X", "B"),
      r(2, "P", "Q"),
      r(1, "B"),
      r(1, "B", "C"),
    ];
    const out = clusterRoutes(input);
    const seen = out.flatMap((c) => c.members.map((m) => m.key));
    expect(seen.slice().sort()).toEqual(input.map((i) => i.key).sort());
    expect(new Set(seen).size).toBe(input.length);
  });

  it("under the exact rule, reproduces today's grouping exactly", () => {
    const input = [r(1, "A", "B"), r(1, "A", "X", "B")];
    const out = clusterRoutes(input, { kind: "exact" });
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.members.length === 1)).toBe(true);
  });

  it("returns the same answer twice and mutates neither the input nor its arrays", () => {
    const input = [r(2, "A", "B"), r(1, "A", "X", "B")];
    const snapshot = JSON.stringify(input);
    const a = clusterRoutes(input);
    const b = clusterRoutes(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("is empty for no routes", () => {
    expect(clusterRoutes([])).toEqual([]);
  });
});
