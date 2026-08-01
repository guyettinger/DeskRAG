import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/replay/plan.js";
import { isRepairStep } from "../src/replay/types.js";
import type { Locate, Predicate } from "../src/replay/types.js";
import type { Action, Graph, TraceEdge, TraceNode } from "../src/trace/types.js";

const appPred = (app: string): Predicate => ({
  kind: "app",
  args: { app },
  reach: "achievable",
});

const node = (id: string, predicates: Predicate[] = []): TraceNode => ({
  id,
  predicates,
  intervene: "select",
  observations: 1,
});

const click: Action = {
  kind: "click",
  anchor: { point: { x: 10, y: 20, displayId: "1" } },
  button: 1,
  count: 1,
};

const edge = (id: string, from: string, to: string, actions: Action[] = [click]): TraceEdge => ({
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

const found: Locate = async () => ({ handle: 1, bounds: { x: 0, y: 0, w: 10, h: 10 } });

describe("buildPlan: app activation repair", () => {
  const g = graph(
    [node("n0", [appPred("TextEdit")]), node("n1", [appPred("Google Chrome")])],
    [edge("e0", "n0", "n1")],
  );

  it("inserts a repair step when the destination app is not frontmost", async () => {
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [appPred("TextEdit")],
      locate: found,
      runningApps: ["TextEdit", "Google Chrome"],
    });
    const repairs = plan.steps.filter(isRepairStep);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ repair: "activate", app: "Google Chrome", launch: false });
    expect(repairs[0]!.reason).toMatch(/Google Chrome/);
  });

  /**
   * CORRECTED from "before". The `app` predicate being repaired lives on the
   * DESTINATION node, so it has to hold when the edge FINISHES — the edge's own
   * actions run in the source app. Activating first posted one application's
   * clicks and keystrokes into another.
   */
  it("puts the repair AFTER the edge's actions", async () => {
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [appPred("TextEdit")],
      locate: found,
      runningApps: ["TextEdit", "Google Chrome"],
    });
    expect(isRepairStep(plan.steps[plan.steps.length - 1]!)).toBe(true);
    expect(isRepairStep(plan.steps[0]!)).toBe(false);
  });

  it("inserts nothing when the app already holds", async () => {
    const same = graph(
      [node("n0", [appPred("TextEdit")]), node("n1", [appPred("TextEdit")])],
      [edge("e0", "n0", "n1")],
    );
    const plan = await buildPlan({
      graph: same,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [appPred("TextEdit")],
      locate: found,
      runningApps: ["TextEdit"],
    });
    expect(plan.steps.filter(isRepairStep)).toHaveLength(0);
  });

  it("blocks when the app is not running and launching was not allowed", async () => {
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [appPred("TextEdit")],
      locate: found,
      runningApps: ["TextEdit"],
    });
    expect(plan.steps.filter(isRepairStep)).toHaveLength(0);
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]!.reason).toMatch(/Google Chrome is not running/);
  });

  it("turns that blocker into a launching repair step under allowLaunch", async () => {
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [appPred("TextEdit")],
      locate: found,
      runningApps: ["TextEdit"],
      allowLaunch: true,
    });
    expect(plan.blockers).toHaveLength(0);
    const repairs = plan.steps.filter(isRepairStep);
    expect(repairs[0]).toMatchObject({ app: "Google Chrome", launch: true });
  });

  // A path that stays in one app must not re-activate it at every hop.
  it("collapses consecutive repairs for the same app", async () => {
    const chain = graph(
      [
        node("n0", [appPred("TextEdit")]),
        node("n1", [appPred("Chrome")]),
        node("n2", [appPred("Chrome")]),
      ],
      [edge("e0", "n0", "n1"), edge("e1", "n1", "n2")],
    );
    const plan = await buildPlan({
      graph: chain,
      fromNodeId: "n0",
      toNodeId: "n2",
      observed: [appPred("TextEdit")],
      locate: found,
      runningApps: ["TextEdit", "Chrome"],
    });
    expect(plan.steps.filter(isRepairStep)).toHaveLength(1);
  });

  // Repairs are not targets; a plan does not get less brittle by adding them.
  /**
   * CORRECTED from "axRate is 0". This edge's only action IS the recorded
   * switch — a point-only final click — so the repair supersedes it and it is
   * never posted. An action that will not be posted must not count against the
   * edge's AX rate, which is precisely what takes cross-app edges from 0%/50%
   * to 100% and below-floor edges from 2/4 to 0/4 on the real graph.
   */
  it("excludes the superseded switch from axRate, leaving nothing brittle", async () => {
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [appPred("TextEdit")],
      locate: found,
      runningApps: ["TextEdit", "Google Chrome"],
    });
    expect(plan.brittleness[0]!.axRate).toBe(1);
    expect(plan.brittleness[0]!.belowFloor).toBe(false);
  });

  it("inserts no repair when runningApps was not supplied", async () => {
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [appPred("TextEdit")],
      locate: found,
    });
    expect(plan.steps.filter(isRepairStep)).toHaveLength(0);
    expect(plan.blockers).toHaveLength(0);
  });
});
