import { describe, expect, it } from "vitest";
import { canArm, executePlan } from "../src/replay/execute.js";
import type {
  ActivateOutcome,
  Actuator,
  AxObservation,
  Plan,
  ReplayInput,
  UIElement,
} from "../src/replay/types.js";
import { isRepairStep } from "../src/replay/types.js";
import type { Action, Graph, Vec2 } from "../src/trace/types.js";
import type { Keymap } from "../src/capture/env/types.js";

const us: Keymap = {
  layoutId: "com.apple.keylayout.US",
  entries: { 0: ["a", "A", "å", "Å"], 1: ["s", "S", "ß", "Í"] },
};

/** Records calls instead of touching the desktop. */
class FakeActuator implements Actuator {
  calls: string[] = [];
  tree: UIElement[] = [];
  app: string | undefined;
  dump = async (): Promise<AxObservation> => ({
    elements: this.tree,
    ...(this.app !== undefined ? { app: this.app } : {}),
  });
  /** Apps the fake reports as running; drives the activate outcome. */
  running: string[] = [];
  runningApps = async (): Promise<string[]> => this.running;
  activate = async (app: string, launch: boolean): Promise<ActivateOutcome> => {
    this.calls.push(`activate ${app} launch=${launch}`);
    if (this.running.includes(app)) return "activated";
    if (launch) {
      this.running.push(app);
      return "launched";
    }
    return "not-running";
  };
  locate = async (): Promise<{ handle: number; bounds: { x: number; y: number; w: number; h: number } }> => ({
    handle: 1,
    bounds: { x: 0, y: 0, w: 10, h: 10 },
  });
  click = async (p: Vec2, button: number, count: number): Promise<void> => {
    this.calls.push(`click ${p.x},${p.y} b${button} x${count}`);
  };
  async moveTo(p: Vec2): Promise<void> {
    this.calls.push(`move ${p.x},${p.y}`);
  }
  async dragPath(samples: readonly { p: Vec2; atMs: number }[], button: number): Promise<void> {
    this.calls.push(`drag ${samples.length} b${button}`);
  }
  async scroll(p: Vec2, delta: Vec2, steps: number): Promise<void> {
    this.calls.push(`scroll ${p.x},${p.y} ${delta.x},${delta.y} s${steps}`);
  }
  async key(keycode: number, modifiers: readonly string[], down: boolean): Promise<void> {
    this.calls.push(`key ${keycode} [${modifiers.join("+")}] ${down ? "down" : "up"}`);
  }
}

/** Narrow a plan step to the recorded-action kind these tests operate on. */
const asAction = (s: Plan["steps"][number]) => {
  if (isRepairStep(s)) throw new Error("expected a PlannedAction, got a repair step");
  return s;
};

const graph: Graph = {
  id: "g1",
  nodes: [
    { id: "n0", predicates: [], intervene: "select", observations: 1 },
    { id: "n1", predicates: [], intervene: "select", observations: 1 },
  ],
  edges: [],
  slots: [],
  entry: "n0",
};

const plan = (steps: Plan["steps"], over: Partial<Plan> = {}): Plan => ({
  id: "p1",
  graphId: "g1",
  from: "n0",
  to: "n1",
  steps,
  blockers: [],
  brittleness: [{ edgeId: "e0", axRate: 1, belowFloor: false }],
  ...over,
});

const clickStep = (x: number, y: number): Plan["steps"][number] => ({
  edgeId: "e0",
  action: {
    kind: "click",
    anchor: { point: { x, y, displayId: "5" } },
    button: 1,
    count: 1,
  } as Action,
  resolution: { layer: "identifier", point: { x, y }, confidence: 1, attempts: [] },
});

const input = (actuator: Actuator): ReplayInput => ({ graph, actuator, keymap: us });

describe("canArm", () => {
  it("allows a clean plan", () => {
    expect(canArm(plan([]))).toEqual({ ok: true });
  });

  it("refuses a plan with blockers", () => {
    const r = canArm(plan([], { blockers: [{ reason: "display missing" }] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/display missing/);
  });

  it("refuses an edge below the brittleness floor", () => {
    const r = canArm(plan([], { brittleness: [{ edgeId: "e0", axRate: 0.2, belowFloor: true }] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/brittle/i);
  });

  it("allows a brittle plan with an explicit override", () => {
    const p = plan([], { brittleness: [{ edgeId: "e0", axRate: 0.2, belowFloor: true }] });
    expect(canArm(p, true)).toEqual({ ok: true });
  });

  it("still refuses blockers even with an override — they have no repair path", () => {
    const p = plan([], { blockers: [{ reason: "display missing" }] });
    expect(canArm(p, true).ok).toBe(false);
  });
});

describe("executePlan", () => {
  it("refuses to run an unarmable plan and posts nothing", async () => {
    const a = new FakeActuator();
    const out = await executePlan(
      plan([clickStep(10, 20)], { blockers: [{ reason: "nope" }] }),
      input(a),
    );
    expect(out.completed).toBe(false);
    expect(a.calls).toEqual([]);
  });

  it("moves then clicks at the RESOLVED point, not the recorded one", async () => {
    const a = new FakeActuator();
    const step = clickStep(10, 20);
    asAction(step).resolution = { layer: "identifier", point: { x: 900, y: 40 }, confidence: 1, attempts: [] };
    const out = await executePlan(plan([step]), input(a));
    expect(out.completed).toBe(true);
    expect(a.calls).toEqual(["move 900,40", "click 900,40 b1 x1"]);
  });

  it("types through the injected keymap, one down/up pair per character", async () => {
    const a = new FakeActuator();
    const step: Plan["steps"][number] = {
      edgeId: "e0",
      action: { kind: "type", slot: "s", recorded: "aS" } as Action,
    };
    await executePlan(plan([step]), input(a));
    expect(a.calls).toEqual([
      "key 0 [] down",
      "key 0 [] up",
      "key 1 [shift] down",
      "key 1 [shift] up",
    ]);
  });

  it("prefers a slot binding over the recorded text", async () => {
    const a = new FakeActuator();
    const step: Plan["steps"][number] = {
      edgeId: "e0",
      action: { kind: "type", slot: "s", recorded: "a" } as Action,
      slotBinding: { name: "s", value: "s" },
    };
    await executePlan(plan([step]), input(a));
    expect(a.calls).toEqual(["key 1 [] down", "key 1 [] up"]);
  });

  it("polls a wait predicate instead of sleeping, and succeeds when it becomes true", async () => {
    const a = new FakeActuator();
    let polls = 0;
    a.dump = async () => {
      polls++;
      return {
        elements: polls >= 2 ? [{ role: "Button", label: "Send", x: 0, y: 0, w: 10, h: 10 }] : [],
      };
    };
    const step: Plan["steps"][number] = {
      edgeId: "e0",
      action: {
        kind: "wait",
        until: { kind: "ax_exists", args: { role: "Button", label: "Send" }, reach: "achievable" },
        timeoutMs: 2000,
      } as Action,
    };
    const out = await executePlan(plan([step]), input(a), { pollMs: 1 });
    expect(out.completed).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("aborts naming the predicate when a wait times out", async () => {
    const a = new FakeActuator();
    const step: Plan["steps"][number] = {
      edgeId: "e0",
      action: {
        kind: "wait",
        until: { kind: "ax_exists", args: { role: "Button", label: "Never" }, reach: "achievable" },
        timeoutMs: 5,
      } as Action,
    };
    const out = await executePlan(plan([step]), input(a), { pollMs: 1 });
    expect(out.completed).toBe(false);
    expect(out.failure!.reason).toMatch(/Never/);
  });

  it("stops at the failing step and reports how far it got", async () => {
    const a = new FakeActuator();
    a.click = async () => {
      throw new Error("sidecar died");
    };
    const out = await executePlan(plan([clickStep(1, 2), clickStep(3, 4)]), input(a));
    expect(out.completed).toBe(false);
    expect(out.failure).toMatchObject({ step: 0 });
    expect(out.failure!.reason).toMatch(/sidecar died/);
    expect(out.stepsRun).toBe(0);
  });

  it("records telemetry for every resolved step", async () => {
    const a = new FakeActuator();
    const out = await executePlan(plan([clickStep(1, 2)]), input(a));
    expect(out.telemetry).toEqual([{ edgeId: "e0", layer: "identifier", confidence: 1 }]);
  });

  it("aborts a spatial action that carries no resolution rather than guessing", async () => {
    const a = new FakeActuator();
    const step: Plan["steps"][number] = {
      edgeId: "e0",
      action: {
        kind: "click",
        anchor: { point: { x: 1, y: 2, displayId: "5" } },
        button: 1,
        count: 1,
      } as Action,
    };
    const out = await executePlan(plan([step]), input(a));
    expect(out.completed).toBe(false);
    expect(a.calls).toEqual([]);
  });
});
