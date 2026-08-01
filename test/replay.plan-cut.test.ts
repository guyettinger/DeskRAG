import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/replay/plan.js";
import { canArm } from "../src/replay/execute.js";
import type { AxDescriptor, Locate, Predicate } from "../src/replay/types.js";
import type { Action, Anchor, Graph, TraceEdge, TraceNode } from "../src/trace/types.js";

const appPred = (app: string): Predicate => ({
  kind: "app",
  args: { app },
  reach: "achievable",
});
/** Assertable: no UI action can produce it, so it can only ever gate. */
const displayPred = (id: string): Predicate => ({
  kind: "display",
  args: { id, w: 100, h: 100 },
  reach: "assertable",
});

const node = (id: string, predicates: Predicate[] = []): TraceNode => ({
  id,
  predicates,
  intervene: "select",
  observations: 1,
});

const pointAnchor: Anchor = { point: { x: 671, y: 1017, displayId: "1" } };
const axAnchor = (identifier: string): Anchor => ({
  ax: { role: "Button", identifier, path: "Window[0]>Button[0]" },
  point: { x: 10, y: 20, displayId: "1" },
});

const clickOn = (anchor: Anchor): Action => ({ kind: "click", anchor, button: 1, count: 1 });

const edge = (id: string, from: string, to: string, actions: Action[]): TraceEdge => ({
  id,
  from,
  to,
  actions,
  provenance: "recorded",
  observations: 1,
  outcomes: { attempts: 0, successes: 0 },
});

const graph = (nodes: TraceNode[], edges: TraceEdge[]): Graph => ({
  id: "g1",
  nodes,
  edges,
  slots: [],
  entry: nodes[0]!.id,
});

/** Resolves only the identifiers named; everything else is "gone". */
const locateOnly =
  (...ids: string[]): Locate =>
  async (d: AxDescriptor) =>
    d.identifier !== undefined && ids.includes(d.identifier)
      ? { handle: 1, bounds: { x: 10, y: 20, w: 10, h: 10 } }
      : null;

const chain = graph(
  [
    node("n0", [appPred("TextEdit")]),
    node("n1", [appPred("TextEdit")]),
    node("n2", [appPred("TextEdit")]),
  ],
  [
    edge("e0", "n0", "n1", [clickOn(axAnchor("a"))]),
    edge("e1", "n1", "n2", [clickOn(axAnchor("b"))]),
  ],
);

const build = (locate: Locate, g: Graph = chain, toNodeId = "n2") =>
  buildPlan({ graph: g, fromNodeId: "n0", toNodeId, observed: [appPred("TextEdit")], locate });

describe("buildPlan: the greedy cut", () => {
  it("does not cut when every anchor resolves — one segment, exactly as today", async () => {
    const plan = await build(locateOnly("a", "b"));
    expect(plan.cut).toBeUndefined();
    expect(plan.remainder).toEqual([]);
    expect(plan.steps).toHaveLength(2);
  });

  /**
   * The executor MEASURING that it is describing a state which does not exist
   * yet: the anchor carries descriptors, so it should resolve — and does not.
   */
  it("cuts at the first ax-carrying anchor that reaches no AX rung", async () => {
    const plan = await build(locateOnly("a"));
    expect(plan.cut?.edgeId).toBe("e1");
    expect(plan.cut?.resumeAt).toBe("n1");
    expect(plan.cut?.attempts.length).toBeGreaterThan(0);
    expect(plan.steps).toHaveLength(1);
    expect(plan.remainder.map((r) => r.edgeId)).toEqual(["e1"]);
  });

  /**
   * The cut is at an EDGE boundary. A node boundary is the only place the world
   * can be re-observed and verified; stopping between one edge's actions leaves
   * the run in a state no node describes.
   */
  it("moves the WHOLE failing edge to the remainder, never half of it", async () => {
    const g = graph(
      [node("n0", [appPred("TextEdit")]), node("n1", [appPred("TextEdit")])],
      [edge("e0", "n0", "n1", [clickOn(axAnchor("a")), clickOn(axAnchor("gone"))])],
    );
    const plan = await build(locateOnly("a"), g, "n1");
    expect(plan.steps).toHaveLength(0);
    expect(plan.remainder.map((r) => r.edgeId)).toEqual(["e0"]);
    expect(plan.cut?.resumeAt).toBe("n0");
  });

  /** A point-only anchor is at its permanent best; deferring cannot improve it. */
  it("does not cut on a point-only anchor", async () => {
    const g = graph(
      [node("n0", [appPred("TextEdit")]), node("n1", [appPred("TextEdit")])],
      [edge("e0", "n0", "n1", [clickOn(pointAnchor)])],
    );
    const plan = await build(locateOnly(), g, "n1");
    expect(plan.cut).toBeUndefined();
    expect(plan.steps).toHaveLength(1);
  });

  it("discloses the remainder without resolving it", async () => {
    const plan = await build(locateOnly("a"));
    const r = plan.remainder[0]!;
    expect(r.toNodeId).toBe("n2");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.kind).toBe("click");
    expect(r.actions[0]!.descriptors).toEqual(["identifier", "path"]);
    expect(r.actions[0]!.recordedPoint).toEqual({ x: 10, y: 20 });
  });

  it("marks segment brittleness measured and remainder brittleness upper", async () => {
    const plan = await build(locateOnly("a"));
    expect(plan.brittleness.find((b) => b.edgeId === "e0")!.bound).toBe("measured");
    const rem = plan.brittleness.find((b) => b.edgeId === "e1")!;
    expect(rem.bound).toBe("upper");
    // The anchor carries an `ax` layer, so its ceiling is 100% — it has simply
    // not been resolved yet, which is a different thing from resolving badly.
    expect(rem.axRate).toBe(1);
  });

  /**
   * A deductive ceiling, not a forecast: an anchor with no `ax` layer can never
   * reach an AX rung, at any time, by any mechanism. Without this a reviewer can
   * arm segment 1, change the real world, and only then discover segment 2 can
   * never arm — a dead end reached by acting, the worst outcome available here.
   */
  it("bounds a point-only remainder edge below the floor, and refuses to arm", async () => {
    const g = graph(
      [
        node("n0", [appPred("TextEdit")]),
        node("n1", [appPred("TextEdit")]),
        node("n2", [appPred("TextEdit")]),
        node("n3", [appPred("TextEdit")]),
      ],
      [
        edge("e0", "n0", "n1", [clickOn(axAnchor("a"))]),
        edge("e1", "n1", "n2", [clickOn(axAnchor("gone"))]),
        edge("e2", "n2", "n3", [clickOn(pointAnchor)]),
      ],
    );
    const plan = await build(locateOnly("a"), g, "n3");
    expect(plan.remainder.map((r) => r.edgeId)).toEqual(["e1", "e2"]);
    const e2 = plan.brittleness.find((b) => b.edgeId === "e2")!;
    expect(e2.bound).toBe("upper");
    expect(e2.axRate).toBe(0);
    expect(e2.belowFloor).toBe(true);
    expect(canArm(plan).ok).toBe(false);
  });

  /**
   * `assertable` means no UI action can produce it, so checking a remainder node
   * against the PRESENT observation is valid — an unreachable goal is knowable
   * before anything at all is posted.
   */
  it("raises a remainder-scoped blocker and refuses to arm on it", async () => {
    const g = graph(
      [
        node("n0", [appPred("TextEdit")]),
        node("n1", [appPred("TextEdit")]),
        node("n2", [appPred("TextEdit")]),
        node("n3", [appPred("TextEdit"), displayPred("D9")]),
      ],
      [
        edge("e0", "n0", "n1", [clickOn(axAnchor("a"))]),
        edge("e1", "n1", "n2", [clickOn(axAnchor("gone"))]),
        edge("e2", "n2", "n3", [clickOn(axAnchor("c"))]),
      ],
    );
    const plan = await build(locateOnly("a"), g, "n3");
    const blocked = plan.blockers.find((b) => b.scope === "remainder");
    expect(blocked).toBeDefined();
    expect(canArm(plan).ok).toBe(false);
  });
});
