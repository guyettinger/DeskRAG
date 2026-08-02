# Replay Screen UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Replay screen's fixed graph/plan split with two modes — a downward-flowing graph with a bottom inspector sheet, and a plan review that only exists when a plan does.

**Architecture:** The stage becomes a single slot holding one of two components, switched on whether a plan or run log exists. All non-trivial logic is extracted into **pure modules** (`graph-layout.ts`, `run-log.ts`, plus two functions in `plan-view.ts`) that the ROOT vitest suite tests through the `@shared` / `deskrag` aliases already in `vitest.config.ts` — the same trick that puts `app/src/main/plan-view.ts` in the suite. React components stay thin enough to be gated by typecheck plus a real-graph walkthrough.

**Tech Stack:** TypeScript (strict, ESM), React 18, electron-vite, vitest. No new dependencies — the graph layout is a ~15-line barycenter sweep, deliberately not a layout library.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-02-replay-screen-ux-design.md`. Read it before Task 1.
- **No behavior change in `src/replay/` or `src/trace/`.** The only library edit in this plan is one barrel export (Task 1).
- **No new IPC channels and no new `RunEventDTO` variants.** Segment outcomes are inferred (Task 8).
- **`grep` silently skips `src/store/store.ts`** (two deliberate NUL bytes). Use `grep -a` / `rg -a` for any search over `src/`.
- **AX roles carry NO `AX` prefix in real data** (`ax-dump.swift` does `rawRole.dropFirst(2)`). Any test fixture must use `Button`, `TextArea`, `Window` — never `AXButton`. Matching the prefixed spelling shipped once and produced zero predicates from every real recording.
- **Root suite path aliases already exist** — `@shared` → `app/src/shared`, `deskrag` → `src/index.ts` in `vitest.config.ts`; `@shared/types` and `deskrag` in `tsconfig.json` `paths`. Root is NodeNext and needs the `.js` extension on relative imports; the app resolves as a bundler and may omit it. Root tests import app files as `../app/src/main/plan-view.js`.
- **Never render `telemetry` as a measurement.** `src/replay/execute.ts:117` pushes the *planned* `step.resolution` verbatim. There is no measured-at-execution resolution anywhere in the system.
- **Gates, in order:** `npm run typecheck` → `npm test` → `npm --prefix app run typecheck`. Library changes need `npm run build` before the app runs, because the app imports `dist/`, not `src/`.
- **Theme tokens** (`app/src/renderer/src/styles.css:1-30`): `--ink --panel --elevated --hairline --hairline-soft --text --muted --muted-dim --accent --rec --amber --ok --radius --radius-sm --font-ui --font-mono`. `--rec` is reserved for live capture and must not be used for replay state. `--ok` means "true right now", `--accent` means interactive selection, `--amber` means degraded/warning.
- **Commit after every task.** Branch is `feat/replay-screen-ux`, already checked out.

---

### Task 1: Expose node identity to the renderer

`GraphNodeDTO` carries a label and a chip but not the predicates that ARE the node's identity, and not whether the node can ever be located. The bottom sheet in Task 5 needs both.

**Files:**
- Modify: `src/index.ts:284-291` (add `isLocatable` to the `trace/identity-set.js` exports)
- Modify: `app/src/shared/types.ts:300-324` (`GraphNodeDTO`)
- Modify: `app/src/main/plan-view.ts:158-199` (`toGraphDTO`)
- Test: `test/replay.plan-view.test.ts` (append to the existing `toGraphDTO` describe block)

**Interfaces:**
- Consumes: nothing.
- Produces: `GraphNodeDTO.predicates: string[]` (human-readable, via the existing exported `describePredicate`) and `GraphNodeDTO.locatable: boolean`. Tasks 4, 5 and 9 read both.

- [ ] **Step 1: Write the failing test**

Append to `test/replay.plan-view.test.ts`. The file already defines `app()`, `exists()`, `focused()`, `node()`, `edge()` and `graph()` helpers at the top — reuse them, do not redefine them.

```ts
describe("toGraphDTO identity fields", () => {
  it("renders every predicate as human-readable text", () => {
    const n = node("n1", [app("TextEdit"), exists("TextArea", "Body")]);
    const dto = toGraphDTO(graph([n], [], "n1"));
    expect(dto.nodes[0]!.predicates).toEqual([
      "app(app=TextEdit)",
      "ax_exists(role=TextArea, label=Body)",
    ]);
  });

  it("marks an app-only node unlocatable — `app` cannot say WHICH state", () => {
    const bare = node("n1", [app("TextEdit")]);
    const rich = node("n2", [app("TextEdit"), focused("TextArea", "Body")]);
    const dto = toGraphDTO(graph([bare, rich], [edge("e1", "n1", "n2")], "n1"));
    expect(dto.nodes[0]!.locatable).toBe(false);
    expect(dto.nodes[1]!.locatable).toBe(true);
  });

  it("gives a predicate-less node an empty list, not undefined", () => {
    const dto = toGraphDTO(graph([node("n1")], [], "n1"));
    expect(dto.nodes[0]!.predicates).toEqual([]);
    expect(dto.nodes[0]!.locatable).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/replay.plan-view.test.ts -t "toGraphDTO identity fields"`
Expected: FAIL — `predicates` and `locatable` are `undefined`.

- [ ] **Step 3: Export `isLocatable` from the barrel**

In `src/index.ts`, immediately after the existing `./trace/identity.js` export block (which ends at line 291 with `} from "./trace/identity.js";`), add:

```ts
/**
 * `isLocatable` is exported for the app's graph projection: a node whose
 * identity is only `app` VERIFIES perfectly and LOCATES never, and the reviewer
 * has to be told that before a node is chosen as a goal. Pure, in `trace/`,
 * loads nothing native.
 */
export { isLocatable } from "./trace/identity-set.js";
```

- [ ] **Step 4: Add the DTO fields**

In `app/src/shared/types.ts`, inside `GraphNodeDTO`, after `observations: number;`:

```ts
  /**
   * The node's whole identity, human-readable via `describePredicate`. Empty
   * when the node describes no state. This is what merges, verifies and
   * locates, and it had no surface in the app until now.
   */
  predicates: string[];
  /**
   * False when the identity is only `app`. Such a node is satisfied by every
   * observation in that application, so it cannot answer "which state is
   * this?" — it verifies perfectly and locates never, which makes it unusable
   * as a goal. Measured: without a URL only 3 of 8 nodes were locatable.
   */
  locatable: boolean;
```

- [ ] **Step 5: Populate them in `toGraphDTO`**

In `app/src/main/plan-view.ts`, add `isLocatable` to the existing `import { isRepairStep, isSupersededStep } from "deskrag";` on line 17:

```ts
import { isLocatable, isRepairStep, isSupersededStep } from "deskrag";
```

Then inside the `graph.nodes.map` in `toGraphDTO`, add to the returned object after `observations: n.observations,`:

```ts
      predicates: n.predicates.map(describePredicate),
      locatable: isLocatable(n.predicates),
```

`describePredicate` is already defined and exported lower in this same file (line 201) — function declarations hoist, so no reordering is needed.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/replay.plan-view.test.ts`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 7: Typecheck both packages**

Run: `npm run typecheck && npm --prefix app run typecheck`
Expected: both clean. The app's typecheck will fail if any existing construction of a `GraphNodeDTO` literal omits the new required fields — `toGraphDTO` is the only producer, so it should not.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts app/src/shared/types.ts app/src/main/plan-view.ts test/replay.plan-view.test.ts
git commit -m "feat(app): carry node predicates and locatability into GraphNodeDTO

Identity is what merges, verifies and locates, and the app never showed it.
\`isLocatable\` was reachable only from inside replay/locate.ts; export it so
the reviewer can be told which nodes verify but can never be located."
```

---

### Task 2: Fix the off-by-one in the reported failing step

`execute.ts:133` reports `failure.step` as an index into the LIBRARY's `plan.steps`. `plan-view.ts:304` prepends a handoff step to `PlanDTO.steps`, so the rendered list is one longer whenever the `from` node carries an `app` predicate — which is nearly always. `ReplayScreen.tsx:33` renders `step ${failure.step + 1}` with no correction, so today's message names the wrong step. The service already computes `handoffOffsets` and already applies it to its *other* message (`replay-service.ts:484`), inline.

**Files:**
- Modify: `app/src/main/plan-view.ts` (add `failedStepIndex`, exported)
- Modify: `app/src/shared/types.ts:451-457` (document `failure.step`)
- Modify: `app/src/main/replay-service.ts:453-486` (`report`)
- Test: `test/replay.plan-view.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `failedStepIndex(rawStep: number, handoffOffset: number): number | undefined` from `plan-view.ts`. Task 8's run-log reducer and Task 9's status line both consume `segment-done.failure.step` already converted to DTO space, so neither re-applies an offset.

- [ ] **Step 1: Write the failing test**

Append to `test/replay.plan-view.test.ts`. Add `failedStepIndex` to the existing import on line 2.

```ts
describe("failedStepIndex", () => {
  it("shifts past a prepended handoff step", () => {
    // execute.ts says step 0; the rendered list has the handoff at 0, so the
    // action the reviewer sees fail is at 1.
    expect(failedStepIndex(0, 1)).toBe(1);
    expect(failedStepIndex(6, 1)).toBe(7);
  });

  it("is identity when no handoff was prepended", () => {
    expect(failedStepIndex(0, 0)).toBe(0);
    expect(failedStepIndex(6, 0)).toBe(6);
  });

  it("returns undefined for a refusal to start", () => {
    // canArm reports step -1: nothing ran, so no step failed.
    expect(failedStepIndex(-1, 1)).toBeUndefined();
    expect(failedStepIndex(-1, 0)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/replay.plan-view.test.ts -t "failedStepIndex"`
Expected: FAIL — `failedStepIndex is not a function`.

- [ ] **Step 3: Implement it in `plan-view.ts`**

Add near `describePredicate` (after line 206):

```ts
/**
 * Which step of the RENDERED list failed.
 *
 * `execute.ts` indexes the library's `plan.steps`; `toPlanDTO` prepends a
 * handoff step whenever the `from` node carries an `app` predicate, which is
 * nearly always. Without the shift the reviewer is told a step number one below
 * the step that actually failed — measured: "step 7" for the activate at
 * position 8.
 *
 * `canArm` reports -1, meaning it refused to start. That is not a step that
 * ran, so there is no index to name.
 */
export function failedStepIndex(rawStep: number, handoffOffset: number): number | undefined {
  return rawStep < 0 ? undefined : rawStep + handoffOffset;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/replay.plan-view.test.ts -t "failedStepIndex"`
Expected: PASS.

- [ ] **Step 5: Document the DTO field**

In `app/src/shared/types.ts`, replace the `failure?: { step: number; reason: string };` line inside the `segment-done` variant of `RunEventDTO` with:

```ts
      /**
       * `step` indexes the RENDERED `PlanDTO.steps`, NOT the library's plan.
       * The DTO prepends a handoff step whenever the `from` node carries an
       * `app` predicate, so the raw index from `execute.ts` is one short.
       * `replay-service.report` converts it with `failedStepIndex`; absent when
       * the segment refused to start (raw -1), because then no step ran.
       */
      failure?: { step: number; reason: string };
```

- [ ] **Step 6: Apply it in the service, replacing the inline arithmetic**

In `app/src/main/replay-service.ts`, add `failedStepIndex` to the existing `plan-view.js` import on line 35:

```ts
import { describePredicate, failedStepIndex, labelNode, toGraphDTO, toPlanDTO } from "./plan-view.js";
```

In `report()`, change the per-segment emit so the failure it publishes is already in DTO space:

```ts
    outcome.segments.forEach((s, i) => {
      const f = s.outcome.failure;
      // DTO space, once, here — every consumer downstream renders the list this
      // index points into and must not re-shift it.
      const at = f === undefined ? undefined : failedStepIndex(f.step, this.handoffOffsets[i] ?? 0);
      this.emitEvent({
        type: "segment-done",
        segment: i + 1,
        completed: s.outcome.completed,
        ...(f !== undefined && at !== undefined ? { failure: { step: at, reason: f.reason } } : {}),
        telemetry: s.outcome.telemetry.map((t) => ({
          edgeId: t.edgeId,
          layer: t.layer,
          confidence: t.confidence,
        })),
      });
    });
```

Then replace the `stepLabel` block below it (which does the same arithmetic inline) with a call to the same helper:

```ts
    const at =
      failed === undefined ? undefined : failedStepIndex(failed.step, this.handoffOffsets[failedAt] ?? 0);
    const stepLabel = at === undefined ? undefined : `step ${at + 1}: `;
```

Note the `+ 1` stays here and only here: `stepLabel` is one-based prose for a human, while `failure.step` on the event is a zero-based array index.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck && npm --prefix app run typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add app/src/main/plan-view.ts app/src/main/replay-service.ts app/src/shared/types.ts test/replay.plan-view.test.ts
git commit -m "fix(app): report the failing step in the index the reviewer reads

execute.ts indexes the library plan; the DTO prepends a handoff step, so the
rendered failure named a step one below the one that failed whenever a handoff
existed — the normal case. One helper, applied at the emit site and reused by
the stop-detail message that was doing the arithmetic inline."
```

---

### Task 3: The pure graph layout

Today `GraphCanvas` computes `x = rank * (CARD_W + GAP_X)` with rows stacked in `graph.nodes` array order. Two problems: it grows along the axis the window has least of, and array order causes crossings for no reason. This task extracts layout into a pure module, transposes it, and adds a barycenter ordering sweep.

Determinism is not a nicety here: `LocationDTO` arrives on a 2000ms poll and re-renders the canvas, so a layout that reorders on equal barycenters would make the graph twitch continuously.

**Files:**
- Create: `app/src/renderer/src/screens/graph-layout.ts`
- Test: `test/replay.graph-layout.test.ts`

**Interfaces:**
- Consumes: `GraphDTO` from `@shared/types` (Task 1's version).
- Produces:
  ```ts
  export const CARD_W = 180;
  export const CARD_H = 132;
  export const GAP_X = 40;
  export const GAP_Y = 56;
  export interface PlacedNode { node: GraphNodeDTO; x: number; y: number }
  export interface PlacedEdge { edge: GraphEdgeDTO; d: string }
  export interface Layout {
    nodes: PlacedNode[];
    edges: PlacedEdge[];
    at: Map<string, PlacedNode>;
    width: number;
    height: number;
  }
  export function layoutGraph(graph: GraphDTO): Layout;
  ```
  Task 4 consumes all of it.

- [ ] **Step 1: Write the failing test**

Create `test/replay.graph-layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { GraphDTO, GraphEdgeDTO, GraphNodeDTO } from "../app/src/shared/types.js";
import {
  CARD_H,
  CARD_W,
  GAP_X,
  GAP_Y,
  layoutGraph,
} from "../app/src/renderer/src/screens/graph-layout.js";

const n = (id: string, rank: number): GraphNodeDTO => ({
  id,
  label: id,
  chip: id,
  observations: 1,
  intervene: "select",
  rank,
  predicates: [],
  locatable: true,
});

const e = (id: string, from: string, to: string, back = false): GraphEdgeDTO => ({
  id,
  from,
  to,
  actions: 1,
  back,
  provenance: "recorded",
});

const g = (nodes: GraphNodeDTO[], edges: GraphEdgeDTO[]): GraphDTO => ({
  id: "default",
  entry: nodes[0]?.id ?? "",
  nodes,
  edges,
  slots: [],
});

describe("layoutGraph", () => {
  it("puts rank on the Y axis, so the graph flows downward", () => {
    const out = layoutGraph(g([n("a", 0), n("b", 1), n("c", 2)], [e("e1", "a", "b"), e("e2", "b", "c")]));
    const y = (id: string): number => out.at.get(id)!.y;
    expect(y("a")).toBe(0);
    expect(y("b")).toBe(CARD_H + GAP_Y);
    expect(y("c")).toBe(2 * (CARD_H + GAP_Y));
    // A chain occupies ONE column.
    expect(new Set(out.nodes.map((p) => p.x)).size).toBe(1);
  });

  it("spreads siblings across X within their rank", () => {
    const out = layoutGraph(
      g([n("a", 0), n("b", 1), n("c", 1)], [e("e1", "a", "b"), e("e2", "a", "c")]),
    );
    expect(out.at.get("b")!.y).toBe(out.at.get("c")!.y);
    expect(Math.abs(out.at.get("b")!.x - out.at.get("c")!.x)).toBe(CARD_W + GAP_X);
  });

  it("orders a rank by its parents' position, not by array order", () => {
    // `left` feeds `l`, `right` feeds `r`, but rank 2 lists r BEFORE l. Array
    // order would cross both wires; barycenter must not.
    const out = layoutGraph(
      g(
        [n("root", 0), n("left", 1), n("right", 1), n("r", 2), n("l", 2)],
        [
          e("e1", "root", "left"),
          e("e2", "root", "right"),
          e("e3", "left", "l"),
          e("e4", "right", "r"),
        ],
      ),
    );
    const x = (id: string): number => out.at.get(id)!.x;
    expect(x("left") < x("right")).toBe(true);
    expect(x("l") < x("r")).toBe(true);
  });

  it("is stable across repeated calls — the location poll re-renders constantly", () => {
    const graph = g(
      [n("a", 0), n("b", 1), n("c", 1), n("d", 2)],
      [e("e1", "a", "b"), e("e2", "a", "c"), e("e3", "b", "d")],
    );
    expect(layoutGraph(graph).nodes).toEqual(layoutGraph(graph).nodes);
  });

  it("bows a back edge sideways rather than down through the cards it passes", () => {
    const out = layoutGraph(g([n("a", 0), n("b", 1)], [e("e1", "a", "b"), e("e2", "b", "a", true)]));
    const forward = out.edges.find((p) => p.edge.id === "e1")!;
    const back = out.edges.find((p) => p.edge.id === "e2")!;
    expect(back.d).not.toBe(forward.d);
    // The bow's control points leave the column the cards occupy.
    const xs = [...back.d.matchAll(/-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?/g)].map((m) =>
      Number(m[0].split(/\s+/)[0]),
    );
    expect(Math.max(...xs)).toBeGreaterThan(CARD_W);
  });

  it("places an orphan rather than dropping it", () => {
    // rankNodes gives an unreachable node rank 0. Visible and fixable beats
    // silently absent.
    const out = layoutGraph(g([n("a", 0), n("orphan", 0)], []));
    expect(out.nodes).toHaveLength(2);
    expect(out.at.get("orphan")).toBeDefined();
  });

  it("sizes the world to fit every card plus a margin", () => {
    const out = layoutGraph(g([n("a", 0), n("b", 1)], [e("e1", "a", "b")]));
    expect(out.width).toBeGreaterThanOrEqual(CARD_W);
    expect(out.height).toBeGreaterThanOrEqual(2 * CARD_H + GAP_Y);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/replay.graph-layout.test.ts`
Expected: FAIL — cannot resolve `graph-layout.js`.

- [ ] **Step 3: Write the implementation**

Create `app/src/renderer/src/screens/graph-layout.ts`:

```ts
/**
 * Where every card and wire goes. Pure — no React, no DOM — so it lives in the
 * ROOT suite alongside `plan-view.ts`, for the same reason: it is layout for
 * data a human reads before authorizing a click, and it has real failure modes.
 *
 * No layout dependency. `@vidstack/react` was worth one because a media player
 * is not 60 lines; a layered layout for tens of nodes is.
 */

import type { GraphDTO, GraphEdgeDTO, GraphNodeDTO } from "@shared/types";

export const CARD_W = 180;
export const CARD_H = 132;
export const GAP_X = 40;
export const GAP_Y = 56;
/** Breathing room around the world so cards are not flush against the edge. */
const MARGIN = 48;

export interface PlacedNode {
  node: GraphNodeDTO;
  x: number;
  y: number;
}

export interface PlacedEdge {
  edge: GraphEdgeDTO;
  /** An SVG path `d`, in world coordinates. */
  d: string;
}

export interface Layout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  at: Map<string, PlacedNode>;
  width: number;
  height: number;
}

/**
 * Rank is the ROW. The graph flows downward, which is the axis a window has to
 * spare — and which lets the plan review take the whole stage rather than a
 * column stolen from the graph's width.
 *
 * Within a rank, order by the mean X of already-placed parents (one top-down
 * barycenter sweep). Ties break on the node's index in `graph.nodes`, so the
 * result is IDENTICAL across calls: `LocationDTO` arrives on a poll and
 * re-renders the canvas, and a layout that reordered on equal barycenters would
 * twitch continuously.
 */
export function layoutGraph(graph: GraphDTO): Layout {
  const order = new Map(graph.nodes.map((node, i) => [node.id, i]));

  const byRank = new Map<number, GraphNodeDTO[]>();
  for (const node of graph.nodes) {
    const list = byRank.get(node.rank);
    if (list === undefined) byRank.set(node.rank, [node]);
    else list.push(node);
  }

  // Forward edges only: a back edge points at an equal or lower rank, so using
  // it as a parent would pull a node toward a rank not yet placed.
  const parents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.back) continue;
    const list = parents.get(edge.to);
    if (list === undefined) parents.set(edge.to, [edge.from]);
    else list.push(edge.from);
  }

  const at = new Map<string, PlacedNode>();
  const placed: PlacedNode[] = [];

  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const row = byRank.get(rank)!;
    /** Mean x of placed parents; -1 when there are none, so roots keep array order. */
    const bary = (node: GraphNodeDTO): number => {
      const xs = (parents.get(node.id) ?? [])
        .map((id) => at.get(id)?.x)
        .filter((x): x is number => x !== undefined);
      return xs.length === 0 ? -1 : xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    const keyed = row.map((node) => ({ node, b: bary(node), i: order.get(node.id) ?? 0 }));
    keyed.sort((a, b) => (a.b === b.b ? a.i - b.i : a.b - b.b));

    keyed.forEach(({ node }, column) => {
      const p: PlacedNode = {
        node,
        x: column * (CARD_W + GAP_X),
        y: rank * (CARD_H + GAP_Y),
      };
      at.set(node.id, p);
      placed.push(p);
    });
  }

  const width = Math.max(...placed.map((p) => p.x + CARD_W), CARD_W) + MARGIN;
  const height = Math.max(...placed.map((p) => p.y + CARD_H), CARD_H) + MARGIN;

  const edges: PlacedEdge[] = [];
  for (const edge of graph.edges) {
    const a = at.get(edge.from);
    const b = at.get(edge.to);
    if (a === undefined || b === undefined) continue;
    edges.push({ edge, d: wire(a, b, edge.back, width) });
  }

  return { nodes: placed, edges, at, width, height };
}

/**
 * A forward wire leaves the bottom of one card and enters the top of the next.
 * A back edge bows OUT TO THE MARGIN instead of running down through every card
 * between its endpoints — a loop is a real feature of a merged graph and has to
 * stay readable as one.
 */
function wire(a: PlacedNode, b: PlacedNode, back: boolean, width: number): string {
  const x1 = a.x + CARD_W / 2;
  const x2 = b.x + CARD_W / 2;
  if (!back) {
    const y1 = a.y + CARD_H;
    const y2 = b.y;
    const mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  }
  // Out the right side, up the margin, back in the right side.
  const y1 = a.y + CARD_H / 2;
  const y2 = b.y + CARD_H / 2;
  const lane = Math.max(a.x, b.x) + CARD_W + Math.max(GAP_X, (width - Math.max(a.x, b.x)) / 3);
  return `M ${a.x + CARD_W} ${y1} C ${lane} ${y1}, ${lane} ${y2}, ${b.x + CARD_W} ${y2}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/replay.graph-layout.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck && npm --prefix app run typecheck`
Expected: clean. The root typecheck reaches this file because `tsconfig.json` includes `test`, which imports it.

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/src/screens/graph-layout.ts test/replay.graph-layout.test.ts
git commit -m "feat(app): pure downward graph layout with barycenter ordering

Rank becomes the row, so the graph grows along the axis a window has to spare.
One top-down barycenter sweep orders each rank by its parents instead of by
array position; ties break on array index so the layout is byte-identical
across the location poll's re-renders. Back edges bow to the margin."
```

---

### Task 4: The canvas — vertical, fit on load, findable

`GraphCanvas` keeps pan and zoom (a merged graph is genuinely graph-shaped and there is no overview without zoom) but stops being the only way to get anywhere. It also changes contract: it reports selection rather than a goal.

**Files:**
- Modify: `app/src/renderer/src/screens/GraphCanvas.tsx` (rewrite)
- Modify: `app/src/renderer/src/styles.css` (the `.gcanvas` / `.gnode` block, lines 1466-1497)

**Interfaces:**
- Consumes: `layoutGraph`, `CARD_W`, `CARD_H` from Task 3; `GraphNodeDTO.locatable` from Task 1.
- Produces:
  ```ts
  interface Props {
    graph: GraphDTO;
    selectedId: string | null;
    locationNodeId?: string | undefined;
    onSelect: (nodeId: string | null) => void;
  }
  export function GraphCanvas(props: Props): React.JSX.Element;
  ```
  Task 9 renders it. Note `onSelect` takes `null` — a click on empty canvas deselects.

- [ ] **Step 1: Rewrite the component**

Replace the whole of `app/src/renderer/src/screens/GraphCanvas.tsx`:

```tsx
/**
 * The graph, flowing downward. Layout lives in `graph-layout.ts` (pure, and in
 * the root suite); this file is the canvas, the cards and the controls.
 *
 * Pan and zoom are kept — a merged graph has branches and loops, and there is
 * no overview without zoom — but they are no longer the only way to navigate:
 * the canvas fits on mount, and `◎ me` returns to the located node.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GraphDTO } from "@shared/types";
import { CARD_H, CARD_W, layoutGraph } from "./graph-layout.js";

/** Pixels of travel before a press becomes a pan rather than a click. */
const DRAG_THRESHOLD = 4;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;

interface Props {
  graph: GraphDTO;
  selectedId: string | null;
  locationNodeId?: string | undefined;
  onSelect: (nodeId: string | null) => void;
}

export function GraphCanvas({
  graph,
  selectedId,
  locationNodeId,
  onSelect,
}: Props): React.JSX.Element {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const viewport = useRef<HTMLDivElement | null>(null);
  /**
   * Pointer capture must NOT start on pointerdown. Capturing redirects every
   * later pointer event to this div, so the node button never sees its own
   * pointerup and no click is ever synthesized — the canvas pans and nothing is
   * ever selectable. Capture only once the pointer has actually travelled.
   */
  const drag = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
    moved: boolean;
  } | null>(null);

  const layout = useMemo(() => layoutGraph(graph), [graph]);

  /** Centre the whole graph in the viewport at the largest zoom that fits. */
  const fit = (): void => {
    const box = viewport.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0) return;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(box.width / layout.width, box.height / layout.height)));
    setZoom(z);
    setPan({
      x: (box.width - layout.width * z) / 2,
      y: (box.height - layout.height * z) / 2,
    });
  };

  /** Centre one card without changing zoom. */
  const centreOn = (nodeId: string): void => {
    const box = viewport.current?.getBoundingClientRect();
    const p = layout.at.get(nodeId);
    if (box === undefined || p === undefined) return;
    setPan({
      x: box.width / 2 - (p.x + CARD_W / 2) * zoom,
      y: box.height / 2 - (p.y + CARD_H / 2) * zoom,
    });
  };

  /**
   * Fit ONCE per mount, not on every graph change: the location poll re-renders
   * this component every 2s, and re-fitting would move the canvas out from
   * under whoever is reading it.
   */
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || layout.nodes.length === 0) return;
    fitted.current = true;
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelect]);

  return (
    <div className="gcanvas" ref={viewport}>
      <div
        className="gcanvas__surface"
        onWheel={(e) => setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z - e.deltaY * 0.001)))}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d === null) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          // Below the threshold this is still a click, so leave the pointer alone.
          if (!d.moved) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            d.moved = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          setPan({ x: d.panX + dx, y: d.panY + dy });
        }}
        onPointerUp={() => {
          // A press that never travelled is a click on empty canvas: deselect.
          // The threshold above is what stops this firing at the end of a pan.
          if (drag.current !== null && !drag.current.moved) onSelect(null);
          drag.current = null;
        }}
        onDoubleClick={fit}
      >
        <div
          className="gcanvas__world"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <svg className="gcanvas__wires" width={layout.width} height={layout.height}>
            {layout.edges.map(({ edge, d }) => (
              <path
                key={edge.id}
                d={d}
                className={`gwire${edge.back ? " is-back" : ""}${
                  edge.provenance === "synthesized" ? " is-synth" : ""
                }`}
              />
            ))}
          </svg>

          {layout.nodes.map(({ node, x, y }) => {
            const here = node.id === locationNodeId;
            const selected = node.id === selectedId;
            return (
              <button
                key={node.id}
                className={`gnode${here ? " is-here" : ""}${selected ? " is-selected" : ""}${
                  node.locatable ? "" : " is-unlocatable"
                }`}
                style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
                onClick={(e) => {
                  // The surface's pointerup would otherwise deselect right after.
                  e.stopPropagation();
                  onSelect(node.id);
                }}
                title={`${node.id}\n${node.label} · ${node.observations} observation${
                  node.observations === 1 ? "" : "s"
                }`}
              >
                {node.frameBlobId !== undefined ? (
                  <img
                    className="gnode__shot"
                    src={`deskrag://frame/${node.frameBlobId}`}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  <div className="gnode__shot gnode__shot--none">no keyframe</div>
                )}
                <div className="gnode__label">{node.label}</div>
                <div className="gnode__meta">
                  <span className="gnode__id">{node.chip}</span>
                  {node.id === graph.entry && <span className="gnode__tag">entry</span>}
                  {here && <span className="gnode__tag is-here">you are here</span>}
                  {!node.locatable && (
                    <span className="gnode__tag is-warn" title="Identity is only `app`, which every state in that application satisfies">
                      unlocatable
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="gcanvas__controls">
        <button className="gbtn" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.2))} title="Zoom in">
          +
        </button>
        <button className="gbtn" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.2))} title="Zoom out">
          −
        </button>
        <button className="gbtn" onClick={fit} title="Fit the whole graph">
          fit
        </button>
        <button
          className="gbtn"
          disabled={locationNodeId === undefined}
          onClick={() => locationNodeId !== undefined && centreOn(locationNodeId)}
          title={locationNodeId === undefined ? "Nothing is located" : "Centre on where you are"}
        >
          ◎ me
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Replace the canvas CSS**

In `app/src/renderer/src/styles.css`, replace lines 1466-1497 (the `.gcanvas` through `.gnode__tag.is-goal` block) with:

```css
.gcanvas {
  position: relative; overflow: hidden; min-width: 0; min-height: 0;
  border: 1px solid var(--hairline); border-radius: var(--radius);
  background: var(--panel);
}
/* The pan surface is a child, not .gcanvas itself, so the control cluster can
   sit above it without every press on a button starting a pan. */
.gcanvas__surface { position: absolute; inset: 0; cursor: grab; touch-action: none; }
.gcanvas__surface:active { cursor: grabbing; }
.gcanvas__world { position: absolute; transform-origin: 0 0; }
.gcanvas__wires { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.gwire { fill: none; stroke: var(--hairline); stroke-width: 2; }
.gwire.is-back { stroke-dasharray: 5 4; opacity: 0.7; }
.gwire.is-synth { stroke-dasharray: 2 3; }

.gcanvas__controls {
  position: absolute; right: 10px; bottom: 10px; z-index: 2;
  display: flex; gap: 4px; padding: 4px;
  border: 1px solid var(--hairline); border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--elevated) 88%, transparent);
  backdrop-filter: blur(6px);
}
.gbtn {
  min-width: 26px; height: 24px; padding: 0 7px;
  font-size: 11px; font-family: var(--font-mono); color: var(--muted);
  border-radius: 5px;
}
.gbtn:hover:not(:disabled) { background: rgb(255 255 255 / 0.07); color: var(--text); }
.gbtn:disabled { opacity: 0.4; cursor: default; }

.gnode {
  position: absolute; display: flex; flex-direction: column; gap: 4px;
  padding: 6px; text-align: left; overflow: hidden;
  border: 1px solid var(--hairline); border-radius: var(--radius-sm);
  background: var(--elevated); color: inherit; cursor: pointer;
}
/* --ok is the palette's "this is true right now"; --accent is interactive
   selection. The recording red (--rec) is reserved for live capture. */
.gnode.is-here { border-color: var(--ok); box-shadow: 0 0 0 2px rgb(88 213 163 / 0.25); }
.gnode.is-selected { border-color: var(--accent); box-shadow: 0 0 0 2px rgb(124 156 255 / 0.25); }
/* Dimmed, not hidden: it is still a real recorded state and still worth
   reading — it just cannot answer "which state is this?". */
.gnode.is-unlocatable .gnode__shot { opacity: 0.55; }
.gnode__shot { width: 100%; height: 72px; object-fit: cover; border-radius: 4px; }
.gnode__shot--none {
  display: grid; place-items: center; font-size: 11px;
  color: var(--muted-dim); background: rgb(255 255 255 / 0.03);
}
.gnode__label { font-size: 12px; line-height: 1.25; max-height: 2.5em; overflow: hidden; }
.gnode__meta { display: flex; gap: 6px; align-items: center; font-size: 10px; color: var(--muted); }
.gnode__id { font-family: var(--font-mono); }
.gnode__tag { padding: 1px 5px; border-radius: 999px; background: rgb(255 255 255 / 0.07); }
.gnode__tag.is-here { background: rgb(88 213 163 / 0.2); color: var(--ok); }
.gnode__tag.is-warn { background: rgb(255 194 75 / 0.18); color: var(--amber); }
```

- [ ] **Step 3: Typecheck the app**

Run: `npm --prefix app run typecheck`
Expected: FAIL, in `ReplayScreen.tsx` only — it still passes `goalId` / `onPick`. That is Task 9's job; the failure confirms the prop contract changed.

- [ ] **Step 4: Commit**

```bash
git add app/src/renderer/src/screens/GraphCanvas.tsx app/src/renderer/src/styles.css
git commit -m "feat(app): vertical canvas that fits on mount and can find you

Consumes the pure layout. Adds a control cluster (zoom, fit, 'me') so being
lost is recoverable without hunting, moves panning onto a child surface so a
control press does not start a pan, and reports SELECTION rather than a goal.
Selection is the goal from here on, so there is no second piece of state to
disagree. ReplayScreen is knowingly broken until it is rewritten."
```

---

### Task 5: The bottom sheet

One sheet, three contents, strict precedence: selected node ▸ locating diagnosis ▸ closed. It rises from the bottom rather than sitting beside the canvas, because a downward flow is tall and narrow — horizontal room is what the transpose freed, and an inspector column would take it straight back.

**Files:**
- Create: `app/src/renderer/src/screens/NodeSheet.tsx`
- Modify: `app/src/renderer/src/styles.css` (append a `.sheet` block after the `.gnode` rules)

**Interfaces:**
- Consumes: `GraphNodeDTO` (with `predicates`, `locatable`), `NearestNodeDTO`, `GraphDTO["slots"]`.
- Produces:
  ```ts
  interface Props {
    node: GraphNodeDTO | null;
    nearest?: NearestNodeDTO[] | undefined;
    slots: GraphDTO["slots"];
    bindings: Record<string, string>;
    allowLaunch: boolean;
    busy: boolean;
    edgeCounts: { in: number; out: number };
    onBind: (name: string, value: string) => void;
    onAllowLaunch: (on: boolean) => void;
    onRun: () => void;
    onClose: () => void;
  }
  export function NodeSheet(props: Props): React.JSX.Element | null;
  ```
  Returns `null` when there is nothing to show. Task 9 renders it and owns all the state.

- [ ] **Step 1: Write the component**

Create `app/src/renderer/src/screens/NodeSheet.tsx`:

```tsx
/**
 * The graph's detail surface: one sheet, three possible contents, in strict
 * precedence — selected node, then the locating diagnosis, then nothing.
 *
 * It rises from the bottom rather than sitting beside the canvas. A downward
 * flow is tall and narrow, so horizontal room is exactly what the transpose
 * freed; an inspector column would take it straight back.
 */

import React from "react";
import type { GraphDTO, GraphNodeDTO, NearestNodeDTO } from "@shared/types";

interface Props {
  node: GraphNodeDTO | null;
  nearest?: NearestNodeDTO[] | undefined;
  slots: GraphDTO["slots"];
  bindings: Record<string, string>;
  allowLaunch: boolean;
  busy: boolean;
  edgeCounts: { in: number; out: number };
  onBind: (name: string, value: string) => void;
  onAllowLaunch: (on: boolean) => void;
  onRun: () => void;
  onClose: () => void;
}

export function NodeSheet({
  node,
  nearest,
  slots,
  bindings,
  allowLaunch,
  busy,
  edgeCounts,
  onBind,
  onAllowLaunch,
  onRun,
  onClose,
}: Props): React.JSX.Element | null {
  if (node !== null) {
    return (
      <aside className="sheet">
        <header className="sheet__head">
          <span className="sheet__chip">{node.chip}</span>
          <span className="sheet__title">{node.label}</span>
          <span className="muted">
            {node.observations} observation{node.observations === 1 ? "" : "s"} ·{" "}
            {edgeCounts.in} in · {edgeCounts.out} out
          </span>
          {!node.locatable && (
            <span className="sheet__warn">
              verifies but never locates — its identity is only `app`, which every state
              in that application satisfies
            </span>
          )}
          <button className="sheet__close" onClick={onClose} title="Close (Esc)">
            ╳
          </button>
        </header>

        <div className="sheet__body">
          {node.frameBlobId !== undefined ? (
            <img className="sheet__shot" src={`deskrag://frame/${node.frameBlobId}`} alt="" />
          ) : (
            <div className="sheet__shot sheet__shot--none">no keyframe</div>
          )}

          <section className="sheet__preds">
            <h3 className="eyebrow">Predicates</h3>
            {node.predicates.length === 0 ? (
              <p className="muted">
                No predicates — this state cannot be verified or located.
              </p>
            ) : (
              <ul>
                {node.predicates.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="sheet__run">
            <h3 className="eyebrow">Run</h3>
            {/* Only when the graph actually has slots — an empty control is
                worse than no control. */}
            {slots.map((s) => (
              <label key={s.name} className="sheet__slot">
                {s.name}
                <input
                  list={`slot-${s.name}`}
                  value={bindings[s.name] ?? ""}
                  onChange={(e) => onBind(s.name, e.target.value)}
                />
                <datalist id={`slot-${s.name}`}>
                  {s.samples.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </label>
            ))}
            <label className="sheet__launch">
              <input
                type="checkbox"
                checked={allowLaunch}
                onChange={(e) => onAllowLaunch(e.target.checked)}
              />
              allow launching apps
            </label>
            <button
              className="btn"
              disabled={busy || !node.locatable}
              onClick={onRun}
              title={
                node.locatable
                  ? undefined
                  : "This state cannot be located, so it cannot be reached as a goal"
              }
            >
              Run to here
            </button>
          </section>
        </div>
      </aside>
    );
  }

  if (nearest !== undefined && nearest.length > 0) {
    return (
      <aside className="sheet">
        <header className="sheet__head">
          <span className="sheet__title">Why nothing matched</span>
          <button className="sheet__close" onClick={onClose} title="Close (Esc)">
            ╳
          </button>
        </header>
        <div className="sheet__body sheet__body--diagnosis">
          <p className="muted">
            Locating is a subset check — every predicate a state claims must hold.
          </p>
          {nearest.map((n) => (
            <div key={n.nodeId} className="nearby">
              <div className="nearby__head">
                <span title={n.nodeId}>{n.label}</span>
                <span className="nearby__score">
                  {n.held}/{n.total}
                </span>
              </div>
              <ul>
                {n.missing.map((m, i) => (
                  <li key={i}>✗ {m}</li>
                ))}
                {n.more > 0 && <li className="muted">+{n.more} more</li>}
              </ul>
            </div>
          ))}
        </div>
      </aside>
    );
  }

  return null;
}
```

- [ ] **Step 2: Add the sheet CSS**

Append to `app/src/renderer/src/styles.css`, after the `.gnode__tag.is-warn` rule:

```css
/* --- the bottom sheet ---------------------------------------------------- */
.sheet {
  flex: 0 0 auto; max-height: 46%; overflow-y: auto;
  border: 1px solid var(--hairline); border-radius: var(--radius);
  background: var(--panel);
}
.sheet__head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 10px; border-bottom: 1px solid var(--hairline-soft);
}
.sheet__chip { font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
.sheet__title { font-size: 13px; font-weight: 600; }
.sheet__warn { font-size: 11px; color: var(--amber); }
.sheet__close { margin-left: auto; color: var(--muted); font-size: 12px; padding: 2px 6px; }
.sheet__close:hover { color: var(--text); }
.sheet__body {
  display: grid; grid-template-columns: 200px minmax(0, 1fr) 220px;
  gap: 14px; padding: 10px;
}
.sheet__body--diagnosis { display: block; }
.sheet__shot { width: 100%; border-radius: var(--radius-sm); object-fit: contain; }
.sheet__shot--none {
  display: grid; place-items: center; min-height: 90px; font-size: 11px;
  color: var(--muted-dim); background: rgb(255 255 255 / 0.03);
  border-radius: var(--radius-sm);
}
.sheet__preds ul { margin: 4px 0 0; padding-left: 16px; font-size: 11px; }
/* A predicate can be long (a URL prefix, an AX identifier) and must wrap
   rather than widen its column. */
.sheet__preds li { font-family: var(--font-mono); word-break: break-word; color: var(--muted); }
.sheet__run { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.sheet__slot, .sheet__launch { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.sheet__slot input { width: 130px; }
```

The `.nearby*` rules already exist (lines 1531-1535) and are reused unchanged.

- [ ] **Step 3: Typecheck the app**

Run: `npm --prefix app run typecheck`
Expected: still failing in `ReplayScreen.tsx` only (Task 4's known breakage). No new errors from `NodeSheet.tsx`.

- [ ] **Step 4: Commit**

```bash
git add app/src/renderer/src/screens/NodeSheet.tsx app/src/renderer/src/styles.css
git commit -m "feat(app): bottom sheet for node identity, diagnosis and run setup

Puts three things on screen that existed nowhere: a node's predicates, whether
it can ever be located, and the run parameters — slots and allow-launch, moved
off the top bar and rendered only when the graph has slots. The locating
diagnosis moves here from the review column that is about to be deleted."
```

---

### Task 6: The route strip and one segment's narrative

Review mode's two display pieces. `PlanSegment` is where the spec's central move happens: brittleness, the cut and the remainder stop being separate sections that print an edge id and expect the reader to correlate it, and become annotations on the steps they describe.

**Files:**
- Create: `app/src/renderer/src/screens/RouteStrip.tsx`
- Create: `app/src/renderer/src/screens/PlanSegment.tsx`
- Modify: `app/src/renderer/src/styles.css` (append after the sheet block)

**Interfaces:**
- Consumes: `PlanDTO`, `GraphDTO`, `shortId` from `@shared/types`.
- Produces:
  ```ts
  // RouteStrip.tsx
  export function routeNodeIds(plan: PlanDTO, graph: GraphDTO): string[];
  export function RouteStrip(props: {
    plan: PlanDTO | null;
    graph: GraphDTO;
    onBack: () => void;
    pending: boolean;
  }): React.JSX.Element;

  // PlanSegment.tsx
  export interface SegmentOutcome {
    state: "awaiting" | "running" | "completed" | "failed";
    failedStep?: number;
    reason?: string;
  }
  export function PlanSegment(props: {
    plan: PlanDTO;
    outcome: SegmentOutcome;
    expanded: boolean;
    onToggle: () => void;
  }): React.JSX.Element;
  ```
  Task 8 defines `SegmentOutcome`'s producer; Task 7 renders `PlanSegment`. **`SegmentOutcome` is declared here and imported by Task 8**, not the other way round.

- [ ] **Step 1: Write `RouteStrip.tsx`**

```tsx
/**
 * The thread between the two modes: the node chain this segment traverses.
 *
 * The chain is derived rather than carried — `PlanDTO` has `from`/`to` and the
 * steps carry `edgeId`, so walking `graph.edges` reconstructs the intermediate
 * nodes and the DTO needs no new field.
 */

import React from "react";
import { shortId, type GraphDTO, type PlanDTO } from "@shared/types";

/**
 * `plan.from`, then the destination of each distinct edge the steps name, in
 * step order. An edge id with no match in the graph is skipped rather than
 * breaking the chain: a plan is always built from the graph it is shown with,
 * so this can only happen if they have drifted, and a short chain is a better
 * failure than none.
 */
export function routeNodeIds(plan: PlanDTO, graph: GraphDTO): string[] {
  const byId = new Map(graph.edges.map((e) => [e.id, e]));
  const out = [plan.from];
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (step.kind === "handoff") continue;
    if (seen.has(step.edgeId)) continue;
    seen.add(step.edgeId);
    const edge = byId.get(step.edgeId);
    if (edge !== undefined) out.push(edge.to);
  }
  return out;
}

export function RouteStrip({
  plan,
  graph,
  onBack,
  pending,
}: {
  plan: PlanDTO | null;
  graph: GraphDTO;
  onBack: () => void;
  pending: boolean;
}): React.JSX.Element {
  const chips = plan === null ? [] : routeNodeIds(plan, graph);
  const labelFor = (id: string): string =>
    graph.nodes.find((n) => n.id === id)?.chip ?? shortId(id);

  return (
    <div className="route">
      <button className="gbtn" onClick={onBack} title="Look at the graph — this does not cancel">
        ⟵ graph
      </button>
      <div className="route__chain">
        {chips.map((id, i) => (
          <React.Fragment key={`${id}-${i}`}>
            {i > 0 && <span className="route__link" />}
            <span className={`route__node${i === chips.length - 1 ? " is-dest" : ""}`} title={id}>
              {labelFor(id)}
            </span>
          </React.Fragment>
        ))}
      </div>
      {pending && <span className="route__pending">awaiting approval</span>}
    </div>
  );
}
```

- [ ] **Step 2: Write `PlanSegment.tsx`**

```tsx
/**
 * One segment, as ONE narrative.
 *
 * Brittleness, the cut and the remainder are all per-edge facts, and steps
 * carry `edgeId` — rendering them as separate sections is what forced the
 * reader to correlate `shortId(edgeId)` against the step list by eye. They are
 * annotations here.
 *
 * The remainder is BULLETED, never numbered. `buildPlan` cuts at an edge
 * boundary and discloses the rest as "action kinds, recorded descriptors,
 * recorded points, explicitly not targets"; the run re-observes at `resumeAt`
 * and re-plans. A step number is a claim of authorization, and this list is the
 * one place in the app where that distinction is the entire point.
 */

import React from "react";
import { shortId, type PlanDTO } from "@shared/types";

export interface SegmentOutcome {
  state: "awaiting" | "running" | "completed" | "failed";
  /** Index into the RENDERED `plan.steps`; already DTO-space. */
  failedStep?: number;
  reason?: string;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

export function PlanSegment({
  plan,
  outcome,
  expanded,
  onToggle,
}: {
  plan: PlanDTO;
  outcome: SegmentOutcome;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const brittleEdges = new Set(plan.brittleness.filter((b) => b.belowFloor).map((b) => b.edgeId));
  const axRate = new Map(plan.brittleness.map((b) => [b.edgeId, b]));

  /** ✓ / ✗ / not attempted, derived from the outcome alone. */
  const markOf = (i: number): string => {
    if (outcome.state === "completed") return "✓";
    if (outcome.state !== "failed") return "";
    if (outcome.failedStep === undefined) return "";
    if (i < outcome.failedStep) return "✓";
    return i === outcome.failedStep ? "✗" : "·";
  };

  return (
    <section className={`seg is-${outcome.state}`}>
      <button className="seg__head" onClick={onToggle}>
        <span className="seg__caret">{expanded ? "▾" : "▸"}</span>
        <span className={`seg__state is-${outcome.state}`}>
          {outcome.state === "completed"
            ? "✓"
            : outcome.state === "failed"
              ? "✗"
              : outcome.state === "running"
                ? "●"
                : ""}
        </span>
        <span className="seg__title">Segment {plan.segment}</span>
        <span className="muted">
          {plan.fromLabel} → {plan.toLabel}
        </span>
        <span className="muted seg__count">
          {plan.steps.length} step{plan.steps.length === 1 ? "" : "s"}
        </span>
      </button>

      {!expanded && outcome.state === "failed" && outcome.reason !== undefined && (
        <p className="seg__failline">{outcome.reason}</p>
      )}

      {expanded && (
        <>
          {plan.drift !== undefined && (
            <div className="seg__banner is-warn">
              Last segment expected <code title={plan.drift.expected}>{shortId(plan.drift.expected)}</code>,
              landed on <code title={plan.drift.observed}>{shortId(plan.drift.observed)}</code>.
            </div>
          )}

          <ol className="steps">
            {plan.steps.map((s, i) => {
              const mark = markOf(i);
              if (s.kind === "handoff") {
                return (
                  <li key={i} className="step step--handoff">
                    <span className="step__mark">↺</span>
                    <span className="step__kind">hide DeskRAG, return focus to {s.app}</span>
                  </li>
                );
              }
              const brittle = brittleEdges.has(s.edgeId);
              if (s.kind === "repair") {
                return (
                  <li key={i} className="step step--repair">
                    <span className="step__mark">{mark}</span>
                    <span className="step__kind">activate {s.app}</span>
                    <span className="step__note">
                      {s.reason}
                      {s.launch ? " · may launch it" : " · will not launch it"}
                    </span>
                  </li>
                );
              }
              if (s.kind === "superseded") {
                return (
                  <li key={i} className="step step--superseded">
                    <span className="step__mark" />
                    <span className="step__kind">{s.action}</span>
                    <span className="step__note">not posted — {s.reason}</span>
                  </li>
                );
              }
              return (
                <li key={i} className={`step${brittle ? " is-brittle" : ""}`}>
                  <span className="step__mark">{mark}</span>
                  <span className="step__kind">{s.action}</span>
                  <span className="step__target">{s.target}</span>
                  {s.slot !== undefined && (
                    <span className="step__slot">
                      {s.slot.name} = “{s.slot.value}”
                    </span>
                  )}
                  {s.layer !== undefined && (
                    <span className="step__res">
                      {s.layer} {s.confidence !== undefined ? s.confidence.toFixed(2) : ""}
                    </span>
                  )}
                  {brittle && (
                    <span className="step__brittle">
                      ⚠ {pct(axRate.get(s.edgeId)?.axRate ?? 0)} resolved to an AX rung
                      {axRate.get(s.edgeId)?.bound === "upper" ? " (upper bound)" : ""} — mostly
                      coordinates, which click whatever has moved into that spot
                    </span>
                  )}
                  {outcome.state === "failed" &&
                    outcome.failedStep === i &&
                    outcome.reason !== undefined && (
                      <span className="step__fail">{outcome.reason}</span>
                    )}
                </li>
              );
            })}
          </ol>

          {plan.cut !== undefined && (
            <div className="cut">
              <div className="cut__rule">
                resolution stopped · resumes at{" "}
                <code title={plan.cut.resumeAt}>{shortId(plan.cut.resumeAt)}</code> after
                re-observing
              </div>
              <ul className="cut__attempts">
                {plan.cut.attempts.map((a, i) => (
                  <li key={i}>
                    <code>{a.layer}</code> — {a.rejected}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.remainder.length > 0 && (
            <ul className="remainder">
              {plan.remainder.flatMap((r) =>
                r.actions.map((a, i) => (
                  <li key={`${r.edgeId}-${i}`}>
                    {/* A bullet, never a number: these are disclosed, not authorized. */}
                    <span className="step__mark">·</span>
                    <span className="step__kind">{a.kind}</span>
                    <span className="step__target">
                      {a.descriptors !== undefined && `recorded: ${a.descriptors.join(", ")}`}
                      {a.slot !== undefined && ` ⟨${a.slot}⟩`}
                      {/* Provenance, never a target. */}
                      {a.recordedPoint !== undefined &&
                        ` · recorded at (${Math.round(a.recordedPoint.x)}, ${Math.round(
                          a.recordedPoint.y,
                        )})`}
                    </span>
                    <span className="step__res">unresolved</span>
                  </li>
                )),
              )}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Add the route and segment CSS**

Append to `app/src/renderer/src/styles.css`:

```css
/* --- review mode --------------------------------------------------------- */
.route {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 6px 10px;
  border: 1px solid var(--hairline); border-radius: var(--radius);
  background: var(--panel);
}
.route__chain { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.route__node {
  padding: 2px 7px; border-radius: 999px; font-family: var(--font-mono); font-size: 11px;
  color: var(--muted); background: rgb(255 255 255 / 0.06);
}
.route__node.is-dest { color: var(--accent); background: rgb(124 156 255 / 0.16); }
.route__link { width: 14px; height: 1px; background: var(--hairline); }
.route__pending { margin-left: auto; font-size: 11px; color: var(--amber); }

.seg { border-top: 1px solid var(--hairline-soft); padding: 8px 0; }
.seg:first-child { border-top: none; }
.seg__head {
  display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
  font-size: 12px; padding: 2px 0;
}
.seg__caret { color: var(--muted-dim); }
.seg__state.is-completed { color: var(--ok); }
.seg__state.is-failed { color: var(--amber); }
.seg__state.is-running { color: var(--accent); }
.seg__title { font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; }
.seg__count { margin-left: auto; }
.seg__failline { font-size: 11px; color: var(--amber); padding: 2px 0 0 24px; overflow-wrap: anywhere; }
.seg__banner.is-warn {
  padding: 8px; margin: 6px 0; border-radius: var(--radius-sm); font-size: 12px;
  color: var(--amber);
  background: rgb(255 194 75 / 0.12); border: 1px solid rgb(255 194 75 / 0.3);
}

.steps, .remainder { margin: 6px 0; padding: 0; list-style: none; font-size: 12px; }
.step {
  display: grid; grid-template-columns: 18px 1fr; gap: 2px 6px; margin-bottom: 6px;
}
.step__mark { font-family: var(--font-mono); color: var(--muted-dim); text-align: center; }
.step__kind { font-weight: 600; }
.step__target, .step__note, .step__slot, .step__res, .step__brittle, .step__fail {
  grid-column: 2; font-size: 11px;
}
.step__target, .step__note { color: var(--muted); word-break: break-word; }
.step__res { font-variant-numeric: tabular-nums; color: var(--muted); }
.step--handoff .step__kind { color: var(--accent); font-weight: 400; }
.step--superseded { opacity: 0.6; }
.step--superseded .step__kind { text-decoration: line-through; }
.step.is-brittle .step__mark { color: var(--amber); }
.step__brittle { color: var(--amber); }
.step__fail { color: var(--amber); overflow-wrap: anywhere; }
.remainder { opacity: 0.55; }
.remainder li { display: grid; grid-template-columns: 18px 1fr; gap: 2px 6px; margin-bottom: 6px; }

.cut { margin: 10px 0; }
.cut__rule {
  font-size: 11px; color: var(--amber); text-transform: uppercase; letter-spacing: 0.06em;
  padding-bottom: 4px; border-bottom: 2px dashed rgb(255 194 75 / 0.4);
}
.cut__attempts { margin: 6px 0 0; padding-left: 34px; font-size: 11px; color: var(--muted); }
.cut code, .seg code, .remainder code { font-family: var(--font-mono); font-size: 11px; }
```

- [ ] **Step 4: Typecheck the app**

Run: `npm --prefix app run typecheck`
Expected: still only the known `ReplayScreen.tsx` failure.

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/src/screens/RouteStrip.tsx app/src/renderer/src/screens/PlanSegment.tsx app/src/renderer/src/styles.css
git commit -m "feat(app): route strip and one-narrative segment rendering

Brittleness, the cut and the remainder are per-edge facts and steps carry
edgeId, so they become annotations on the steps rather than four more sections
printing shortId(edgeId) for the reader to correlate by eye.

The remainder is bulleted, not numbered: buildPlan discloses it explicitly as
'not targets', and a step number is a claim of authorization."
```

---

### Task 7: The run log and the gates

The accumulating list plus the two gates, whose asymmetry must be preserved exactly: blockers can NEVER be overridden — `assertable` means no UI action produces the predicate, so there is nothing an override could mean — while brittleness can be, behind a tick that names what is being accepted.

**Files:**
- Create: `app/src/renderer/src/screens/RunLog.tsx`
- Delete: `app/src/renderer/src/screens/PlanReview.tsx`
- Modify: `app/src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `PlanSegment`, `SegmentOutcome` from Task 6.
- Produces:
  ```ts
  export function stopMessage(reason: ReplayStopReason, detail?: string): string;
  export interface LoggedSegment { plan: PlanDTO; outcome: SegmentOutcome }
  export function RunLog(props: {
    segments: LoggedSegment[];
    status: string | null;
    busy: boolean;
    onArm: (override: boolean) => void;
    onCancel: () => void;
  }): React.JSX.Element;
  ```
  `stopMessage` moves here verbatim from `PlanReview.tsx:18-37`. Task 8 imports `LoggedSegment`; Task 9 imports `stopMessage` and `RunLog`.

- [ ] **Step 1: Write `RunLog.tsx`**

```tsx
/**
 * The whole run, not just the current segment.
 *
 * The gates keep the library's asymmetry exactly. Blockers can NEVER be
 * overridden — `assertable` means no UI action produces the predicate, so there
 * is nothing an override could mean. Brittleness can be, behind a tick that
 * names what is being accepted.
 *
 * The gate bar is PINNED. Arm used to sit below blockers, the cut, the
 * remainder and the brittleness table, so authorizing a click meant scrolling
 * past everything that might argue against it.
 */

import React, { useState } from "react";
import type { PlanDTO, ReplayStopReason } from "@shared/types";
import { PlanSegment, type SegmentOutcome } from "./PlanSegment.js";

export function stopMessage(reason: ReplayStopReason, detail?: string): string {
  switch (reason) {
    case "cancelled":
      return "Cancelled — no event was posted.";
    case "handoff-failed":
      return `${detail ?? "The app"} did not come forward; nothing was posted.`;
    case "observe-blocked":
      return "DeskRAG stayed frontmost, so there was nothing to observe. Nothing was posted.";
    case "not-located":
      return "The desktop matches no recorded state.";
    case "no-path":
      return "No recorded path from here to that state.";
    case "no-progress":
      return "The first action's target is gone from this screen.";
    case "max-segments":
      return "Stopped after the segment limit.";
    case "failed":
      return detail ?? "A step failed; the run stopped.";
  }
}

export interface LoggedSegment {
  plan: PlanDTO;
  outcome: SegmentOutcome;
}

export function RunLog({
  segments,
  status,
  busy,
  onArm,
  onCancel,
}: {
  segments: LoggedSegment[];
  status: string | null;
  busy: boolean;
  onArm: (override: boolean) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [override, setOverride] = useState(false);
  /** Only the segment being decided is open by default; finished ones collapse. */
  const [openId, setOpenId] = useState<string | null>(null);

  const pending = segments.find((s) => s.outcome.state === "awaiting");
  const plan = pending?.plan;
  const brittle = plan === undefined ? [] : plan.brittleness.filter((b) => b.belowFloor);
  const blocked = plan !== undefined && plan.blockers.length > 0;
  const needsOverride = brittle.length > 0;

  return (
    <div className="runlog">
      <div className="runlog__list">
        {segments.map((s) => (
          <PlanSegment
            key={s.plan.id}
            plan={s.plan}
            outcome={s.outcome}
            expanded={openId === null ? s.outcome.state === "awaiting" : openId === s.plan.id}
            onToggle={() => setOpenId((cur) => (cur === s.plan.id ? "" : s.plan.id))}
          />
        ))}
        {status !== null && <p className="runlog__status">{status}</p>}
      </div>

      <div className="runlog__gate">
        {blocked && plan !== undefined && (
          <section className="gate__block">
            <h3>Blocked</h3>
            <ul>
              {plan.blockers.map((b, i) => (
                <li key={i}>
                  {b.reason} <span className="muted">({b.scope})</span>
                </li>
              ))}
            </ul>
            <p className="muted">No UI action produces these, so there is no override.</p>
          </section>
        )}

        {needsOverride && !blocked && (
          <label className="gate__override">
            <input
              type="checkbox"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
            />
            Arm anyway — {brittle.length} edge(s) resolve mostly to coordinates, which click
            whatever has moved into that spot.
          </label>
        )}

        <div className="gate__actions">
          <button className="btn ghost" onClick={onCancel} disabled={busy || plan === undefined}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={busy || plan === undefined || blocked || (needsOverride && !override)}
            onClick={() => onArm(override)}
          >
            {plan === undefined ? "Arm" : `Arm segment ${plan.segment}`}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Note the `onToggle` collapse sentinel is `""` (never a real plan id), so "collapse the open one" is distinguishable from "no explicit choice yet" (`null`).

- [ ] **Step 2: Delete the old panel**

```bash
git rm app/src/renderer/src/screens/PlanReview.tsx
```

- [ ] **Step 3: Replace the old review CSS**

In `app/src/renderer/src/styles.css`, delete lines 1499-1538 — the `.review` block through `.review--empty p.muted` — EXCEPT keep `.nearby`, `.nearby__head`, `.nearby__score`, `.nearby ul` and `.nearby li` (the sheet reuses them, Task 5). Then append:

```css
.runlog {
  display: flex; flex-direction: column; min-height: 0; flex: 1;
  border: 1px solid var(--hairline); border-radius: var(--radius);
  background: var(--panel);
}
.runlog__list { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; }
/* A boundary-verification failure names every predicate that did not hold, so
   this line can be long and must wrap rather than widen the column. */
.runlog__status { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; padding-top: 8px; }
.runlog__gate {
  flex: 0 0 auto; padding: 10px 12px; border-top: 1px solid var(--hairline);
  background: var(--elevated); border-radius: 0 0 var(--radius) var(--radius);
}
.gate__block { border-left: 3px solid var(--rec); padding-left: 8px; margin-bottom: 8px; }
.gate__block h3 { font-size: 12px; margin: 0 0 4px; }
.gate__block ul { margin: 0; padding-left: 16px; font-size: 12px; }
.gate__override { display: block; margin-bottom: 8px; font-size: 12px; }
.gate__actions { display: flex; gap: 8px; justify-content: flex-end; }
```

`--rec` on the blocker border is the one legitimate replay use of the recording red: a blocker is the hardest stop the system has.

- [ ] **Step 4: Typecheck the app**

Run: `npm --prefix app run typecheck`
Expected: `ReplayScreen.tsx` now fails on the missing `./PlanReview.js` import too. Still the only failing file.

- [ ] **Step 5: Commit**

```bash
git add -A app/src/renderer/src/screens app/src/renderer/src/styles.css
git commit -m "feat(app): accumulating run log with a pinned gate bar

Arm used to sit below blockers, the cut, the remainder and the brittleness
table, so authorizing a click meant scrolling past everything arguing against
it. Pin the gates; scroll the narrative. Blocker/brittleness asymmetry is
unchanged. PlanReview.tsx is replaced; stopMessage moves with it."
```

---

### Task 8: Infer segment outcomes from the events that already exist

`report()` emits `segment-done` for EVERY segment at once, after the whole run returns — `executeRun` has no per-segment callback. So while segment 2 is being reviewed, segment 1's outcome has not been reported. It is nonetheless sound to infer: `executeRun` plans segment N+1 only if segment N completed.

This is the reducer that turns the event stream into `LoggedSegment[]`. It is pure, so it goes in the root suite.

**Files:**
- Create: `app/src/renderer/src/screens/run-log.ts`
- Test: `test/replay.run-log.test.ts`

**Interfaces:**
- Consumes: `LoggedSegment` from Task 7, `SegmentOutcome` from Task 6, `RunEventDTO` from `@shared/types`.
- Produces: `export function reduceRunEvent(segments: LoggedSegment[], event: RunEventDTO): LoggedSegment[]`. Task 9 calls it in the `onEvent` handler.

- [ ] **Step 1: Write the failing test**

Create `test/replay.run-log.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PlanDTO, RunEventDTO } from "../app/src/shared/types.js";
import { reduceRunEvent } from "../app/src/renderer/src/screens/run-log.js";
import type { LoggedSegment } from "../app/src/renderer/src/screens/RunLog.js";

const plan = (segment: number): PlanDTO => ({
  id: `p${segment}`,
  segment,
  from: `n${segment}`,
  to: `n${segment + 1}`,
  fromLabel: "TextEdit",
  toLabel: "Chrome",
  steps: [
    { kind: "handoff", app: "TextEdit" },
    { kind: "action", edgeId: "e1", action: "click", target: 'Button "Bold"' },
  ],
  blockers: [],
  brittleness: [],
  remainder: [],
});

const run = (events: RunEventDTO[]): LoggedSegment[] =>
  events.reduce<LoggedSegment[]>(reduceRunEvent, []);

describe("reduceRunEvent", () => {
  it("opens a planned segment awaiting approval", () => {
    const out = run([{ type: "segment-planned", plan: plan(1) }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.outcome.state).toBe("awaiting");
  });

  it("marks it running once armed", () => {
    const out = run([{ type: "segment-planned", plan: plan(1) }, { type: "armed", segment: 1 }]);
    expect(out[0]!.outcome.state).toBe("running");
  });

  it("infers an earlier segment completed when a later one is planned", () => {
    // executeRun only plans segment N+1 if segment N completed, and
    // segment-done for BOTH arrives after the whole run returns.
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "armed", segment: 1 },
      { type: "segment-planned", plan: plan(2) },
    ]);
    expect(out[0]!.outcome.state).toBe("completed");
    expect(out[1]!.outcome.state).toBe("awaiting");
  });

  it("records a failure with its DTO-space step index and reason", () => {
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "armed", segment: 1 },
      {
        type: "segment-done",
        segment: 1,
        completed: false,
        failure: { step: 1, reason: 'ax_exists(label="Stop recording")' },
        telemetry: [],
      },
    ]);
    expect(out[0]!.outcome).toEqual({
      state: "failed",
      failedStep: 1,
      reason: 'ax_exists(label="Stop recording")',
    });
  });

  it("confirms a completion the successor already implied", () => {
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "armed", segment: 1 },
      { type: "segment-planned", plan: plan(2) },
      { type: "segment-done", segment: 1, completed: true, telemetry: [] },
    ]);
    expect(out[0]!.outcome.state).toBe("completed");
  });

  it("leaves a refusal-to-start with no step index", () => {
    // failedStepIndex returns undefined for raw -1, so the event carries no
    // `failure` at all. The segment still failed.
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "armed", segment: 1 },
      { type: "segment-done", segment: 1, completed: false, telemetry: [] },
    ]);
    expect(out[0]!.outcome.state).toBe("failed");
    expect(out[0]!.outcome.failedStep).toBeUndefined();
  });

  it("stops leaves a still-awaiting segment alone — Cancel is not a failure", () => {
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "stopped", reached: false, reason: "cancelled" },
    ]);
    expect(out[0]!.outcome.state).toBe("awaiting");
  });

  it("demotes a segment left running when the run stops without reporting it", () => {
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "armed", segment: 1 },
      { type: "stopped", reached: false, reason: "handoff-failed" },
    ]);
    expect(out[0]!.outcome.state).toBe("failed");
  });

  it("replaces a re-plan of the same segment rather than appending", () => {
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "segment-planned", plan: { ...plan(1), toLabel: "Safari" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.plan.toLabel).toBe("Safari");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/replay.run-log.test.ts`
Expected: FAIL — cannot resolve `run-log.js`.

- [ ] **Step 3: Write the reducer**

Create `app/src/renderer/src/screens/run-log.ts`:

```ts
/**
 * The event stream, folded into the run log the reviewer reads.
 *
 * WHY OUTCOMES ARE INFERRED. `replay-service.report()` emits `segment-done` for
 * EVERY segment at once, after the whole run returns — `executeRun` has no
 * per-segment callback, only `arm`, and reporting one segment would discard the
 * telemetry of every earlier one. So while segment 2 is being reviewed,
 * segment 1's outcome has not been reported yet.
 *
 * It is still sound to conclude segment 1 completed: `executeRun` plans segment
 * N+1 only if segment N completed. The final burst confirms the inference and
 * supplies the failure detail. That is why this needs no new IPC event.
 */

import type { RunEventDTO } from "@shared/types";
import type { SegmentOutcome } from "./PlanSegment.js";
import type { LoggedSegment } from "./RunLog.js";

const withOutcome = (s: LoggedSegment, outcome: SegmentOutcome): LoggedSegment => ({
  plan: s.plan,
  outcome,
});

export function reduceRunEvent(
  segments: LoggedSegment[],
  event: RunEventDTO,
): LoggedSegment[] {
  switch (event.type) {
    case "segment-planned": {
      const at = segments.findIndex((s) => s.plan.segment === event.plan.segment);
      const entry: LoggedSegment = { plan: event.plan, outcome: { state: "awaiting" } };
      // A re-plan of the same segment replaces it. Appending would show the
      // reviewer two versions of one decision.
      if (at >= 0) return segments.map((s, i) => (i === at ? entry : s));
      // Every EARLIER segment must have completed, or this one would not exist.
      return [
        ...segments.map((s) =>
          s.outcome.state === "awaiting" || s.outcome.state === "running"
            ? withOutcome(s, { state: "completed" })
            : s,
        ),
        entry,
      ];
    }

    case "armed":
      return segments.map((s) =>
        s.plan.segment === event.segment ? withOutcome(s, { state: "running" }) : s,
      );

    case "segment-done":
      return segments.map((s) => {
        if (s.plan.segment !== event.segment) return s;
        if (event.completed) return withOutcome(s, { state: "completed" });
        return withOutcome(s, {
          state: "failed",
          // Already DTO space — `report()` converts with `failedStepIndex`, and
          // re-shifting here would undo that fix. Absent when the segment
          // refused to start, because then no step ran.
          ...(event.failure !== undefined
            ? { failedStep: event.failure.step, reason: event.failure.reason }
            : {}),
        });
      });

    case "stopped":
      // A segment left RUNNING when the run stops never got its own report —
      // a failed handoff or a blocked observation ends the run before
      // execution. One still AWAITING was cancelled, which is not a failure.
      return segments.map((s) =>
        s.outcome.state === "running" ? withOutcome(s, { state: "failed" }) : s,
      );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/replay.run-log.test.ts`
Expected: PASS, all nine cases.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: pass. (`npm --prefix app run typecheck` still fails on `ReplayScreen.tsx` — Task 9.)

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/src/screens/run-log.ts test/replay.run-log.test.ts
git commit -m "feat(app): fold run events into a segment log, outcomes inferred

report() emits segment-done for every segment only after the whole run returns,
so an earlier segment's outcome is unknown while a later one is reviewed. It is
inferable: executeRun plans segment N+1 only if N completed. The final burst
confirms it and supplies the failure detail — no new IPC event."
```

---

### Task 9: Wire the screen, and validate against the real graph

The last task: mode derivation, the peek flag, state ownership, and the acceptance check this repo has paid for twice — synthetic fixtures agree with whatever the code assumes.

**Files:**
- Modify: `app/src/renderer/src/screens/ReplayScreen.tsx` (rewrite)
- Modify: `app/src/renderer/src/styles.css` (the `.replay` block, lines 1446-1465)

**Interfaces:**
- Consumes: everything from Tasks 1, 3-8.
- Produces: nothing — this is the leaf.

- [ ] **Step 1: Rewrite `ReplayScreen.tsx`**

```tsx
/**
 * Two modes, not a split.
 *
 * The stage holds ONE component. Browse is the graph plus its bottom sheet;
 * review is the route strip plus the run log. The base mode is derived, never
 * stored — `plan or log exists` — so there is no mode variable to desynchronize
 * from the data.
 *
 * `⟵ graph` is a PEEK, not a cancel. Looking at the graph while deciding
 * whether to arm is the loop this screen exists for, so the back affordance
 * works while a segment awaits approval; it sets one flag and posts nothing.
 * Browse then carries a bar saying an approval is outstanding, so an unanswered
 * authorization cannot be lost by navigating away. Only Cancel declines.
 */

import React, { useEffect, useMemo, useState } from "react";
import type { GraphDTO, LocationDTO, RunEventDTO } from "@shared/types";
import { api } from "../api.js";
import { GraphCanvas } from "./GraphCanvas.js";
import { NodeSheet } from "./NodeSheet.js";
import { RouteStrip } from "./RouteStrip.js";
import { RunLog, stopMessage, type LoggedSegment } from "./RunLog.js";
import { reduceRunEvent } from "./run-log.js";

export function ReplayScreen(): React.JSX.Element {
  const [graph, setGraph] = useState<GraphDTO | null>(null);
  const [location, setLocation] = useState<LocationDTO | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [segments, setSegments] = useState<LoggedSegment[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [allowLaunch, setAllowLaunch] = useState(false);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  /** Closed explicitly, so the diagnosis does not reopen on the next poll. */
  const [diagnosisClosed, setDiagnosisClosed] = useState(false);

  useEffect(() => {
    void api.replay.graph().then(setGraph);
    void api.replay.watch(true);
    const offLoc = api.replay.onLocation(setLocation);
    const offEvt = api.replay.onEvent((e: RunEventDTO) => {
      setSegments((cur) => reduceRunEvent(cur, e));
      if (e.type === "segment-planned") {
        setBusy(false);
        setStatus(null);
        // A new decision is due: stop peeking and show it.
        setPeeking(false);
      } else if (e.type === "armed") {
        setBusy(true);
        setStatus(e.app === undefined ? "Arming…" : `Returning focus to ${e.app}…`);
      } else if (e.type === "segment-done") {
        setStatus(null);
      } else {
        setBusy(false);
        setStatus(
          e.reached
            ? "Reached the goal."
            : e.reason === undefined
              ? "Stopped."
              : stopMessage(e.reason, e.detail),
        );
      }
    });
    return () => {
      offLoc();
      offEvt();
      void api.replay.watch(false);
    };
  }, []);

  const here = useMemo(() => {
    if (location === null) return "Looking…";
    const where =
      location.nodeId !== undefined
        ? `${location.app ?? "?"}${location.window !== undefined ? ` — ${location.window}` : ""}`
        : location.ambiguous
          ? `ambiguous — ${location.candidates} candidates`
          : "no recorded state matches";
    // While DeskRAG is frontmost the reading describes the reviewer, so the
    // service re-emits the last foreign one with its age. Say so.
    return location.staleMs !== undefined && location.staleMs > 0
      ? `last seen: ${where}, ${Math.round(location.staleMs / 1000)}s ago`
      : where;
  }, [location]);

  if (graph === null) {
    return (
      <div className="page replay">
        <p className="muted">No trace graph yet. Record a session, or rebuild from the Library.</p>
      </div>
    );
  }

  const pending = segments.find((s) => s.outcome.state === "awaiting");
  const reviewing = segments.length > 0 && !peeking;
  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;
  const edgeCounts = {
    in: graph.edges.filter((e) => e.to === selectedId).length,
    out: graph.edges.filter((e) => e.from === selectedId).length,
  };

  return (
    <div className="page page--fill replay">
      <div className="replay__bar">
        <button
          className={`chip${location?.nodeId !== undefined ? " live" : ""}`}
          onClick={() => setDiagnosisClosed(false)}
          title="Show why nothing matched"
        >
          <span className="dot" /> {here}
        </button>
        {peeking && pending !== undefined && (
          <button className="replay__pending" onClick={() => setPeeking(false)}>
            Segment {pending.plan.segment} awaiting approval · return to review
          </button>
        )}
      </div>

      {reviewing ? (
        <div className="replay__stage">
          <RouteStrip
            plan={pending?.plan ?? segments[segments.length - 1]?.plan ?? null}
            graph={graph}
            pending={pending !== undefined}
            onBack={() => {
              // A finished run leaves review for real; a pending one peeks.
              if (pending === undefined) setSegments([]);
              else setPeeking(true);
            }}
          />
          <RunLog
            segments={segments}
            status={status}
            busy={busy}
            onArm={(override) => {
              setBusy(true);
              void api.replay.arm({
                segment: pending?.plan.segment ?? 1,
                approve: true,
                override,
              });
            }}
            onCancel={() => void api.replay.cancel()}
          />
        </div>
      ) : (
        <div className="replay__stage">
          <GraphCanvas
            graph={graph}
            selectedId={selectedId}
            locationNodeId={location?.nodeId}
            onSelect={(id) => {
              setSelectedId(id);
              if (id !== null) setDiagnosisClosed(false);
            }}
          />
          <NodeSheet
            node={selected}
            nearest={diagnosisClosed ? undefined : location?.nearest}
            slots={graph.slots}
            bindings={bindings}
            allowLaunch={allowLaunch}
            busy={busy}
            edgeCounts={edgeCounts}
            onBind={(name, value) => setBindings((b) => ({ ...b, [name]: value }))}
            onAllowLaunch={setAllowLaunch}
            onRun={() => {
              if (selectedId === null) return;
              setStatus("Planning…");
              setBusy(true);
              setPeeking(false);
              void api.replay.start({
                goalNodeId: selectedId,
                slotBindings: bindings,
                allowLaunch,
              });
            }}
            onClose={() => {
              if (selected !== null) setSelectedId(null);
              else setDiagnosisClosed(true);
            }}
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Replace the stage CSS**

In `app/src/renderer/src/styles.css`, replace lines 1446-1465 (`/* --- replay --- */` through the `.replay__stage` block) with:

```css
/* --- replay -------------------------------------------------------------- */
.replay { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
/* This file has no global muted-text utility — `.hint` and `.sub` are both
   scoped — so this one is scoped to the surfaces added here rather than
   introducing a global class the rest of the app does not use. */
.replay .muted, .sheet .muted, .runlog .muted, .route .muted { color: var(--muted); }
.replay__bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.replay__pending {
  font-size: 11px; color: var(--amber); padding: 3px 9px; border-radius: 999px;
  background: rgb(255 194 75 / 0.14); border: 1px solid rgb(255 194 75 / 0.3);
}

/* ONE slot, holding browse or review. The old fixed 1fr/340px split mounted the
   review column permanently to hold a single sentence. Both children need
   min-height: 0 or the log's long text grows the row instead of scrolling. */
.replay__stage {
  display: flex; flex-direction: column; gap: 12px;
  flex: 1; min-height: 0;
}
.replay__stage > .gcanvas { flex: 1; min-height: 200px; }
```

- [ ] **Step 3: Typecheck everything**

Run: `npm run typecheck && npm test && npm --prefix app run typecheck`
Expected: all three clean. This is the first point since Task 4 that the app typechecks.

- [ ] **Step 4: Build and launch against the real graph**

```bash
npm run build && npm run app:dev
```

Quit any dev instance first. The app reads `~/Library/Application Support/deskrag-app/DeskRAG/`.

- [ ] **Step 5: Walk the acceptance checklist on the real accreted graph**

Synthetic fixtures agree with whatever the code assumes — both of this repo's worst bugs were invisible to `npm test` and obvious within minutes of driving real data. Check each, on the real `DEFAULT_GRAPH_ID` graph:

1. **Flows downward**, ranks as rows, and the whole graph is visible on open without touching a control.
2. **Colliding labels** — the two Chrome nodes both labelled "Google Chrome" are distinguishable by their id chips.
3. **The over-merged bare-`app` node** (`observations = 6`) shows the `unlocatable` tag, and its sheet disables "Run to here" with the tooltip.
4. **Back edges from merges** bow to the margin and do not cross the cards between their endpoints.
5. **A DeskRAG hub node's** sheet lists `ax_exists(label="Stop recording")` — making it obvious why that node cannot verify outside recording mode.
6. **Wires do not cross** where a parent has two children that each have one child (the barycenter case).
7. **`◎ me`** is disabled when nothing is located and centres the located card when something is.
8. **Escape and a click on empty canvas** both close the sheet; a click that ends a *pan* does not.
9. **Pick a locatable goal and press Run.** The screen switches to review; the route strip shows the chain; the gate bar is visible without scrolling.
10. **Press `⟵ graph` while the plan is pending.** The graph returns with the amber "awaiting approval" bar, and nothing is posted. Pressing that bar goes back to the plan.
11. **Cancel.** `stopMessage` renders "Cancelled — no event was posted."

Record anything that differs. Any measurement taken from one application is provisional — the anchor ladder was falsified twice, each time by recording in one more app.

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/src/screens/ReplayScreen.tsx app/src/renderer/src/styles.css
git commit -m "feat(app): switch the Replay screen between browse and review

The stage holds one component. Mode is derived from whether a plan or run log
exists, so the review surface only exists when there is something to review —
the old empty 340px column is gone. Selection is the goal; slots and
allow-launch live with Run in the sheet.

'⟵ graph' peeks without cancelling, and browse carries a bar while an approval
is outstanding so it cannot be lost by navigating away."
```

---

### Task 10: Update CLAUDE.md

The Replay screen section in `CLAUDE.md` describes the surface this plan replaces, and CLAUDE.md is the invariants reference.

**Files:**
- Modify: `CLAUDE.md` (the "**The Replay screen is the plan review surface**" bullet and its sub-bullets)

- [ ] **Step 1: Rewrite the Replay screen bullets**

Keep every invariant that is still true — the reviewer-is-an-application rule, the double get-out-of-the-way inside `arm`, `app.hide()` vs `win.hide()`, the poller using `ax-exec`, the `frameBlobId`-is-a-frame-id trap, and the node-label collision rule. Replace the layout description and add what this work established:

```markdown
  - **The screen is TWO MODES, not a split.** Browse is the graph plus a bottom
    sheet; review is the route strip plus the run log. Mode is derived from
    whether a plan or run log exists, never stored. The old fixed
    `1fr / 340px` grid mounted the review column permanently to hold one
    sentence, and sized the graph for a column that was empty most of the time.
  - **The graph flows DOWNWARD and its layout is pure** (`graph-layout.ts`, in
    the ROOT suite like `plan-view.ts`). Rank is the row, so the graph grows
    along the axis a window has to spare. Within a rank, order by the mean x of
    already-placed parents — ties break on array index, and that tiebreak is
    load-bearing: `LocationDTO` arrives on a 2s poll and re-renders the canvas,
    so a layout that reordered on equal barycenters would twitch continuously.
    Fit runs ONCE per mount for the same reason.
  - **Selection is the goal.** One piece of state, so there is nothing to
    desynchronize. Slots and allow-launch live with Run in the sheet and render
    only when the graph has slots.
  - **A node's predicates and its `locatable` flag reach the renderer**
    (`GraphNodeDTO`). `isLocatable` had to be added to the barrel — it was
    reachable only from inside `replay/locate.ts`. A node whose identity is only
    `app` cannot be a goal, and the screen says so before the click.
  - **Brittleness, the cut and the remainder are ANNOTATIONS on the steps**, not
    sections. They are per-edge facts and steps carry `edgeId`; printing
    `shortId(edgeId)` in four separate places made the reader correlate by eye.
    **The remainder is bulleted, never numbered** — `buildPlan` discloses it as
    "explicitly not targets", and a step number is a claim of authorization.
  - **Segment outcomes are INFERRED, and that needs no new IPC.** `report()`
    emits `segment-done` for every segment at once *after the whole run
    returns*, so an earlier segment's outcome is unknown while a later one is
    reviewed. `executeRun` plans segment N+1 only if N completed, so the log
    concludes it; the final burst confirms and supplies the failure detail.
  - **There is no live per-step progress, deliberately.** `arm` calls
    `app.hide()`, so the window is hidden for the whole of execution. Per-step
    events would add library surface to render a view nobody can see.
  - **`telemetry` is the PLANNED resolution echoed back** (`execute.ts:117`).
    There is no measured-at-execution resolution anywhere in the system, so no
    UI may present one. The run log reports which steps ran — from `completed`
    plus `failure.step` — and nothing more.
  - **`segment-done.failure.step` is DTO-space, converted at the emit site.**
    `execute.ts` indexes the library's `plan.steps`; the DTO prepends a handoff
    step whenever the `from` node carries an `app` predicate, which is nearly
    always. The screen named a step one below the one that failed until
    `failedStepIndex` was applied in `report()`.
  - **`⟵ graph` is a peek, not a cancel.** Browse carries a bar while an
    approval is outstanding, so an unanswered authorization cannot be lost by
    navigating away. Only Cancel declines.
```

- [ ] **Step 2: Verify no stale claim remains**

Run: `grep -n "340px\|replay__stage\|PlanReview\|goalId" CLAUDE.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the Replay screen's two modes and their invariants

The layout description named a split that no longer exists. Adds the four rules
this work established: the barycenter tiebreak is what stops the canvas
twitching under the location poll, telemetry is the planned resolution echoed
back and must never be shown as measured, segment outcomes are inferable from
the ordering executeRun guarantees, and failure.step is DTO-space."
```

---

## Self-Review

**Spec coverage.** Every section of `2026-08-02-replay-screen-ux-design.md` maps to a task: two modes → 9; rank-as-row + barycenter + back-edge margin → 3; canvas defaults → 4; bottom sheet, predicates, `isLocatable`, slots relocation, selection-is-goal → 1, 5, 9; locating diagnosis → 5; outcome inference and no-live-progress → 8; route strip → 6; four sections as annotations and the bulleted remainder → 6; pinned gates → 7; the three contract changes → 1 and 2; the file table → all; testing → 1, 2, 3, 8, and the Task 9 walkthrough. The spec's rejected alternatives need no task. `CLAUDE.md` is not in the spec's file table but is required by the repo's own conventions, hence Task 10.

**Type consistency, checked across tasks.** `GraphNodeDTO.predicates` / `.locatable` (1) are read in 4, 5, 9. `failedStepIndex` (2) is used in `replay-service` only; its output flows to `SegmentOutcome.failedStep` (6) via `reduceRunEvent` (8) with no second shift. `layoutGraph` / `Layout` / `CARD_W` / `CARD_H` (3) are consumed in 4 under those exact names. `SegmentOutcome` is declared in `PlanSegment.tsx` (6) and imported by `run-log.ts` (8) and `RunLog.tsx` (7) — one declaration site. `LoggedSegment` is declared in `RunLog.tsx` (7) and imported by `run-log.ts` (8) and `ReplayScreen.tsx` (9). `GraphCanvas`'s props are `selectedId` / `onSelect` in both 4 and 9. `stopMessage` moves from `PlanReview.tsx` to `RunLog.tsx` (7) and is imported from there in 9.

**Ordering note.** Tasks 4-7 knowingly leave `app/src/renderer/src/typecheck` failing on `ReplayScreen.tsx` alone; each task's step says so, and Task 9 closes it. The root suite (`npm test`) stays green throughout.
