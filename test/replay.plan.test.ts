import { describe, expect, it } from "vitest";
import { buildPlan, edgeCost, findPath } from "../src/replay/plan.js";
import type { Locate } from "../src/replay/types.js";
import type { Action, Graph, Predicate, TraceEdge, TraceNode } from "../src/trace/types.js";
import type { Keymap } from "../src/capture/env/types.js";

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
    expect(plan.steps[0]!.resolution!.layer).toBe("path");
    expect(plan.blockers).toEqual([]);
  });

  it("computes an AX rate per edge and flags one below the floor", async () => {
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [],
      locate: missing,
    });
    expect(plan.steps[0]!.resolution!.layer).toBe("point");
    expect(plan.brittleness[0]!.axRate).toBe(0);
    expect(plan.brittleness[0]!.belowFloor).toBe(true);
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
    expect(plan.steps[0]!.slotBinding).toEqual({ name: "title", value: "aa" });
  });

  it("throws when there is no path, rather than returning an empty plan", async () => {
    await expect(
      buildPlan({ graph: g, fromNodeId: "n1", toNodeId: "n0", observed: [], locate: found }),
    ).rejects.toThrow(/no path/i);
  });
});
