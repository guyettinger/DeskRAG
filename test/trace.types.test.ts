import { describe, expect, it } from "vitest";
import type {
  Action, Anchor, Graph, Path, Predicate, Slot, Trace, TraceEdge, TraceNode,
} from "../src/trace/types.js";
import { REACH_BY_KIND } from "../src/trace/types.js";

const anchor: Anchor = {
  ax: { role: "AXButton", label: "Send", path: "AXWindow>AXGroup[0]>AXButton[2]" },
  visual: { regionId: "r_1", framePhash: "0f1e2d3c4b5a6978", bbox: { x: 10, y: 20, w: 80, h: 32 } },
  point: { x: 1420, y: 386, displayId: "D1", windowRelative: { x: 220, y: 118 } },
};

const path: Path = {
  curve: [{ c1: { x: 0.33, y: -0.2 }, c2: { x: 0.66, y: -0.2 }, end: { x: 1, y: 0 } }],
  durationMs: 840,
  velocity: [0, 0.25, 0.6, 1],
  fitConfidence: 0.9,
};

describe("IR types", () => {
  it("expresses an anchor with all three layers", () => {
    expect(anchor.point.displayId).toBe("D1");
    expect(anchor.ax?.path).toContain("AXButton");
  });

  it("expresses every action kind", () => {
    const actions: Action[] = [
      { kind: "click", anchor, button: 1, count: 1 },
      { kind: "drag", from: anchor, to: anchor, path, button: 1 },
      { kind: "hover", anchor, dwellMs: 1200 },
      { kind: "scroll", anchor, delta: { x: 0, y: -450 }, steps: 6 },
      { kind: "type", slot: "recipient", recorded: "guy@example.com" },
      { kind: "chord", keys: ["cmd", "s"] },
      { kind: "wait", until: { kind: "ax_exists", args: { role: "AXSheet" }, reach: "achievable" }, timeoutMs: 3000 },
    ];
    expect(actions.map((a) => a.kind)).toHaveLength(7);
  });

  it("permits an anchor with only the required point layer", () => {
    const bare: Anchor = { point: { x: 5, y: 5, displayId: "D1" } };
    expect(bare.ax).toBeUndefined();
  });

  it("tags reach by predicate kind, achievable vs assertable", () => {
    expect(REACH_BY_KIND.ax_exists).toBe("achievable");
    expect(REACH_BY_KIND.app).toBe("achievable");
    expect(REACH_BY_KIND.display).toBe("assertable");
    expect(REACH_BY_KIND.file).toBe("assertable");
    expect(REACH_BY_KIND.permission).toBe("assertable");
  });

  it("expresses a Trace as a linear chain and a Graph as the merged form", () => {
    const node: TraceNode = {
      id: "n1", predicates: [], intervene: "select", observations: 1,
    };
    const edge: TraceEdge = {
      id: "e1", from: "n1", to: "n1", actions: [],
      provenance: "recorded", observations: 1, outcomes: { attempts: 0, successes: 0 },
    };
    const slot: Slot = { name: "recipient", samples: ["a@b.com"], secret: false };
    const trace: Trace = { sessionId: "s1", nodes: [node], edges: [edge], slots: [slot] };
    const graph: Graph = { id: "g1", nodes: [node], edges: [edge], slots: [slot], entry: "n1" };
    expect(trace.nodes[0]!.intervene).toBe("select");
    expect(graph.entry).toBe("n1");
  });

  it("defaults a predicate's reach through the lookup rather than by hand", () => {
    const p: Predicate = { kind: "window", args: { title: "New Message" }, reach: REACH_BY_KIND.window };
    expect(p.reach).toBe("achievable");
  });
});
