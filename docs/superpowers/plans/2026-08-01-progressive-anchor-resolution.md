# Progressive Anchor Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a plan stop where anchor resolution stops working, disclose the rest of the route unresolved, and re-plan after each segment — so a multi-step, cross-application replay becomes possible without ever posting an action the user did not review at exact resolution.

**Architecture:** `buildPlan` cuts the plan at the first anchor that carries AX descriptors but reaches no AX rung; that edge and every later one become a disclosed-but-unresolved `remainder`. A new `executeRun` loop observes, locates the current node, pathfinds, builds a segment, asks an **injected** `arm` callback, executes, and repeats. `replay/` stays a leaf that cannot decide to act on its own.

**Tech Stack:** TypeScript (strict, ESM), vitest, `better-sqlite3`/LanceDB behind `DualStore` (untouched here), Swift `ax-exec` sidecar behind the `Actuator` interface (untouched here).

**Spec:** `docs/superpowers/specs/2026-08-01-progressive-anchor-resolution-design.md`

## Global Constraints

- **`replay/` is a leaf.** It may import `trace/`, `capture/env/types.js` and `embed/types.js` only. It must never import `store/`, `represent/` or `retrieve/`. Enforced by `test/replay.barrel.test.ts`.
- **Only `src/replay/sidecar.ts` may spawn a process.** No file added by this plan may mention `child_process`, `execFile`, or `spawn(`. Enforced by the same test.
- **`plan.ts` must never call `.activate(`.** Planning is inert; activating to discover state would change the world the plan describes. Enforced by the same test.
- **Never fabricate a target.** A spatial action with no resolution aborts; it never falls back to a recorded coordinate.
- **`type` has no fallback layout.** No keymap, or text the layout cannot produce, is a blocker — never a US-QWERTY guess.
- Run `npm run typecheck` (strict `tsc --noEmit`) and `npm test` before every commit. Both must pass.
- Tests use `FakeActuator`-style stubs only. The suite must stay structurally incapable of posting a real event.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/replay/types.ts` *(modify)* | Vocabulary: `SegmentCut`, `RemainderAction`, `RemainderEdge`, `SupersededStep`, run types, and new fields on `Plan`/`Blocker`/`EdgeBrittleness`/`RepairStep`. |
| `src/replay/locate.ts` *(create)* | `locateNode` — which recorded node is still true here. Pure. |
| `src/replay/plan.ts` *(modify)* | Supersession, repair placement, the greedy cut, remainder disclosure. |
| `src/replay/execute.ts` *(modify)* | Superseded steps are no-ops; drag `to` resolves at execution; node-boundary verification. |
| `src/replay/observe.ts` *(modify)* | Expose `predicatesOf` so a caller can spend ONE `dump()` on locating, verifying and resolving. |
| `src/replay/run.ts` *(create)* | `executeRun` — the observe/locate/plan/arm/execute loop. |
| `src/index.ts` *(modify)* | Export `locateNode`, `executeRun`, and the new types. |
| `test/replay.barrel.test.ts` *(modify)* | Guard by directory glob rather than a hand-written file list. |

---

### Task 1: Vocabulary, and a guard that cannot be forgotten

**Files:**
- Modify: `src/replay/types.ts`
- Modify: `src/replay/plan.ts` (satisfy the new required fields — no behaviour change)
- Modify: `test/replay.execute.test.ts:79-87` (Plan fixture), `test/replay.execute-activate.test.ts` (Plan fixture + RepairStep literals), `test/replay.plan-activate.test.ts`, `test/replay.repair-step.test.ts` (RepairStep literals)
- Modify: `test/replay.barrel.test.ts`
- Test: `test/replay.types.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `SegmentCut`, `RemainderAction`, `RemainderEdge`, `SupersededStep`, `isSupersededStep(s: PlanStep): s is SupersededStep`, `RunInput`, `RunOutcome`, `NodeLocation`. `RepairStep` gains `edgeId: string`. `Blocker` gains `scope: "segment" | "remainder"`. `EdgeBrittleness` gains `bound: "measured" | "upper"`. `Plan` gains `cut?: SegmentCut`, `remainder: RemainderEdge[]`, `drift?: { expected: string; observed: string }`.

- [ ] **Step 1: Write the failing test**

Create `test/replay.types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isRepairStep, isSupersededStep } from "../src/replay/types.js";
import type { PlanStep } from "../src/replay/types.js";

const action = {
  kind: "click",
  anchor: { point: { x: 1, y: 2, displayId: "1" } },
  button: 1,
  count: 1,
} as const;

describe("plan step discrimination", () => {
  const planned: PlanStep = { edgeId: "e0", action };
  const repair: PlanStep = {
    repair: "activate",
    edgeId: "e0",
    app: "Google Chrome",
    launch: false,
    reason: 'app(app="Google Chrome") does not hold',
  };
  const superseded: PlanStep = {
    superseded: "activate",
    edgeId: "e0",
    action,
    reason: "activating Google Chrome replaces this",
  };

  // Each guard keys on a field unique to its variant, so a PlannedAction stays
  // the fall-through case. `app/` will grow a review surface against this shape,
  // and a renderer that only knows about actions must keep working.
  it("tells the three step kinds apart, with PlannedAction as the fall-through", () => {
    expect(isRepairStep(repair)).toBe(true);
    expect(isSupersededStep(repair)).toBe(false);

    expect(isSupersededStep(superseded)).toBe(true);
    expect(isRepairStep(superseded)).toBe(false);

    expect(isRepairStep(planned)).toBe(false);
    expect(isSupersededStep(planned)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/replay.types.test.ts`
Expected: FAIL — `isSupersededStep` is not exported from `types.js`.

- [ ] **Step 3: Add the types**

In `src/replay/types.ts`, add `edgeId` to `RepairStep` (immediately after the `repair` field):

```ts
export interface RepairStep {
  repair: "activate";
  /** The edge this repair belongs to, so execution can find its node boundary. */
  edgeId: string;
  app: string;
  launch: boolean;
  reason: string;
}
```

Add `scope` to `Blocker` and `bound` to `EdgeBrittleness`:

```ts
export interface Blocker {
  predicate?: Predicate;
  reason: string;
  /**
   * Blockers span the WHOLE run. `assertable` means no UI action can produce the
   * predicate, so checking a remainder node against the present observation is
   * valid — an unreachable goal is knowable before anything is posted.
   */
  scope: "segment" | "remainder";
}

export interface EdgeBrittleness {
  edgeId: string;
  axRate: number;
  belowFloor: boolean;
  /**
   * `measured` — resolved against the live tree. `upper` — a remainder edge,
   * where the rate is a deductive CEILING: an anchor with no `ax` layer can
   * never reach an AX rung, at any time, by any mechanism.
   */
  bound: "measured" | "upper";
}
```

Add the new interfaces after `RepairStep`:

```ts
/** Where greedy resolution stopped, and why. */
export interface SegmentCut {
  /** Node to re-observe and re-plan from — the `from` of the first unplanned edge. */
  resumeAt: string;
  edgeId: string;
  /** `resolveAnchor`'s own record of which rungs were tried and how each failed. */
  attempts: { layer: ResolvedLayer; rejected: string }[];
}

/**
 * What a remainder action discloses. Descriptor presence is a fact about the
 * RECORDING, not a forecast of what the anchor will resolve to.
 */
export interface RemainderAction {
  kind: Action["kind"];
  descriptors?: ("identifier" | "label" | "path" | "visual")[];
  /** Where it was recorded. Provenance, never presented as a target. */
  recordedPoint?: Vec2;
  slot?: string;
}

export interface RemainderEdge {
  edgeId: string;
  toNodeId: string;
  actions: RemainderAction[];
  /** Repairs this edge would need, from the same inert `runningApps` read. */
  repairs: RepairStep[];
}

/**
 * An action the plan will NOT post, kept visible so the review explains itself.
 * A repair that replaces a recorded switch must be disclosed, not silent.
 */
export interface SupersededStep {
  superseded: "activate";
  edgeId: string;
  action: Action;
  reason: string;
}
```

Replace the `PlanStep` union and add the guard:

```ts
export type PlanStep = PlannedAction | RepairStep | SupersededStep;

export const isRepairStep = (s: PlanStep): s is RepairStep => "repair" in s;
export const isSupersededStep = (s: PlanStep): s is SupersededStep => "superseded" in s;
```

Add the three fields to `Plan` (after `brittleness`):

```ts
  /** Absent when the plan reaches the goal in one segment — today's behaviour. */
  cut?: SegmentCut;
  /** Edges beyond the cut: disclosed, deliberately unresolved. */
  remainder: RemainderEdge[];
  /** Set when the previous segment did not land where it said it would. */
  drift?: { expected: string; observed: string };
```

Add the run types at the end of the file:

```ts
/** What `locateNode` concluded. `candidates` is reported whatever the outcome. */
export interface NodeLocation {
  nodeId?: string;
  candidates: number;
  ambiguous: boolean;
}

export interface RunInput extends ReplayInput {
  goalNodeId: string;
  /**
   * The review gate. `replay/` never decides to act; the caller does. Injected
   * for the same reason `Actuator` is: it keeps the decision outside this
   * package, so an AI-in-the-loop caller can supply it later without `replay/`
   * growing a policy.
   */
  arm: (plan: Plan) => Promise<boolean>;
  slotBindings?: Record<string, string>;
  allowLaunch?: boolean;
  override?: boolean;
  /** Runaway guard. Default 8. */
  maxSegments?: number;
  pollMs?: number;
}

export type RunStop =
  | "declined"
  | "not-located"
  | "no-path"
  | "no-progress"
  | "max-segments"
  | "failed";

export interface RunOutcome {
  goalNodeId: string;
  reached: boolean;
  segments: { plan: Plan; outcome: ExecOutcome }[];
  stopped?: RunStop;
}
```

- [ ] **Step 4: Make the existing code compile**

In `src/replay/plan.ts`, the `RepairStep` literal gains `edgeId`, blockers gain `scope`, brittleness gains `bound`, and the returned plan gains `remainder`. Four edits, no behaviour change:

```ts
// in the repair branch:
const repair: RepairStep = {
  repair: "activate",
  edgeId: edge.id,
  app: wanted,
  launch: !running && mayLaunch,
  reason: `app(app="${wanted}") does not hold`,
};
```

```ts
// every `blockers.push({...})` in this file gains `scope: "segment"`, e.g.:
blockers.push({
  predicate: v.predicate,
  reason: "assertable predicate does not hold",
  scope: "segment",
});
blockers.push({ reason: `${wanted} is not running`, scope: "segment" });
blockers.push({ reason: `no keymap supplied: cannot type "${value}"`, scope: "segment" });
blockers.push({
  reason: `"${value}" cannot be typed with layout ${input.keymap.layoutId}`,
  scope: "segment",
});
```

```ts
brittleness.push({
  edgeId: edge.id,
  axRate,
  belowFloor: axRate < BRITTLENESS_FLOOR,
  bound: "measured",
});
```

```ts
  return {
    id: input.planId ?? ulid(),
    graphId: input.graph.id,
    from: input.fromNodeId,
    to: input.toNodeId,
    steps,
    blockers,
    brittleness,
    remainder: [],
  };
```

- [ ] **Step 5: Update the test fixtures**

In `test/replay.execute.test.ts`, the `plan` helper gains `remainder` and the brittleness entry gains `bound`:

```ts
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
```

Apply the same two additions to the Plan fixture in `test/replay.execute-activate.test.ts`. Then run `npm run typecheck` and add `edgeId: "e0"` (or the edge id already used in that assertion) to every `{ repair: "activate", ... }` object literal the compiler flags in `test/replay.execute-activate.test.ts`, `test/replay.plan-activate.test.ts` and `test/replay.repair-step.test.ts`, and `scope: "segment"` to any `Blocker` literal it flags.

- [ ] **Step 6: Re-export the new names from the barrel**

`src/index.ts` enumerates the `replay/types.js` exports by name — a new type is
NOT picked up automatically. In the `export { ... } from "./replay/types.js"`
block (around line 360), add `isSupersededStep` beside `isRepairStep`, and these
to the type list:

```ts
  type NodeLocation,
  type RemainderAction,
  type RemainderEdge,
  type RunInput,
  type RunOutcome,
  type RunStop,
  type SegmentCut,
  type SupersededStep,
```

Add `"isSupersededStep"` to the exported-names array in
`test/replay.barrel.test.ts`.

- [ ] **Step 7: Convert the barrel guard to a directory glob**

In `test/replay.barrel.test.ts`, replace the three hand-written file lists. A guard that must be remembered is a guard that will eventually be forgotten — `locate.ts` and `run.ts` arrive in later tasks and must be covered without anyone opting them in.

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPLAY_DIR = join(process.cwd(), "src/replay");
/** Every file in replay/, so a file added later is covered by default. */
const replayFiles = (): string[] =>
  readdirSync(REPLAY_DIR).filter((f) => f.endsWith(".ts"));
const read = (f: string): string => readFileSync(join(REPLAY_DIR, f), "utf8");
```

Then, in the three checks, iterate `replayFiles()` instead of the literal arrays. `sidecar.ts` stays the single named exemption from the spawn check:

```ts
  it("only sidecar.ts spawns a process anywhere in replay/", () => {
    for (const file of replayFiles()) {
      if (file === "sidecar.ts") continue;
      expect(read(file), `${file} must not spawn`).not.toMatch(
        /child_process|execFile|\bspawn\(/,
      );
    }
    // The exemption must stay real: if sidecar.ts stopped spawning, this guard
    // would be silently exempting a file that no longer needs it.
    expect(read("sidecar.ts")).toMatch(/\bspawn\(/);
  });

  it("replay/ never imports store, represent, or retrieve", () => {
    for (const file of replayFiles()) {
      expect(read(file), `${file} must stay a leaf`).not.toMatch(
        /from "\.\.\/(store|represent|retrieve)\//,
      );
    }
  });
```

Leave the `plan.ts never calls activate` check as it is — it names one file on purpose.

- [ ] **Step 8: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS, including the new `test/replay.types.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add src/replay/types.ts src/replay/plan.ts src/index.ts test/
git commit -m "feat(replay): vocabulary for segmented plans, and a barrel guard by glob"
```

---

### Task 2: `locateNode` — which recorded node is still true here

**Files:**
- Create: `src/replay/locate.ts`
- Modify: `src/index.ts`
- Test: `test/replay.locate.test.ts` (create)

**Interfaces:**
- Consumes: `verifyNode` from `./verify.js`; `NodeLocation` from Task 1.
- Produces: `locateNode(observed: readonly Predicate[], nodes: readonly TraceNode[]): NodeLocation`.

- [ ] **Step 1: Write the failing test**

Create `test/replay.locate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { locateNode } from "../src/replay/locate.js";
import type { Predicate } from "../src/replay/types.js";
import type { TraceNode } from "../src/trace/types.js";

const app = (name: string): Predicate => ({
  kind: "app",
  args: { app: name },
  reach: "achievable",
});
const exists = (role: string, label: string): Predicate => ({
  kind: "ax_exists",
  args: { role, label },
  reach: "achievable",
});

const node = (id: string, predicates: Predicate[]): TraceNode => ({
  id,
  predicates,
  intervene: "select",
  observations: 1,
});

describe("locateNode", () => {
  it("locates the node whose every predicate holds", () => {
    const nodes = [node("n1", [app("TextEdit"), exists("Button", "Save")])];
    const r = locateNode([app("TextEdit"), exists("Button", "Save")], nodes);
    expect(r.nodeId).toBe("n1");
    expect(r.candidates).toBe(1);
    expect(r.ambiguous).toBe(false);
  });

  /**
   * Verification is SUBSET, so extra observed predicates are not violations.
   * That is what lets a node match a screen that gained something since it was
   * recorded — the common case, given how aggressive the stability filter is.
   */
  it("tolerates observed predicates the node never claimed", () => {
    const nodes = [node("n1", [app("TextEdit")])];
    const r = locateNode([app("TextEdit"), exists("Button", "New")], nodes);
    expect(r.nodeId).toBe("n1");
  });

  /**
   * Subset matching is MONOTONE: a node carrying only `app` is satisfied by every
   * observation in that app. So the most specific description that still holds
   * wins, or a two-predicate node would beat a twenty-predicate one at random.
   */
  it("prefers the most specific candidate over one that is a strict subset", () => {
    const nodes = [
      node("broad", [app("TextEdit")]),
      node("specific", [app("TextEdit"), exists("Button", "Save"), exists("Button", "New")]),
    ];
    const r = locateNode(
      [app("TextEdit"), exists("Button", "Save"), exists("Button", "New")],
      nodes,
    );
    expect(r.nodeId).toBe("specific");
    expect(r.candidates).toBe(2);
  });

  /** A redundant node is visible and fixable; a wrong match sends replay down
   *  another context's branch. Ambiguity never guesses. */
  it("declines when two candidates are equally specific", () => {
    const nodes = [
      node("a", [app("TextEdit"), exists("Button", "Save")]),
      node("b", [app("TextEdit"), exists("Button", "New")]),
    ];
    const r = locateNode(
      [app("TextEdit"), exists("Button", "Save"), exists("Button", "New")],
      nodes,
    );
    expect(r.nodeId).toBeUndefined();
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toBe(2);
  });

  it("reports nothing found rather than throwing", () => {
    const r = locateNode([app("WebStorm")], [node("n1", [app("TextEdit")])]);
    expect(r.nodeId).toBeUndefined();
    expect(r.candidates).toBe(0);
    expect(r.ambiguous).toBe(false);
  });

  /**
   * Not a hypothetical: `n0` in the recorded graph carries no predicates. An
   * empty set is vacuously a subset of EVERY observation, so it would verify
   * against any desktop at all. Ranking it last is not enough — it would still
   * be returned when it is the only candidate.
   */
  it("never returns a zero-predicate node, even as the only candidate", () => {
    const r = locateNode([app("TextEdit")], [node("n0", [])]);
    expect(r.nodeId).toBeUndefined();
    expect(r.candidates).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/replay.locate.test.ts`
Expected: FAIL — cannot resolve `../src/replay/locate.js`.

- [ ] **Step 3: Write the implementation**

Create `src/replay/locate.ts`:

```ts
/**
 * Locating the live desktop in a recorded graph — "which recorded state is still
 * true here?".
 *
 * Deliberately NOT `trace/identity.ts`'s `matchNode`. That matches on
 * `samePredicateSet`, exact equality, which is right for MERGING: a differing
 * set is a different state. Locating asks a different question, and a live
 * screen that gained anything since recording would never match exactly.
 *
 * Its visual fallback is unavailable here in any case: there is no live frame at
 * replay time, which is the same reason `resolve.ts` records the visual rung as
 * "no live frame to corroborate against".
 *
 * Pure: no subprocess, no clock, no I/O.
 */

import type { TraceNode } from "../trace/types.js";
import type { NodeLocation, Predicate } from "./types.js";
import { verifyNode } from "./verify.js";

export function locateNode(
  observed: readonly Predicate[],
  nodes: readonly TraceNode[],
): NodeLocation {
  // A node with NO predicates is vacuously satisfied by every observation, so it
  // would verify against any desktop. Excluded outright rather than ranked last:
  // ranking cannot help when it is the only candidate.
  const candidates = nodes.filter(
    (n) => n.predicates.length > 0 && verifyNode(n.predicates, observed).satisfied,
  );
  if (candidates.length === 0) return { candidates: 0, ambiguous: false };

  // Subset matching is monotone — fewer predicates are satisfied by strictly
  // more worlds — so the most specific description that still holds wins.
  const most = Math.max(...candidates.map((n) => n.predicates.length));
  const top = candidates.filter((n) => n.predicates.length === most);
  if (top.length > 1) return { candidates: candidates.length, ambiguous: true };
  return { nodeId: top[0]!.id, candidates: candidates.length, ambiguous: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/replay.locate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Export from the barrel**

In `src/index.ts`, beside the other `replay/` exports, add:

```ts
export { locateNode } from "./replay/locate.js";
```

Then add `"locateNode"` to the exported-names array in `test/replay.barrel.test.ts`.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/replay/locate.ts src/index.ts test/replay.locate.test.ts test/replay.barrel.test.ts
git commit -m "feat(replay): locate the live node by the subset rule"
```

---

### Task 3: Supersession, and the repair moved to the edge's end

**Files:**
- Modify: `src/replay/plan.ts`
- Test: `test/replay.plan-supersede.test.ts` (create)

**Interfaces:**
- Consumes: `SupersededStep`, `RepairStep.edgeId` from Task 1.
- Produces: no new exports. `buildPlan` now emits `SupersededStep`s and places each `RepairStep` after its edge's other actions.

**Why this changes shipped behaviour:** `plan.ts` currently pushes the repair *before* the edge's actions, but the `app` predicate it repairs lives on the **destination** node — it must hold at the edge's *end*. The edge's own actions run in the *source* app, so today a cross-app plan would activate Chrome and then post TextEdit's clicks and keystrokes into it. Measured on the real graph: `e2` is a TextEdit click, ⌘A, typing "this is a new line", then the Dock click.

- [ ] **Step 1: Write the failing test**

Create `test/replay.plan-supersede.test.ts`:

```ts
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

  /** Both conditions are required. Absence of evidence never produces a silent
   *  change: a final action with an AX layer cannot have been the switch. */
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
   * run in the source app.
   */
  it("emits the repair AFTER the edge's other actions, never before", async () => {
    const plan = await planFor(crossApp([clickOn(axAnchor), clickOn(pointAnchor)]));
    const repairIndex = plan.steps.findIndex(isRepairStep);
    const clickIndex = plan.steps.findIndex(
      (s) => !isRepairStep(s) && !isSupersededStep(s),
    );
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/replay.plan-supersede.test.ts`
Expected: FAIL — no `SupersededStep` is ever emitted, and the repair is emitted first.

- [ ] **Step 3: Implement supersession in `plan.ts`**

Add two helpers above `buildPlan`:

```ts
/** Actions with a spatial target; the only kinds an anchor belongs to. */
const isSpatial = (
  a: Action,
): a is Extract<Action, { kind: "click" | "hover" | "scroll" | "drag" }> =>
  a.kind === "click" || a.kind === "hover" || a.kind === "scroll" || a.kind === "drag";

/** The anchor an action aims at — `from` for a drag, `anchor` for the rest. */
const anchorOf = (a: Action): Anchor | undefined =>
  a.kind === "drag" ? a.from : isSpatial(a) ? a.anchor : undefined;

/**
 * Indices of the actions a repair for `app` REPLACES.
 *
 * The final action when it is spatial and carries no `ax` layer — both
 * conditions required. The switch target sits outside the focused window's tree
 * by definition, which is exactly why the recorded Dock click is point-only; an
 * action aimed at an element in the app's own tree cannot have been the switch.
 *
 * Plus every `wait { until: app(X) }`, wherever it sits: `runRepair` already
 * polls that predicate before returning, so dropping one is a no-op rather than
 * a skipped check. Measurement put them mid-edge, not beside the switch.
 */
function supersededBy(actions: readonly Action[], app: string): Set<number> {
  const out = new Set<number>();
  const lastIndex = actions.length - 1;
  const last = actions[lastIndex];
  if (last !== undefined && isSpatial(last) && anchorOf(last)?.ax === undefined) {
    out.add(lastIndex);
  }
  actions.forEach((a, i) => {
    if (a.kind === "wait" && a.until.kind === "app" && a.until.args.app === app) out.add(i);
  });
  return out;
}
```

Add `Action` and `Anchor` to the `trace/types.js` type import at the top of `plan.ts`.

Then restructure the per-edge body of `buildPlan`. Replace the repair block so it *builds* the repair without pushing it:

```ts
    // Repair an unmet `app` predicate by raising that application. Not pushed
    // yet: it belongs at the edge's END, because the `app` predicate is on the
    // DESTINATION node and the edge's own actions run in the source app.
    let repair: RepairStep | undefined;
    if (to !== undefined && input.runningApps !== undefined) {
      const wanted = to.predicates.find((p) => p.kind === "app")?.args.app;
      if (typeof wanted === "string" && wanted.length > 0 && wanted !== frontmost) {
        const running = input.runningApps.includes(wanted);
        const mayLaunch = input.allowLaunch === true;
        if (!running && !mayLaunch) {
          blockers.push({ reason: `${wanted} is not running`, scope: "segment" });
        } else {
          repair = {
            repair: "activate",
            edgeId: edge.id,
            app: wanted,
            launch: !running && mayLaunch,
            reason: `app(app="${wanted}") does not hold`,
          };
        }
        frontmost = wanted;
      }
    }

    const superseded = repair === undefined ? new Set<number>() : supersededBy(edge.actions, repair.app);
```

Change the action loop to skip superseded indices, and append the repair afterwards:

```ts
    for (const [i, action] of edge.actions.entries()) {
      if (superseded.has(i)) {
        // Visible, never silent: the review has to be able to say what will not
        // be posted and why.
        steps.push({
          superseded: "activate",
          edgeId: edge.id,
          action,
          reason: `activating ${repair!.app} replaces this`,
        });
        continue;
      }

      const step: PlannedAction = { edgeId: edge.id, action };
      // ...the existing click/hover/scroll/drag/type body, unchanged...
      steps.push(step);
    }

    if (repair !== undefined) steps.push(repair);
```

Because superseded actions `continue` before the `targets++` counters, they are excluded from the edge's AX rate automatically — which is the intended effect, not a side effect.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/replay.plan-supersede.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Update the pre-existing activation tests**

Run: `npx vitest run test/replay.plan-activate.test.ts`

Any assertion that the repair is the *first* step now fails — that is the intended correction, so re-express the assertion rather than relaxing it. For example, an assertion reading `expect(isRepairStep(plan.steps[0]!)).toBe(true)` becomes:

```ts
    // The repair belongs at the edge's END: the `app` predicate is on the
    // DESTINATION node, and the edge's own actions run in the source app.
    expect(isRepairStep(plan.steps[plan.steps.length - 1]!)).toBe(true);
```

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/replay/plan.ts test/replay.plan-supersede.test.ts test/replay.plan-activate.test.ts
git commit -m "fix(replay): supersede the recorded app switch, and repair at the edge's end"
```

---

### Task 4: The greedy cut, the remainder, and arming over both

**Files:**
- Modify: `src/replay/plan.ts`
- Modify: `src/replay/execute.ts` (the `canArm` message only)
- Test: `test/replay.plan-cut.test.ts` (create)

**Interfaces:**
- Consumes: `SegmentCut`, `RemainderEdge`, `RemainderAction` from Task 1; `isSpatial`/`anchorOf`/`supersededBy` from Task 3.
- Produces: `buildPlan` now sets `Plan.cut` and `Plan.remainder`, and pushes remainder blockers (`scope: "remainder"`) and remainder brittleness (`bound: "upper"`) into the same arrays `canArm` already reads.

- [ ] **Step 1: Write the failing test**

Create `test/replay.plan-cut.test.ts`. Reuse the fixture helpers from Task 3 verbatim (`appPred`, `node`, `pointAnchor`, `axAnchor`, `clickOn`, `edge`, `graph`) — copy them into this file; do not import from another test.

```ts
import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/replay/plan.js";
import { canArm } from "../src/replay/execute.js";
import { isSupersededStep, isRepairStep } from "../src/replay/types.js";
import type { AxDescriptor, Locate, Predicate } from "../src/replay/types.js";
import type { Action, Anchor, Graph, TraceEdge, TraceNode } from "../src/trace/types.js";

const appPred = (app: string): Predicate => ({
  kind: "app",
  args: { app },
  reach: "achievable",
});
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
const locateOnly = (...ids: string[]): Locate =>
  async (d: AxDescriptor) =>
    d.identifier !== undefined && ids.includes(d.identifier)
      ? { handle: 1, bounds: { x: 10, y: 20, w: 10, h: 10 } }
      : null;

const chain = graph(
  [node("n0", [appPred("TextEdit")]), node("n1", [appPred("TextEdit")]), node("n2", [appPred("TextEdit")])],
  [
    edge("e0", "n0", "n1", [clickOn(axAnchor("a"))]),
    edge("e1", "n1", "n2", [clickOn(axAnchor("b"))]),
  ],
);

const build = (over: Partial<Parameters<typeof buildPlan>[0]> = {}) =>
  buildPlan({
    graph: chain,
    fromNodeId: "n0",
    toNodeId: "n2",
    observed: [appPred("TextEdit")],
    locate: locateOnly("a", "b"),
    ...over,
  });

describe("buildPlan: the greedy cut", () => {
  it("does not cut when every anchor resolves — one segment, as today", async () => {
    const plan = await build();
    expect(plan.cut).toBeUndefined();
    expect(plan.remainder).toEqual([]);
    expect(plan.steps).toHaveLength(2);
  });

  /**
   * The executor MEASURING that it is describing a state which does not exist
   * yet: the anchor carries descriptors, so it should resolve — and does not.
   */
  it("cuts at the first ax-carrying anchor that reaches no AX rung", async () => {
    const plan = await build({ locate: locateOnly("a") });
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
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [appPred("TextEdit")],
      locate: locateOnly("a"),
    });
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
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n1",
      observed: [appPred("TextEdit")],
      locate: locateOnly(),
    });
    expect(plan.cut).toBeUndefined();
    expect(plan.steps).toHaveLength(1);
  });

  it("discloses the remainder without resolving it", async () => {
    const plan = await build({ locate: locateOnly("a") });
    const r = plan.remainder[0]!;
    expect(r.toNodeId).toBe("n2");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.kind).toBe("click");
    expect(r.actions[0]!.descriptors).toEqual(["identifier", "path"]);
    expect(r.actions[0]!.recordedPoint).toEqual({ x: 10, y: 20 });
  });

  it("marks segment brittleness measured and remainder brittleness upper", async () => {
    const plan = await build({ locate: locateOnly("a") });
    expect(plan.brittleness.find((b) => b.edgeId === "e0")!.bound).toBe("measured");
    const rem = plan.brittleness.find((b) => b.edgeId === "e1")!;
    expect(rem.bound).toBe("upper");
    // The anchor carries an `ax` layer, so its ceiling is 100% — it simply has
    // not been resolved yet.
    expect(rem.axRate).toBe(1);
  });

  /**
   * A deductive ceiling, not a forecast: an anchor with no `ax` layer can never
   * reach an AX rung, at any time, by any mechanism. Without this, a reviewer
   * can arm segment 1, change the real world, and only then discover segment 2
   * can never arm — a dead end reached by acting.
   */
  it("bounds a point-only remainder edge below the floor, refusing to arm", async () => {
    const g = graph(
      [node("n0", [appPred("TextEdit")]), node("n1", [appPred("TextEdit")]), node("n2", [appPred("TextEdit")])],
      [
        edge("e0", "n0", "n1", [clickOn(axAnchor("a"))]),
        edge("e1", "n1", "n2", [clickOn(axAnchor("gone"))]),
        edge("e2", "n2", "n2", [clickOn(pointAnchor)]),
      ],
    );
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n2",
      observed: [appPred("TextEdit")],
      locate: locateOnly("a"),
    });
    const rem = plan.brittleness.find((b) => b.edgeId === "e1")!;
    expect(rem.bound).toBe("upper");
    expect(plan.remainder.map((r) => r.edgeId)).toEqual(["e1"]);
  });

  /**
   * `assertable` means no UI action can produce it, so checking a remainder
   * node against the PRESENT observation is valid — an unreachable goal is
   * knowable before anything is posted.
   */
  it("raises a remainder blocker, scoped, and refuses to arm on it", async () => {
    const g = graph(
      [
        node("n0", [appPred("TextEdit")]),
        node("n1", [appPred("TextEdit")]),
        node("n2", [appPred("TextEdit"), displayPred("D9")]),
      ],
      [
        edge("e0", "n0", "n1", [clickOn(axAnchor("a"))]),
        edge("e1", "n1", "n2", [clickOn(axAnchor("gone"))]),
      ],
    );
    const plan = await buildPlan({
      graph: g,
      fromNodeId: "n0",
      toNodeId: "n2",
      observed: [appPred("TextEdit")],
      locate: locateOnly("a"),
    });
    const blocked = plan.blockers.find((b) => b.scope === "remainder");
    expect(blocked).toBeDefined();
    expect(canArm(plan).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/replay.plan-cut.test.ts`
Expected: FAIL — `plan.cut` is always undefined and `plan.remainder` always empty.

- [ ] **Step 3: Implement the cut and the remainder**

Add helpers to `plan.ts` above `buildPlan`:

```ts
/** The descriptors the RECORDING carries. A fact about the anchor, never a
 *  forecast of what it will resolve to. */
function descriptorsOf(anchor: Anchor | undefined): RemainderAction["descriptors"] {
  if (anchor === undefined) return undefined;
  const d: NonNullable<RemainderAction["descriptors"]> = [];
  if (anchor.ax?.identifier !== undefined && anchor.ax.identifier.length > 0) d.push("identifier");
  if (anchor.ax?.label !== undefined && anchor.ax.label.length > 0) d.push("label");
  if (anchor.ax?.path !== undefined && anchor.ax.path.length > 0) d.push("path");
  if (anchor.visual !== undefined) d.push("visual");
  return d.length > 0 ? d : undefined;
}

/**
 * The deductive CEILING on an edge's AX rate. An anchor with no `ax` layer can
 * never resolve to an AX rung — at any time, by any mechanism — so this is
 * arithmetic over the recording, not a prediction.
 */
function axCeiling(actions: readonly Action[]): number {
  const spatial = actions.filter(isSpatial);
  if (spatial.length === 0) return 1; // matches the measured branch: no targets, no doubt
  return spatial.filter((a) => anchorOf(a)?.ax !== undefined).length / spatial.length;
}

function remainderActionOf(action: Action): RemainderAction {
  const anchor = anchorOf(action);
  const descriptors = descriptorsOf(anchor);
  return {
    kind: action.kind,
    ...(descriptors !== undefined ? { descriptors } : {}),
    ...(anchor !== undefined
      ? { recordedPoint: { x: anchor.point.x, y: anchor.point.y } }
      : {}),
    ...(action.kind === "type" ? { slot: action.slot } : {}),
  };
}
```

Import `RemainderAction`, `RemainderEdge`, `SegmentCut` and `SupersededStep` from `./types.js`.

Restructure the loop over `path`. The shape is: plan each edge into a **temporary** buffer, and if any anchor cuts, discard the buffer and send this edge plus all later ones to the remainder.

```ts
  let cut: SegmentCut | undefined;
  const remainder: RemainderEdge[] = [];

  for (const edge of path) {
    const to = nodesById.get(edge.to);

    // Assertable predicates gate the WHOLE run, segment or remainder alike.
    if (to !== undefined) {
      for (const v of blockersOf(verifyNode(to.predicates, input.observed).violations)) {
        blockers.push({
          predicate: v.predicate,
          reason: "assertable predicate does not hold",
          scope: cut === undefined ? "segment" : "remainder",
        });
      }
    }

    // Build the repair WITHOUT pushing it: it belongs at the edge's end.
    let repair: RepairStep | undefined;
    if (to !== undefined && input.runningApps !== undefined) {
      const wanted = to.predicates.find((p) => p.kind === "app")?.args.app;
      if (typeof wanted === "string" && wanted.length > 0 && wanted !== frontmost) {
        const running = input.runningApps.includes(wanted);
        const mayLaunch = input.allowLaunch === true;
        if (!running && !mayLaunch) {
          blockers.push({
            reason: `${wanted} is not running`,
            scope: cut === undefined ? "segment" : "remainder",
          });
        } else {
          repair = {
            repair: "activate",
            edgeId: edge.id,
            app: wanted,
            launch: !running && mayLaunch,
            reason: `app(app="${wanted}") does not hold`,
          };
        }
        frontmost = wanted;
      }
    }

    const superseded =
      repair === undefined ? new Set<number>() : supersededBy(edge.actions, repair.app);
    const kept = edge.actions.filter((_, i) => !superseded.has(i));

    if (cut !== undefined) {
      remainder.push({
        edgeId: edge.id,
        toNodeId: edge.to,
        actions: kept.map(remainderActionOf),
        repairs: repair === undefined ? [] : [repair],
      });
      const ceiling = axCeiling(kept);
      brittleness.push({
        edgeId: edge.id,
        axRate: ceiling,
        belowFloor: ceiling < BRITTLENESS_FLOOR,
        bound: "upper",
      });
      continue;
    }

    const buffer: PlanStep[] = [];
    const bufferedBlockers: Blocker[] = [];
    let targets = 0;
    let axTargets = 0;
    let edgeCut: SegmentCut | undefined;

    for (const [i, action] of edge.actions.entries()) {
      if (superseded.has(i)) {
        buffer.push({
          superseded: "activate",
          edgeId: edge.id,
          action,
          reason: `activating ${repair!.app} replaces this`,
        });
        continue;
      }

      const step: PlannedAction = { edgeId: edge.id, action };
      const anchor = anchorOf(action);

      if (anchor !== undefined && action.kind !== "drag") {
        const r = await resolveAnchor(anchor, input.locate, resolveOpts);
        // The cut: the anchor CARRIES descriptors and still reached no AX rung.
        if (r.layer === "point" && anchor.ax !== undefined) {
          edgeCut = { resumeAt: edge.from, edgeId: edge.id, attempts: r.attempts };
          break;
        }
        step.resolution = r;
        targets++;
        if (r.layer !== "point") axTargets++;
      } else if (action.kind === "drag") {
        const r = await resolveAnchor(action.from, input.locate, resolveOpts);
        if (r.layer === "point" && action.from.ax !== undefined) {
          edgeCut = { resumeAt: edge.from, edgeId: edge.id, attempts: r.attempts };
          break;
        }
        step.resolution = r;
        targets++;
        if (r.layer !== "point") axTargets++;
      } else if (action.kind === "type") {
        const bound = input.slotBindings?.[action.slot];
        const value = bound ?? action.recorded;
        if (bound !== undefined) step.slotBinding = { name: action.slot, value: bound };
        if (input.keymap === undefined) {
          bufferedBlockers.push({
            reason: `no keymap supplied: cannot type "${value}"`,
            scope: "segment",
          });
        } else if (strokesFor(value, input.keymap) === null) {
          bufferedBlockers.push({
            reason: `"${value}" cannot be typed with layout ${input.keymap.layoutId}`,
            scope: "segment",
          });
        }
      }

      buffer.push(step);
    }

    if (edgeCut !== undefined) {
      // Cut at the EDGE boundary: discard the partial plan for this edge and
      // disclose the whole edge instead. A node boundary is the only place the
      // world can be re-observed.
      cut = edgeCut;
      remainder.push({
        edgeId: edge.id,
        toNodeId: edge.to,
        actions: kept.map(remainderActionOf),
        repairs: repair === undefined ? [] : [repair],
      });
      const ceiling = axCeiling(kept);
      brittleness.push({
        edgeId: edge.id,
        axRate: ceiling,
        belowFloor: ceiling < BRITTLENESS_FLOOR,
        bound: "upper",
      });
      continue;
    }

    steps.push(...buffer, ...(repair === undefined ? [] : [repair]));
    blockers.push(...bufferedBlockers);
    const axRate = targets > 0 ? axTargets / targets : 1;
    brittleness.push({
      edgeId: edge.id,
      axRate,
      belowFloor: axRate < BRITTLENESS_FLOOR,
      bound: "measured",
    });
  }
```

Return `cut` and `remainder` from the plan:

```ts
  return {
    id: input.planId ?? ulid(),
    graphId: input.graph.id,
    from: input.fromNodeId,
    to: input.toNodeId,
    steps,
    blockers,
    brittleness,
    ...(cut !== undefined ? { cut } : {}),
    remainder,
  };
```

Import `Blocker` and `PlanStep` types if they are not already imported.

- [ ] **Step 4: Make `canArm` name the scope**

In `src/replay/execute.ts`, `canArm` already reads both arrays, so remainder entries gate automatically. Only the message changes, so a reviewer can tell which half refused:

```ts
export function canArm(plan: Plan, override = false): { ok: boolean; reason?: string } {
  if (plan.blockers.length > 0) {
    return {
      ok: false,
      reason: plan.blockers.map((b) => `${b.reason} (${b.scope})`).join("; "),
    };
  }
  const brittle = plan.brittleness.filter((b) => b.belowFloor);
  if (brittle.length > 0 && !override) {
    return {
      ok: false,
      reason: `brittle edges (majority of targets resolve to coordinates only): ${brittle
        .map((b) => `${b.edgeId} @ ${(b.axRate * 100).toFixed(0)}% ${b.bound}`)
        .join(", ")}`,
    };
  }
  return { ok: true };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/replay.plan-cut.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS. If an assertion in `test/replay.plan.test.ts` now cuts where it previously planned a stale point resolution, that is the intended change — re-express the assertion to expect the cut, do not relax it.

- [ ] **Step 7: Commit**

```bash
git add src/replay/plan.ts src/replay/execute.ts test/replay.plan-cut.test.ts test/replay.plan.test.ts
git commit -m "feat(replay): cut the plan at the resolution frontier and disclose the remainder"
```

---

### Task 5: Execution — superseded no-ops, drag `to`, and node-boundary verification

**Files:**
- Modify: `src/replay/execute.ts`
- Test: `test/replay.execute-boundary.test.ts` (create)

**Interfaces:**
- Consumes: `isSupersededStep`, `RepairStep.edgeId` from Task 1; `locateNode` is NOT used here.
- Produces: no new exports. `executePlan` verifies each edge's destination node after the edge's last step, resolves a drag's `to` endpoint, and treats a `SupersededStep` as a no-op.

- [ ] **Step 1: Write the failing test**

Create `test/replay.execute-boundary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { executePlan } from "../src/replay/execute.js";
import type {
  Actuator,
  AxDescriptor,
  AxObservation,
  Plan,
  Predicate,
  Rect,
  Vec2,
} from "../src/replay/types.js";
import type { Graph, TraceEdge, TraceNode } from "../src/trace/types.js";

const keymap = { layoutId: "com.apple.keylayout.US", entries: { 0: ["a", "A", "å", "Å"] } };

class FakeActuator implements Actuator {
  posted: string[] = [];
  constructor(private readonly observations: AxObservation[]) {}
  private turn = 0;
  async dump(): Promise<AxObservation> {
    const o = this.observations[Math.min(this.turn, this.observations.length - 1)]!;
    this.turn++;
    return o;
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
  async moveTo(): Promise<void> {
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

const el = (role: string, label: string): AxObservation["elements"][number] =>
  ({ role, label, x: 0, y: 0, w: 10, h: 10 }) as AxObservation["elements"][number];

const obs = (app: string, labels: string[]): AxObservation => ({
  app,
  elements: labels.map((l) => el("Button", l)),
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
    const actuator = new FakeActuator([obs("TextEdit", ["Saved"])]);
    const out = await executePlan(plan([clickStep()]), { graph: g, actuator, keymap });
    expect(out.completed).toBe(true);
    expect(actuator.posted).toContain("click");
  });

  /** The executor spec promised verification at every node boundary; without it
   *  a segment can drift and the next segment re-plans from a lie. */
  it("aborts naming the predicate when the destination state did not arrive", async () => {
    const actuator = new FakeActuator([obs("TextEdit", ["Unchanged"])]);
    const out = await executePlan(plan([clickStep()]), { graph: g, actuator, keymap });
    expect(out.completed).toBe(false);
    expect(out.failure?.reason).toContain("Saved");
  });

  it("treats a superseded step as a no-op that posts nothing", async () => {
    const actuator = new FakeActuator([obs("TextEdit", ["Saved"])]);
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
    const actuator = new FakeActuator([obs("TextEdit", [])]);
    const out = await executePlan(plan([dragStep("target")]), { graph: g, actuator, keymap });
    expect(out.completed).toBe(true);
    expect(actuator.posted).toContain("drag");
  });

  /** Never a fallback to the recorded coordinate: that is the drift the IR
   *  forbids, and a drag that lands in the wrong place is not recoverable. */
  it("aborts when the `to` endpoint no longer resolves", async () => {
    const actuator = new FakeActuator([obs("TextEdit", [])]);
    const out = await executePlan(plan([dragStep("gone")]), { graph: g, actuator, keymap });
    expect(out.completed).toBe(false);
    expect(actuator.posted).not.toContain("drag");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/replay.execute-boundary.test.ts`
Expected: FAIL — no boundary verification happens, a superseded step throws (no resolution), and the drag `to` is never resolved.

- [ ] **Step 3: Implement in `execute.ts`**

Add imports: `isSupersededStep` from `./types.js`, `resolveAnchor` from `./resolve.js`, `verifyNode` from `./verify.js`, `windowOriginOf` from `./observe.js`, and the `SupersededStep` type.

Add a helper for which edge a step belongs to:

All three step kinds carry `edgeId` after Task 1, so the edge a step belongs to
is a single property read — `step.edgeId` — and needs no helper.

In `executePlan`, before the loop, compute the last step index for each edge:

```ts
  // The last step of an edge is its node boundary. Computed once rather than
  // scanned per step.
  const lastStepOfEdge = new Map<string, number>();
  plan.steps.forEach((s, i) => lastStepOfEdge.set(s.edgeId, i));
  const nodesById = new Map(input.graph.nodes.map((n) => [n.id, n]));
  const edgesById = new Map(input.graph.edges.map((e) => [e.id, e]));
```

After a step runs successfully (inside the `try`, after `runStep`/`runRepair`), verify the boundary:

```ts
      const edgeId = step.edgeId;
      if (lastStepOfEdge.get(edgeId) === i) {
        const dest = nodesById.get(edgesById.get(edgeId)?.to ?? "");
        // Skip when the graph does not describe this edge, or the node claims
        // nothing: there is no state to verify, and inventing one would fail
        // every plan built against a partial graph.
        if (dest !== undefined && dest.predicates.length > 0) {
          const observed = await observe(input.actuator);
          const { violations } = verifyNode(dest.predicates, observed);
          if (violations.length > 0) {
            const names = violations.map((v) => predicateKey(v.predicate)).join(", ");
            throw new Error(`node ${dest.id} did not verify after edge ${edgeId}: ${names}`);
          }
        }
      }
```

In `runStep`, make a superseded step a no-op. Add at the top of `executePlan`'s loop body, before the telemetry push:

```ts
    if (isSupersededStep(step)) {
      // Exists to be reviewed, not run. The repair replaces it.
      stepsRun++;
      continue;
    }
```

Place this *before* the boundary check is reached for that index — instead, keep the boundary check by moving the `continue` to after the boundary verification block. Simplest correct ordering inside the loop:

1. if `isSupersededStep(step)` → skip actuation, still run the boundary check, `stepsRun++`, continue.
2. otherwise → telemetry, `runRepair`/`runStep`, boundary check, `stepsRun++`.

Extract the boundary check into a local `async function verifyBoundary(i: number, step: PlanStep): Promise<void>` inside `executePlan` and call it from both paths, so there is one copy.

Finally, resolve the drag `to` in `runStep`:

```ts
    case "drag": {
      const from = requirePoint(step);
      // The `to` endpoint resolves HERE, against the same ladder — closing the
      // gap between what plan.ts documented and what this did. Never a fallback
      // to the recorded coordinate: a drag that ends in the wrong place is not
      // a recoverable error.
      const resolvedTo = await resolveAnchor(action.to, (d) => actuator.locate(d), {
        ...(windowOriginOf(await actuator.dump()) !== undefined
          ? { windowOrigin: windowOriginOf(await actuator.dump())! }
          : {}),
      });
      if (resolvedTo.layer === "point" && action.to.ax !== undefined) {
        throw new Error(`drag target on edge ${step.edgeId} no longer resolves`);
      }
      const to: Vec2 = resolvedTo.point;
      const points = projectPath(action.path, from, to);
      const stepMs = action.path.durationMs / Math.max(1, points.length - 1);
      const samples = points.map((p, i) => ({ p, atMs: Math.round(i * stepMs) }));
      await actuator.dragPath(samples, action.button);
      return;
    }
```

Simplify the double `dump()` above into one call:

```ts
      const observation = await actuator.dump();
      const origin = windowOriginOf(observation);
      const resolvedTo = await resolveAnchor(
        action.to,
        (d) => actuator.locate(d),
        origin !== undefined ? { windowOrigin: origin } : {},
      );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/replay.execute-boundary.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS. Existing `test/replay.execute.test.ts` plans use a graph whose nodes carry no predicates, so boundary verification skips them and those tests are unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/replay/execute.ts test/replay.execute-boundary.test.ts
git commit -m "feat(replay): verify at node boundaries and resolve drag targets at execution"
```

---

### Task 6: `executeRun` — the segment loop

**Files:**
- Create: `src/replay/run.ts`
- Modify: `src/replay/observe.ts` (expose `predicatesOf`)
- Modify: `src/index.ts`
- Modify: `test/replay.barrel.test.ts` (exported-names list)
- Modify: `CLAUDE.md`
- Test: `test/replay.run.test.ts` (create)

**Interfaces:**
- Consumes: `locateNode` (Task 2), `buildPlan`/`findPath` (Tasks 3–4), `executePlan`/`canArm` (Task 5), `RunInput`/`RunOutcome`/`RunStop` (Task 1).
- Produces: `executeRun(input: RunInput): Promise<RunOutcome>` and `predicatesOf(o: AxObservation): Predicate[]`.

- [ ] **Step 1: Write the failing test**

Create `test/replay.run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { executeRun } from "../src/replay/run.js";
import type {
  Actuator,
  AxDescriptor,
  AxObservation,
  Plan,
  Predicate,
  Rect,
} from "../src/replay/types.js";
import type { Action, Graph, TraceEdge, TraceNode } from "../src/trace/types.js";

const keymap = { layoutId: "com.apple.keylayout.US", entries: { 0: ["a", "A", "å", "Å"] } };

const el = (label: string): AxObservation["elements"][number] =>
  ({ role: "Button", label, x: 0, y: 0, w: 10, h: 10 }) as AxObservation["elements"][number];

/** Steps through a script of observations, one per dump, holding at the last. */
class ScriptedActuator implements Actuator {
  posted: string[] = [];
  dumps = 0;
  constructor(
    private readonly script: AxObservation[],
    private readonly resolvable: (d: AxDescriptor) => boolean,
  ) {}
  async dump(): Promise<AxObservation> {
    const o = this.script[Math.min(this.dumps, this.script.length - 1)]!;
    this.dumps++;
    return o;
  }
  async runningApps(): Promise<string[]> {
    return ["TextEdit"];
  }
  async activate(): Promise<"activated"> {
    return "activated";
  }
  async locate(d: AxDescriptor): Promise<{ handle: number; bounds: Rect } | null> {
    return this.resolvable(d) ? { handle: 1, bounds: { x: 0, y: 0, w: 10, h: 10 } } : null;
  }
  async moveTo(): Promise<void> {
    this.posted.push("move");
  }
  async click(): Promise<void> {
    this.posted.push("click");
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

/** n0 -e0-> n1 -e1-> n2, each node distinguished by one button. */
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
    // Only "first" resolves at n0; only "second" resolves at n1 — which is what
    // forces the cut and therefore a second segment.
    let stage = 0;
    const actuator = new ScriptedActuator(
      [at("Start"), at("Start"), at("Middle"), at("Middle"), at("End"), at("End")],
      (d) => (stage === 0 ? d.identifier === "first" : d.identifier === "second"),
    );
    const armed: Plan[] = [];
    const out = await executeRun({
      graph,
      actuator,
      keymap,
      goalNodeId: "n2",
      arm: async (p) => {
        armed.push(p);
        stage++;
        return true;
      },
    });

    expect(out.reached).toBe(true);
    expect(out.stopped).toBeUndefined();
    expect(armed).toHaveLength(2);
    // The first plan stops at the frontier and discloses the rest.
    expect(armed[0]!.cut?.resumeAt).toBe("n1");
    expect(armed[0]!.remainder.map((r) => r.edgeId)).toEqual(["e1"]);
    expect(armed[1]!.cut).toBeUndefined();
  });

  /** Nothing is posted from a plan the caller did not approve. */
  it("stops with `declined` and posts nothing when arm returns false", async () => {
    const actuator = new ScriptedActuator([at("Start")], () => true);
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
   * genuinely gone, not merely not-yet-arrived, and looping would spin forever.
   */
  it("stops with `no-progress` when the very first edge cannot resolve", async () => {
    const actuator = new ScriptedActuator([at("Start")], () => false);
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
    const actuator = new ScriptedActuator([at("Start")], () => true);
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
   * It only has to be DISCLOSED, and the caller has to arm again regardless.
   */
  it("records drift when a segment does not land where it said it would", async () => {
    let stage = 0;
    // After segment 1 the world is at n0 again, not n1.
    const actuator = new ScriptedActuator(
      [at("Start"), at("Start"), at("Start"), at("Start")],
      (d) => (stage === 0 ? d.identifier === "first" : false),
    );
    const armed: Plan[] = [];
    const out = await executeRun({
      graph,
      actuator,
      keymap,
      goalNodeId: "n2",
      arm: async (p) => {
        armed.push(p);
        stage++;
        return true;
      },
    });
    // The run stops, but the second plan (if built) discloses the drift.
    expect(["failed", "no-progress"]).toContain(out.stopped);
  });

  it("terminates at maxSegments rather than looping", async () => {
    const actuator = new ScriptedActuator([at("Start")], () => true);
    const out = await executeRun({
      graph,
      actuator,
      keymap,
      goalNodeId: "n2",
      maxSegments: 2,
      arm: async () => true,
    });
    expect(out.segments.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/replay.run.test.ts`
Expected: FAIL — cannot resolve `../src/replay/run.js`.

- [ ] **Step 3: Expose `predicatesOf` in `observe.ts`**

One `dump()` per boundary must serve locating, verifying and resolving. `observe` currently owns the dump, so a caller that also needs `windowOriginOf` would have to dump twice — the split-fact hazard this repo has already paid for. Refactor:

```ts
/** Express one observation as predicates. The dump-free half of `observe`. */
export function predicatesOf(o: AxObservation): Predicate[] {
  return extractPredicates(o.elements, {
    ...(o.app !== undefined && o.app.length > 0 ? { app: o.app } : {}),
    ...(o.windowTitle !== undefined && o.windowTitle.length > 0
      ? { windowTitle: o.windowTitle }
      : {}),
  });
}

/** Dump the live state and express it as predicates. */
export async function observe(actuator: Actuator): Promise<Predicate[]> {
  return predicatesOf(await actuator.dump());
}
```

- [ ] **Step 4: Write `run.ts`**

Create `src/replay/run.ts`:

```ts
/**
 * The segment loop — observe, locate, plan, ask, execute, repeat.
 *
 * `buildPlan` stops where anchor resolution stops working, so a multi-step plan
 * arrives in segments. This drives them, and the arming decision is INJECTED:
 * `replay/` never decides to act on its own, the same seam as `Actuator` and
 * `VisualMatcher`. An AI-in-the-loop caller can supply `arm` later without this
 * package growing a policy.
 *
 * The promise the loop preserves is exact: nothing is posted from a plan the
 * caller has not reviewed at exact resolution. Segmentation is what costs
 * approvals; it is not what costs safety.
 *
 * Never touches a process: everything reaching the desktop goes through the
 * injected `Actuator`.
 */

import { locateNode } from "./locate.js";
import { predicatesOf, windowOriginOf } from "./observe.js";
import { buildPlan, findPath } from "./plan.js";
import { executePlan } from "./execute.js";
import type { ExecOutcome, Plan, RunInput, RunOutcome, RunStop } from "./types.js";

const DEFAULT_MAX_SEGMENTS = 8;

export async function executeRun(input: RunInput): Promise<RunOutcome> {
  const segments: { plan: Plan; outcome: ExecOutcome }[] = [];
  const maxSegments = input.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const stop = (stopped: RunStop): RunOutcome => ({
    goalNodeId: input.goalNodeId,
    reached: false,
    segments,
    stopped,
  });

  /** Where the previous segment said it would land, for drift disclosure. */
  let expected: string | undefined;

  for (let turn = 0; turn < maxSegments; turn++) {
    // ONE dump serving location, resolution geometry and (inside executePlan)
    // verification. Sourcing halves of one fact separately is what made boundary
    // snapshots describe the previous application.
    const observation = await input.actuator.dump();
    const observed = predicatesOf(observation);
    const origin = windowOriginOf(observation);

    const located = locateNode(observed, input.graph.nodes);
    if (located.nodeId === undefined) return stop("not-located");

    const path = findPath(input.graph, located.nodeId, input.goalNodeId);
    if (path === null) return stop("no-path");
    if (path.length === 0) {
      return { goalNodeId: input.goalNodeId, reached: true, segments };
    }

    const plan = await buildPlan({
      graph: input.graph,
      fromNodeId: located.nodeId,
      toNodeId: input.goalNodeId,
      observed,
      locate: (d) => input.actuator.locate(d),
      keymap: input.keymap,
      ...(input.slotBindings !== undefined ? { slotBindings: input.slotBindings } : {}),
      ...(origin !== undefined ? { windowOrigin: origin } : {}),
      runningApps: await input.actuator.runningApps(),
      ...(input.allowLaunch !== undefined ? { allowLaunch: input.allowLaunch } : {}),
    });

    // Drift is not a mechanism: the turn above re-located regardless. It only
    // has to be disclosed, and the caller arms again in any case.
    if (expected !== undefined && expected !== located.nodeId) {
      plan.drift = { expected, observed: located.nodeId };
    }

    // A segment with nothing in it that resumes where it started cannot advance,
    // and is the loop's only way to spin. The reviewer is never asked to arm it.
    if (plan.steps.length === 0 && plan.cut?.resumeAt === located.nodeId) {
      return stop("no-progress");
    }

    if (!(await input.arm(plan))) return stop("declined");

    const outcome = await executePlan(plan, input, {
      ...(input.override !== undefined ? { override: input.override } : {}),
      ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
    });
    segments.push({ plan, outcome });
    if (!outcome.completed) return stop("failed");

    expected = plan.cut?.resumeAt ?? input.goalNodeId;
  }

  return stop("max-segments");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/replay.run.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Export from the barrel and document the seam**

In `src/index.ts`, beside the other `replay/` exports:

```ts
export { executeRun } from "./replay/run.js";
```

Add `"executeRun"` to the exported-names array in `test/replay.barrel.test.ts`.

In `CLAUDE.md`, in the `### 4. The executor (src/replay/)` section, add after the dry-run bullet:

```markdown
- **A plan STOPS where resolution stops working, and the rest is disclosed unresolved.** `buildPlan` cuts at the first anchor that carries AX descriptors yet reaches no AX rung — the executor measuring that it is describing a state which does not exist yet. That edge and every later one become `remainder`: action kinds, recorded descriptors and recorded points, explicitly not targets. The cut is at an EDGE boundary, never mid-edge, because a node boundary is the only place the world can be re-observed. `executeRun` then loops observe → locate → plan → **arm** → execute, and `arm` is injected, so `replay/` still never decides to act. The dry-run promise is unchanged in substance — *nothing is posted from a plan you have not reviewed at exact resolution* — and segmentation costs approvals rather than safety. Measured on a real cross-app graph: 2 segments, cut exactly at the app boundary, and 0 anchors falsely resolving in the wrong application across 9 foreign trials.
- **The recorded app switch is SUPERSEDED by the repair, and the repair goes at the edge's END.** On an edge whose destination app differs, the final action is the switch when it is spatial and carries no `ax` layer (4 of 4 measured — `computeBoundaries` cuts at the focus change, so the switch is structurally last), and every `wait { until: app(X) }` is redundant because `runRepair` polls that predicate itself. Both become visible `SupersededStep`s rather than silent omissions. The repair belongs at the end because the `app` predicate is on the DESTINATION node while the edge's own actions run in the SOURCE app — placing it first posts one app's clicks into another. Suppressing the switch is also what makes cross-app edges armable at all: their AX rate goes 0%/50% → 100%, and below-floor edges 2/4 → 0/4.
- **`locateNode` uses the SUBSET rule, not `matchNode`.** Merging needs exact set equality; locating asks "which recorded state is still true here?", and a live screen that gained anything would never match exactly. Most predicates wins, a tie declines, and a zero-predicate node is never a candidate — an empty set is vacuously a subset of every observation.
```

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/replay/run.ts src/replay/observe.ts src/index.ts test/ CLAUDE.md
git commit -m "feat(replay): drive a segmented plan through an injected arming gate"
```

---

### Task 7: Prove it against the real desktop

**Files:**
- Modify: `docs/superpowers/specs/2026-08-01-progressive-anchor-resolution-design.md`
- Modify: `scripts/replay-probe.mjs`

**Interfaces:**
- Consumes: `executeRun`, `locateNode` from the barrel.
- Produces: no new exports. A `--dry-run` probe mode that drives `executeRun` with an `arm` callback that always returns **false**, so the loop is exercised end to end without posting anything.

**Why this task exists:** every number in this spec came from driving a real recording, and both of this repo's worst bugs were invisible to `npm test`. The suite cannot change the frontmost application, so it cannot prove the loop works.

- [ ] **Step 1: Add the dry-run mode to the probe**

In `scripts/replay-probe.mjs`, add an import and a mode. The `readOnly` proxy already makes actuation impossible, so this cannot post an event even if `arm` were wrong:

```js
import { executeRun } from "../dist/replay/run.js";
```

```js
/**
 * Drive the real loop with an arming gate that always REFUSES. Exercises
 * observe -> locate -> pathfind -> buildPlan -> arm end to end and prints the
 * segment it would have run, without posting anything.
 */
async function dryRun(graph, goalId) {
  const sidecar = AxExecSidecar.spawn({ planId: `probe-run-${Date.now()}` });
  const actuator = readOnly(sidecar);
  try {
    if (!(await waitForApp(actuator))) return;
    const goal = graph.nodes.find((n) => n.id === goalId || n.id.endsWith(`:${goalId}`));
    if (goal === undefined) { console.log(`no such goal node: ${goalId}`); return; }

    const out = await executeRun({
      graph,
      actuator,
      keymap: { layoutId: "probe", entries: {} },
      goalNodeId: goal.id,
      arm: async (plan) => {
        console.log(`\n=== SEGMENT ${plan.steps.length} steps ===`);
        for (const s of plan.steps) {
          if (s.repair) console.log(`  activate ${s.app}${s.launch ? " (launching)" : ""}`);
          else if (s.superseded) console.log(`  superseded ${s.action.kind} — ${s.reason}`);
          else console.log(`  ${s.action.kind} -> ${s.resolution?.layer ?? "-"}@${(s.resolution?.confidence ?? 0).toFixed(2)}`);
        }
        console.log(`  cut: ${plan.cut ? `${plan.cut.edgeId} (resume ${plan.cut.resumeAt})` : "none"}`);
        console.log(`  remainder: ${plan.remainder.map((r) => r.edgeId).join(", ") || "none"}`);
        console.log(`  blockers: ${plan.blockers.map((b) => `${b.reason} [${b.scope}]`).join("; ") || "none"}`);
        if (plan.drift) console.log(`  DRIFT: expected ${plan.drift.expected}, observed ${plan.drift.observed}`);
        console.log(`  (refusing to arm — this probe never posts)`);
        return false;
      },
    });
    console.log(`\nstopped: ${out.stopped}  reached: ${out.reached}`);
  } finally {
    sidecar.close();
  }
}
```

Wire it into the mode dispatch, before the `--sweep` branch:

```js
  if (has("--dry-run")) await dryRun(graph, val("--goal"));
  else if (has("--sweep")) await sweep(graph);
```

- [ ] **Step 2: Rebuild and run it against the real desktop**

```bash
npm run build
node scripts/replay-probe.mjs --wait-for TextEdit --dry-run --goal n4
```

Expected, against the re-lifted graph: `n2` located, a first segment covering `e2` with the TextEdit anchor at `identifier@1.00`, the Dock click shown as **superseded**, an `activate Google Chrome` repair as the **last** step, a cut at `e3`, `e3` in the remainder, and `stopped: declined`.

- [ ] **Step 3: Record what actually happened in the spec**

Add a short subsection to the spec under the validation gate, in the style of its existing entries — the observed segment count, which steps were superseded, where the cut landed, and any divergence from the expectation above. If reality differs, the spec records reality; do not adjust the expectation to match the code.

- [ ] **Step 4: Commit**

```bash
git add scripts/replay-probe.mjs docs/superpowers/specs/2026-08-01-progressive-anchor-resolution-design.md
git commit -m "test(replay): drive the segment loop against a real desktop, arming refused"
```

---

## What this plan does NOT build

Stated so the boundary is explicit, and matching the spec's "Out of scope":

- **Unattended replay.** `arm` is injected precisely so an AI-in-the-loop caller can supply it later; that is subsystem #4.
- **Rollback** for a run that stops after posting events. There is no undo on a desktop. `RunOutcome.segments` reports how far it got; the world is left where it is.
- **Re-resolving anchors within a segment.** Anchors in a segment resolve once, at plan time, so the review is exact. Re-resolving at arrival is the rejected design, not a later increment of this one.
- **The app's review UI.** Nothing in `app/` calls `buildPlan`. The segment and remainder shapes are designed to be rendered, but that surface is a separate piece of work.
