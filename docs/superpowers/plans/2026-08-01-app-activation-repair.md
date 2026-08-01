# App Activation Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an unmet `app` predicate a repair path, so the executor can bring a named application forward instead of replaying a Dock click at a stale coordinate.

**Architecture:** Planning inserts a visible `RepairStep` before any edge whose destination node names an app that isn't frontmost, deciding *at plan time* — via a new inert `runningApps()` read — whether that app can be raised or is a blocker. Execution performs the activation through the injected `Actuator` and then polls the `app` predicate rather than sleeping. Nothing in `src/trace/` changes: activation is not recorded behaviour, so it is a `RepairStep`, never an `Action`.

**Tech Stack:** TypeScript (strict, ESM, `exactOptionalPropertyTypes`), Vitest, Swift (`swiftc -O`, AppKit/`NSWorkspace`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-01-app-activation-repair-design.md`. Read it before Task 1.
- **Planning must stay inert.** `buildPlan` may call `runningApps()` but **never** `activate()` — activating to discover whether an app is running would change the world the plan describes.
- **`src/trace/` is not modified by this plan.** Activation is not an `Action`.
- **No test may activate or launch a real application.** `FakeActuator` covers it, and the real-sidecar test uses a name that cannot match plus `launch: false`.
- **Match applications on `localizedName`** — the string `active-win` records as `owner.name` and `dump` already returns. No name normalization anywhere.
- **`allowLaunch` defaults to `false`** and lives on `BuildPlanInput`; it is recorded onto each `RepairStep.launch`.
- **`activateTimeoutMs` defaults to `5000`** and lives on `ExecuteOptions`.
- **After activating, poll the predicate. Never sleep a fixed duration.**
- **Gates:** `npm run typecheck` and `npm test` must pass before every commit. Run `npm run build && npm --prefix app run typecheck` only in the task that changes the barrel (Task 5).
- `strict` + `exactOptionalPropertyTypes` are on: build optional properties with `...(x !== undefined ? { k: x } : {})`, never `k: undefined`.

## File Structure

| File | Change |
| --- | --- |
| `src/replay/types.ts` | `RepairStep`, `PlanStep`, `isRepairStep`, `Actuator.runningApps` + `.activate`, `Plan.steps` retype |
| `src/replay/plan.ts` | insert repair steps / blockers; `allowLaunch` input |
| `src/replay/execute.ts` | perform activation, poll the predicate; `activateTimeoutMs` |
| `native/ax-exec.swift` | `runningApps` and `activate` commands |
| `src/replay/sidecar.ts` | client methods for both |
| `src/index.ts` | barrel exports |
| `test/replay.*.test.ts` | one test file per behaviour below |

---

### Task 1: The repair step type and the actuator surface

Types only, plus the guard that discriminates them. No behaviour yet, so the deliverable is that every existing implementer of `Actuator` is forced to declare the new methods.

**Files:**
- Modify: `src/replay/types.ts`
- Modify: `test/replay.execute.test.ts` (extend `FakeActuator`)
- Create: `test/replay.repair-step.test.ts`

**Interfaces:**
- Produces: `RepairStep`, `PlanStep`, `isRepairStep(step): step is RepairStep`, `Actuator.runningApps(): Promise<string[]>`, `Actuator.activate(app: string, launch: boolean): Promise<ActivateOutcome>`, `ActivateOutcome = "activated" | "launched" | "not-running"`.

- [ ] **Step 1: Write the failing test**

Create `test/replay.repair-step.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isRepairStep } from "../src/replay/types.js";
import type { PlanStep, RepairStep } from "../src/replay/types.js";
import type { Action } from "../src/trace/types.js";

const repair: RepairStep = {
  repair: "activate",
  app: "TextEdit",
  launch: false,
  reason: 'app(app="TextEdit") does not hold',
};

const action: PlanStep = {
  edgeId: "e0",
  action: { kind: "chord", keys: ["cmd", "s"] } as Action,
};

describe("isRepairStep", () => {
  it("identifies a repair step", () => {
    expect(isRepairStep(repair)).toBe(true);
  });

  // The discriminator is the presence of `repair`, so no field had to be added
  // to PlannedAction and every existing step shape stays untouched.
  it("does not mistake a planned action for one", () => {
    expect(isRepairStep(action)).toBe(false);
  });

  it("narrows the type so `app` is reachable", () => {
    const step: PlanStep = repair;
    expect(isRepairStep(step) ? step.app : "").toBe("TextEdit");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/replay.repair-step.test.ts`
Expected: FAIL — `types.js` has no export `isRepairStep`.

- [ ] **Step 3: Add the types**

In `src/replay/types.ts`, immediately after the `PlannedAction` interface, add:

```ts
/**
 * A step the EXECUTOR synthesized to reach a state, as opposed to one the user
 * recorded. Activation is not an `Action` because `Action` is the IR — recorded
 * behaviour — and nothing recorded this; keeping it separate is also what stops
 * this feature from reaching into `src/trace/`.
 */
export interface RepairStep {
  repair: "activate";
  app: string;
  /**
   * Whether execution may LAUNCH the app rather than only raise it. Decided at
   * plan time and recorded here, so the review shows exactly what will happen —
   * an override that only lived in the executor's options would be a launch the
   * plan never disclosed.
   */
  launch: boolean;
  /** The unmet predicate this repairs, so the plan can explain itself. */
  reason: string;
}

/** A plan step is either a recorded action or a synthesized repair. */
export type PlanStep = PlannedAction | RepairStep;

export const isRepairStep = (s: PlanStep): s is RepairStep => "repair" in s;
```

Change `Plan.steps` to use it:

```ts
  steps: PlanStep[];
```

Add the outcome type and the two methods to `Actuator`, after `dump()`:

```ts
export type ActivateOutcome = "activated" | "launched" | "not-running";
```

```ts
  /**
   * Which applications are running, by `localizedName`. INERT — this is the read
   * planning uses to decide between a repair step and a blocker. Planning must
   * never call `activate` to find out, because that would activate the app and
   * change the world the plan is describing.
   */
  runningApps(): Promise<string[]>;
  /** Raise `app`, or launch it when `launch` is true. Execution only. */
  activate(app: string, launch: boolean): Promise<ActivateOutcome>;
```

- [ ] **Step 4: Extend FakeActuator so the suite still compiles**

In `test/replay.execute.test.ts`, inside `class FakeActuator`, add after the `dump` member:

```ts
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
```

and extend the type import on line 3 to include `ActivateOutcome`:

```ts
import type { ActivateOutcome, Actuator, AxObservation, Plan, ReplayInput, UIElement } from "../src/replay/types.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/replay.repair-step.test.ts test/replay.execute.test.ts`
Expected: PASS (3 new + the existing execute tests).

- [ ] **Step 6: Run the gates**

Run: `npm run typecheck && npm test`
Expected: typecheck silent, suite green.

- [ ] **Step 7: Commit**

```bash
git add src/replay/types.ts test/replay.repair-step.test.ts test/replay.execute.test.ts
git commit -m "feat(replay): repair step type and the activate actuator surface"
```

---

### Task 2: Planning inserts repair steps

**Files:**
- Modify: `src/replay/plan.ts`
- Create: `test/replay.plan-activate.test.ts`

**Interfaces:**
- Consumes: `RepairStep`, `PlanStep`, `isRepairStep`, `Actuator.runningApps` (Task 1).
- Produces: `BuildPlanInput.runningApps?: readonly string[]`, `BuildPlanInput.allowLaunch?: boolean`.

Note: `buildPlan` takes the *result* of `runningApps()` rather than the `Actuator` itself, so `plan.ts` keeps its existing shape — it already receives `locate` as a plain function rather than an actuator, and staying consistent keeps it a pure function over injected data.

- [ ] **Step 1: Write the failing test**

Create `test/replay.plan-activate.test.ts`:

```ts
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
      graph: g, fromNodeId: "n0", toNodeId: "n1",
      observed: [appPred("TextEdit")],
      locate: found,
      runningApps: ["TextEdit", "Google Chrome"],
    });
    const repairs = plan.steps.filter(isRepairStep);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ repair: "activate", app: "Google Chrome", launch: false });
    expect(repairs[0]!.reason).toMatch(/Google Chrome/);
  });

  it("puts the repair BEFORE the edge's actions", async () => {
    const plan = await buildPlan({
      graph: g, fromNodeId: "n0", toNodeId: "n1",
      observed: [appPred("TextEdit")], locate: found,
      runningApps: ["TextEdit", "Google Chrome"],
    });
    expect(isRepairStep(plan.steps[0]!)).toBe(true);
    expect(isRepairStep(plan.steps[1]!)).toBe(false);
  });

  it("inserts nothing when the app already holds", async () => {
    const same = graph(
      [node("n0", [appPred("TextEdit")]), node("n1", [appPred("TextEdit")])],
      [edge("e0", "n0", "n1")],
    );
    const plan = await buildPlan({
      graph: same, fromNodeId: "n0", toNodeId: "n1",
      observed: [appPred("TextEdit")], locate: found,
      runningApps: ["TextEdit"],
    });
    expect(plan.steps.filter(isRepairStep)).toHaveLength(0);
  });

  it("blocks when the app is not running and launching was not allowed", async () => {
    const plan = await buildPlan({
      graph: g, fromNodeId: "n0", toNodeId: "n1",
      observed: [appPred("TextEdit")], locate: found,
      runningApps: ["TextEdit"],
    });
    expect(plan.steps.filter(isRepairStep)).toHaveLength(0);
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]!.reason).toMatch(/Google Chrome is not running/);
  });

  it("turns that blocker into a launching repair step under allowLaunch", async () => {
    const plan = await buildPlan({
      graph: g, fromNodeId: "n0", toNodeId: "n1",
      observed: [appPred("TextEdit")], locate: found,
      runningApps: ["TextEdit"], allowLaunch: true,
    });
    expect(plan.blockers).toHaveLength(0);
    const repairs = plan.steps.filter(isRepairStep);
    expect(repairs[0]).toMatchObject({ app: "Google Chrome", launch: true });
  });

  // A path that stays in one app must not re-activate it at every hop.
  it("collapses consecutive repairs for the same app", async () => {
    const chain = graph(
      [node("n0", [appPred("TextEdit")]), node("n1", [appPred("Chrome")]), node("n2", [appPred("Chrome")])],
      [edge("e0", "n0", "n1"), edge("e1", "n1", "n2")],
    );
    const plan = await buildPlan({
      graph: chain, fromNodeId: "n0", toNodeId: "n2",
      observed: [appPred("TextEdit")], locate: found,
      runningApps: ["TextEdit", "Chrome"],
    });
    expect(plan.steps.filter(isRepairStep)).toHaveLength(1);
  });

  // Repairs are not targets; a plan does not get less brittle by adding them.
  it("does not let a repair step affect axRate", async () => {
    const plan = await buildPlan({
      graph: g, fromNodeId: "n0", toNodeId: "n1",
      observed: [appPred("TextEdit")], locate: found,
      runningApps: ["TextEdit", "Google Chrome"],
    });
    // One click target, resolving to point => 0%.
    expect(plan.brittleness[0]!.axRate).toBe(0);
  });

  it("inserts no repair when runningApps was not supplied", async () => {
    const plan = await buildPlan({
      graph: g, fromNodeId: "n0", toNodeId: "n1",
      observed: [appPred("TextEdit")], locate: found,
    });
    expect(plan.steps.filter(isRepairStep)).toHaveLength(0);
    expect(plan.blockers).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/replay.plan-activate.test.ts`
Expected: FAIL — `runningApps` is not a known property of `BuildPlanInput`, and no repair steps are produced.

- [ ] **Step 3: Add the inputs**

In `src/replay/plan.ts`, add to `BuildPlanInput` after `windowOrigin`:

```ts
  /**
   * Applications currently running, by `localizedName` — from the INERT
   * `Actuator.runningApps()`. Absent means app repair is not attempted at all,
   * which keeps `buildPlan` usable without an actuator.
   */
  runningApps?: readonly string[];
  /**
   * Allow a repair step to LAUNCH an app that is not running. Default false: a
   * launch can restore windows, reopen documents and run startup work, which is
   * categorically larger than raising an app that is already there.
   */
  allowLaunch?: boolean;
```

Extend the type import to include the repair types:

```ts
  type PlanStep,
  type RepairStep,
```

- [ ] **Step 4: Insert the repair steps**

In `buildPlan`, change the `steps` declaration:

```ts
  const steps: PlanStep[] = [];
```

Then, inside `for (const edge of path) {`, immediately **after** the blocker loop for `to.predicates` and **before** `for (const action of edge.actions) {`, add:

```ts
    // Repair an unmet `app` predicate by raising that application. `app` is
    // tagged achievable, which promises exactly this; replaying the recorded
    // Dock click instead is a coordinate on a surface whose contents move, and
    // it fails silently because a click always "succeeds".
    if (to !== undefined && input.runningApps !== undefined) {
      const wanted = to.predicates.find((p) => p.kind === "app")?.args.app;
      if (typeof wanted === "string" && wanted.length > 0 && wanted !== frontmost) {
        const running = input.runningApps.includes(wanted);
        const launch = input.allowLaunch === true;
        if (!running && !launch) {
          blockers.push({ reason: `${wanted} is not running` });
        } else {
          const repair: RepairStep = {
            repair: "activate",
            app: wanted,
            launch: !running && launch,
            reason: `app(app="${wanted}") does not hold`,
          };
          steps.push(repair);
        }
        // Whatever we decided, the rest of the path is now "in" this app, so a
        // multi-hop path through one application repairs it once.
        frontmost = wanted;
      }
    }
```

Declare `frontmost` from the observed state, just above the `for (const edge of path)` loop:

```ts
  // The app we believe is frontmost as the plan progresses — starts from what is
  // observed and advances as repairs are inserted.
  let frontmost = input.observed.find((p) => p.kind === "app")?.args.app;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/replay.plan-activate.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Run the gates**

Run: `npm run typecheck && npm test`

- [ ] **Step 7: Commit**

```bash
git add src/replay/plan.ts test/replay.plan-activate.test.ts
git commit -m "feat(replay): plan an activation repair for an unmet app predicate"
```

---

### Task 3: Execution performs the activation and waits on the predicate

**Files:**
- Modify: `src/replay/execute.ts`
- Create: `test/replay.execute-activate.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: `ExecuteOptions.activateTimeoutMs?: number` (default `5000`).

- [ ] **Step 1: Write the failing test**

Create `test/replay.execute-activate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { executePlan } from "../src/replay/execute.js";
import type {
  ActivateOutcome, Actuator, AxObservation, Plan, ReplayInput, Rect, UIElement, Vec2,
} from "../src/replay/types.js";
import type { Action, Graph } from "../src/trace/types.js";
import type { Keymap } from "../src/capture/env/types.js";

const us: Keymap = { layoutId: "com.apple.keylayout.US", entries: { 0: ["a", "A", "å", "Å"] } };

/** Reports a frontmost app that only changes when `activate` is called. */
class AppActuator implements Actuator {
  calls: string[] = [];
  frontmost = "TextEdit";
  running = ["TextEdit", "Google Chrome"];
  /** Set to true to make activation never take effect. */
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
  id: "p1", graphId: "g1", from: "n0", to: "n1", steps,
  blockers: [], brittleness: [{ edgeId: "e0", axRate: 1, belowFloor: false }],
});

const clickStep: Plan["steps"][number] = {
  edgeId: "e0",
  action: { kind: "click", anchor: { point: { x: 5, y: 6, displayId: "1" } }, button: 1, count: 1 } as Action,
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
    a.activationSticks = false; // activate returns ok, but the app never fronts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/replay.execute-activate.test.ts`
Expected: FAIL — repair steps are treated as actions and `runStep` throws on the missing `action` property.

- [ ] **Step 3: Implement**

In `src/replay/execute.ts`, add to `ExecuteOptions`:

```ts
  /** How long to wait for an activated app to actually come forward. */
  activateTimeoutMs?: number;
```

Extend the type import with `isRepairStep` (a value, so a normal import) and the step types:

```ts
import { isRepairStep } from "./types.js";
import type {
  ExecOutcome, Plan, PlanStep, PlannedAction, ReplayInput, RepairStep, ResolvedLayer, Vec2,
} from "./types.js";
```

Inside `executePlan`, read the option next to `pollMs`:

```ts
  const activateTimeoutMs = opts.activateTimeoutMs ?? 5000;
```

Replace the body of the step loop's telemetry + dispatch with a repair-aware version:

```ts
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    if (!isRepairStep(step) && step.resolution !== undefined) {
      telemetry.push({
        edgeId: step.edgeId,
        layer: step.resolution.layer,
        confidence: step.resolution.confidence,
      });
    }
    try {
      if (isRepairStep(step)) await runRepair(step, input, pollMs, activateTimeoutMs);
      else await runStep(step, input, pollMs);
    } catch (err) {
```

Add the repair runner next to `runStep`:

```ts
/**
 * Bring an application forward, then CONFIRM it by polling the `app` predicate.
 * Never sleeps a fixed duration: a cold app takes an unpredictable time to come
 * forward, and that is the difference between a replay that works once and one
 * that works repeatedly.
 */
async function runRepair(
  step: RepairStep,
  input: ReplayInput,
  pollMs: number,
  timeoutMs: number,
): Promise<void> {
  const outcome = await input.actuator.activate(step.app, step.launch);
  if (outcome === "not-running") {
    throw new Error(`${step.app} is not running and launching was not permitted`);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observed = await observe(input.actuator);
    if (observed.some((p) => p.kind === "app" && p.args.app === step.app)) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${step.app} to come to the front`);
    }
    await sleep(pollMs);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/replay.execute-activate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the gates**

Run: `npm run typecheck && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/replay/execute.ts test/replay.execute-activate.test.ts
git commit -m "feat(replay): execute an activation repair, confirming by predicate"
```

---

### Task 4: The sidecar commands and client

**Files:**
- Modify: `native/ax-exec.swift`
- Modify: `src/replay/sidecar.ts`
- Modify: `test/replay.sidecar.test.ts`
- Modify: `test/replay.sidecar-client.test.ts`

**Interfaces:**
- Produces: sidecar commands `runningApps` → `{ apps: string[] }` and `activate` → `{ outcome: ActivateOutcome }`; `AxExecSidecar.runningApps()` and `.activate()`.

- [ ] **Step 1: Write the failing client test**

Append to `test/replay.sidecar-client.test.ts`, inside the existing `describe("AxExecSidecar", …)` block:

```ts
  it("parses runningApps", async () => {
    const { dir, path } = stubBinary(`
      console.log(JSON.stringify({ id: req.id, ok: true, result: { apps: ["TextEdit", "Google Chrome"] } }));
    `);
    const s = AxExecSidecar.spawn({ planId: "p1", binaryPath: "node", args: [path] });
    expect(await s.runningApps()).toEqual(["TextEdit", "Google Chrome"]);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("parses an activate outcome and passes launch through", async () => {
    const { dir, path } = stubBinary(`
      console.log(JSON.stringify({ id: req.id, ok: true, result: { outcome: req.launch ? "launched" : "activated" } }));
    `);
    const s = AxExecSidecar.spawn({ planId: "p1", binaryPath: "node", args: [path] });
    expect(await s.activate("TextEdit", false)).toBe("activated");
    expect(await s.activate("TextEdit", true)).toBe("launched");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("treats a malformed activate result as not-running rather than throwing", async () => {
    const { dir, path } = stubBinary(`
      console.log(JSON.stringify({ id: req.id, ok: true, result: {} }));
    `);
    const s = AxExecSidecar.spawn({ planId: "p1", binaryPath: "node", args: [path] });
    expect(await s.activate("Nope", false)).toBe("not-running");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/replay.sidecar-client.test.ts`
Expected: FAIL — `s.runningApps is not a function`.

- [ ] **Step 3: Add the client methods**

In `src/replay/sidecar.ts`, add after `dump()`:

```ts
  async runningApps(): Promise<string[]> {
    const r = await this.send<{ apps?: string[] } | null>("runningApps");
    return r?.apps ?? [];
  }

  async activate(app: string, launch: boolean): Promise<ActivateOutcome> {
    const r = await this.send<{ outcome?: string } | null>("activate", { app, launch });
    // An unrecognised outcome means the app was not raised; saying so is safer
    // than throwing mid-plan or claiming success.
    return r?.outcome === "activated" || r?.outcome === "launched" ? r.outcome : "not-running";
  }
```

and extend its type import with `ActivateOutcome`.

- [ ] **Step 4: Add the Swift commands**

In `native/ax-exec.swift`, add `let app: String?` and `let launch: Bool?` to `struct Request` (alongside the existing optional fields).

Add two cases to the command loop, before `default:`:

```swift
    case "runningApps":
        // localizedName is what active-win records as `owner.name` and what
        // `dump` returns, so an `app` predicate matches verbatim — no
        // normalization anywhere, which is the class of divergence that has
        // already cost this project a day.
        let names = NSWorkspace.shared.runningApplications.compactMap { $0.localizedName }
        emit(req.id, ok: true, result: ["apps": Array(Set(names)).sorted()])

    case "activate":
        guard let wanted = req.app, !wanted.isEmpty else {
            emit(req.id, ok: false, error: "activate needs app")
            break
        }
        let launch = req.launch ?? false
        if let running = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == wanted }) {
            running.activate(options: [.activateIgnoringOtherApps])
            emit(req.id, ok: true, result: ["outcome": "activated"])
            break
        }
        guard launch, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: wanted)
            ?? NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: "/dev/null")) else {
            emit(req.id, ok: true, result: ["outcome": "not-running"])
            break
        }
        // Launching is opt-in: it can restore windows, reopen documents and run
        // startup work, which is categorically larger than raising an app.
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        let sema = DispatchSemaphore(value: 0)
        var launched = false
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, err in
            launched = (err == nil)
            sema.signal()
        }
        _ = sema.wait(timeout: .now() + 10)
        emit(req.id, ok: true, result: ["outcome": launched ? "launched" : "not-running"])
```

- [ ] **Step 5: Add the real-sidecar test**

Append to `test/replay.sidecar.test.ts`, inside the `describe.skipIf(!hasSwiftc)` block:

```ts
  // Exercised against a name that CANNOT match a running application, and with
  // launch disabled, so this test activates and launches nothing.
  it("answers runningApps and refuses to activate an unknown app", async () => {
    const proc: ChildProcessWithoutNullStreams = spawn(bin, ["--plan", "p1"]);
    const { lines, feed } = lineCollector();
    proc.stdout.on("data", feed);

    proc.stdin.write(`${JSON.stringify({ id: 1, cmd: "runningApps" })}\n`);
    proc.stdin.write(
      `${JSON.stringify({ id: 2, cmd: "activate", app: "NoSuchApp_ZZZ", launch: false })}\n`,
    );
    await new Promise((r) => setTimeout(r, 2500));

    const byId = new Map(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    expect(byId.get(1)?.result?.apps?.length).toBeGreaterThan(0);
    expect(byId.get(2)?.result?.outcome).toBe("not-running");

    proc.kill();
  }, 20_000);
```

- [ ] **Step 6: Build and run**

Run: `npm run build:ax-exec && npx vitest run test/replay.sidecar-client.test.ts test/replay.sidecar.test.ts`
Expected: PASS. The Swift test block skips entirely if `swiftc` is absent.

- [ ] **Step 7: Run the gates**

Run: `npm run typecheck && npm test`

- [ ] **Step 8: Commit**

```bash
git add native/ax-exec.swift src/replay/sidecar.ts test/replay.sidecar.test.ts test/replay.sidecar-client.test.ts
git commit -m "feat(replay): ax-exec runningApps and activate commands"
```

---

### Task 5: Barrel exports and the inertness guard

**Files:**
- Modify: `src/index.ts`
- Modify: `test/replay.barrel.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/replay.barrel.test.ts`, add `"isRepairStep"` to the list of names in the "exports the executor's public surface" test, and append this test to the `describe("executor inertness", …)` block:

```ts
  // Planning must stay inert: calling `activate` to discover whether an app is
  // running would activate it, changing the world the plan is describing.
  it("plan.ts never calls activate", () => {
    const src = readFileSync(join(process.cwd(), "src/replay/plan.ts"), "utf8");
    expect(src).not.toMatch(/\.activate\(/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/replay.barrel.test.ts`
Expected: FAIL — the barrel has no `isRepairStep`.

- [ ] **Step 3: Add the exports**

In `src/index.ts`, add to the `./replay/types.js` export block:

```ts
  isRepairStep,
  type ActivateOutcome,
  type PlanStep,
  type RepairStep,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/replay.barrel.test.ts`
Expected: PASS.

- [ ] **Step 5: Run every gate, including the app's**

Run: `npm run typecheck && npm test && npm run build && npm --prefix app run typecheck`
Expected: all green. The app gate matters here because the barrel changed.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/replay.barrel.test.ts
git commit -m "feat(replay): export the repair-step surface and guard planning inertness"
```

---

### Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the invariant**

In the `### 4. The executor (src/replay/)` section, after the bullet beginning "**Dry-run is the default and arming is one gate.**", add:

```markdown
- **An unmet `app` predicate is repaired by ACTIVATING the app, and the repair is a visible plan step.** `app` is tagged `achievable`, so the IR promises a repair path. The graph does contain the recorded switch — as a point-only Dock click — but replaying a coordinate on a surface whose contents move fails silently, because a click always "succeeds". **Planning may call `runningApps()` but never `activate()`**: activating to discover whether an app is running would change the world the plan describes, and `test/replay.barrel.test.ts` asserts `plan.ts` never calls it. Not running is a blocker unless the caller passes `allowLaunch`, and the decision is recorded on `RepairStep.launch` so the review shows whether a launch can happen. Activation is confirmed by polling the predicate, never by sleeping.
```

- [ ] **Step 2: Update the "one live run" note**

In the same section, the paragraph beginning "**The loop has run end to end once**" says a cross-app plan cannot arm "because anchors do not resolve while the wrong app is frontmost (whether the executor should switch apps to satisfy an `app` predicate is unbuilt …)". Replace the parenthetical with:

```markdown
(the executor now activates the app to satisfy an `app` predicate, but the anchors still cannot resolve at plan time — that is the separate, unbuilt progressive-resolution problem).
```

- [ ] **Step 3: Run the gates**

Run: `npm test`
Expected: green (`test/brand.assets.test.ts` and friends unaffected).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the app-activation repair seam"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: `RepairStep`/`PlanStep`/discriminator → Task 1; the two actuator methods and the inert-planning split → Tasks 1, 4, 5; planning insertion, collapsing, the blocker table and `allowLaunch` → Task 2; execution, predicate polling and `activateTimeoutMs` → Task 3; the failure-handling table → Tasks 2–4 (blocker at plan time, not-running at execution, activation timeout, malformed outcome); the testing section's four bullets → Tasks 2, 3, 4, 5; barrel and inertness → Task 5.

**Deliberately not built.** The spec's "Out of scope" items stay out: progressive anchor resolution, launching by default, window selection within an app, and anything for `file`/`permission` predicates.

**Known simplification, flagged rather than hidden.** The Swift launch path resolves an application URL by bundle identifier and falls back to a default-handler lookup. `localizedName` is not a bundle id, so **launching by display name may fail and return `not-running`** — which is a safe outcome, not a crash, and matches the "launch is opt-in and may not work" posture. Making launch reliable needs a bundle id recorded on the `app` predicate at capture time, which this plan does not add.

**Type consistency.** Checked across tasks: `RepairStep { repair, app, launch, reason }` (Tasks 1, 2, 3, 4), `isRepairStep` (Tasks 1, 2, 3, 5), `ActivateOutcome` (Tasks 1, 3, 4), `Actuator.runningApps(): Promise<string[]>` and `.activate(app, launch)` (Tasks 1, 3, 4), `BuildPlanInput.runningApps`/`allowLaunch` (Task 2), `ExecuteOptions.activateTimeoutMs` (Task 3), and `Plan.steps: PlanStep[]` (Tasks 1, 2, 3).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-01-app-activation-repair.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.
