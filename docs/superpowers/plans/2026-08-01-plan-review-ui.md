# Plan Review UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give DeskRAGApp a Replay screen that renders a recorded trace graph, plans a run against the live desktop, and lets a human review and arm each segment — the first surface that can post a multi-segment run.

**Architecture:** `main/replay-service.ts` owns the `AxExecSidecar`, a location poller and the `executeRun` call; `main/plan-view.ts` is a pure `Graph`/`Plan` → DTO projection; the renderer gets a fifth rail route with a graph canvas and an always-present review column. The library is **not modified** — the focus handoff lives inside the injected `arm` callback, which is `async` and therefore gates execution by construction.

**Tech Stack:** TypeScript strict ESM, Electron + electron-vite, React 18, vitest. No new npm dependencies in either package.

**Spec:** `docs/superpowers/specs/2026-08-01-plan-review-ui-design.md`

## Global Constraints

- **Do not modify anything under `src/`.** This feature is a consumer of the merged executor. If a change to `src/replay/` seems necessary, stop and raise it — it means the design is wrong.
- **`app/src/shared/types.ts` imports nothing from Node or `deskrag`.** DTOs are structural mirrors, never re-exports.
- **`src/main` is the only process that may touch the library.** The renderer sees plain serializable DTOs only.
- **Bytes do not cross IPC.** Keyframes are served through the existing `deskrag://frame/<blobId>` protocol.
- **No new npm dependencies**, root or app. The graph layout is hand-written.
- **AX roles carry no `AX` prefix** in real data (`ax-dump.swift` does `rawRole.dropFirst(2)`). Any role comparison normalizes, and test fixtures use the unprefixed spelling.
- **There is no `window` predicate.** `extractPredicates` never emits one and `Window` is absent from `STABLE_ROLES`. A window title may only come from `AxObservation.windowTitle` (the live location), never from a node.
- **Blockers are never overridable.** Brittleness is, behind an explicit tick.
- Gates: `npm run typecheck`, `npm test`, `npm --prefix app run typecheck`. The app imports `dist/`, so run `npm run build` before `npm run app:dev`.
- Commit after every task. Branch is `feat/plan-review-ui`.

## File Structure

| File | Responsibility |
|---|---|
| `app/src/shared/types.ts` (modify) | DTOs + `IPC` channel names + `DeskRagApi.replay` |
| `app/src/main/plan-view.ts` (create) | Pure projection: `Graph`→`GraphDTO`, `Plan`→`PlanDTO`, labelling, BFS ranks |
| `app/src/main/replay-service.ts` (create) | Sidecar lifecycle, location poller, run + arm bridge, focus handoff |
| `app/src/main/deskrag-service.ts` (modify) | One accessor: `traceGraph()` |
| `app/src/main/ipc.ts` (modify) | Register the replay channels |
| `app/src/main/index.ts` (modify) | `ERAG_AX_EXEC_BIN` default; construct + close `ReplayService` |
| `app/src/preload/index.ts` (modify) | Bridge the replay channels |
| `app/src/renderer/src/screens/GraphCanvas.tsx` (create) | Ranked node/edge canvas, pan + zoom, you-are-here |
| `app/src/renderer/src/screens/PlanReview.tsx` (create) | The review column and the two gates |
| `app/src/renderer/src/screens/ReplayScreen.tsx` (create) | Split layout, run setup, event wiring |
| `app/src/renderer/src/App.tsx` (modify) | Fifth rail route |
| `app/src/renderer/src/icons.tsx` (modify) | `IconReplay` |
| `app/src/renderer/src/styles.css` (modify) | Replay screen styles |
| `vitest.config.ts` (modify) | `@shared` + `deskrag` aliases so `plan-view.ts` is testable |
| `test/replay.plan-view.test.ts` (create) | The projection's tests |

---

### Task 1: The DTO contract

Types and channel names only. Nothing consumes them yet; this exists so Tasks 2–5 share one vocabulary.

**Files:**
- Modify: `app/src/shared/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GraphNodeDTO`, `GraphEdgeDTO`, `GraphDTO`, `LocationDTO`, `PlanStepDTO`, `PlanDTO`, `RunEventDTO`, `ReplayStartInput`, `ReplayArmInput`, `DeskRagApi["replay"]`, and the `IPC` keys `replayGraph`, `replayWatch`, `replayStart`, `replayArm`, `replayCancel`, `replayEvent`, `replayLocationEvent`.

- [ ] **Step 1: Add the DTOs**

Append to `app/src/shared/types.ts`, before the `DeskRagApi` interface:

```ts
// --- replay (the plan review surface) ---------------------------------------

export interface GraphNodeDTO {
  id: string;
  /** "TextEdit — Save", or the id when the node describes no state. */
  label: string;
  app?: string;
  /**
   * A Sheet/Dialog or focused-element label. NEVER a window title: a title is
   * document identity rather than state, which is why `extractPredicates` emits
   * no `window` predicate and `STABLE_ROLES` omits `Window`.
   */
  hint?: string;
  /** From TraceNode.visual — served via deskrag://frame/<blobId>. */
  frameBlobId?: string;
  observations: number;
  intervene: "none" | "select" | "synthesize";
  /** BFS distance from the graph entry. The canvas's column. */
  rank: number;
}

export interface GraphEdgeDTO {
  id: string;
  from: string;
  to: string;
  actions: number;
  /** To an equal or lower rank — a loop a merge produced, not a mistake. */
  back: boolean;
  provenance: "recorded" | "synthesized";
}

export interface GraphDTO {
  id: string;
  entry: string;
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  slots: { name: string; samples: string[] }[];
}

/** Where the live desktop is, as far as the locator can tell. */
export interface LocationDTO {
  nodeId?: string;
  candidates: number;
  ambiguous: boolean;
  app?: string;
  /** From AxObservation.windowTitle — the one place a title is legitimate. */
  window?: string;
  /**
   * Age of the last FOREIGN observation. Set while DeskRAG itself is frontmost,
   * because then the observation describes the reviewer, not the desktop.
   */
  staleMs?: number;
}

export type PlanStepDTO =
  | { kind: "handoff"; app: string }
  | {
      kind: "action";
      edgeId: string;
      /** "click", "type", "wait until app(TextEdit)" — already human. */
      action: string;
      /** Described from the RECORDED descriptors, never from the resolution. */
      target: string;
      layer?: string;
      confidence?: number;
      slot?: { name: string; value: string };
    }
  | { kind: "repair"; edgeId: string; app: string; launch: boolean; reason: string }
  | { kind: "superseded"; edgeId: string; action: string; reason: string };

export interface PlanDTO {
  id: string;
  /** 1-based. There is deliberately no total: the loop does not know one. */
  segment: number;
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  steps: PlanStepDTO[];
  blockers: { reason: string; scope: "segment" | "remainder" }[];
  brittleness: {
    edgeId: string;
    axRate: number;
    belowFloor: boolean;
    bound: "measured" | "upper";
  }[];
  cut?: {
    resumeAt: string;
    edgeId: string;
    attempts: { layer: string; rejected: string }[];
  };
  remainder: {
    edgeId: string;
    toNodeId: string;
    actions: {
      kind: string;
      descriptors?: string[];
      /** Provenance. Never presented as a target. */
      recordedPoint?: { x: number; y: number };
      slot?: string;
    }[];
    repairs: { app: string; launch: boolean }[];
  }[];
  drift?: { expected: string; observed: string };
}

/**
 * Why the run ended. `declined` covers both a user's Cancel and a failed focus
 * handoff — `executeRun` reports any false `arm` as "declined" — so the service
 * distinguishes them here rather than leaving the panel to guess.
 */
export type ReplayStopReason =
  | "cancelled"
  | "handoff-failed"
  | "not-located"
  | "no-path"
  | "no-progress"
  | "max-segments"
  | "failed";

export type RunEventDTO =
  | { type: "segment-planned"; plan: PlanDTO }
  | { type: "armed"; segment: number; app?: string }
  | {
      type: "segment-done";
      segment: number;
      completed: boolean;
      failure?: { step: number; reason: string };
      telemetry: { edgeId: string; layer: string; confidence: number }[];
    }
  | { type: "stopped"; reached: boolean; reason?: ReplayStopReason; detail?: string };

export interface ReplayStartInput {
  goalNodeId: string;
  slotBindings?: Record<string, string>;
  allowLaunch?: boolean;
}

export interface ReplayArmInput {
  segment: number;
  approve: boolean;
  /** Accepts brittleness only. Blockers have no override and never will. */
  override?: boolean;
}
```

- [ ] **Step 2: Add the `replay` API surface**

Inside `interface DeskRagApi`, after the `sessions` block:

```ts
  replay: {
    graph(): Promise<GraphDTO | null>;
    /** Spawns/kills the ax-exec sidecar AND starts/stops the poller. */
    watch(on: boolean): Promise<void>;
    start(input: ReplayStartInput): Promise<void>;
    arm(input: ReplayArmInput): Promise<void>;
    cancel(): Promise<void>;
    onEvent(cb: (e: RunEventDTO) => void): () => void;
    onLocation(cb: (l: LocationDTO) => void): () => void;
  };
```

- [ ] **Step 3: Add the channel names**

Inside the `IPC` object, after `sessionsReindex`:

```ts
  replayGraph: "replay:graph",
  replayWatch: "replay:watch",
  replayStart: "replay:start",
  replayArm: "replay:arm",
  replayCancel: "replay:cancel",
  replayEvent: "replay:event",
  replayLocationEvent: "replay:location-event",
```

- [ ] **Step 4: Verify it compiles**

Run: `npm --prefix app run typecheck`
Expected: FAIL — `Property 'replay' is missing` in `app/src/preload/index.ts`, because the preload implements `DeskRagApi`. That is the correct failure and Task 5 fixes it. Confirm there is no *other* error.

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/types.ts
git commit -m "feat(app): the replay DTO contract

Structural mirrors, not re-exports: shared/types.ts imports nothing from
deskrag. PlanDTO carries every Plan field the review must disclose,
including the cut's attempt ladder and the remainder's recorded-only
descriptors.

ReplayStopReason splits what executeRun conflates: it reports any false
arm as \"declined\", which would put a user's Cancel and a failed focus
handoff under one word."
```

---

### Task 2: Graph projection — labelling and ranks

**Files:**
- Create: `app/src/main/plan-view.ts`
- Create: `test/replay.plan-view.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: `GraphDTO`, `GraphNodeDTO`, `GraphEdgeDTO` from Task 1.
- Produces: `labelNode(node: TraceNode): { label: string; app?: string; hint?: string }`, `rankNodes(graph: Graph): Map<string, number>`, `toGraphDTO(graph: Graph): GraphDTO`.

- [ ] **Step 1: Add the vitest aliases**

`plan-view.ts` lives under `app/` and imports `@shared/types` plus `deskrag`. Root vitest resolves neither. Replace the `test` block's contents in `vitest.config.ts` by adding a `resolve` section as a sibling of `test`:

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // `app/src/main/plan-view.ts` is a pure projection and belongs in the
      // suite, but it is written against the app's module names. Aliasing them
      // here is cheaper than duplicating the DTOs into `src/`.
      "@shared": here("./app/src/shared"),
      deskrag: here("./src/index.ts"),
    },
  },
  test: {
    // Native modules (better-sqlite3) + LanceDB and process-kill tests are not
    // safe to run concurrently across worker threads sharing temp dirs; each
    // test file gets its own tmp dir but we keep the pool single-forked to avoid
    // native-addon reload churn.
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Write the failing test**

Create `test/replay.plan-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { labelNode, rankNodes, toGraphDTO } from "../app/src/main/plan-view.js";
import type { Graph, Predicate, TraceEdge, TraceNode } from "../src/trace/types.js";

// Roles WITHOUT the "AX" prefix — the shape ax-dump actually emits
// (`rawRole.dropFirst(2)`). Matching the prefixed spelling is the bug that
// already shipped once in this repo and produced zero predicates from every
// real recording.
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
const focused = (role: string, label: string): Predicate => ({
  kind: "ax_focused",
  args: { role, label },
  reach: "achievable",
});

const node = (id: string, predicates: Predicate[] = []): TraceNode => ({
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
  outcomes: { attempts: 1, successes: 1 },
});

const graph = (nodes: TraceNode[], edges: TraceEdge[], entry = "n0"): Graph => ({
  id: "default",
  nodes,
  edges,
  slots: [],
  entry,
});

describe("labelNode", () => {
  it("names the app, and prefers a Sheet label as the hint", () => {
    const n = node("n1", [app("TextEdit"), exists("Button", "Cancel"), exists("Sheet", "Save")]);
    expect(labelNode(n)).toEqual({ label: "TextEdit — Save", app: "TextEdit", hint: "Save" });
  });

  it("falls back to the focused element when there is no sheet", () => {
    const n = node("n2", [app("TextEdit"), focused("TextArea", "Body")]);
    expect(labelNode(n)).toEqual({ label: "TextEdit — Body", app: "TextEdit", hint: "Body" });
  });

  it("normalizes a prefixed role, because a consumer must never assume", () => {
    const n = node("n3", [app("Chrome"), exists("AXDialog", "Open")]);
    expect(labelNode(n).hint).toBe("Open");
  });

  it("labels two same-app nodes identically rather than inventing a difference", () => {
    const a = node("n4", [app("TextEdit"), exists("Button", "Bold")]);
    const b = node("n5", [app("TextEdit"), exists("Button", "Italic")]);
    expect(labelNode(a).label).toBe("TextEdit");
    expect(labelNode(b).label).toBe(labelNode(a).label);
  });

  it("says a node with no predicates describes no state", () => {
    expect(labelNode(node("n0"))).toEqual({ label: "n0 — no state" });
  });

  it("never labels from a window title, which nodes do not carry", () => {
    // Defensive: PredicateKind lists "window" even though extractPredicates
    // never emits one. If that ever changes, it must not become a label.
    const n = node("n6", [
      app("TextEdit"),
      { kind: "window", args: { title: "report.rtf" }, reach: "achievable" },
    ]);
    expect(labelNode(n).label).toBe("TextEdit");
  });
});

describe("rankNodes", () => {
  it("ranks by BFS distance from the entry", () => {
    const g = graph(
      [node("n0"), node("n1"), node("n2")],
      [edge("e0", "n0", "n1"), edge("e1", "n1", "n2")],
    );
    expect([...rankNodes(g)]).toEqual([
      ["n0", 0],
      ["n1", 1],
      ["n2", 2],
    ]);
  });

  it("keeps the first-seen rank when a loop revisits a node", () => {
    const g = graph(
      [node("n0"), node("n1"), node("n2")],
      [edge("e0", "n0", "n1"), edge("e1", "n1", "n2"), edge("e2", "n2", "n1")],
    );
    expect(rankNodes(g).get("n1")).toBe(1);
  });

  it("ranks a node unreachable from the entry rather than dropping it", () => {
    const g = graph([node("n0"), node("n9")], []);
    expect(rankNodes(g).get("n9")).toBe(0);
  });
});

describe("toGraphDTO", () => {
  it("marks a back edge, and carries the keyframe id through", () => {
    const withFrame: TraceNode = {
      ...node("n1", [app("TextEdit")]),
      visual: { frameBlobId: "blob-1", phash: "ff" },
    };
    const g = graph(
      [node("n0"), withFrame],
      [edge("e0", "n0", "n1"), edge("e1", "n1", "n0")],
    );
    const dto = toGraphDTO(g);
    expect(dto.edges.map((e) => e.back)).toEqual([false, true]);
    expect(dto.nodes[1]?.frameBlobId).toBe("blob-1");
    expect(dto.nodes[1]?.rank).toBe(1);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run test/replay.plan-view.test.ts`
Expected: FAIL — cannot resolve `../app/src/main/plan-view.js`.

- [ ] **Step 4: Implement**

Create `app/src/main/plan-view.ts`:

```ts
/**
 * The projection the reviewer reads.
 *
 * Pure: no Electron, no Node, no I/O — which is what lets it live in the root
 * test suite. It is the last thing between a `Plan` and a human authorizing a
 * click, so it is tested rather than eyeballed.
 */

import type { GraphDTO, GraphEdgeDTO, GraphNodeDTO } from "@shared/types";
import type { Graph, Predicate, TraceNode } from "deskrag";

/**
 * Roles whose label names a STATE rather than a document. `Sheet` and `Dialog`
 * are kept in `STABLE_ROLES` for exactly this reason ("Open", "Save"), while
 * `Window` is excluded because its label is the open file.
 */
const HINT_ROLES: ReadonlySet<string> = new Set(["sheet", "dialog"]);

/**
 * Real data carries roles WITHOUT the `AX` prefix — the Swift sidecar strips it.
 * Predicate args are already canonical, so this is belt and braces; every
 * consumer of a role in this repo normalizes, and the one that did not produced
 * zero predicates from every recording.
 */
const canonical = (role: unknown): string =>
  typeof role === "string" ? role.replace(/^AX/i, "").toLowerCase() : "";

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/**
 * A node's name, from what nodes actually carry.
 *
 * There is no `window` predicate to use: `extractPredicates` never emits one and
 * `Window` is absent from `STABLE_ROLES`, both because a title is document
 * identity rather than state. Two nodes in one app with no sheet and no focused
 * element therefore label identically — the id chip on the card separates them,
 * and inventing a difference would be worse than showing there isn't one.
 */
export function labelNode(node: TraceNode): { label: string; app?: string; hint?: string } {
  const preds: readonly Predicate[] = node.predicates;
  const appName = str(preds.find((p) => p.kind === "app")?.args["app"]);

  const sheet = preds.find(
    (p) => p.kind === "ax_exists" && HINT_ROLES.has(canonical(p.args["role"])),
  );
  const focus = preds.find((p) => p.kind === "ax_focused");
  const hint = str(sheet?.args["label"]) ?? str(focus?.args["label"]);

  if (appName === undefined && hint === undefined) {
    return { label: `${node.id} — no state` };
  }
  const label = appName === undefined ? hint! : hint === undefined ? appName : `${appName} — ${hint}`;
  return {
    label,
    ...(appName !== undefined ? { app: appName } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}

/**
 * BFS distance from the entry, first-seen winning so a merged loop does not
 * re-rank its target. A node unreachable from the entry ranks 0 rather than
 * being dropped: an orphan is visible and fixable, an omitted node is not.
 */
export function rankNodes(graph: Graph): Map<string, number> {
  const out = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = outgoing.get(e.from);
    if (list === undefined) outgoing.set(e.from, [e.to]);
    else list.push(e.to);
  }

  const queue: string[] = [];
  if (graph.nodes.some((n) => n.id === graph.entry)) {
    out.set(graph.entry, 0);
    queue.push(graph.entry);
  }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    const next = (out.get(id) ?? 0) + 1;
    for (const to of outgoing.get(id) ?? []) {
      if (out.has(to)) continue;
      out.set(to, next);
      queue.push(to);
    }
  }

  for (const n of graph.nodes) if (!out.has(n.id)) out.set(n.id, 0);
  return out;
}

export function toGraphDTO(graph: Graph): GraphDTO {
  const ranks = rankNodes(graph);

  const nodes: GraphNodeDTO[] = graph.nodes.map((n) => {
    const named = labelNode(n);
    return {
      id: n.id,
      label: named.label,
      ...(named.app !== undefined ? { app: named.app } : {}),
      ...(named.hint !== undefined ? { hint: named.hint } : {}),
      ...(n.visual !== undefined ? { frameBlobId: n.visual.frameBlobId } : {}),
      observations: n.observations,
      intervene: n.intervene,
      rank: ranks.get(n.id) ?? 0,
    };
  });

  const edges: GraphEdgeDTO[] = graph.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    actions: e.actions.length,
    back: (ranks.get(e.to) ?? 0) <= (ranks.get(e.from) ?? 0),
    provenance: e.provenance,
  }));

  return {
    id: graph.id,
    entry: graph.entry,
    nodes,
    edges,
    slots: graph.slots.map((s) => ({ name: s.name, samples: [...s.samples] })),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/replay.plan-view.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Confirm nothing else broke**

Run: `npm test && npm run typecheck`
Expected: PASS. The aliases are additive; no existing test imports `@shared` or `deskrag`.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts app/src/main/plan-view.ts test/replay.plan-view.test.ts
git commit -m "feat(app): project a trace graph for review

Labels come from what nodes actually carry. There is no window
predicate — extractPredicates never emits one and Window is absent from
STABLE_ROLES, both because a title is document identity rather than
state — so a label is the app plus a Sheet/Dialog or focused-element
hint. Two same-app nodes with neither label identically; the id chip
separates them.

Ranks are BFS from the entry, first-seen winning so a merged loop does
not re-rank its target, and an unreachable node ranks 0 rather than
vanishing.

Pure, so it lives in the root suite behind two vitest aliases."
```

---

### Task 3: Plan projection

**Files:**
- Modify: `app/src/main/plan-view.ts`
- Modify: `test/replay.plan-view.test.ts`

**Interfaces:**
- Consumes: `labelNode` from Task 2; `PlanDTO`, `PlanStepDTO` from Task 1.
- Produces: `describeAction(a: Action): string`, `describeTarget(a: Action): string`, `toPlanDTO(plan: Plan, graph: Graph, segment: number, handoffApp?: string): PlanDTO`.

- [ ] **Step 1: Write the failing test**

Append to `test/replay.plan-view.test.ts`:

```ts
import { toPlanDTO } from "../app/src/main/plan-view.js";
import type { Anchor, Plan } from "../src/replay/types.js";

const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  point: { x: 10, y: 20, displayId: "d0" },
  ...over,
});

describe("toPlanDTO", () => {
  const g = graph(
    [node("n0", [app("TextEdit")]), node("n1", [app("Notes")])],
    [edge("e0", "n0", "n1")],
  );

  const base: Plan = {
    id: "p1",
    graphId: "default",
    from: "n0",
    to: "n1",
    steps: [],
    blockers: [],
    brittleness: [],
    remainder: [],
  };

  it("puts the handoff first, before any recorded action", () => {
    const plan: Plan = {
      ...base,
      steps: [
        {
          edgeId: "e0",
          action: { kind: "click", anchor: anchor(), button: 0, count: 1 },
          resolution: { layer: "identifier", point: { x: 1, y: 2 }, confidence: 1, attempts: [] },
        },
      ],
    };
    const dto = toPlanDTO(plan, g, 1, "TextEdit");
    expect(dto.steps[0]).toEqual({ kind: "handoff", app: "TextEdit" });
    expect(dto.steps[1]).toMatchObject({ kind: "action", layer: "identifier", confidence: 1 });
  });

  it("omits the handoff when there is no app to name", () => {
    expect(toPlanDTO(base, g, 1).steps).toEqual([]);
  });

  it("describes a target from the RECORDED descriptors, not the resolution", () => {
    const plan: Plan = {
      ...base,
      steps: [
        {
          edgeId: "e0",
          action: {
            kind: "click",
            anchor: anchor({ ax: { role: "Button", label: "Save", identifier: "save-btn", path: "Window[0]>Button[1]" } }),
            button: 0,
            count: 1,
          },
          resolution: { layer: "point", point: { x: 9, y: 9 }, confidence: 0.3, attempts: [] },
        },
      ],
    };
    const step = toPlanDTO(plan, g, 1).steps[0];
    expect(step).toMatchObject({ kind: "action", target: 'Button "Save" #save-btn' });
  });

  it("keeps superseded steps visible, with their reason", () => {
    const plan: Plan = {
      ...base,
      steps: [
        {
          superseded: "activate",
          edgeId: "e0",
          action: { kind: "click", anchor: anchor(), button: 0, count: 1 },
          reason: "the repair activates Notes directly",
        },
      ],
    };
    expect(toPlanDTO(plan, g, 1).steps[0]).toEqual({
      kind: "superseded",
      edgeId: "e0",
      action: "click",
      reason: "the repair activates Notes directly",
    });
  });

  it("carries blockers, the cut and the remainder through intact", () => {
    const plan: Plan = {
      ...base,
      blockers: [{ reason: "no keymap", scope: "segment" }],
      brittleness: [{ edgeId: "e0", axRate: 0.25, belowFloor: true, bound: "measured" }],
      cut: {
        resumeAt: "n1",
        edgeId: "e1",
        attempts: [{ layer: "identifier", rejected: "not found" }],
      },
      remainder: [
        {
          edgeId: "e1",
          toNodeId: "n2",
          actions: [{ kind: "click", descriptors: ["label"], recordedPoint: { x: 5, y: 6 } }],
          repairs: [{ repair: "activate", edgeId: "e1", app: "Notes", launch: false, reason: "app" }],
        },
      ],
    };
    const dto = toPlanDTO(plan, g, 2);
    expect(dto.blockers).toEqual([{ reason: "no keymap", scope: "segment" }]);
    expect(dto.brittleness[0]?.belowFloor).toBe(true);
    expect(dto.cut?.attempts).toEqual([{ layer: "identifier", rejected: "not found" }]);
    expect(dto.remainder[0]?.actions[0]?.recordedPoint).toEqual({ x: 5, y: 6 });
    expect(dto.remainder[0]?.repairs).toEqual([{ app: "Notes", launch: false }]);
    expect(dto.segment).toBe(2);
    expect(dto.fromLabel).toBe("TextEdit");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/replay.plan-view.test.ts -t "toPlanDTO"`
Expected: FAIL — `toPlanDTO is not a function`.

- [ ] **Step 3: Implement**

Append to `app/src/main/plan-view.ts`, and extend the type import to
`import type { Action, Anchor, Graph, Plan, PlanStep, Predicate, TraceNode } from "deskrag";`
plus the runtime guards `import { isRepairStep, isSupersededStep } from "deskrag";`
and the DTO types `PlanDTO`, `PlanStepDTO`:

```ts
const describePredicate = (p: Predicate): string => {
  const args = Object.entries(p.args)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
  return `${p.kind}(${args})`;
};

/** What the step does, in a reviewer's words rather than an enum's. */
export function describeAction(a: Action): string {
  switch (a.kind) {
    case "click":
      return a.count > 1 ? `${a.count}× click` : "click";
    case "drag":
      return "drag";
    case "hover":
      return `hover ${a.dwellMs}ms`;
    case "scroll":
      return "scroll";
    case "type":
      return "type";
    case "chord":
      return `press ${a.keys.join("+")}`;
    case "wait":
      return `wait until ${describePredicate(a.until)}`;
  }
}

const describeAnchor = (anchor: Anchor): string => {
  const ax = anchor.ax;
  if (ax === undefined) {
    return `point (${Math.round(anchor.point.x)}, ${Math.round(anchor.point.y)})`;
  }
  const parts = [ax.role];
  if (ax.label !== undefined && ax.label.length > 0) parts.push(`"${ax.label}"`);
  if (ax.identifier !== undefined && ax.identifier.length > 0) parts.push(`#${ax.identifier}`);
  return parts.join(" ");
};

/**
 * The target as RECORDED. Deliberately not sourced from the resolution: the
 * resolution is where the action will land, and the review has to show both so a
 * disagreement between them is visible rather than smoothed over.
 */
export function describeTarget(a: Action): string {
  switch (a.kind) {
    case "click":
    case "hover":
    case "scroll":
      return describeAnchor(a.anchor);
    case "drag":
      return `${describeAnchor(a.from)} → ${describeAnchor(a.to)}`;
    case "type":
      return `slot ${a.slot}`;
    case "chord":
    case "wait":
      return "—";
  }
}

const stepDTO = (s: PlanStep): PlanStepDTO => {
  if (isRepairStep(s)) {
    return {
      kind: "repair",
      edgeId: s.edgeId,
      app: s.app,
      launch: s.launch,
      reason: s.reason,
    };
  }
  if (isSupersededStep(s)) {
    return {
      kind: "superseded",
      edgeId: s.edgeId,
      action: describeAction(s.action),
      reason: s.reason,
    };
  }
  return {
    kind: "action",
    edgeId: s.edgeId,
    action: describeAction(s.action),
    target: describeTarget(s.action),
    ...(s.resolution !== undefined
      ? { layer: s.resolution.layer, confidence: s.resolution.confidence }
      : {}),
    ...(s.slotBinding !== undefined ? { slot: s.slotBinding } : {}),
  };
};

/**
 * `handoffApp` is the app the reviewer's window will be handed back to. It is
 * rendered as the plan's FIRST step because that is when it happens — inside
 * `arm`, before `executePlan` posts anything. Undefined when the `from` node
 * carries no `app` predicate: there is nothing to name, and the window is hidden
 * regardless.
 */
export function toPlanDTO(
  plan: Plan,
  graph: Graph,
  segment: number,
  handoffApp?: string,
): PlanDTO {
  const labelOf = (id: string): string => {
    const n = graph.nodes.find((x) => x.id === id);
    return n === undefined ? id : labelNode(n).label;
  };

  const steps: PlanStepDTO[] = [
    ...(handoffApp !== undefined ? [{ kind: "handoff" as const, app: handoffApp }] : []),
    ...plan.steps.map(stepDTO),
  ];

  return {
    id: plan.id,
    segment,
    from: plan.from,
    to: plan.to,
    fromLabel: labelOf(plan.from),
    toLabel: labelOf(plan.to),
    steps,
    blockers: plan.blockers.map((b) => ({ reason: b.reason, scope: b.scope })),
    brittleness: plan.brittleness.map((b) => ({
      edgeId: b.edgeId,
      axRate: b.axRate,
      belowFloor: b.belowFloor,
      bound: b.bound,
    })),
    ...(plan.cut !== undefined
      ? {
          cut: {
            resumeAt: plan.cut.resumeAt,
            edgeId: plan.cut.edgeId,
            attempts: plan.cut.attempts.map((a) => ({ layer: a.layer, rejected: a.rejected })),
          },
        }
      : {}),
    remainder: plan.remainder.map((r) => ({
      edgeId: r.edgeId,
      toNodeId: r.toNodeId,
      actions: r.actions.map((a) => ({
        kind: a.kind,
        ...(a.descriptors !== undefined ? { descriptors: [...a.descriptors] } : {}),
        ...(a.recordedPoint !== undefined ? { recordedPoint: { ...a.recordedPoint } } : {}),
        ...(a.slot !== undefined ? { slot: a.slot } : {}),
      })),
      repairs: r.repairs.map((p) => ({ app: p.app, launch: p.launch })),
    })),
    ...(plan.drift !== undefined ? { drift: { ...plan.drift } } : {}),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/replay.plan-view.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/plan-view.ts test/replay.plan-view.test.ts
git commit -m "feat(app): project a Plan into the review's DTO

Every Plan field is carried: blockers with their scope, per-edge
brittleness, the cut's attempt ladder rung by rung, and the remainder's
recorded descriptors and points. A field the reviewer cannot see is a
field the plan did not disclose, so the test asserts they survive
projection rather than trusting them to.

A target is described from the RECORDED descriptors, never from the
resolution — the review shows both so a disagreement is visible."
```

---

### Task 4: The sidecar and the location poller

**Files:**
- Create: `app/src/main/replay-service.ts`
- Modify: `app/src/main/deskrag-service.ts`

**Interfaces:**
- Consumes: `toGraphDTO` (Task 2); `GraphDTO`, `LocationDTO` (Task 1).
- Produces: `class ReplayService` with `graph(): GraphDTO | null`, `watch(on: boolean): void`, `onLocation(cb: (l: LocationDTO) => void): () => void`, `close(): void`; and `DeskRagService.traceGraph(): Graph | undefined`.

- [ ] **Step 1: Expose the graph from the service**

`store` is private on `DeskRagService`. Add one accessor after `getBlobRow`:

```ts
  /** The accreting trace graph every session merges into, or undefined before any. */
  traceGraph(): Graph | undefined {
    return this.store.getGraph(DEFAULT_GRAPH_ID);
  }
```

Add `Graph` to the existing `import type { … } from "deskrag"` block and `DEFAULT_GRAPH_ID` to the existing `./trace-index.js` import.

- [ ] **Step 2: Write the service**

Create `app/src/main/replay-service.ts`:

```ts
/**
 * The single owner of replay in the app: the ax-exec sidecar's lifetime, the
 * location poller, and (Task 5) the run.
 *
 * WHY THE POLLER USES ax-exec. `locateNode` needs an `app` predicate — nearly
 * every node carries one and cannot verify without it — and `ax-dump` reports no
 * app or window. `ax-exec`'s `dump` reports both in ONE call. Sourcing the tree
 * and the app name separately is the pattern the IR spec rejected by name: it is
 * what made boundary snapshots describe the previous application.
 *
 * The cost, stated rather than buried: a binary capable of clicking is alive
 * whenever the Replay screen is open, not only during an armed run. Its lifetime
 * is exactly `watch()`, it still gates on AXIsProcessTrusted() and still refuses
 * to start without --plan, and nothing posts outside executePlan.
 */

import { AxExecSidecar, locateNode, predicatesOf, type AxObservation, type Graph } from "deskrag";
import type { GraphDTO, LocationDTO } from "@shared/types";
import { toGraphDTO } from "./plan-view.js";

const POLL_MS = 2000;

/**
 * How DeskRAG names itself to the AX layer. `AxObservation.app` is the
 * `localizedName`, which is the app's display name — "Electron" in dev, since
 * that is what an unpackaged Electron reports.
 */
const SELF_NAMES: ReadonlySet<string> = new Set(["DeskRAG", "Electron"]);

export class ReplayService {
  private sidecar: AxExecSidecar | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastForeign: { at: number; location: LocationDTO } | null = null;
  private readonly locationCbs = new Set<(l: LocationDTO) => void>();

  constructor(private readonly getGraph: () => Graph | undefined) {}

  graph(): GraphDTO | null {
    const g = this.getGraph();
    return g === undefined ? null : toGraphDTO(g);
  }

  onLocation(cb: (l: LocationDTO) => void): () => void {
    this.locationCbs.add(cb);
    return () => this.locationCbs.delete(cb);
  }

  /** The screen being open is the whole of the sidecar's liveness condition. */
  watch(on: boolean): void {
    if (on) {
      this.ensureSidecar();
      if (this.timer === null) {
        this.timer = setInterval(() => void this.poll(), POLL_MS);
        void this.poll();
      }
      return;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.closeSidecar();
  }

  close(): void {
    this.watch(false);
    this.locationCbs.clear();
  }

  private ensureSidecar(): AxExecSidecar {
    if (this.sidecar === null) {
      this.sidecar = AxExecSidecar.spawn({
        planId: `deskrag-app-${Date.now()}`,
        ...(process.env["ERAG_AX_EXEC_BIN"] !== undefined
          ? { binaryPath: process.env["ERAG_AX_EXEC_BIN"] }
          : {}),
      });
    }
    return this.sidecar;
  }

  private closeSidecar(): void {
    this.sidecar?.close();
    this.sidecar = null;
  }

  private emit(l: LocationDTO): void {
    for (const cb of this.locationCbs) cb(l);
  }

  /**
   * WHEN DESKRAG IS FRONTMOST, THE OBSERVATION DESCRIBES THE REVIEWER.
   * Discard it and re-emit the last FOREIGN reading with its age. Without this
   * the indicator reads "no match" permanently, because looking at it is what
   * breaks it — and with it the workflow works the way a user expects: get the
   * target into the state you want, switch back, and the canvas still shows it.
   */
  private async poll(): Promise<void> {
    let observation: AxObservation;
    try {
      observation = await this.ensureSidecar().dump();
    } catch {
      // A dead sidecar must not kill the poller: drop it and try again next tick.
      this.closeSidecar();
      return;
    }

    if (observation.app !== undefined && SELF_NAMES.has(observation.app)) {
      const last = this.lastForeign;
      this.emit(
        last === null
          ? { candidates: 0, ambiguous: false, staleMs: 0 }
          : { ...last.location, staleMs: Date.now() - last.at },
      );
      return;
    }

    const location = this.locate(observation);
    this.lastForeign = { at: Date.now(), location };
    this.emit(location);
  }

  private locate(observation: AxObservation): LocationDTO {
    const graph = this.getGraph();
    const located =
      graph === undefined
        ? { candidates: 0, ambiguous: false }
        : locateNode(predicatesOf(observation), graph.nodes);
    return {
      ...(located.nodeId !== undefined ? { nodeId: located.nodeId } : {}),
      candidates: located.candidates,
      ambiguous: located.ambiguous,
      ...(observation.app !== undefined ? { app: observation.app } : {}),
      ...(observation.windowTitle !== undefined ? { window: observation.windowTitle } : {}),
    };
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run build && npm --prefix app run typecheck`
Expected: the only remaining error is the preload's missing `replay` property (Task 6). The `build` is required because the app typechecks `deskrag` against `dist/`.

- [ ] **Step 4: Commit**

```bash
git add app/src/main/replay-service.ts app/src/main/deskrag-service.ts
git commit -m "feat(app): observe the live desktop from the Replay screen

The poller goes through ax-exec because locateNode needs an app
predicate and only ax-exec's dump reports one, alongside the tree, in a
single call. Splitting that across ax-dump + active-win is the pattern
the IR spec rejected by name — two halves of one observation is what
made boundary snapshots describe the previous application.

The consequence is recorded rather than buried: a binary that can click
is alive while the screen is open. Its lifetime is exactly watch().

And the rule the poller needs: when DeskRAG is frontmost the observation
describes the reviewer, so it is discarded in favour of the last foreign
reading plus its age. Without it, looking at the indicator is what
breaks it."
```

---

### Task 5: The run, the arm bridge, and the focus handoff

**Files:**
- Modify: `app/src/main/replay-service.ts`

**Interfaces:**
- Consumes: `toPlanDTO` (Task 3), `ReplayService` (Task 4), `RunEventDTO`/`ReplayStartInput`/`ReplayArmInput` (Task 1).
- Produces: `ReplayService.start(input, hideWindow)`, `.arm(input)`, `.cancel()`, `.onEvent(cb)`.

- [ ] **Step 1: Add the run state and the event channel**

Add to `ReplayService`'s fields:

```ts
  private readonly eventCbs = new Set<(e: RunEventDTO) => void>();
  private running = false;
  /** Resolves the pending `arm` promise. Non-null only while a review is open. */
  private pendingArm: ((decision: { approve: boolean; override: boolean }) => void) | null = null;
  private override = false;
  /** Distinguishes the two things executeRun reports as "declined". */
  private stopReason: ReplayStopReason | null = null;
  private stopDetail: string | undefined;
```

and the subscription:

```ts
  onEvent(cb: (e: RunEventDTO) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  private emitEvent(e: RunEventDTO): void {
    for (const cb of this.eventCbs) cb(e);
  }
```

- [ ] **Step 2: Implement the run**

Add to `ReplayService`. Extend the `deskrag` import with `executeRun`, `SwiftKeymapSource`, and the types `Plan`, `ExecOutcome`, `RunOutcome`; extend the `@shared/types` import with `ReplayArmInput`, `ReplayStartInput`, `ReplayStopReason`, `RunEventDTO`; and import `toPlanDTO` from `./plan-view.js`.

```ts
  /**
   * `hideWindow` is injected rather than imported so this class never touches
   * Electron — the same reason `Actuator` is injected into `replay/`.
   */
  async start(input: ReplayStartInput, hideWindow: () => void): Promise<void> {
    if (this.running) return;
    const graph = this.getGraph();
    if (graph === undefined) {
      this.emitEvent({ type: "stopped", reached: false, reason: "no-path", detail: "no graph" });
      return;
    }

    // The layout to type through. No fallback: typing text against a layout
    // other than the one it was lifted from is silently wrong text, which is
    // exactly what the capture spec rejected a static table to avoid.
    const keymap = await new SwiftKeymapSource().query();

    this.running = true;
    this.stopReason = null;
    this.stopDetail = undefined;
    // The poller must not compete with the run for the sidecar's turn-taking.
    this.pausePolling();

    let segment = 0;
    // The brittleness override is decided per segment, INSIDE `arm` — so it
    // cannot be a snapshot value on this object. `run.ts` reads `input.override`
    // fresh on each turn, so a getter over a closure variable is what makes a
    // decision taken in segment N actually reach segment N's execution. Passing
    // `override: this.override` would evaluate once, before any review, and the
    // tick would silently do nothing.
    let override = false;
    try {
      const outcome = await executeRun({
        graph,
        actuator: this.ensureSidecar(),
        // Empty layout, not a US-QWERTY guess. `strokesFor` finds no keycode for
        // any character and typing becomes a blocker, which is the intended
        // outcome — same rule as `resolveKeys` at lift time, opposite direction.
        keymap: keymap ?? { layoutId: "", entries: {} },
        goalNodeId: input.goalNodeId,
        ...(input.slotBindings !== undefined ? { slotBindings: input.slotBindings } : {}),
        ...(input.allowLaunch !== undefined ? { allowLaunch: input.allowLaunch } : {}),
        get override(): boolean {
          return override;
        },
        arm: async (plan: Plan) => {
          segment += 1;
          const approved = await this.review(
            plan,
            graph,
            segment,
            hideWindow,
            keymap === undefined,
          );
          override = this.override;
          return approved;
        },
      });
      this.report(outcome);
    } catch (err) {
      this.emitEvent({
        type: "stopped",
        reached: false,
        reason: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
      this.pendingArm = null;
      this.resumePolling();
    }
  }

  /**
   * The review gate AND the focus handoff, in that order, inside one callback.
   *
   * This is the whole reason the surface is safe. The reviewer is itself an
   * application: approving means clicking in DeskRAG, which raises its window
   * OVER the target. `app` was met at plan time, so `buildPlan` planned no
   * repair to correct it — execution would post the first click at a coordinate
   * the reviewer's own window now covers.
   *
   * `arm` is async, so everything here completes before `executePlan` posts
   * anything. Approving a plan and then leaving your window over the target is
   * not an approval that means anything.
   */
  private async review(
    plan: Plan,
    graph: Graph,
    segment: number,
    hideWindow: () => void,
    noKeymap: boolean,
  ): Promise<boolean> {
    const handoffApp = appPredicateOf(graph, plan.from);
    const dto = toPlanDTO(plan, graph, segment, handoffApp);
    if (noKeymap && plan.steps.some((s) => !("repair" in s) && !("superseded" in s) && s.action.kind === "type")) {
      // Same rule as resolveKeys at lift time, opposite direction: no keymap is
      // a blocker, never a US-QWERTY guess.
      dto.blockers.push({ reason: "no keyboard layout — typing cannot be replayed", scope: "segment" });
    }
    this.emitEvent({ type: "segment-planned", plan: dto });

    const decision = await new Promise<{ approve: boolean; override: boolean }>((resolve) => {
      this.pendingArm = resolve;
    });
    this.pendingArm = null;
    if (!decision.approve) {
      this.stopReason = "cancelled";
      return false;
    }
    this.override = decision.override;

    hideWindow();
    this.emitEvent({ type: "armed", segment, ...(handoffApp !== undefined ? { app: handoffApp } : {}) });
    if (handoffApp === undefined) return true;

    const restored = await this.restoreFocus(handoffApp);
    if (!restored) {
      this.stopReason = "handoff-failed";
      this.stopDetail = handoffApp;
      return false;
    }
    return true;
  }

  /**
   * Raise the target and CONFIRM it, by polling the predicate rather than
   * sleeping — the same rule execute.ts already follows for activation.
   * `launch` is false: a handoff restores a state the plan was reviewed
   * against, and starting an application is not that.
   *
   * A failed handoff stops the run. It must never become a click posted into
   * the reviewer.
   */
  private async restoreFocus(app: string, timeoutMs = 3000): Promise<boolean> {
    const sidecar = this.ensureSidecar();
    try {
      const outcome = await sidecar.activate(app, false);
      if (outcome === "not-running") return false;
    } catch {
      return false;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if ((await sidecar.dump()).app === app) return true;
      } catch {
        return false;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private report(outcome: RunOutcome): void {
    const last = outcome.segments[outcome.segments.length - 1];
    if (last !== undefined) {
      this.emitEvent({
        type: "segment-done",
        segment: outcome.segments.length,
        completed: last.outcome.completed,
        ...(last.outcome.failure !== undefined ? { failure: last.outcome.failure } : {}),
        telemetry: last.outcome.telemetry.map((t) => ({
          edgeId: t.edgeId,
          layer: t.layer,
          confidence: t.confidence,
        })),
      });
    }
    // executeRun reports every false `arm` as "declined". Which one it was is
    // known here and nowhere else.
    const reason: ReplayStopReason | undefined =
      outcome.stopped === "declined"
        ? (this.stopReason ?? "cancelled")
        : outcome.stopped === undefined
          ? undefined
          : outcome.stopped;
    this.emitEvent({
      type: "stopped",
      reached: outcome.reached,
      ...(reason !== undefined ? { reason } : {}),
      ...(this.stopDetail !== undefined ? { detail: this.stopDetail } : {}),
    });
  }

  arm(input: ReplayArmInput): void {
    this.pendingArm?.({ approve: input.approve, override: input.override ?? false });
  }

  cancel(): void {
    this.pendingArm?.({ approve: false, override: false });
  }

  private pausePolling(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private resumePolling(): void {
    if (this.timer === null && this.sidecar !== null) {
      this.timer = setInterval(() => void this.poll(), POLL_MS);
    }
  }
```

And the module-level helper, below `SELF_NAMES`:

```ts
/** The app a node claims to be in, if it claims one. */
function appPredicateOf(graph: Graph, nodeId: string): string | undefined {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const value = node?.predicates.find((p) => p.kind === "app")?.args["app"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
```

- [ ] **Step 3: Guard the sidecar against being closed mid-run**

`watch(false)` currently closes the sidecar unconditionally, which would kill a run in progress. Change `watch`'s off-branch:

```ts
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Leaving the screen must not kill a run that is mid-flight; the run's own
    // `finally` is what ends it.
    if (!this.running) this.closeSidecar();
```

- [ ] **Step 4: Typecheck**

Run: `npm run build && npm --prefix app run typecheck`
Expected: only the preload's missing `replay` property remains.

`Keymap` is `{ layoutId: string; entries: Record<number, [string, string, string, string]> }` — verified against `src/capture/env/types.ts`, not assumed.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/replay-service.ts
git commit -m "feat(app): review and arm a segment, then hand focus back

The handoff lives inside the injected arm callback, which is async and
therefore gates execution by construction — the library needs no change.

It has to. The reviewer is itself an application: approving means
clicking in DeskRAG, which raises its window over the target, and `app`
was met at plan time so buildPlan planned no repair. Execution would
post the first click at a coordinate the reviewer now covers.

A failed handoff returns false and stops the run rather than acting.
executeRun reports that as \"declined\", the same word as a user's
Cancel, so the service records which it was."
```

---

### Task 6: Wire the IPC

**Files:**
- Modify: `app/src/main/ipc.ts`
- Modify: `app/src/main/index.ts`
- Modify: `app/src/preload/index.ts`

**Interfaces:**
- Consumes: `ReplayService` (Tasks 4–5), the `IPC` keys and `DeskRagApi["replay"]` (Task 1).
- Produces: a working `window.deskrag.replay`.

- [ ] **Step 1: Register the handlers**

In `registerIpc`, add a `replay: ReplayService` parameter after `settings`, and below the `sessionsReindex` handler:

```ts
  replay.onLocation((l) => send(IPC.replayLocationEvent, l));
  replay.onEvent((e) => send(IPC.replayEvent, e));

  ipcMain.handle(IPC.replayGraph, () => replay.graph());
  ipcMain.handle(IPC.replayWatch, (_e, on: boolean) => replay.watch(on));
  ipcMain.handle(IPC.replayStart, (_e, input: ReplayStartInput) =>
    // Hiding is injected so ReplayService never touches Electron. It is what
    // stops the reviewer's own window occluding the target it just approved.
    replay.start(input, () => getWindow()?.hide()),
  );
  ipcMain.handle(IPC.replayArm, (_e, input: ReplayArmInput) => replay.arm(input));
  ipcMain.handle(IPC.replayCancel, () => replay.cancel());
```

Import `ReplayStartInput` and `ReplayArmInput` from `@shared/types` and `type { ReplayService }` from `./replay-service.js`.

- [ ] **Step 2: Construct it in main**

In `app/src/main/index.ts`, beside the existing `ERAG_AX_BIN` block, add the same treatment for the actuating binary:

```ts
// `ax-exec` is a SEPARATE binary from `ax-dump` on purpose: ax-dump is
// read-only and two of its modes are deliberately permission-free. Same dev
// resolution, its own variable.
if (!process.env["ERAG_AX_EXEC_BIN"]) {
  const exec = join(__dirname, "../../../native/ax-exec");
  if (existsSync(exec)) process.env["ERAG_AX_EXEC_BIN"] = exec;
}
```

Construct the service where `registerIpc` is called, and close it where `service.close()` is called:

```ts
const replay = new ReplayService(() => service.traceGraph());
registerIpc(service, settings, replay, () => win);
```

```ts
replay.close();
service.close();
```

- [ ] **Step 3: Bridge it in preload**

In `app/src/preload/index.ts`, add to the `api` object after `sessions`:

```ts
  replay: {
    graph: () => ipcRenderer.invoke(IPC.replayGraph),
    watch: (on: boolean) => ipcRenderer.invoke(IPC.replayWatch, on),
    start: (input: ReplayStartInput) => ipcRenderer.invoke(IPC.replayStart, input),
    arm: (input: ReplayArmInput) => ipcRenderer.invoke(IPC.replayArm, input),
    cancel: () => ipcRenderer.invoke(IPC.replayCancel),
    onEvent: (cb: (e: RunEventDTO) => void) => subscribe(IPC.replayEvent, cb),
    onLocation: (cb: (l: LocationDTO) => void) => subscribe(IPC.replayLocationEvent, cb),
  },
```

Add `type LocationDTO`, `type ReplayArmInput`, `type ReplayStartInput`, `type RunEventDTO` to the `@shared/types` import.

- [ ] **Step 4: Typecheck — this is the first clean pass**

Run: `npm run build && npm --prefix app run typecheck`
Expected: PASS with no errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/ipc.ts app/src/main/index.ts app/src/preload/index.ts
git commit -m "feat(app): bridge replay over IPC

Window hiding is injected into start() rather than imported, so
ReplayService never touches Electron — the same seam as Actuator.

ERAG_AX_EXEC_BIN gets its own dev resolution beside ERAG_AX_BIN, because
ax-exec is a separate binary on purpose: ax-dump is read-only and two of
its modes are deliberately permission-free."
```

---

### Task 7: The graph canvas

No unit tests: there is no renderer test runner in this repo, and adding one is not this feature's job. The gates are `npm --prefix app run typecheck` and running the app.

**Files:**
- Create: `app/src/renderer/src/screens/GraphCanvas.tsx`

**Interfaces:**
- Consumes: `GraphDTO`, `GraphNodeDTO`, `LocationDTO` (Task 1).
- Produces: `<GraphCanvas graph goalId locationNodeId onPick />`.

- [ ] **Step 1: Write the component**

```tsx
/**
 * The graph, laid out by rank. No layout dependency: `@vidstack/react` was worth
 * one because a media player is not 60 lines; a layered layout for tens of nodes
 * is.
 */

import React, { useMemo, useRef, useState } from "react";
import type { GraphDTO } from "@shared/types";

const CARD_W = 180;
const CARD_H = 132;
const GAP_X = 90;
const GAP_Y = 28;

interface Props {
  graph: GraphDTO;
  goalId: string | null;
  locationNodeId?: string | undefined;
  onPick: (nodeId: string) => void;
}

export function GraphCanvas({ graph, goalId, locationNodeId, onPick }: Props): React.JSX.Element {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  /** Column per rank, stacked in graph order so layout is stable across polls. */
  const placed = useMemo(() => {
    const perRank = new Map<number, number>();
    return graph.nodes.map((n) => {
      const row = perRank.get(n.rank) ?? 0;
      perRank.set(n.rank, row + 1);
      return { node: n, x: n.rank * (CARD_W + GAP_X), y: row * (CARD_H + GAP_Y) };
    });
  }, [graph]);

  const at = useMemo(
    () => new Map(placed.map((p) => [p.node.id, p])),
    [placed],
  );

  const width = Math.max(...placed.map((p) => p.x + CARD_W), CARD_W) + 48;
  const height = Math.max(...placed.map((p) => p.y + CARD_H), CARD_H) + 48;

  return (
    <div
      className="gcanvas"
      onWheel={(e) => setZoom((z) => Math.min(2, Math.max(0.35, z - e.deltaY * 0.001)))}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current === null) return;
        setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
    >
      <div
        className="gcanvas__world"
        style={{
          width,
          height,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        <svg className="gcanvas__wires" width={width} height={height}>
          {graph.edges.map((e) => {
            const a = at.get(e.from);
            const b = at.get(e.to);
            if (a === undefined || b === undefined) return null;
            const x1 = a.x + CARD_W;
            const y1 = a.y + CARD_H / 2;
            const x2 = b.x;
            const y2 = b.y + CARD_H / 2;
            // A back edge bows below rather than cutting through the cards it
            // passes. A loop is a real feature of a merged graph.
            const bow = e.back ? Math.max(60, Math.abs(y2 - y1)) : 0;
            const mid = (x1 + x2) / 2;
            const d = e.back
              ? `M ${x1} ${y1} C ${mid} ${y1 + bow}, ${mid} ${y2 + bow}, ${x2} ${y2}`
              : `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
            return (
              <path
                key={e.id}
                d={d}
                className={`gwire${e.back ? " is-back" : ""}${e.provenance === "synthesized" ? " is-synth" : ""}`}
              />
            );
          })}
        </svg>

        {placed.map(({ node, x, y }) => {
          const here = node.id === locationNodeId;
          const goal = node.id === goalId;
          return (
            <button
              key={node.id}
              className={`gnode${here ? " is-here" : ""}${goal ? " is-goal" : ""}`}
              style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
              onClick={() => onPick(node.id)}
              title={`${node.label} · ${node.observations} observation${node.observations === 1 ? "" : "s"}`}
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
                <span className="gnode__id">{node.id}</span>
                {node.id === graph.entry && <span className="gnode__tag">entry</span>}
                {here && <span className="gnode__tag is-here">you are here</span>}
                {goal && <span className="gnode__tag is-goal">goal</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm --prefix app run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/src/renderer/src/screens/GraphCanvas.tsx
git commit -m "feat(app): lay out the trace graph without a layout dependency

Rank is BFS from the entry, columns are ranks, back edges bow below
rather than cutting through the cards they pass — a loop is a real
feature of a merged graph and should not read as a mistake.

Nodes show the keyframe they recorded, which the frame protocol already
serves, and degrade to a text card when they have none."
```

---

### Task 8: The review column

**Files:**
- Create: `app/src/renderer/src/screens/PlanReview.tsx`

**Interfaces:**
- Consumes: `PlanDTO`, `RunEventDTO`, `ReplayStopReason` (Task 1).
- Produces: `<PlanReview plan status onArm onCancel />`, and `stopMessage(reason, detail)`.

- [ ] **Step 1: Write the component**

```tsx
/**
 * The review column: every Plan field, and the two gates.
 *
 * The gates keep the library's asymmetry exactly. Blockers can NEVER be
 * overridden — `assertable` means no UI action produces the predicate, so there
 * is nothing an override could mean. Brittleness can be, behind a tick that
 * names what is being accepted.
 */

import React, { useState } from "react";
import type { PlanDTO, ReplayStopReason } from "@shared/types";

export function stopMessage(reason: ReplayStopReason, detail?: string): string {
  switch (reason) {
    case "cancelled":
      return "Cancelled — no event was posted.";
    case "handoff-failed":
      return `${detail ?? "The app"} did not come forward; nothing was posted.`;
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

const pct = (n: number): string => `${Math.round(n * 100)}%`;

interface Props {
  plan: PlanDTO | null;
  status: string | null;
  busy: boolean;
  onArm: (override: boolean) => void;
  onCancel: () => void;
}

export function PlanReview({ plan, status, busy, onArm, onCancel }: Props): React.JSX.Element {
  const [override, setOverride] = useState(false);

  if (plan === null) {
    return (
      <aside className="review review--empty">
        <h2 className="review__title">Plan</h2>
        <p className="muted">{status ?? "Pick a goal on the graph, then run."}</p>
      </aside>
    );
  }

  const brittle = plan.brittleness.filter((b) => b.belowFloor);
  const blocked = plan.blockers.length > 0;
  const needsOverride = brittle.length > 0;

  return (
    <aside className="review">
      {/* Segment N, never "N of M": the loop does not know a total, and
          inventing a denominator would be a claim the executor never makes. */}
      <h2 className="review__title">Segment {plan.segment}</h2>
      <p className="review__route">
        {plan.fromLabel} → {plan.toLabel}
      </p>

      {plan.drift !== undefined && (
        <div className="review__banner is-warn">
          Last segment expected <code>{plan.drift.expected}</code>, landed on{" "}
          <code>{plan.drift.observed}</code>.
        </div>
      )}

      <ol className="steps">
        {plan.steps.map((s, i) => {
          if (s.kind === "handoff") {
            return (
              <li key={i} className="step step--handoff">
                <span className="step__kind">hide DeskRAG, return focus to {s.app}</span>
              </li>
            );
          }
          if (s.kind === "repair") {
            return (
              <li key={i} className="step step--repair">
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
                <span className="step__kind">{s.action}</span>
                <span className="step__note">not posted — {s.reason}</span>
              </li>
            );
          }
          return (
            <li key={i} className="step">
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
            </li>
          );
        })}
      </ol>

      {blocked && (
        <section className="review__block">
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

      {plan.cut !== undefined && (
        <section className="review__cut">
          <h3>Resolution stopped</h3>
          <p>
            at edge <code>{plan.cut.edgeId}</code>; the run resumes from{" "}
            <code>{plan.cut.resumeAt}</code> after re-observing.
          </p>
          <ul className="attempts">
            {plan.cut.attempts.map((a, i) => (
              <li key={i}>
                <code>{a.layer}</code> — {a.rejected}
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.remainder.length > 0 && (
        <section className="review__remainder">
          <h3>Beyond the cut · {plan.remainder.length} edge(s)</h3>
          <p className="muted">Disclosed, deliberately unresolved.</p>
          {plan.remainder.map((r) => (
            <div key={r.edgeId} className="remainder">
              <code>{r.edgeId}</code> → <code>{r.toNodeId}</code>
              <ul>
                {r.actions.map((a, i) => (
                  <li key={i}>
                    {a.kind}
                    {a.descriptors !== undefined && ` · recorded: ${a.descriptors.join(", ")}`}
                    {/* Provenance, never a target. */}
                    {a.recordedPoint !== undefined &&
                      ` · recorded at (${Math.round(a.recordedPoint.x)}, ${Math.round(a.recordedPoint.y)})`}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {plan.brittleness.length > 0 && (
        <section className="review__brittle">
          <h3>Anchor quality</h3>
          <ul>
            {plan.brittleness.map((b) => (
              <li key={b.edgeId} className={b.belowFloor ? "is-low" : ""}>
                <code>{b.edgeId}</code> — {pct(b.axRate)} resolved to an AX rung
                {b.bound === "upper" && <span className="muted"> (upper bound)</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {needsOverride && !blocked && (
        <label className="review__override">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
          />
          Arm anyway — {brittle.length} edge(s) resolve mostly to coordinates, which
          click whatever has moved into that spot.
        </label>
      )}

      <div className="review__actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          disabled={busy || blocked || (needsOverride && !override)}
          onClick={() => onArm(override)}
        >
          Arm segment {plan.segment}
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm --prefix app run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/src/renderer/src/screens/PlanReview.tsx
git commit -m "feat(app): render every field of a plan, and the two gates

A field the reviewer cannot see is a field the plan did not disclose, so
the cut's attempt ladder, the superseded steps and the remainder's
recorded-only descriptors are all on screen.

The gates keep the library's asymmetry: blockers can never be
overridden, brittleness can, behind a tick that says what accepting it
means. Segment N, never N of M — the loop does not know a total."
```

---

### Task 9: The screen, the route, the styles

**Files:**
- Create: `app/src/renderer/src/screens/ReplayScreen.tsx`
- Modify: `app/src/renderer/src/App.tsx`, `app/src/renderer/src/icons.tsx`, `app/src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `GraphCanvas` (Task 7), `PlanReview` + `stopMessage` (Task 8), `api.replay` (Task 6).
- Produces: the `replay` route.

- [ ] **Step 1: Write the screen**

```tsx
import React, { useEffect, useMemo, useState } from "react";
import type { GraphDTO, LocationDTO, PlanDTO, RunEventDTO } from "@shared/types";
import { api } from "../api.js";
import { GraphCanvas } from "./GraphCanvas.js";
import { PlanReview, stopMessage } from "./PlanReview.js";

export function ReplayScreen(): React.JSX.Element {
  const [graph, setGraph] = useState<GraphDTO | null>(null);
  const [location, setLocation] = useState<LocationDTO | null>(null);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanDTO | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allowLaunch, setAllowLaunch] = useState(false);
  const [bindings, setBindings] = useState<Record<string, string>>({});

  useEffect(() => {
    api.replay.graph().then(setGraph);
    void api.replay.watch(true);
    const offLoc = api.replay.onLocation(setLocation);
    const offEvt = api.replay.onEvent((e: RunEventDTO) => {
      if (e.type === "segment-planned") {
        setPlan(e.plan);
        setBusy(false);
        setStatus(null);
      } else if (e.type === "armed") {
        setBusy(true);
        setStatus(e.app === undefined ? "Arming…" : `Returning focus to ${e.app}…`);
      } else if (e.type === "segment-done") {
        setStatus(
          e.completed
            ? `Segment ${e.segment} completed.`
            : `Segment ${e.segment} failed at step ${(e.failure?.step ?? 0) + 1}: ${e.failure?.reason ?? "unknown"}`,
        );
      } else {
        setPlan(null);
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
      <div className="page">
        <p className="muted">
          No trace graph yet. Record a session, or rebuild from the Library.
        </p>
      </div>
    );
  }

  return (
    <div className="page page--fill replay">
      <div className="replay__bar">
        <span className={`chip${location?.nodeId !== undefined ? " live" : ""}`}>
          <span className="dot" /> {here}
        </span>
        <span className="muted">
          {goalId === null ? "Pick a goal on the graph" : `Goal: ${goalId}`}
        </span>
        <label className="replay__launch">
          <input
            type="checkbox"
            checked={allowLaunch}
            onChange={(e) => setAllowLaunch(e.target.checked)}
          />
          allow launching apps
        </label>
        {graph.slots.map((s) => (
          <label key={s.name} className="replay__slot">
            {s.name}
            <input
              list={`slot-${s.name}`}
              value={bindings[s.name] ?? ""}
              onChange={(e) => setBindings((b) => ({ ...b, [s.name]: e.target.value }))}
            />
            <datalist id={`slot-${s.name}`}>
              {s.samples.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
        ))}
        <button
          className="btn btn--primary"
          disabled={goalId === null || busy || plan !== null}
          onClick={() => {
            setStatus("Planning…");
            setBusy(true);
            void api.replay.start({
              goalNodeId: goalId!,
              slotBindings: bindings,
              allowLaunch,
            });
          }}
        >
          Run
        </button>
      </div>

      <div className="replay__stage">
        <GraphCanvas
          graph={graph}
          goalId={goalId}
          locationNodeId={location?.nodeId}
          onPick={setGoalId}
        />
        <PlanReview
          plan={plan}
          status={status}
          busy={busy}
          onArm={(override) => {
            setBusy(true);
            void api.replay.arm({ segment: plan?.segment ?? 1, approve: true, override });
          }}
          onCancel={() => void api.replay.cancel()}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the icon**

In `app/src/renderer/src/icons.tsx`, following the existing icons' exact prop and stroke conventions (open the file and copy the shape of `IconLibrary`), add `IconReplay` — a play glyph inside a rounded square.

- [ ] **Step 3: Add the route**

In `App.tsx`: extend `Route` with `"replay"`, add `{ id: "replay", label: "Replay", Icon: IconReplay }` to `NAV` after `library`, add `replay: "Replay"` to `TITLES`, and render `{route === "replay" && <ReplayScreen />}`.

- [ ] **Step 4: Style it**

Append to `app/src/renderer/src/styles.css`. The height chain matters for the same reason the Library's does — every link needs `min-height: 0` or the row grows to fit its content instead of bounding it:

```css
/* --- replay -------------------------------------------------------------- */
.replay { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.replay__bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.replay__slot, .replay__launch { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.replay__slot input { width: 140px; }

/* Fixed split: the graph stays visible while the plan is read. Both children
   need min-width/min-height 0 or the review's long text widens the row. */
.replay__stage {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

.gcanvas {
  position: relative; overflow: hidden; min-width: 0; min-height: 0;
  border: 1px solid var(--hairline); border-radius: var(--radius);
  background: var(--panel); cursor: grab; touch-action: none;
}
.gcanvas__world { position: absolute; transform-origin: 0 0; }
.gcanvas__wires { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.gwire { fill: none; stroke: var(--hairline); stroke-width: 2; }
.gwire.is-back { stroke-dasharray: 5 4; opacity: 0.7; }
.gwire.is-synth { stroke-dasharray: 2 3; }

.gnode {
  position: absolute; display: flex; flex-direction: column; gap: 4px;
  padding: 6px; text-align: left; overflow: hidden;
  border: 1px solid var(--hairline); border-radius: var(--radius-sm);
  background: var(--elevated); color: inherit; cursor: pointer;
}
/* --ok is the palette's "this is true right now"; --accent is interactive
   selection. The recording red (--rec) is reserved for live capture. */
.gnode.is-here { border-color: var(--ok); box-shadow: 0 0 0 2px rgb(88 213 163 / 0.25); }
.gnode.is-goal { border-color: var(--accent); box-shadow: 0 0 0 2px rgb(124 156 255 / 0.25); }
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
.gnode__tag.is-goal { background: rgb(124 156 255 / 0.2); color: var(--accent); }

.review {
  min-width: 0; min-height: 0; overflow-y: auto; padding: 12px;
  border: 1px solid var(--hairline); border-radius: var(--radius);
  background: var(--panel);
}
.review__title { margin: 0; font-size: 14px; }
.review__route { margin: 2px 0 10px; font-size: 12px; color: var(--muted); }
.review__banner.is-warn {
  padding: 8px; margin-bottom: 10px; border-radius: var(--radius-sm); font-size: 12px;
  color: var(--amber);
  background: rgb(255 194 75 / 0.12); border: 1px solid rgb(255 194 75 / 0.3);
}
.steps { margin: 0 0 12px; padding-left: 18px; font-size: 12px; }
.step { margin-bottom: 6px; }
.step__kind { font-weight: 600; }
.step__target { display: block; color: var(--muted); word-break: break-word; }
.step__res { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--muted); }
.step__slot { display: block; font-size: 11px; }
.step--handoff .step__kind { color: var(--accent); }
.step--superseded { opacity: 0.6; }
.step--superseded .step__kind { text-decoration: line-through; }
.review__block { border-left: 3px solid var(--rec); padding-left: 8px; }
.review__block h3, .review__cut h3, .review__remainder h3, .review__brittle h3 {
  font-size: 12px; margin: 12px 0 4px;
}
.review section ul, .attempts { margin: 0; padding-left: 16px; font-size: 12px; }
.review code, .remainder code { font-family: var(--font-mono); font-size: 11px; }
.review__brittle .is-low { color: var(--amber); }
.review__override { display: block; margin: 12px 0; font-size: 12px; }
.review__actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
```

Every custom property above is verified present at the top of `styles.css`
(`--panel`, `--elevated`, `--hairline`, `--muted`, `--muted-dim`, `--accent`,
`--ok`, `--rec`, `--amber`, `--radius`, `--radius-sm`, `--font-mono`). Do not
introduce new ones — reuse the palette, and note that `--rec` is otherwise
reserved for live recording, used here only for the blocked state.

- [ ] **Step 5: Typecheck and run it**

Run: `npm --prefix app run typecheck`
Expected: PASS.

Run: `npm run build:ax && npm run app:dev`
Expected: a Replay tab appears. With no recordings it says so. With recordings it draws the graph, and the you-are-here chip updates when you switch to another app and back.

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/src/screens/ReplayScreen.tsx app/src/renderer/src/App.tsx app/src/renderer/src/icons.tsx app/src/renderer/src/styles.css
git commit -m "feat(app): the Replay screen

Fixed split, both panes always present: nothing moves when a plan
arrives, and the graph stays visible while the plan is read.

The location chip says 'last seen … Ns ago' when the reading is stale,
which it always is while you are looking at it — DeskRAG is frontmost,
so the observation describes the reviewer."
```

---

### Task 10: Drive it against a real desktop

The repo's standing rule, and the only gate that can reach what this feature is about: the suite is structurally incapable of posting an event, so the handoff is verified by running it.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-08-01-plan-review-ui-design.md` (findings)

- [ ] **Step 1: Record something replayable**

Record a short two-app session (a click in one app, a switch, a click in the other), let indexing finish, and confirm the Trace stage does not report a missing keymap.

- [ ] **Step 2: Read what actually landed**

Open Replay. Confirm, and write down:
- the node count and whether labels are distinguishable or collide;
- whether the you-are-here chip resolves when you switch to the recorded app;
- whether any node shows a keyframe.

- [ ] **Step 3: Plan without arming**

Pick a goal, hit Run, and **read the plan without arming**. Confirm the handoff step is first, the cut and remainder render if present, and blockers disable the button.

- [ ] **Step 4: Arm one segment**

Arm it. Watch for the thing this feature exists to prevent: the window must disappear and the target must come forward **before** any click lands. If a click lands on DeskRAG's own window, stop and treat it as a bug in `restoreFocus`, not a tuning problem.

- [ ] **Step 5: Record the findings**

Add a "What the first live run found" section to the spec with the real numbers, in the style of the existing specs. Correct anything the run falsified — a measurement from one pair of applications is provisional, exactly as the anchor ladder's was.

- [ ] **Step 6: Update `CLAUDE.md`**

The executor section currently ends "no multi-segment run has ever posted an event". If this run changed that, say precisely what it exercised and what it did not. Add to the app section: the Replay route, the `arm`-callback handoff and why it exists, and that the poller holds an `ax-exec` sidecar while the screen is open.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-08-01-plan-review-ui-design.md
git commit -m "docs: what the first reviewed run actually did

Numbers from one pair of applications, so provisional — the anchor
ladder was falsified twice, each time by recording in one more app."
```

---

## Self-Review

**Spec coverage:** handoff-in-`arm` → Task 5; poller + frontmost-is-self → Task 4; `ax-exec` decision + sidecar lifetime → Tasks 4–5; DTOs → Task 1; labelling without a `window` predicate → Task 2; ranks/back edges → Tasks 2, 7; every `Plan` field rendered → Tasks 3, 8; two gates → Task 8; run setup (goal, slots, `allowLaunch`) → Task 9; keymap-or-blocker → Task 5; `RunStop` messages → Task 8; tests → Tasks 2, 3; real run → Task 10.

**Known gap, deliberate:** `ReplayService.arm` takes a `segment` the service does not check against the segment it is waiting on. A stale click from a previous segment could arm the current one. The renderer disables the button while `busy`, which closes it in practice; a strict check belongs in Task 5 if review finds it reachable.

**Three assumptions were checked against the source rather than carried, and two were wrong:**
- `Keymap` is `{ layoutId, entries }`, not `{ layout, chars }` — Task 5 now uses the real shape.
- `--line`, `--line-strong` and `--panel-2` do not exist in `styles.css`; Task 9 uses the real palette.
- The brittleness override was passed as a snapshot value, so a tick in segment N would never have reached execution. `run.ts` reads `input.override` fresh each turn, so Task 5 passes a getter over a closure variable. This is the kind of bug that fails silently in the *permissive* direction, which is why it is called out rather than quietly fixed.

**Type consistency:** `toGraphDTO`/`toPlanDTO`/`labelNode`/`rankNodes` are used under those exact names in Tasks 4, 5 and the tests. `LocationDTO.staleMs` is set in Task 4 and read in Task 9. `ReplayStopReason` is produced in Task 5 and consumed by `stopMessage` in Task 8.
