import { describe, expect, it } from "vitest";
import { executePlan } from "../src/replay/execute.js";
import type {
  Actuator,
  AxDescriptor,
  AxObservation,
  Plan,
  Predicate,
  Rect,
  UIElement,
  Vec2,
} from "../src/replay/types.js";
import type { Graph, TraceEdge, TraceNode } from "../src/trace/types.js";
import type { Keymap } from "../src/capture/env/types.js";

const keymap: Keymap = {
  layoutId: "com.apple.keylayout.US",
  entries: { 0: ["a", "A", "å", "Å"] },
};

class FakeActuator implements Actuator {
  posted: string[] = [];
  constructor(private readonly observation: AxObservation) {}
  async dump(): Promise<AxObservation> {
    return this.observation;
  }
  async runningApps(): Promise<string[]> {
    return ["TextEdit"];
  }
  async activate(): Promise<"activated"> {
    this.posted.push("activate");
    return "activated";
  }
  async locate(d: AxDescriptor): Promise<{ handle: number; bounds: Rect } | null> {
    return d.identifier === "target"
      ? { handle: 1, bounds: { x: 100, y: 100, w: 10, h: 10 } }
      : null;
  }
  async moveTo(_p: Vec2): Promise<void> {
    this.posted.push("move");
  }
  async click(): Promise<void> {
    this.posted.push("click");
  }
  async dragPath(): Promise<void> {
    this.posted.push("drag");
  }
  async scroll(): Promise<void> {
    this.posted.push("scroll");
  }
  async key(): Promise<void> {
    this.posted.push("key");
  }
}

const el = (label: string): UIElement =>
  ({ role: "Button", label, x: 0, y: 0, w: 10, h: 10 }) as UIElement;

const obs = (app: string, labels: string[]): AxObservation => ({
  app,
  elements: labels.map(el),
});

const node = (id: string, predicates: Predicate[]): TraceNode => ({
  id,
  predicates,
  intervene: "select",
  observations: 1,
});
const edge = (id: string, from: string, to: string): TraceEdge => ({
  id,
  from,
  to,
  actions: [],
  provenance: "recorded",
  observations: 1,
  outcomes: { attempts: 0, successes: 0 },
});

const appPred = (app: string): Predicate => ({ kind: "app", args: { app }, reach: "achievable" });
const existsPred = (label: string): Predicate => ({
  kind: "ax_exists",
  args: { role: "Button", label },
  reach: "achievable",
});

const graph = (nodes: TraceNode[], edges: TraceEdge[]): Graph => ({
  id: "g1",
  nodes,
  edges,
  slots: [],
  entry: "n0",
});

const plan = (steps: Plan["steps"], over: Partial<Plan> = {}): Plan => ({
  id: "p1",
  graphId: "g1",
  from: "n0",
  to: "n1",
  steps,
  blockers: [],
  brittleness: [{ edgeId: "e0", axRate: 1, belowFloor: false, bound: "measured" }],
  remainder: [],
  ...over,
});

const clickStep = (): Plan["steps"][number] => ({
  edgeId: "e0",
  action: {
    kind: "click",
    anchor: { point: { x: 1, y: 2, displayId: "1" } },
    button: 1,
    count: 1,
  },
  resolution: { layer: "point", point: { x: 1, y: 2 }, confidence: 0.3, attempts: [] },
});

describe("executePlan: node-boundary verification", () => {
  const g = graph(
    [node("n0", [appPred("TextEdit")]), node("n1", [appPred("TextEdit"), existsPred("Saved")])],
    [edge("e0", "n0", "n1")],
  );

  it("continues when the destination node's predicates hold afterwards", async () => {
    const actuator = new FakeActuator(obs("TextEdit", ["Saved"]));
    const out = await executePlan(plan([clickStep()]), { graph: g, actuator, keymap });
    expect(out.completed).toBe(true);
    expect(actuator.posted).toContain("click");
  });

  /**
   * The executor spec promised verification at every node boundary and the code
   * never did it. Without it a segment can drift and the NEXT segment re-plans
   * from a state the executor only believes it is in.
   */
  it("aborts naming the predicate when the destination state did not arrive", async () => {
    const actuator = new FakeActuator(obs("TextEdit", ["Unchanged"]));
    const out = await executePlan(plan([clickStep()]), { graph: g, actuator, keymap });
    expect(out.completed).toBe(false);
    expect(out.failure?.reason).toContain("Saved");
  });

  it("treats a superseded step as a no-op that posts nothing", async () => {
    const actuator = new FakeActuator(obs("TextEdit", ["Saved"]));
    const out = await executePlan(
      plan([
        {
          superseded: "activate",
          edgeId: "e0",
          action: {
            kind: "click",
            anchor: { point: { x: 671, y: 1017, displayId: "1" } },
            button: 1,
            count: 1,
          },
          reason: "activating TextEdit replaces this",
        },
      ]),
      { graph: g, actuator, keymap },
    );
    expect(out.completed).toBe(true);
    expect(actuator.posted).not.toContain("click");
    expect(actuator.posted).not.toContain("move");
  });
});

describe("executePlan: drag endpoints", () => {
  const g = graph([node("n0", []), node("n1", [])], [edge("e0", "n0", "n1")]);

  const dragStep = (toIdentifier: string): Plan["steps"][number] => ({
    edgeId: "e0",
    action: {
      kind: "drag",
      from: { point: { x: 0, y: 0, displayId: "1" } },
      to: {
        ax: { role: "Button", identifier: toIdentifier, path: "Window[0]>Button[0]" },
        point: { x: 500, y: 500, displayId: "1" },
      },
      path: { curve: [], durationMs: 100, velocity: [0, 1], fitConfidence: 1 },
      button: 1,
    },
    resolution: { layer: "point", point: { x: 0, y: 0 }, confidence: 0.3, attempts: [] },
  });

  it("resolves the `to` endpoint against the ladder at execution time", async () => {
    const actuator = new FakeActuator(obs("TextEdit", []));
    const out = await executePlan(plan([dragStep("target")]), { graph: g, actuator, keymap });
    expect(out.completed).toBe(true);
    expect(actuator.posted).toContain("drag");
  });

  /**
   * Never a fallback to the recorded coordinate: that is exactly the drift the
   * IR forbids, and a drag that ends somewhere else is not a recoverable error.
   */
  it("aborts when the `to` endpoint no longer resolves", async () => {
    const actuator = new FakeActuator(obs("TextEdit", []));
    const out = await executePlan(plan([dragStep("gone")]), { graph: g, actuator, keymap });
    expect(out.completed).toBe(false);
    expect(actuator.posted).not.toContain("drag");
  });
});
