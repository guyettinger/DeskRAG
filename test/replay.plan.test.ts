import { describe, expect, it } from "vitest";
import { buildPlan, edgeCost, findPath } from "../src/replay/plan.js";
import { isRepairStep, isSupersededStep } from "../src/replay/types.js";
import type { Locate, PlanStep, PlannedAction } from "../src/replay/types.js";
import type { Action, Graph, Predicate, TraceEdge, TraceNode } from "../src/trace/types.js";
import type { Keymap } from "../src/capture/env/types.js";

/** Narrow a plan step to the recorded-action kind these tests operate on. */
const asAction = (s: PlanStep): PlannedAction => {
  if (isRepairStep(s)) throw new Error("expected a PlannedAction, got a repair step");
  if (isSupersededStep(s)) throw new Error("expected a PlannedAction, got a superseded step");
  return s;
};

const us: Keymap = {
  layoutId: "com.apple.keylayout.US",
  entries: { 0: ["a", "A", "å", "Å"] },
};

const node = (id: string, predicates: Predicate[] = []): TraceNode => ({
  id,
  predicates,
  intervene: "select",
  observations: 1,
});

const clickAt = (x: number, y: number): Action => ({
  kind: "click",
  anchor: {
    ax: { role: "Button", label: "Go", path: "Window[0]>Button[0]" },
    point: { x, y, displayId: "5" },
  },
  button: 1,
  count: 1,
});

const edge = (id: string, from: string, to: string, actions: Action[], obs = 1): TraceEdge => ({
  id,
  from,
  to,
  actions,
  provenance: "recorded",
  observations: obs,
  outcomes: { attempts: 0, successes: 0 },
});

const graph = (nodes: TraceNode[], edges: TraceEdge[]): Graph => ({
  id: "g1",
  nodes,
  edges,
  slots: [],
  entry: nodes[0]!.id,
});

const found: Locate = async () => ({ handle: 1, bounds: { x: 0, y: 0, w: 10, h: 10 } });
const missing: Locate = async () => null;

describe("edgeCost", () => {
  it("prefers a well-trodden edge over a once-seen one", () => {
    const rare = edge("e1", "a", "b", [], 1);
    const common = { ...edge("e2", "a", "b", [], 20), outcomes: { attempts: 20, successes: 20 } };
    expect(edgeCost(common)).toBeLessThan(edgeCost(rare));
  });

  it("penalises an edge that keeps failing", () => {
    const good = { ...edge("e1", "a", "b", [], 10), outcomes: { attempts: 10, successes: 10 } };
    const bad = { ...edge("e2", "a", "b", [], 10), outcomes: { attempts: 10, successes: 1 } };
    expect(edgeCost(good)).toBeLessThan(edgeCost(bad));
  });

  describe("recency", () => {
    const DAY = 86_400_000;
    const NOW = Date.UTC(2026, 8, 1);
    /**
     * The dates live in a MAP beside the graph, never on the edge — which is
     * the shape of the real thing: `EdgeSource` carries `t_mono` only, and the
     * wall clock is joined from `session.started_at` at query time.
     */
    const days = new Map<string, number>();
    const dated = (e: TraceEdge, ...ages: number[]): TraceEdge => ({
      ...e,
      sources: ages.map((age, i) => {
        const sessionId = `${e.id}-s${i}`;
        days.set(sessionId, NOW - age * DAY);
        return { sessionId, tMonoStart: 0, tMonoEnd: 1000 };
      }),
    });
    const recency = {
      startedAt: (id: string) => days.get(id) ?? null,
      now: NOW,
      halfLifeMs: 14 * DAY,
    };

    it("is byte-identical to the tally when no options are given", () => {
      // The default path is the one every caller in the repo takes. Pinned
      // against the literal formula, not against itself.
      for (const obs of [0, 1, 5, 20]) {
        const e = edge("e", "a", "b", [], obs);
        expect(edgeCost(e)).toBe(1 / (1 + obs * 0.5));
      }
    });

    it("makes a stale well-trodden edge cost more than a fresh rarer one", () => {
      const stale = dated(edge("old", "a", "b", [], 4), 180, 190, 200, 210);
      const fresh = dated(edge("new", "a", "b", [], 1), 1);
      expect(edgeCost(stale)).toBeLessThan(edgeCost(fresh)); // without recency
      expect(edgeCost(stale, recency)).toBeGreaterThan(edgeCost(fresh, recency));
    });

    it("degrades to the tally on a graph lifted before provenance existed", () => {
      const e = edge("e", "a", "b", [], 6);
      expect(e.sources).toBeUndefined();
      expect(edgeCost(e, recency)).toBe(edgeCost(e));
    });

    it("keeps a whole vote for a source no date could be found for", () => {
      const e = { ...edge("e", "a", "b", [], 2), sources: [
        { sessionId: "ghost", tMonoStart: 0, tMonoEnd: 1 },
        { sessionId: "ghost2", tMonoStart: 0, tMonoEnd: 1 },
      ] };
      expect(edgeCost(e, { startedAt: () => null, now: NOW, halfLifeMs: 14 * DAY })).toBe(
        edgeCost(e),
      );
    });

    it("does not charge an edge for a recording that was deleted", () => {
      // 3 observations, 1 surviving source, dated today: the two missing
      // recordings are added back whole, so this is the un-discounted cost.
      const e = dated(edge("e", "a", "b", [], 3), 0);
      expect(edgeCost(e, recency)).toBeCloseTo(edgeCost(e), 10);
    });

    it("never lets a future-dated recording count as more than one walk", () => {
      const e = dated(edge("e", "a", "b", [], 1), -30);
      expect(edgeCost(e, recency)).toBe(edgeCost(e));
    });
  });
});

describe("findPath", () => {
  const g = graph(
    [node("n0"), node("n1"), node("n2")],
    [edge("e0", "n0", "n1", []), edge("e1", "n1", "n2", [])],
  );

  it("finds a multi-hop path", () => {
    expect(findPath(g, "n0", "n2")!.map((e) => e.id)).toEqual(["e0", "e1"]);
  });

  it("returns an empty path when already at the goal", () => {
    expect(findPath(g, "n2", "n2")).toEqual([]);
  });

  it("returns null when no path exists", () => {
    expect(findPath(g, "n2", "n0")).toBeNull();
  });

  it("does not loop forever on a self-edge", () => {
    const loop = graph(
      [node("n0"), node("n1")],
      [edge("s", "n0", "n0", []), edge("e", "n0", "n1", [])],
    );
    expect(findPath(loop, "n0", "n1")!.map((e) => e.id)).toEqual(["e"]);
  });
});

describe("buildPlan", () => {
  const g = graph([node("n0"), node("n1")], [edge("e0", "n0", "n1", [clickAt(100, 100)])]);

  it("resolves every spatial action and records the winning layer", async () => {
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [],
      locate: found,
    });
    expect(plan.steps).toHaveLength(1);
    // The fixture anchor has a label and a shallow path (depth 2) but no
    // identifier. A shallow path outranks a label, so the path rung wins.
    expect(asAction(plan.steps[0]!).resolution!.layer).toBe("path");
    expect(plan.blockers).toEqual([]);
  });

  /**
   * CORRECTED. This fixture's anchor CARRIES an AX layer, so failing to resolve
   * is no longer "a brittle point target" — it is the executor measuring that it
   * is describing a state which does not exist yet, and the plan CUTS.
   *
   * The old expectation (a point resolution at 0% AX) was the behaviour this
   * design exists to remove: the plan displayed a specific stale pixel the
   * executor genuinely would have clicked.
   */
  it("cuts rather than planning a stale point target for an ax-carrying anchor", async () => {
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [],
      locate: missing,
    });
    expect(plan.steps).toHaveLength(0);
    expect(plan.cut?.edgeId).toBe("e0");
    expect(plan.cut?.resumeAt).toBe("n0");
    expect(plan.remainder.map((r) => r.edgeId)).toEqual(["e0"]);
    // Unresolved is not the same as unresolvable: the anchor carries an AX
    // layer, so its ceiling is 100%.
    expect(plan.brittleness[0]!.bound).toBe("upper");
    expect(plan.brittleness[0]!.axRate).toBe(1);
  });

  /**
   * The other half of the same rule: an anchor with NO ax layer is already at
   * its permanent best, so it does not cut and it DOES make the edge brittle.
   */
  it("still flags a genuinely point-only edge below the floor", async () => {
    const pointOnly = graph(
      [node("n0"), node("n1")],
      [
        edge("e0", "n0", "n1", [
          { kind: "click", anchor: { point: { x: 1, y: 2, displayId: "5" } }, button: 1, count: 1 },
        ]),
      ],
    );
    const plan = await buildPlan({
      graph: pointOnly,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [],
      locate: missing,
    });
    expect(plan.cut).toBeUndefined();
    expect(asAction(plan.steps[0]!).resolution!.layer).toBe("point");
    expect(plan.brittleness[0]!.axRate).toBe(0);
    expect(plan.brittleness[0]!.belowFloor).toBe(true);
    expect(plan.brittleness[0]!.bound).toBe("measured");
  });

  it("does not flag an edge whose targets all resolve by AX", async () => {
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [],
      locate: found,
    });
    expect(plan.brittleness[0]!.axRate).toBe(1);
    expect(plan.brittleness[0]!.belowFloor).toBe(false);
  });

  it("blocks on an assertable predicate that does not hold", async () => {
    const display: Predicate = { kind: "display", args: { id: "9" }, reach: "assertable" };
    const gg = graph([node("n0"), node("n1", [display])], [edge("e0", "n0", "n1", [])]);
    const plan = await buildPlan({
      graph: gg,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [],
      locate: found,
    });
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]!.predicate).toEqual(display);
  });

  it("does not block on an achievable predicate — that is a repair, not a refusal", async () => {
    const btn: Predicate = {
      kind: "ax_exists",
      args: { role: "Button", label: "Go" },
      reach: "achievable",
    };
    const gg = graph([node("n0"), node("n1", [btn])], [edge("e0", "n0", "n1", [])]);
    const plan = await buildPlan({
      graph: gg,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [],
      locate: found,
    });
    expect(plan.blockers).toEqual([]);
  });

  it("blocks a type action when no keymap is supplied", async () => {
    const typing: Action = { kind: "type", slot: "s1", recorded: "a" };
    const gg = graph([node("n0"), node("n1")], [edge("e0", "n0", "n1", [typing])]);
    const plan = await buildPlan({
      graph: gg,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [],
      locate: found,
    });
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]!.reason).toMatch(/keymap/i);
  });

  it("blocks a type action whose text the layout cannot produce", async () => {
    const typing: Action = { kind: "type", slot: "s1", recorded: "€" };
    const gg = graph([node("n0"), node("n1")], [edge("e0", "n0", "n1", [typing])]);
    const plan = await buildPlan({
      graph: gg,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [],
      locate: found,
      keymap: us,
    });
    expect(plan.blockers[0]!.reason).toMatch(/cannot be typed/i);
  });

  it("uses a slot binding in place of the recorded value", async () => {
    const typing: Action = { kind: "type", slot: "title", recorded: "a" };
    const gg = graph([node("n0"), node("n1")], [edge("e0", "n0", "n1", [typing])]);
    const plan = await buildPlan({
      graph: gg,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [],
      locate: found,
      keymap: us,
      slotBindings: { title: "aa" },
    });
    expect(asAction(plan.steps[0]!).slotBinding).toEqual({ name: "title", value: "aa" });
  });

  it("throws when there is no path, rather than returning an empty plan", async () => {
    await expect(
      buildPlan({ graph: g, fromNodeId: "n1", toNodeId: "n0", observed: [], locate: found }),
    ).rejects.toThrow(/no path/i);
  });
});
