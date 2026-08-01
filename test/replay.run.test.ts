import { describe, expect, it } from "vitest";
import { executeRun } from "../src/replay/run.js";
import type {
  Actuator,
  AxDescriptor,
  AxObservation,
  Plan,
  Predicate,
  Rect,
  UIElement,
} from "../src/replay/types.js";
import type { Action, Graph, TraceEdge, TraceNode } from "../src/trace/types.js";
import type { Keymap } from "../src/capture/env/types.js";

const keymap: Keymap = {
  layoutId: "com.apple.keylayout.US",
  entries: { 0: ["a", "A", "å", "Å"] },
};

const el = (label: string): UIElement =>
  ({ role: "Button", label, x: 0, y: 0, w: 10, h: 10 }) as UIElement;

/**
 * A desktop that CHANGES WHEN ACTED UPON: each click advances the world one
 * state. Modelling it as a fixed script of dumps instead would feed stale
 * observations to node-boundary verification, which is exactly the mistake the
 * loop exists to prevent.
 *
 * `resolvable` is asked per world state, so what an anchor can resolve to
 * depends on where the run currently is — which is how a cut, and therefore a
 * second segment, actually arises.
 */
class ScriptedActuator implements Actuator {
  posted: string[] = [];
  dumps = 0;
  world = 0;
  /** Dump index at which something ELSE moves the world, simulating drift. */
  rewindOnDump = -1;
  constructor(
    private readonly states: AxObservation[],
    private readonly resolvable: (d: AxDescriptor, world: number) => boolean,
  ) {}
  async dump(): Promise<AxObservation> {
    this.dumps++;
    if (this.dumps === this.rewindOnDump) this.world = 0;
    return this.states[Math.min(this.world, this.states.length - 1)]!;
  }
  async runningApps(): Promise<string[]> {
    return ["TextEdit"];
  }
  async activate(): Promise<"activated"> {
    this.posted.push("activate");
    return "activated";
  }
  async locate(d: AxDescriptor): Promise<{ handle: number; bounds: Rect } | null> {
    return this.resolvable(d, this.world)
      ? { handle: 1, bounds: { x: 0, y: 0, w: 10, h: 10 } }
      : null;
  }
  async moveTo(): Promise<void> {
    this.posted.push("move");
  }
  async click(): Promise<void> {
    this.posted.push("click");
    this.world++;
  }
  async dragPath(): Promise<void> {}
  async scroll(): Promise<void> {}
  async key(): Promise<void> {}
}

const appPred = (app: string): Predicate => ({ kind: "app", args: { app }, reach: "achievable" });
const existsPred = (label: string): Predicate => ({
  kind: "ax_exists",
  args: { role: "Button", label },
  reach: "achievable",
});

const node = (id: string, predicates: Predicate[]): TraceNode => ({
  id,
  predicates,
  intervene: "select",
  observations: 1,
});

const clickAction = (identifier: string): Action => ({
  kind: "click",
  anchor: {
    ax: { role: "Button", identifier, path: "Window[0]>Button[0]" },
    point: { x: 5, y: 5, displayId: "1" },
  },
  button: 1,
  count: 1,
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

/** n0 -e0-> n1 -e1-> n2, each node distinguished by exactly one button. */
const graph: Graph = {
  id: "g1",
  nodes: [
    node("n0", [appPred("TextEdit"), existsPred("Start")]),
    node("n1", [appPred("TextEdit"), existsPred("Middle")]),
    node("n2", [appPred("TextEdit"), existsPred("End")]),
  ],
  edges: [
    edge("e0", "n0", "n1", [clickAction("first")]),
    edge("e1", "n1", "n2", [clickAction("second")]),
  ],
  slots: [],
  entry: "n0",
};

const at = (label: string): AxObservation => ({ app: "TextEdit", elements: [el(label)] });

describe("executeRun", () => {
  it("reaches the goal across two segments, arming each", async () => {
    // "second" is only findable once the world has actually reached n1 — the
    // state that does not exist yet at plan time, which is the whole premise.
    const actuator = new ScriptedActuator(
      [at("Start"), at("Middle"), at("End")],
      (d, world) => (world === 0 ? d.identifier === "first" : d.identifier === "second"),
    );
    const armed: Plan[] = [];
    const out = await executeRun({
      graph,
      actuator,
      keymap,
      goalNodeId: "n2",
      arm: async (p) => {
        armed.push(p);
        return true;
      },
    });

    expect(out.reached).toBe(true);
    expect(out.stopped).toBeUndefined();
    expect(armed).toHaveLength(2);
    // The first plan stops at the frontier and discloses what remains.
    expect(armed[0]!.cut?.resumeAt).toBe("n1");
    expect(armed[0]!.remainder.map((r) => r.edgeId)).toEqual(["e1"]);
    expect(armed[1]!.cut).toBeUndefined();
  });

  /** Nothing is posted from a plan the caller did not approve. */
  it("stops with `declined` and posts nothing when arm returns false", async () => {
    const actuator = new ScriptedActuator([at("Start"), at("Middle"), at("End")], () => true);
    const out = await executeRun({
      graph,
      actuator,
      keymap,
      goalNodeId: "n2",
      arm: async () => false,
    });
    expect(out.stopped).toBe("declined");
    expect(out.reached).toBe(false);
    expect(actuator.posted).toEqual([]);
  });

  it("stops with `not-located` when nothing verifies", async () => {
    const actuator = new ScriptedActuator([{ app: "WebStorm", elements: [] }], () => true);
    const out = await executeRun({
      graph,
      actuator,
      keymap,
      goalNodeId: "n2",
      arm: async () => true,
    });
    expect(out.stopped).toBe("not-located");
  });

  /**
   * The segment planned zero steps and resumes where it started: the element is
   * genuinely GONE, not merely not-yet-arrived, because edge 1 begins at the
   * node just located. Looping would spin forever.
   */
  it("stops with `no-progress` when the very first edge cannot resolve", async () => {
    const actuator = new ScriptedActuator([at("Start"), at("Middle"), at("End")], () => false);
    let armCalls = 0;
    const out = await executeRun({
      graph,
      actuator,
      keymap,
      goalNodeId: "n2",
      arm: async () => {
        armCalls++;
        return true;
      },
    });
    expect(out.stopped).toBe("no-progress");
    // An empty segment is never put in front of the reviewer.
    expect(armCalls).toBe(0);
  });

  it("reports reaching a goal it is already standing on", async () => {
    const actuator = new ScriptedActuator([at("Start"), at("Middle"), at("End")], () => true);
    const out = await executeRun({
      graph,
      actuator,
      keymap,
      goalNodeId: "n0",
      arm: async () => true,
    });
    expect(out.reached).toBe(true);
    expect(out.segments).toHaveLength(0);
  });

  /**
   * Drift needs no mechanism: the next turn re-observes and re-locates anyway.
   * It only has to be DISCLOSED, and the caller arms again regardless.
   */
  it("discloses drift when something else moves the world between segments", async () => {
    const actuator = new ScriptedActuator([at("Start"), at("Middle"), at("End")], () => true);
    // Segment 1 completes and every node boundary verifies, so the run believes
    // it is at n2. Then something ELSE moves the desktop before the next turn
    // observes — a background app, or the user. That is the only way drift can
    // survive boundary verification, and it must still be disclosed rather than
    // silently absorbed into a fresh plan.
    actuator.rewindOnDump = 4;
    const armed: Plan[] = [];
    await executeRun({
      graph,
      actuator,
      keymap,
      goalNodeId: "n2",
      maxSegments: 2,
      arm: async (p) => {
        armed.push(p);
        return true;
      },
    });
    const drifted = armed.find((p) => p.drift !== undefined);
    expect(drifted).toBeDefined();
    expect(drifted!.drift).toEqual({ expected: "n2", observed: "n0" });
  });

  /**
   * The runaway guard. A run that legitimately needs two segments is capped at
   * one: it stops, reports how far it got, and does NOT quietly keep going.
   */
  it("terminates at maxSegments rather than continuing", async () => {
    const actuator = new ScriptedActuator(
      [at("Start"), at("Middle"), at("End")],
      (d, world) => (world === 0 ? d.identifier === "first" : d.identifier === "second"),
    );
    const out = await executeRun({
      graph,
      actuator,
      keymap,
      goalNodeId: "n2",
      maxSegments: 1,
      arm: async () => true,
    });
    expect(out.stopped).toBe("max-segments");
    expect(out.reached).toBe(false);
    // It got exactly one segment in, and says so — the world is left there.
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]!.outcome.completed).toBe(true);
  });
});
