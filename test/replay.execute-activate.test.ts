import { describe, expect, it } from "vitest";
import { executePlan } from "../src/replay/execute.js";
import type {
  ActivateOutcome,
  Actuator,
  AxObservation,
  Plan,
  Rect,
  ReplayInput,
  UIElement,
  Vec2,
} from "../src/replay/types.js";
import type { Action, Graph } from "../src/trace/types.js";
import type { Keymap } from "../src/capture/env/types.js";

const us: Keymap = { layoutId: "com.apple.keylayout.US", entries: { 0: ["a", "A", "å", "Å"] } };

/** Reports a frontmost app that only changes when `activate` is called. */
class AppActuator implements Actuator {
  calls: string[] = [];
  frontmost = "TextEdit";
  running = ["TextEdit", "Google Chrome"];
  /** Set false to make activation report success but never take effect. */
  activationSticks = true;
  dumps = 0;

  async dump(): Promise<AxObservation> {
    this.dumps++;
    return { elements: [] as UIElement[], app: this.frontmost };
  }
  async runningApps(): Promise<string[]> {
    return this.running;
  }
  async activate(app: string, launch: boolean): Promise<ActivateOutcome> {
    this.calls.push(`activate ${app} launch=${launch}`);
    if (!this.running.includes(app)) {
      if (!launch) return "not-running";
      this.running.push(app);
      if (this.activationSticks) this.frontmost = app;
      return "launched";
    }
    if (this.activationSticks) this.frontmost = app;
    return "activated";
  }
  async locate(): Promise<{ handle: number; bounds: Rect } | null> {
    return null;
  }
  async moveTo(p: Vec2): Promise<void> {
    this.calls.push(`move ${p.x},${p.y}`);
  }
  async click(p: Vec2): Promise<void> {
    this.calls.push(`click ${p.x},${p.y}`);
  }
  async dragPath(): Promise<void> {}
  async scroll(): Promise<void> {}
  async key(): Promise<void> {}
}

const graph: Graph = {
  id: "g1",
  nodes: [{ id: "n0", predicates: [], intervene: "select", observations: 1 }],
  edges: [],
  slots: [],
  entry: "n0",
};

const plan = (steps: Plan["steps"]): Plan => ({
  id: "p1",
  graphId: "g1",
  from: "n0",
  to: "n1",
  steps,
  blockers: [],
  brittleness: [{ edgeId: "e0", axRate: 1, belowFloor: false }],
});

const clickStep: Plan["steps"][number] = {
  edgeId: "e0",
  action: {
    kind: "click",
    anchor: { point: { x: 5, y: 6, displayId: "1" } },
    button: 1,
    count: 1,
  } as Action,
  resolution: { layer: "identifier", point: { x: 5, y: 6 }, confidence: 1, attempts: [] },
};

const input = (a: Actuator): ReplayInput => ({ graph, actuator: a, keymap: us });

describe("executePlan: activation repair", () => {
  it("activates before running the following action", async () => {
    const a = new AppActuator();
    const out = await executePlan(
      plan([{ repair: "activate", app: "Google Chrome", launch: false, reason: "r" }, clickStep]),
      input(a),
      { pollMs: 1 },
    );
    expect(out.completed).toBe(true);
    expect(a.calls[0]).toBe("activate Google Chrome launch=false");
    expect(a.calls).toContain("click 5,6");
  });

  it("polls the app predicate rather than sleeping", async () => {
    const a = new AppActuator();
    const out = await executePlan(
      plan([{ repair: "activate", app: "Google Chrome", launch: false, reason: "r" }]),
      input(a),
      { pollMs: 1 },
    );
    expect(out.completed).toBe(true);
    // It observed the live state to confirm the app came forward.
    expect(a.dumps).toBeGreaterThan(0);
  });

  it("aborts naming the app when activation never takes effect", async () => {
    const a = new AppActuator();
    a.activationSticks = false; // activate reports ok, but the app never fronts
    const out = await executePlan(
      plan([{ repair: "activate", app: "Google Chrome", launch: false, reason: "r" }]),
      input(a),
      { pollMs: 1, activateTimeoutMs: 20 },
    );
    expect(out.completed).toBe(false);
    expect(out.failure!.reason).toMatch(/Google Chrome/);
  });

  it("aborts when the app is not running at execution time", async () => {
    const a = new AppActuator();
    a.running = ["TextEdit"]; // Chrome quit between planning and arming
    const out = await executePlan(
      plan([{ repair: "activate", app: "Google Chrome", launch: false, reason: "r" }]),
      input(a),
      { pollMs: 1, activateTimeoutMs: 20 },
    );
    expect(out.completed).toBe(false);
    expect(out.failure!.reason).toMatch(/not running/i);
  });

  it("launches when the step says so", async () => {
    const a = new AppActuator();
    a.running = ["TextEdit"];
    const out = await executePlan(
      plan([{ repair: "activate", app: "Google Chrome", launch: true, reason: "r" }]),
      input(a),
      { pollMs: 1 },
    );
    expect(out.completed).toBe(true);
    expect(a.calls[0]).toBe("activate Google Chrome launch=true");
  });

  it("records no telemetry for a repair step — it is not a target", async () => {
    const a = new AppActuator();
    const out = await executePlan(
      plan([{ repair: "activate", app: "Google Chrome", launch: false, reason: "r" }]),
      input(a),
      { pollMs: 1 },
    );
    expect(out.telemetry).toEqual([]);
  });
});
