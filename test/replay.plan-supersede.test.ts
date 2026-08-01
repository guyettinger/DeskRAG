import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/replay/plan.js";
import { isRepairStep, isSupersededStep } from "../src/replay/types.js";
import type { Locate, Predicate } from "../src/replay/types.js";
import type { Action, Anchor, Graph, TraceEdge, TraceNode } from "../src/trace/types.js";

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

/** A Dock click: outside the focused window's tree, so no `ax` layer, ever. */
const pointAnchor: Anchor = { point: { x: 671, y: 1017, displayId: "1" } };
/** An in-app target: carries AX descriptors. */
const axAnchor: Anchor = {
  ax: { role: "TextArea", identifier: "doc", path: "Window[0]>Group[0]>TextArea[0]" },
  point: { x: 529, y: 352, displayId: "1" },
};

const clickOn = (anchor: Anchor): Action => ({ kind: "click", anchor, button: 1, count: 1 });
const waitForApp = (app: string): Action => ({
  kind: "wait",
  until: appPred(app),
  timeoutMs: 5000,
});

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

const found: Locate = async () => ({ handle: 1, bounds: { x: 0, y: 0, w: 10, h: 10 } });

const crossApp = (actions: Action[]): Graph =>
  graph(
    [node("n0", [appPred("TextEdit")]), node("n1", [appPred("Google Chrome")])],
    [edge("e0", "n0", "n1", actions)],
  );

const planFor = async (g: Graph) =>
  buildPlan({
    graph: g,
    fromNodeId: "n0",
    toNodeId: "n1",
    observed: [appPred("TextEdit")],
    locate: found,
    runningApps: ["TextEdit", "Google Chrome"],
  });

describe("buildPlan: supersession", () => {
  /**
   * `computeBoundaries` cuts a boundary at the focus change, so the action that
   * causes the switch is BY CONSTRUCTION the last one before it. Measured: holds
   * in 4 of 4 cross-app edges in the real graph, all point-only Dock clicks.
   */
  it("suppresses a point-only FINAL action on a repaired edge", async () => {
    const plan = await planFor(crossApp([clickOn(axAnchor), clickOn(pointAnchor)]));

    const superseded = plan.steps.filter(isSupersededStep);
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.action).toEqual(clickOn(pointAnchor));
    expect(superseded[0]!.edgeId).toBe("e0");

    // The in-app click is still planned as a real action.
    const planned = plan.steps.filter((s) => !isRepairStep(s) && !isSupersededStep(s));
    expect(planned).toHaveLength(1);
  });

  /**
   * Both conditions are required. Absence of evidence never produces a silent
   * change: a final action with an AX layer cannot have been the switch, because
   * the switch target sits outside the focused window's tree by definition.
   */
  it("does NOT suppress a final action that carries an AX layer", async () => {
    const plan = await planFor(crossApp([clickOn(pointAnchor), clickOn(axAnchor)]));
    expect(plan.steps.filter(isSupersededStep)).toHaveLength(0);
  });

  /**
   * The e1/e4 shape from the real graph: a bare single Dock click with no wait
   * at all. An earlier rule anchored on the wait fired on only 2 of 4 edges.
   */
  it("fires on an edge with no wait at all", async () => {
    const plan = await planFor(crossApp([clickOn(pointAnchor)]));
    expect(plan.steps.filter(isSupersededStep)).toHaveLength(1);
    expect(plan.steps.filter(isRepairStep)).toHaveLength(1);
  });

  /**
   * The e2/e5 shape: app waits sit MID-edge, not beside the switch. They are
   * safe to drop wherever they are, because runRepair already polls that exact
   * predicate before returning.
   */
  it("drops app waits wherever they appear on the edge", async () => {
    const plan = await planFor(
      crossApp([
        clickOn(axAnchor),
        waitForApp("Google Chrome"),
        clickOn(axAnchor),
        waitForApp("Google Chrome"),
        clickOn(pointAnchor),
      ]),
    );
    const waits = plan.steps.filter(
      (s) => !isRepairStep(s) && !isSupersededStep(s) && s.action.kind === "wait",
    );
    expect(waits).toHaveLength(0);
    // Two waits plus the Dock click.
    expect(plan.steps.filter(isSupersededStep)).toHaveLength(3);
  });

  /** A wait for a DIFFERENT app is not this repair's business. */
  it("keeps a wait for an app other than the one being activated", async () => {
    const plan = await planFor(
      crossApp([waitForApp("Finder"), clickOn(axAnchor), clickOn(pointAnchor)]),
    );
    const waits = plan.steps.filter(
      (s) => !isRepairStep(s) && !isSupersededStep(s) && s.action.kind === "wait",
    );
    expect(waits).toHaveLength(1);
  });

  /**
   * The correction to shipped behaviour. The `app` predicate is on the
   * DESTINATION node, so it must hold at the edge's END — the edge's own actions
   * run in the source app. Placing the repair first posts one app's clicks and
   * keystrokes into another.
   */
  it("emits the repair AFTER the edge's other actions, never before", async () => {
    const plan = await planFor(crossApp([clickOn(axAnchor), clickOn(pointAnchor)]));
    const repairIndex = plan.steps.findIndex(isRepairStep);
    const clickIndex = plan.steps.findIndex((s) => !isRepairStep(s) && !isSupersededStep(s));
    expect(clickIndex).toBeGreaterThanOrEqual(0);
    expect(repairIndex).toBeGreaterThan(clickIndex);
    expect(repairIndex).toBe(plan.steps.length - 1);
  });

  /**
   * The measurement this design turns on. A superseded action is not posted, so
   * it must not count against the edge's AX rate — that is what takes every
   * cross-app edge from 0%/50% to 100%, and below-floor edges from 2/4 to 0/4.
   */
  it("excludes superseded actions from the edge's AX rate", async () => {
    const plan = await planFor(crossApp([clickOn(axAnchor), clickOn(pointAnchor)]));
    const b = plan.brittleness.find((x) => x.edgeId === "e0")!;
    expect(b.axRate).toBe(1);
    expect(b.belowFloor).toBe(false);
    expect(b.bound).toBe("measured");
  });

  it("leaves a same-app edge completely untouched", async () => {
    const g = graph(
      [node("n0", [appPred("TextEdit")]), node("n1", [appPred("TextEdit")])],
      [edge("e0", "n0", "n1", [clickOn(pointAnchor)])],
    );
    const plan = await planFor(g);
    expect(plan.steps.filter(isSupersededStep)).toHaveLength(0);
    expect(plan.steps.filter(isRepairStep)).toHaveLength(0);
  });
});
