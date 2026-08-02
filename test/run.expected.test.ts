import { describe, expect, it } from "vitest";
import { executeRun } from "../src/replay/run.js";
import type {
  ActivateOutcome,
  Actuator,
  AxDescriptor,
  AxObservation,
  UIElement,
} from "../src/replay/types.js";
import type { Graph, Predicate, TraceEdge, TraceNode, Vec2 } from "../src/trace/types.js";
import type { Keymap } from "../src/capture/env/types.js";

const us: Keymap = { layoutId: "com.apple.keylayout.US", entries: {} };

/**
 * A fake desktop whose state changes when a click is actually POSTED, not when
 * it is observed.
 *
 * A dump-counting script does not survive contact with the loop: an activation
 * repair polls `dump()` until its predicate holds, so the number of observations
 * between turns is not fixed. Keying the world to posted clicks removes the
 * counting entirely and is closer to how a desktop behaves.
 *
 * `locate` resolves ONLY what is currently on screen, which is what makes a plan
 * cut the way a real one does — an actuator that locates anything never produces
 * the case these tests are about.
 *
 * Deliberately its own copy rather than an import from
 * `test/replay.execute.test.ts`: that fake is shaped for its own assertions.
 */
class FakeDesktop implements Actuator {
  calls: string[] = [];
  dumps = 0;
  clicks = 0;

  /** `worlds[n]` is the desktop after n clicks; the last one repeats. */
  constructor(private readonly worlds: AxObservation[]) {}

  private get current(): AxObservation {
    return this.worlds[Math.min(this.clicks, this.worlds.length - 1)]!;
  }

  dump = async (): Promise<AxObservation> => {
    this.dumps += 1;
    return this.current;
  };

  runningApps = async (): Promise<string[]> => ["TextEdit", "Google Chrome"];
  activate = async (app: string): Promise<ActivateOutcome> => {
    this.calls.push(`activate ${app}`);
    return "activated";
  };

  locate = async (
    d: AxDescriptor,
  ): Promise<{ handle: number; bounds: { x: number; y: number; w: number; h: number } } | null> => {
    const present = this.current.elements.some((e) => e.label === d.label);
    return present ? { handle: 1, bounds: { x: 0, y: 0, w: 10, h: 10 } } : null;
  };

  click = async (p: Vec2): Promise<void> => {
    this.calls.push(`click ${p.x},${p.y}`);
    this.clicks += 1;
  };
  async moveTo(): Promise<void> {}
  async dragPath(): Promise<void> {}
  async scroll(): Promise<void> {}
  async key(): Promise<void> {}
}

const app = (name: string): Predicate => ({
  kind: "app",
  args: { app: name },
  reach: "achievable",
});
const exists = (label: string): Predicate => ({
  kind: "ax_exists",
  args: { role: "Button", label },
  reach: "achievable",
});
const el = (label: string): UIElement => ({ role: "Button", label, x: 0, y: 0, w: 10, h: 10 });

const node = (id: string, predicates: Predicate[]): TraceNode => ({
  id,
  predicates,
  intervene: "select",
  observations: 1,
});

const clickEdge = (id: string, from: string, to: string, label: string): TraceEdge => ({
  id,
  from,
  to,
  actions: [
    {
      kind: "click",
      anchor: {
        point: { x: 5, y: 5, displayId: "d0" },
        ax: { role: "Button", label, path: "W[0]>B[0]" },
      },
      button: 0,
      count: 1,
    },
  ],
  provenance: "recorded",
  observations: 1,
  outcomes: { attempts: 1, successes: 1 },
});

/**
 * n0 -> n1 -> n2, where n1 carries ONLY `app` and therefore cannot be located.
 * Reaching n2 is possible only if the loop prefers the node the previous segment
 * said it would land on.
 */
const graph: Graph = {
  id: "g",
  nodes: [
    node("n0", [app("TextEdit"), exists("Start")]),
    node("n1", [app("Google Chrome")]),
    node("n2", [app("Google Chrome"), exists("Done")]),
  ],
  edges: [clickEdge("e0", "n0", "n1", "Start"), clickEdge("e1", "n1", "n2", "Finish")],
  slots: [],
  entry: "n0",
};

const obs = (appName: string, labels: string[]): AxObservation => ({
  elements: labels.map(el),
  app: appName,
});

describe("continuation past a weak node", () => {
  it("adopts the expected node when it verifies but cannot be located", async () => {
    const actuator = new FakeDesktop([
      obs("TextEdit", ["Start"]), //        0 clicks: locate n0; "Finish" is absent so the plan CUTS
      obs("Google Chrome", ["Finish"]), //  1 click:  n1 holds, but ONLY by `app` — it cannot be located
      obs("Google Chrome", ["Done"]), //    2 clicks: n2 holds
    ]);
    const out = await executeRun({
      graph,
      actuator,
      keymap: us,
      goalNodeId: "n2",
      arm: async () => true,
    });
    expect(out.stopped).toBeUndefined();
    expect(out.reached).toBe(true);
    // TWO armed segments. The first cuts at e1 because "Finish" is not on screen
    // yet; the second can only happen if the loop adopts `expected`, since n1
    // carries nothing but `app`.
    expect(out.segments).toHaveLength(2);
    expect(out.segments[0]?.plan.cut?.resumeAt).toBe("n1");
  });

  it("does not blindly adopt an expectation that fails to hold", async () => {
    // The click lands somewhere the recording never described. `expected` must
    // not be taken on faith — the run has to stop rather than plan from a state
    // it only assumed it was in.
    const actuator = new FakeDesktop([obs("TextEdit", ["Start"]), obs("Finder", [])]);
    const out = await executeRun({
      graph,
      actuator,
      keymap: us,
      goalNodeId: "n2",
      arm: async () => true,
    });
    expect(out.reached).toBe(false);
    expect(out.stopped).toBeDefined();
  });

  it("does not adopt anything on a cold start — the first turn must locate", async () => {
    const actuator = new FakeDesktop([obs("Finder", [])]);
    const out = await executeRun({
      graph,
      actuator,
      keymap: us,
      goalNodeId: "n2",
      arm: async () => true,
    });
    expect(out.stopped).toBe("not-located");
  });

  it("never posts an event without arming", async () => {
    const actuator = new FakeDesktop([obs("TextEdit", ["Start"])]);
    const out = await executeRun({
      graph,
      actuator,
      keymap: us,
      goalNodeId: "n2",
      arm: async () => false,
    });
    expect(out.stopped).toBe("declined");
    expect(actuator.calls.filter((c) => c.startsWith("click"))).toHaveLength(0);
  });
});
