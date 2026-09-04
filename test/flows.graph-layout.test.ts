import { describe, expect, it } from "vitest";
import type { GraphDTO, GraphEdgeDTO, GraphNodeDTO } from "../app/src/shared/types.js";
import {
  CARD_H,
  CARD_W,
  GAP_X,
  GAP_Y,
  layoutGraph,
} from "../app/src/renderer/src/screens/graph-layout.js";
import { stabilityOf } from "../src/trace/stability.js";

const n = (id: string, rank: number): GraphNodeDTO => ({
  id,
  label: id,
  chip: id,
  observations: 1,
  intervene: "select",
  rank,
  predicates: [],
  locatable: true,
  sources: [],
  stability: stabilityOf([]),
});

const e = (id: string, from: string, to: string, back = false): GraphEdgeDTO => ({
  id,
  from,
  to,
  actions: [],
  back,
  provenance: "recorded",
  observations: 1,
  sources: [],
  stability: stabilityOf([]),
});

const g = (nodes: GraphNodeDTO[], edges: GraphEdgeDTO[]): GraphDTO => ({
  id: "default",
  entry: nodes[0]?.id ?? "",
  nodes,
  edges,
  slots: [],
});

describe("layoutGraph", () => {
  it("puts rank on the Y axis, so the graph flows downward", () => {
    const out = layoutGraph(
      g([n("a", 0), n("b", 1), n("c", 2)], [e("e1", "a", "b"), e("e2", "b", "c")]),
    );
    const y = (id: string): number => out.at.get(id)!.y;
    expect(y("a")).toBe(0);
    expect(y("b")).toBe(CARD_H + GAP_Y);
    expect(y("c")).toBe(2 * (CARD_H + GAP_Y));
    // A chain occupies ONE column.
    expect(new Set(out.nodes.map((p) => p.x)).size).toBe(1);
  });

  it("spreads siblings across X within their rank", () => {
    const out = layoutGraph(
      g([n("a", 0), n("b", 1), n("c", 1)], [e("e1", "a", "b"), e("e2", "a", "c")]),
    );
    expect(out.at.get("b")!.y).toBe(out.at.get("c")!.y);
    expect(Math.abs(out.at.get("b")!.x - out.at.get("c")!.x)).toBe(CARD_W + GAP_X);
  });

  it("orders a rank by its parents' position, not by array order", () => {
    // `left` feeds `l`, `right` feeds `r`, but rank 2 lists r BEFORE l. Array
    // order would cross both wires; barycenter must not.
    const out = layoutGraph(
      g(
        [n("root", 0), n("left", 1), n("right", 1), n("r", 2), n("l", 2)],
        [
          e("e1", "root", "left"),
          e("e2", "root", "right"),
          e("e3", "left", "l"),
          e("e4", "right", "r"),
        ],
      ),
    );
    const x = (id: string): number => out.at.get(id)!.x;
    expect(x("left") < x("right")).toBe(true);
    expect(x("l") < x("r")).toBe(true);
  });

  it("is stable across repeated calls — the location poll re-renders constantly", () => {
    const graph = g(
      [n("a", 0), n("b", 1), n("c", 1), n("d", 2)],
      [e("e1", "a", "b"), e("e2", "a", "c"), e("e3", "b", "d")],
    );
    expect(layoutGraph(graph).nodes).toEqual(layoutGraph(graph).nodes);
  });

  it("bows a back edge sideways rather than down through the cards it passes", () => {
    const out = layoutGraph(g([n("a", 0), n("b", 1)], [e("e1", "a", "b"), e("e2", "b", "a", true)]));
    const forward = out.edges.find((p) => p.edge.id === "e1")!;
    const back = out.edges.find((p) => p.edge.id === "e2")!;
    expect(back.d).not.toBe(forward.d);
    // The bow's control points leave the column the cards occupy.
    const xs = [...back.d.matchAll(/-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?/g)].map((m) =>
      Number(m[0].split(/\s+/)[0]),
    );
    expect(Math.max(...xs)).toBeGreaterThan(CARD_W);
  });

  it("draws a self-loop with vertical extent, not a flat stub", () => {
    // A revisited state collapses into a loop on itself. Both endpoints
    // coincide, so an out-and-back cubic degenerates into a horizontal line
    // drawn over itself — measured on the real graph as a dashed stub ending in
    // mid-air. The loop must actually enclose area.
    const out = layoutGraph(g([n("a", 0)], [e("self", "a", "a", true)]));
    const d = out.edges[0]!.d;
    const ys = [...d.matchAll(/-?\d+(?:\.\d+)?\s+(-?\d+(?:\.\d+)?)/g)].map((m) =>
      Number(m[1]),
    );
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0);
    const xs = [...d.matchAll(/(-?\d+(?:\.\d+)?)\s+-?\d+(?:\.\d+)?/g)].map((m) =>
      Number(m[1]),
    );
    expect(Math.max(...xs)).toBeGreaterThan(CARD_W);
  });

  it("places an orphan rather than dropping it", () => {
    // rankNodes gives an unreachable node rank 0. Visible and fixable beats
    // silently absent.
    const out = layoutGraph(g([n("a", 0), n("orphan", 0)], []));
    expect(out.nodes).toHaveLength(2);
    expect(out.at.get("orphan")).toBeDefined();
  });

  it("sizes the world to fit every card plus a margin", () => {
    const out = layoutGraph(g([n("a", 0), n("b", 1)], [e("e1", "a", "b")]));
    expect(out.width).toBeGreaterThanOrEqual(CARD_W);
    expect(out.height).toBeGreaterThanOrEqual(2 * CARD_H + GAP_Y);
  });
});
