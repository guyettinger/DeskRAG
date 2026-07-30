# Experience Trace IR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/trace/` — a pure-TypeScript module that lifts recorded desktop activity into a manipulable graph of verified states and action sequences, and persists it.

**Architecture:** The IR is a *projection* of already-stored capture data, in the same way segments and representations are — so it is always rebuildable and a bad heuristic is never a data-loss event. Pure leaf functions (`paths`, `predicates`) build up to composition (`anchors`, `identity`), then the two pipeline entry points (`lift`, `merge`), then the text projection (`language`) and SQLite persistence. External data reaches `trace/` only through injected callbacks and minimal local interfaces, never by importing `store/`, `represent/`, or `retrieve/`.

**Tech Stack:** TypeScript (strict, ESM), vitest, better-sqlite3 (persistence task only). No native modules, no network, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-30-experience-trace-ir-design.md` (commit `eb62640`)

## Global Constraints

- **`src/trace/` is pure TypeScript.** No native modules, no subprocesses, no network. This is what makes it safe to re-export from `src/index.ts` (unlike the future executor).
- **`trace/` never imports from `represent/`, `retrieve/`, or `store/`.** External data arrives via injected callbacks (`VisualMatcher`, `LiftInput.axAt`) or minimal local interfaces. This follows the existing house pattern: `src/segment/types.ts` declares its own `SegEvent` with the comment "Minimal event shape the boundary detector needs (EventRow is compatible)." Do the same — declare `TraceEvent` and `AnchorRegion` locally and note that `EventRow`/`RegionRow` are structurally compatible.
- **No new vector space, no Lance writes.** Visual corroboration reuses existing region/frame vectors by id. Graph persistence is SQLite-only, so there is no dual-store write-order hazard.
- **Strict TS, ESM.** All relative imports carry the `.js` extension.
- **Tests live in `test/`**, not colocated, named `trace.<module>.test.ts` (matching the existing `onnx.image.test.ts` / `dual-store.crash.test.ts` convention). Import from `../src/trace/<module>.js`.
- **`npm run typecheck` is the primary gate.** Run it after every task. `npm test` must stay green.
- **`Slot.secret` is always `false`** — a reserved field. Secure-field content is recorded verbatim; this is an explicit spec decision, not an oversight.

### Deliberate deviations from the spec

Three, each with its reason. Do not "correct" them back.

1. **`Node`/`Edge` are named `TraceNode`/`TraceEdge`.** `Node` is a global DOM type. These types are exported from the barrel and will be consumed by `app/src/renderer`, where `lib.dom` is in scope and a bare `Node` would be genuinely ambiguous.
2. **Gesture grouping is split into its own `gestures.ts`.** The spec put it inside `lift.ts`. Grouping raw events into gestures is pure and independently testable; resolving anchors against AX trees is not. Splitting keeps both files focused and lets the gesture rules be tested exhaustively against plain arrays.
3. **`Anchor.visual.phash` is named `framePhash`.** A region has no pHash of its own; the value is the pHash of the frame the region was proposed from. The spec's name invited the wrong reading.

### Known-degraded behavior (not a bug)

`groupGestures` reads `data.char` and `data.modifiers` from key events. **Capture does not emit either yet** — `UiohookInputProducer` writes `{ keycode }` only, and layout-resolved characters are capture requirement #2 in the spec, deferred to the capture spec. Until then, key events without `char` produce a warning and no `text` gesture. Do **not** invent a keycode→character table to paper over this; fabricating typed content is worse than omitting it, and the omission is what makes the missing capture requirement visible.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/trace/types.ts` | The IR: `Graph`, `Trace`, `TraceNode`, `TraceEdge`, `Action`, `Anchor`, `Path`, `Predicate`, `Slot`, `VisualMatcher`, intervention wire types |
| `src/trace/paths.ts` | `fitPath` (samples → endpoint-normalized curve), `projectPath` (curve + endpoints → polyline) |
| `src/trace/predicates.ts` | AX tree → predicate set; stability filter; `achievable`/`assertable` tagging |
| `src/trace/anchors.ts` | `axPathOf`, `hitTest`, `buildAnchor` — the layered anchor |
| `src/trace/identity.ts` | `matchNode` — predicate-primary, visual-corroborating, ambiguity-averse |
| `src/trace/gestures.ts` | `groupGestures` — raw events → typed gestures |
| `src/trace/lift.ts` | `liftTrace` — events + boundaries + AX → a linear `Trace` |
| `src/trace/merge.ts` | `mergeTrace` — `Trace` + `Graph` → merged `Graph`; slot discovery |
| `src/trace/language.ts` | `printGraph`/`parseGraph`; `parseInterventionResponse` with permission validation |
| `src/store/sqlite/schema.ts` | *(modify)* four additive `trace_*` tables |
| `src/store/store.ts` | *(modify)* `putGraph`/`getGraph`/`listGraphs`/`deleteGraph` |
| `src/index.ts` | *(modify)* barrel section for `trace/` |

Tasks 1–9 have no dependency on `store/`. Task 10 is the only one that touches it.

---

## Task 1: The IR types

**Files:**
- Create: `src/trace/types.ts`
- Test: `test/trace.types.test.ts`

**Interfaces:**
- Consumes: `UIElement` from `../embed/types.js` (re-exported for convenience only — no logic).
- Produces: every type below. Later tasks import exclusively from here.

- [ ] **Step 1: Write the failing test**

A types-only module still has a testable claim: that the model can express a valid value of every shape without casts. This test fails to compile if the model can't.

```ts
// test/trace.types.test.ts
import { describe, expect, it } from "vitest";
import type {
  Action, Anchor, Graph, Path, Predicate, Slot, Trace, TraceEdge, TraceNode,
} from "../src/trace/types.js";
import { REACH_BY_KIND } from "../src/trace/types.js";

const anchor: Anchor = {
  ax: { role: "AXButton", label: "Send", path: "AXWindow>AXGroup[0]>AXButton[2]" },
  visual: { regionId: "r_1", framePhash: "0f1e2d3c4b5a6978", bbox: { x: 10, y: 20, w: 80, h: 32 } },
  point: { x: 1420, y: 386, displayId: "D1", windowRelative: { x: 220, y: 118 } },
};

const path: Path = {
  curve: [{ c1: { x: 0.33, y: -0.2 }, c2: { x: 0.66, y: -0.2 }, end: { x: 1, y: 0 } }],
  durationMs: 840,
  velocity: [0, 0.25, 0.6, 1],
  fitConfidence: 0.9,
};

describe("IR types", () => {
  it("expresses an anchor with all three layers", () => {
    expect(anchor.point.displayId).toBe("D1");
    expect(anchor.ax?.path).toContain("AXButton");
  });

  it("expresses every action kind", () => {
    const actions: Action[] = [
      { kind: "click", anchor, button: 1, count: 1 },
      { kind: "drag", from: anchor, to: anchor, path, button: 1 },
      { kind: "hover", anchor, dwellMs: 1200 },
      { kind: "scroll", anchor, delta: { x: 0, y: -450 }, steps: 6 },
      { kind: "type", slot: "recipient", recorded: "guy@example.com" },
      { kind: "chord", keys: ["cmd", "s"] },
      { kind: "wait", until: { kind: "ax_exists", args: { role: "AXSheet" }, reach: "achievable" }, timeoutMs: 3000 },
    ];
    expect(actions.map((a) => a.kind)).toHaveLength(7);
  });

  it("permits an anchor with only the required point layer", () => {
    const bare: Anchor = { point: { x: 5, y: 5, displayId: "D1" } };
    expect(bare.ax).toBeUndefined();
  });

  it("tags reach by predicate kind, achievable vs assertable", () => {
    expect(REACH_BY_KIND.ax_exists).toBe("achievable");
    expect(REACH_BY_KIND.app).toBe("achievable");
    expect(REACH_BY_KIND.display).toBe("assertable");
    expect(REACH_BY_KIND.file).toBe("assertable");
    expect(REACH_BY_KIND.permission).toBe("assertable");
  });

  it("expresses a Trace as a linear chain and a Graph as the merged form", () => {
    const node: TraceNode = {
      id: "n1", predicates: [], intervene: "select", observations: 1,
    };
    const edge: TraceEdge = {
      id: "e1", from: "n1", to: "n1", actions: [],
      provenance: "recorded", observations: 1, outcomes: { attempts: 0, successes: 0 },
    };
    const slot: Slot = { name: "recipient", samples: ["a@b.com"], secret: false };
    const trace: Trace = { sessionId: "s1", nodes: [node], edges: [edge], slots: [slot] };
    const graph: Graph = { id: "g1", nodes: [node], edges: [edge], slots: [slot], entry: "n1" };
    expect(trace.nodes[0]!.intervene).toBe("select");
    expect(graph.entry).toBe("n1");
  });

  it("defaults a predicate's reach through the lookup rather than by hand", () => {
    const p: Predicate = { kind: "window", args: { title: "New Message" }, reach: REACH_BY_KIND.window };
    expect(p.reach).toBe("achievable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.types.test.ts`
Expected: FAIL — `Cannot find module '../src/trace/types.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/trace/types.ts
/**
 * The experience trace IR — a manipulable representation of recorded desktop
 * behavior. A Graph's nodes are verified states and its edges are action
 * sequences; a Trace is that same shape constrained to the single linear path
 * one recording produces.
 *
 * Pure types plus one lookup table. This module imports nothing but `UIElement`,
 * which keeps `trace/` a leaf: everything it needs from the store arrives through
 * injected callbacks or the minimal local interfaces declared here (the same
 * pattern `segment/types.ts` uses for `SegEvent`).
 */

import type { UIElement } from "../embed/types.js";

export type { UIElement };

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// --- anchors ---------------------------------------------------------------

/**
 * Three independent descriptions of one target, resolved `ax → visual → point`
 * at replay. Recorded independently at capture time and NEVER derived from one
 * another at replay time — deriving an AX target from a coordinate is how these
 * systems silently drift.
 *
 * `point` is required: it is always recordable, so an anchor is never empty.
 */
export interface Anchor {
  /** `path` is the ancestor chain — role+label alone is not unique in a window. */
  ax?: { role: string; label?: string; path: string };
  /** `framePhash` is the pHash of the frame this region was proposed from. */
  visual?: { regionId: string; framePhash: string; bbox: Rect };
  point: { x: number; y: number; displayId: string; windowRelative?: Vec2 };
}

// --- motion ----------------------------------------------------------------

/** One cubic segment; its start is the previous segment's `end` (or the origin). */
export interface CubicBezier {
  c1: Vec2;
  c2: Vec2;
  end: Vec2;
}

/**
 * A fitted motion path, **normalized to a unit box between its endpoints**. The
 * shape carries no absolute coordinates, so retargeting re-projects the same
 * curve onto new endpoints. "Verbatim" vs "synthesized" is therefore a runtime
 * consequence of where the endpoints resolved, not a stored mode — one code path.
 */
export interface Path {
  /** Control points in unit space: the path runs (0,0) → (1,0). */
  curve: CubicBezier[];
  durationMs: number;
  /** Monotonic non-decreasing progress in [0,1], sampled at uniform times. */
  velocity: number[];
  /** Low when the source samples were sparse or the fit residual was high. */
  fitConfidence: number;
}

// --- predicates ------------------------------------------------------------

export type PredicateKind =
  | "app"
  | "window"
  | "ax_exists"
  | "ax_focused"
  | "display"
  | "file"
  | "permission";

/**
 * `achievable` — some edge in the graph establishes it, so a failed check has a
 * repair path (pathfind from where we actually are).
 * `assertable` — no UI action can produce it; it can only gate, with a specific
 * reason. This tag is what makes "ensure the same state is present" well-defined.
 */
export type Reach = "achievable" | "assertable";

export const REACH_BY_KIND: Readonly<Record<PredicateKind, Reach>> = {
  app: "achievable",
  window: "achievable",
  ax_exists: "achievable",
  ax_focused: "achievable",
  display: "assertable",
  file: "assertable",
  permission: "assertable",
};

export interface Predicate {
  kind: PredicateKind;
  args: Record<string, string | number | boolean>;
  reach: Reach;
}

// --- slots -----------------------------------------------------------------

/** A `Slot.name`, resolved against `Graph.slots`. */
export type SlotRef = string;

/**
 * Slots live on the graph, not the action, so one slot can be referenced by
 * several edges. One sample is a constant that happens to be addressable; two or
 * more is a discovered variable (see merge.ts).
 *
 * `secret` is reserved and always false — secure-field content is recorded
 * verbatim, an explicit design decision.
 */
export interface Slot {
  name: string;
  samples: string[];
  secret: false;
}

// --- actions ---------------------------------------------------------------

/**
 * `wait` is load-bearing: replay waits on STATE, never sleeps on a recorded
 * duration. A dialog that took 400ms while recording takes seconds on a cold
 * start. `type` and `chord` are separate because text entry's unit is the string
 * while a chord's unit is the key combination — a command, not text.
 */
export type Action =
  | { kind: "click"; anchor: Anchor; button: number; count: number }
  | { kind: "drag"; from: Anchor; to: Anchor; path: Path; button: number }
  | { kind: "hover"; anchor: Anchor; dwellMs: number }
  | { kind: "scroll"; anchor: Anchor; delta: Vec2; steps: number }
  | { kind: "type"; slot: SlotRef; recorded: string }
  | { kind: "chord"; keys: string[] }
  | { kind: "wait"; until: Predicate; timeoutMs: number };

export type ActionKind = Action["kind"];

// --- graph -----------------------------------------------------------------

/** Whether the AI may intervene here, and how far. Default `select`. */
export type Intervene = "none" | "select" | "synthesize";

/**
 * A node is both a checkpoint (replay verifies state here) and an intervention
 * point (the AI may alter what happens next). Deliberately the same places: an AI
 * can only sensibly rewrite a trace where state is settled.
 */
export interface TraceNode {
  id: string;
  predicates: Predicate[];
  visual?: { frameBlobId: string; phash: string };
  intervene: Intervene;
  observations: number;
}

export interface TraceEdge {
  id: string;
  from: string;
  to: string;
  actions: Action[];
  guard?: Predicate[];
  provenance: "recorded" | "synthesized";
  observations: number;
  outcomes: { attempts: number; successes: number };
  liftWarnings?: string[];
}

export interface Graph {
  id: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  slots: Slot[];
  entry: string;
}

/** The output of lifting one session: a linear chain, merged into a Graph. */
export interface Trace {
  sessionId: string;
  /** In traversal order. */
  nodes: TraceNode[];
  /** `edges[i]` connects `nodes[i]` → `nodes[i+1]`. */
  edges: TraceEdge[];
  /** Each with exactly one sample. */
  slots: Slot[];
}

// --- injected seams --------------------------------------------------------

export interface FrameRef {
  frameId: string;
  phash: string;
}

/**
 * Visual corroboration for node identity. Injected by the caller so `trace/`
 * never depends on `represent/` or `retrieve/` — the same pattern the store's
 * reconciliation uses for its re-embed callback.
 */
export interface VisualMatcher {
  similar(ref: FrameRef, candidates: readonly FrameRef[]): Promise<number[]>;
}

/** Minimal event shape lifting needs. `EventRow` is structurally compatible. */
export interface TraceEvent {
  tMono: number;
  kind: string;
  x: number | null;
  y: number | null;
  data: unknown;
}

/** Minimal region shape anchors need. `RegionRow` is structurally compatible. */
export interface AnchorRegion {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// --- AI intervention wire contract -----------------------------------------

/**
 * Showing `atNode` alongside `observed` is deliberate: the model sees the DIFF
 * between expectation and reality, a far easier judgment for a small local model
 * than "here is a screen, decide what to do".
 */
export interface InterventionRequest {
  goal: string;
  /** What the recording expects here. */
  atNode: Predicate[];
  /** What is actually true now. */
  observed: Predicate[];
  options: { edgeId: string; summary: string; guard?: Predicate[] }[];
  slots: { name: string; samples: string[] }[];
  allow: "select" | "synthesize";
}

export interface InterventionResponse {
  choose?: string;
  bind?: Record<string, string>;
  /** Rejected unless the request carried `allow: "synthesize"`. */
  synthesize?: Action[];
  abort?: string;
}
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `npx vitest run test/trace.types.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/trace/types.ts test/trace.types.test.ts
git commit -m "feat(trace): the experience trace IR types

Graph/Trace, layered Anchor, endpoint-normalized Path, reach-tagged
Predicate, Slot, and the AI intervention wire contract. Node/Edge are
TraceNode/TraceEdge because the barrel reaches the renderer, where DOM
Node is in scope."
```

---

## Task 2: Path fitting and projection

**Files:**
- Create: `src/trace/paths.ts`
- Test: `test/trace.paths.test.ts`

**Interfaces:**
- Consumes: `Path`, `CubicBezier`, `Vec2` from `./types.js`.
- Produces:
  - `interface PathSample { x: number; y: number; tMono: number }`
  - `fitPath(samples: readonly PathSample[]): Path`
  - `projectPath(path: Path, from: Vec2, to: Vec2, steps?: number): Vec2[]`
  - `const VELOCITY_SAMPLES = 16`

**Background — the normalization.** Map the recorded polyline into a frame where the first sample is `(0,0)` and the last is `(1,0)`: translate by `-first`, then rotate by `-atan2(d.y, d.x)` and scale by `1/|d|`. Fitting happens in that frame, so the stored curve is endpoint-independent. `projectPath` applies the inverse transform built from the *new* endpoints. That single inverse is why retargeting needs no separate synthesis code path.

- [ ] **Step 1: Write the failing test**

```ts
// test/trace.paths.test.ts
import { describe, expect, it } from "vitest";
import { fitPath, projectPath, VELOCITY_SAMPLES, type PathSample } from "../src/trace/paths.js";

/** A quarter-arc bulging above the chord from (0,0) to (100,0). */
function arcSamples(n: number): PathSample[] {
  const out: PathSample[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push({ x: 100 * t, y: -40 * Math.sin(Math.PI * t), tMono: 1000 + t * 800 });
  }
  return out;
}

const maxDeviation = (a: readonly PathSample[], b: readonly { x: number; y: number }[]): number => {
  let worst = 0;
  for (const p of a) {
    let best = Infinity;
    for (const q of b) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    worst = Math.max(worst, best);
  }
  return worst;
};

describe("fitPath", () => {
  it("normalizes so the curve runs (0,0) -> (1,0) regardless of screen placement", () => {
    const near = fitPath(arcSamples(24));
    const far = fitPath(arcSamples(24).map((s) => ({ ...s, x: s.x + 900, y: s.y + 500 })));
    expect(near.curve.at(-1)!.end.x).toBeCloseTo(1, 6);
    expect(near.curve.at(-1)!.end.y).toBeCloseTo(0, 6);
    // Same shape in a different place must produce the same stored curve.
    expect(far.curve[0]!.c1.x).toBeCloseTo(near.curve[0]!.c1.x, 6);
    expect(far.curve[0]!.c1.y).toBeCloseTo(near.curve[0]!.c1.y, 6);
  });

  it("is rotation invariant — the same gesture at any angle stores the same curve", () => {
    const flat = fitPath(arcSamples(24));
    const turned = fitPath(
      arcSamples(24).map((s) => ({ ...s, x: -s.y, y: s.x })), // rotate 90 degrees
    );
    expect(turned.curve[0]!.c1.x).toBeCloseTo(flat.curve[0]!.c1.x, 6);
    expect(turned.curve[0]!.c1.y).toBeCloseTo(flat.curve[0]!.c1.y, 6);
  });

  it("records duration from the sample timestamps", () => {
    expect(fitPath(arcSamples(24)).durationMs).toBeCloseTo(800, 6);
  });

  it("emits a monotonic velocity profile from 0 to 1", () => {
    const { velocity } = fitPath(arcSamples(24));
    expect(velocity).toHaveLength(VELOCITY_SAMPLES);
    expect(velocity[0]).toBeCloseTo(0, 6);
    expect(velocity.at(-1)).toBeCloseTo(1, 6);
    for (let i = 1; i < velocity.length; i++) {
      expect(velocity[i]!).toBeGreaterThanOrEqual(velocity[i - 1]! - 1e-9);
    }
  });

  it("reports high confidence for a dense clean arc and low for two samples", () => {
    expect(fitPath(arcSamples(40)).fitConfidence).toBeGreaterThan(0.8);
    const sparse = fitPath([
      { x: 0, y: 0, tMono: 0 },
      { x: 100, y: 0, tMono: 200 },
    ]);
    expect(sparse.fitConfidence).toBeLessThan(0.3);
  });

  it("degrades to a straight zero-confidence path when the endpoints coincide", () => {
    const loop: PathSample[] = [
      { x: 50, y: 50, tMono: 0 },
      { x: 80, y: 20, tMono: 100 },
      { x: 50, y: 50, tMono: 200 },
    ];
    const p = fitPath(loop);
    expect(p.fitConfidence).toBe(0);
    expect(p.curve).toHaveLength(1);
  });

  it("degrades rather than throwing on a single sample", () => {
    const p = fitPath([{ x: 3, y: 4, tMono: 7 }]);
    expect(p.fitConfidence).toBe(0);
    expect(p.durationMs).toBe(0);
  });
});

describe("projectPath", () => {
  it("round-trips: fitting then projecting onto the original endpoints reproduces the polyline", () => {
    const samples = arcSamples(32);
    const path = fitPath(samples);
    const out = projectPath(path, { x: samples[0]!.x, y: samples[0]!.y }, { x: samples.at(-1)!.x, y: samples.at(-1)!.y }, 64);
    expect(out[0]!.x).toBeCloseTo(0, 6);
    expect(out.at(-1)!.x).toBeCloseTo(100, 6);
    expect(maxDeviation(samples, out)).toBeLessThan(2);
  });

  it("retargets: the same curve between new endpoints keeps its curvature sign", () => {
    const path = fitPath(arcSamples(32));
    const out = projectPath(path, { x: 500, y: 500 }, { x: 500, y: 900 }, 32);
    expect(out[0]!.x).toBeCloseTo(500, 6);
    expect(out[0]!.y).toBeCloseTo(500, 6);
    expect(out.at(-1)!.y).toBeCloseTo(900, 6);
    // The arc bulged left of the chord; rotated onto a downward chord it must
    // still bulge to the same side, i.e. every interior point sits off-axis
    // consistently.
    const side = out.slice(1, -1).map((p) => Math.sign(p.x - 500));
    expect(new Set(side).size).toBe(1);
    expect(side[0]).not.toBe(0);
  });

  it("scales with the new chord length", () => {
    const path = fitPath(arcSamples(32));
    const short = projectPath(path, { x: 0, y: 0 }, { x: 50, y: 0 }, 32);
    const long = projectPath(path, { x: 0, y: 0 }, { x: 200, y: 0 }, 32);
    const bulge = (pts: { x: number; y: number }[]) => Math.max(...pts.map((p) => Math.abs(p.y)));
    expect(bulge(long) / bulge(short)).toBeCloseTo(4, 1);
  });

  it("returns the requested number of points, endpoints included", () => {
    const path = fitPath(arcSamples(16));
    expect(projectPath(path, { x: 0, y: 0 }, { x: 10, y: 10 }, 20)).toHaveLength(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.paths.test.ts`
Expected: FAIL — `Cannot find module '../src/trace/paths.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/trace/paths.ts
/**
 * Motion fitting and projection.
 *
 * A recorded polyline is normalized into a frame where the first sample sits at
 * (0,0) and the last at (1,0) — translate, rotate, scale — and a single cubic
 * Bezier is least-squares fitted there. Because the stored curve carries no
 * absolute coordinates, replaying it is the inverse transform built from
 * whatever endpoints replay actually resolved. Retargeting therefore needs no
 * separate synthesis path: `projectPath` onto the original endpoints reproduces
 * the gesture, and onto new endpoints generalizes it.
 *
 * Pure: no store, no clock, no I/O.
 */

import type { CubicBezier, Path, Vec2 } from "./types.js";

export interface PathSample {
  x: number;
  y: number;
  tMono: number;
}

/** Points in the stored velocity profile. */
export const VELOCITY_SAMPLES = 16;

/** Chord shorter than this (px) means the gesture returned to its origin. */
const DEGENERATE_CHORD_PX = 1e-6;

const STRAIGHT: CubicBezier = {
  c1: { x: 1 / 3, y: 0 },
  c2: { x: 2 / 3, y: 0 },
  end: { x: 1, y: 0 },
};

function degenerate(durationMs: number): Path {
  return {
    curve: [STRAIGHT],
    durationMs,
    velocity: Array.from({ length: VELOCITY_SAMPLES }, (_, i) => i / (VELOCITY_SAMPLES - 1)),
    fitConfidence: 0,
  };
}

/**
 * Fit a normalized cubic to a recorded polyline.
 *
 * Endpoints are pinned to (0,0) and (1,0), so only the two interior control
 * points are unknown. With chord-length parameters `t_i` and Bernstein weights
 * `b1 = 3t(1-t)^2`, `b2 = 3t^2(1-t)`, minimizing the squared residual gives a
 * 2x2 normal-equation system, solved per component.
 */
export function fitPath(samples: readonly PathSample[]): Path {
  if (samples.length < 2) return degenerate(0);

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const durationMs = last.tMono - first.tMono;

  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const chord = Math.hypot(dx, dy);
  // A gesture that ends where it began has no chord to normalize against. Its
  // shape is unrecoverable in an endpoint-relative frame, so say so rather than
  // inventing a basis.
  if (chord < DEGENERATE_CHORD_PX) return degenerate(durationMs);

  // Inverse of the placement transform: translate to origin, rotate the chord
  // onto +x, scale to unit length.
  const cos = dx / chord;
  const sin = dy / chord;
  const unit = samples.map((s) => {
    const ox = s.x - first.x;
    const oy = s.y - first.y;
    return {
      x: (ox * cos + oy * sin) / chord,
      y: (-ox * sin + oy * cos) / chord,
    };
  });

  // Chord-length parameterization + the cumulative arc length the velocity
  // profile is read from.
  const cumulative: number[] = [0];
  for (let i = 1; i < unit.length; i++) {
    const a = unit[i - 1]!;
    const b = unit[i]!;
    cumulative.push(cumulative[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cumulative[cumulative.length - 1]!;
  const params = total > 0 ? cumulative.map((c) => c / total) : unit.map((_, i) => i / (unit.length - 1));

  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1x = 0;
  let b1y = 0;
  let b2x = 0;
  let b2y = 0;
  for (let i = 1; i < unit.length - 1; i++) {
    const t = params[i]!;
    const mt = 1 - t;
    const w1 = 3 * t * mt * mt;
    const w2 = 3 * t * t * mt;
    // Residual after removing the pinned endpoint contributions. P0 = (0,0)
    // contributes nothing; P3 = (1,0) contributes t^3 on x only.
    const rx = unit[i]!.x - t * t * t;
    const ry = unit[i]!.y;
    a11 += w1 * w1;
    a12 += w1 * w2;
    a22 += w2 * w2;
    b1x += w1 * rx;
    b1y += w1 * ry;
    b2x += w2 * rx;
    b2y += w2 * ry;
  }

  const det = a11 * a22 - a12 * a12;
  let curve: CubicBezier;
  if (Math.abs(det) < 1e-12) {
    curve = STRAIGHT;
  } else {
    curve = {
      c1: { x: (a22 * b1x - a12 * b2x) / det, y: (a22 * b1y - a12 * b2y) / det },
      c2: { x: (a11 * b2x - a12 * b1x) / det, y: (a11 * b1y * 0 + a11 * b2y - a12 * b1y) / det },
      end: { x: 1, y: 0 },
    };
  }

  // Residual of the fit, in unit space, to score confidence.
  let sq = 0;
  for (let i = 1; i < unit.length - 1; i++) {
    const p = evalCubic(curve, params[i]!);
    sq += (p.x - unit[i]!.x) ** 2 + (p.y - unit[i]!.y) ** 2;
  }
  const interior = Math.max(1, unit.length - 2);
  const rms = Math.sqrt(sq / interior);
  const sampleFactor = Math.min(1, (unit.length - 1) / 8);
  const fitFactor = 1 / (1 + rms * 10);
  const fitConfidence = Number((sampleFactor * fitFactor).toFixed(6));

  return { curve: [curve], durationMs, velocity: velocityProfile(samples, params), fitConfidence };
}

/** Progress along the path at each of VELOCITY_SAMPLES uniform time steps. */
function velocityProfile(samples: readonly PathSample[], params: readonly number[]): number[] {
  const first = samples[0]!;
  const span = samples[samples.length - 1]!.tMono - first.tMono;
  const out: number[] = [];
  for (let k = 0; k < VELOCITY_SAMPLES; k++) {
    const target = first.tMono + (span * k) / (VELOCITY_SAMPLES - 1);
    // Linear interpolation of the parameter against elapsed time.
    let i = 1;
    while (i < samples.length - 1 && samples[i]!.tMono < target) i++;
    const prev = samples[i - 1]!;
    const next = samples[i]!;
    const dt = next.tMono - prev.tMono;
    const f = dt > 0 ? (target - prev.tMono) / dt : 0;
    const v = params[i - 1]! + f * (params[i]! - params[i - 1]!);
    out.push(Math.min(1, Math.max(0, Number(v.toFixed(6)))));
  }
  out[0] = 0;
  out[out.length - 1] = 1;
  return out;
}

function evalCubic(c: CubicBezier, t: number): Vec2 {
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * t * mt * mt;
  const w2 = 3 * t * t * mt;
  const w3 = t * t * t;
  return {
    x: w1 * c.c1.x + w2 * c.c2.x + w3 * c.end.x,
    y: w1 * c.c1.y + w2 * c.c2.y + w3 * c.end.y,
  };
}

/**
 * Replay a stored curve between two endpoints, following its velocity profile.
 * `from`/`to` are the endpoints replay actually resolved — pass the recorded
 * ones to reproduce the gesture, or new ones to retarget it.
 */
export function projectPath(path: Path, from: Vec2, to: Vec2, steps = 32): Vec2[] {
  const n = Math.max(2, steps);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chord = Math.hypot(dx, dy);
  const cos = chord > 0 ? dx / chord : 1;
  const sin = chord > 0 ? dy / chord : 0;
  const curve = path.curve[0] ?? STRAIGHT;

  const out: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const timeFraction = k / (n - 1);
    const t = sampleVelocity(path.velocity, timeFraction);
    const u = evalCubic(curve, t);
    // Forward placement transform: scale by the new chord, rotate onto it,
    // translate to the new origin.
    const sx = u.x * chord;
    const sy = u.y * chord;
    out.push({ x: from.x + sx * cos - sy * sin, y: from.y + sx * sin + sy * cos });
  }
  return out;
}

function sampleVelocity(velocity: readonly number[], fraction: number): number {
  if (velocity.length === 0) return fraction;
  const pos = fraction * (velocity.length - 1);
  const i = Math.min(velocity.length - 2, Math.floor(pos));
  const f = pos - i;
  return velocity[i]! + f * (velocity[i + 1]! - velocity[i]!);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/trace.paths.test.ts && npm run typecheck`
Expected: PASS.

If the `c2.y` line looks odd — `a11 * b1y * 0 + a11 * b2y - a12 * b1y` — simplify it to `(a11 * b2y - a12 * b1y) / det`. It is written expanded here only to mirror the `c2.x` term; collapse it and confirm the tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/trace/paths.ts test/trace.paths.test.ts
git commit -m "feat(trace): endpoint-normalized path fitting and projection

Least-squares cubic fit in a frame where the chord runs (0,0)->(1,0), so
the stored curve is placement- and rotation-invariant. Projecting onto the
recorded endpoints reproduces the gesture; onto new endpoints retargets it.
One code path, no separate synthesis."
```

---

## Task 3: Predicate extraction

**Files:**
- Create: `src/trace/predicates.ts`
- Test: `test/trace.predicates.test.ts`

**Interfaces:**
- Consumes: `Predicate`, `PredicateKind`, `REACH_BY_KIND`, `UIElement` from `./types.js`; `nestAxElements` from `../capture/ax/tree.js`.
- Produces:
  - `interface PredicateContext { app?: string; windowTitle?: string; displays?: { id: string; w: number; h: number }[]; files?: string[]; maxAxPredicates?: number }`
  - `extractPredicates(ax: readonly UIElement[], ctx?: PredicateContext): Predicate[]`
  - `predicateKey(p: Predicate): string`
  - `samePredicateSet(a: readonly Predicate[], b: readonly Predicate[]): boolean`
  - `isVolatileLabel(label: string): boolean`
  - `const DEFAULT_MAX_AX_PREDICATES = 32`

**Background — the stability filter.** A node's identity is its predicate set, so any predicate carrying a clock, a badge count, or a row total makes every visit to that state look like a different state. Filter those out at extraction, the same way `axFilter` already filters regions. Being slightly too aggressive is safe; being too permissive breaks merging entirely.

- [ ] **Step 1: Write the failing test**

```ts
// test/trace.predicates.test.ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_AX_PREDICATES,
  extractPredicates,
  isVolatileLabel,
  predicateKey,
  samePredicateSet,
} from "../src/trace/predicates.js";
import type { UIElement } from "../src/embed/types.js";

const el = (role: string, label: string | undefined, i: number, extra: Partial<UIElement> = {}): UIElement => ({
  role,
  label,
  x: i * 10,
  y: i * 10,
  w: 100,
  h: 20,
  ...extra,
});

describe("isVolatileLabel", () => {
  it("rejects clocks, counts, and bare numbers", () => {
    for (const s of ["9:41", "12:05 PM", "Inbox (14)", "42", "3 unread", "7 items", "Updated 2 minutes ago"]) {
      expect(isVolatileLabel(s), s).toBe(true);
    }
  });

  it("keeps stable UI copy, including copy that merely contains a digit", () => {
    for (const s of ["Send", "New Message", "Save As…", "Tab 1", "iCloud Drive"]) {
      expect(isVolatileLabel(s), s).toBe(false);
    }
  });
});

describe("extractPredicates", () => {
  it("emits app and window predicates from the context, tagged achievable", () => {
    const ps = extractPredicates([], { app: "Mail", windowTitle: "New Message" });
    expect(ps).toContainEqual({ kind: "app", args: { app: "Mail" }, reach: "achievable" });
    expect(ps).toContainEqual({ kind: "window", args: { title: "New Message" }, reach: "achievable" });
  });

  it("emits ax_exists only for stable roles with non-volatile labels", () => {
    const ps = extractPredicates([
      el("AXButton", "Send", 0),
      el("AXStaticText", "9:41", 1),
      el("AXButton", "Inbox (14)", 2),
      el("AXGroup", undefined, 3),
    ]);
    const ax = ps.filter((p) => p.kind === "ax_exists");
    expect(ax).toHaveLength(1);
    expect(ax[0]!.args).toEqual({ role: "AXButton", label: "Send" });
  });

  it("emits ax_focused for the focused element", () => {
    const ps = extractPredicates([
      el("AXButton", "Send", 0),
      el("AXTextField", "To", 1, { focused: true }),
    ]);
    expect(ps).toContainEqual({
      kind: "ax_focused",
      args: { role: "AXTextField", label: "To" },
      reach: "achievable",
    });
  });

  it("tags display predicates assertable — they have no repair path", () => {
    const ps = extractPredicates([], { displays: [{ id: "D1", w: 2560, h: 1440 }] });
    expect(ps).toContainEqual({
      kind: "display",
      args: { id: "D1", w: 2560, h: 1440 },
      reach: "assertable",
    });
  });

  it("is deterministic and capped", () => {
    const many = Array.from({ length: 200 }, (_, i) => el("AXButton", `Button ${String.fromCharCode(65 + (i % 26))}${i}`, i));
    const a = extractPredicates(many);
    const b = extractPredicates([...many].reverse());
    expect(a.filter((p) => p.kind === "ax_exists").length).toBeLessThanOrEqual(DEFAULT_MAX_AX_PREDICATES);
    expect(a.map(predicateKey)).toEqual(b.map(predicateKey));
  });

  it("returns only context predicates for an empty AX tree — the AX-blind case", () => {
    const ps = extractPredicates([], { app: "Terminal" });
    expect(ps.every((p) => p.kind !== "ax_exists")).toBe(true);
    expect(ps).toHaveLength(1);
  });
});

describe("samePredicateSet", () => {
  it("ignores order", () => {
    const a = extractPredicates([el("AXButton", "Send", 0), el("AXButton", "Cancel", 1)]);
    expect(samePredicateSet(a, [...a].reverse())).toBe(true);
  });

  it("distinguishes different sets", () => {
    const a = extractPredicates([el("AXButton", "Send", 0)]);
    const b = extractPredicates([el("AXButton", "Cancel", 0)]);
    expect(samePredicateSet(a, b)).toBe(false);
  });

  it("treats a subset as different — not merely overlapping", () => {
    const a = extractPredicates([el("AXButton", "Send", 0), el("AXButton", "Cancel", 1)]);
    const b = extractPredicates([el("AXButton", "Send", 0)]);
    expect(samePredicateSet(a, b)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.predicates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/trace/predicates.ts
/**
 * AX tree -> predicate set. A node's identity IS its predicate set, so anything
 * volatile in here — a clock, a badge count, a row total — makes every visit to
 * the same state look like a new state and the graph never merges. The filter is
 * deliberately aggressive: dropping a stable predicate costs a little identity
 * precision, keeping a volatile one costs merging entirely.
 *
 * Pure: no store, no clock, no I/O.
 */

import { nestAxElements } from "../capture/ax/tree.js";
import type { Predicate, UIElement } from "./types.js";
import { REACH_BY_KIND } from "./types.js";

export interface PredicateContext {
  /** Focused application name, from a `focus_change` event. */
  app?: string;
  windowTitle?: string;
  /** Assertable — recorded so replay can refuse on a different monitor setup. */
  displays?: { id: string; w: number; h: number }[];
  /** Assertable — paths the recording depended on existing. */
  files?: string[];
  maxAxPredicates?: number;
}

export const DEFAULT_MAX_AX_PREDICATES = 32;

/**
 * Roles whose presence says something durable about which screen you are on.
 * Containers and decorative text are excluded: they are ubiquitous, so they add
 * no discriminating power while inflating every set.
 */
const STABLE_ROLES: ReadonlySet<string> = new Set([
  "AXWindow",
  "AXSheet",
  "AXDialog",
  "AXButton",
  "AXPopUpButton",
  "AXCheckBox",
  "AXRadioButton",
  "AXTextField",
  "AXTextArea",
  "AXSecureTextField",
  "AXComboBox",
  "AXMenuItem",
  "AXMenuButton",
  "AXTabGroup",
  "AXToolbar",
  "AXSearchField",
]);

const VOLATILE_PATTERNS: readonly RegExp[] = [
  /\d{1,2}:\d{2}/, //           a clock, or a duration
  /\(\s*\d+\s*\)/, //           "Inbox (14)"
  /^\s*[\d.,]+\s*%?\s*$/, //    a bare number or percentage
  /\b\d+\s+(unread|items?|messages?|results?|files?|photos?|selected)\b/i,
  /\b(just now|\d+\s+(seconds?|minutes?|hours?|days?)\s+ago)\b/i,
  /\b\d+\s*(KB|MB|GB|TB)\b/i,
];

export function isVolatileLabel(label: string): boolean {
  return VOLATILE_PATTERNS.some((re) => re.test(label));
}

/** Canonical string form, so predicate sets compare as sets of strings. */
export function predicateKey(p: Predicate): string {
  const args = Object.keys(p.args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(p.args[k])}`)
    .join(",");
  return `${p.kind}(${args})`;
}

export function samePredicateSet(a: readonly Predicate[], b: readonly Predicate[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a.map(predicateKey));
  if (left.size !== a.length) {
    // Duplicates would make size comparison lie; fall back to multiset compare.
    const sortedA = a.map(predicateKey).sort();
    const sortedB = b.map(predicateKey).sort();
    return sortedA.every((k, i) => k === sortedB[i]);
  }
  return b.every((p) => left.has(predicateKey(p)));
}

export function extractPredicates(
  ax: readonly UIElement[],
  ctx: PredicateContext = {},
): Predicate[] {
  const out: Predicate[] = [];
  const add = (kind: Predicate["kind"], args: Predicate["args"]): void => {
    out.push({ kind, args, reach: REACH_BY_KIND[kind] });
  };

  if (ctx.app !== undefined && ctx.app.length > 0) add("app", { app: ctx.app });
  if (ctx.windowTitle !== undefined && ctx.windowTitle.length > 0 && !isVolatileLabel(ctx.windowTitle)) {
    add("window", { title: ctx.windowTitle });
  }
  for (const d of ctx.displays ?? []) add("display", { id: d.id, w: d.w, h: d.h });
  for (const f of ctx.files ?? []) add("file", { path: f });

  if (ax.length > 0) {
    const nested = nestAxElements(ax);
    const focused = nested.find((e) => e.focused === true);
    if (focused !== undefined && STABLE_ROLES.has(focused.role)) {
      add("ax_focused", labelArgs(focused));
    }

    // Deterministic order independent of input order: shallowest first, then
    // role, then label. Two captures of the same screen must yield the same
    // truncation, or the cap itself becomes a source of false mismatches.
    const candidates = nested
      .filter((e) => STABLE_ROLES.has(e.role))
      .filter((e) => e.label !== undefined && e.label.length > 0 && !isVolatileLabel(e.label))
      .sort(
        (a, b) =>
          (a.depth ?? 0) - (b.depth ?? 0) ||
          a.role.localeCompare(b.role) ||
          (a.label ?? "").localeCompare(b.label ?? ""),
      );

    const seen = new Set<string>();
    const cap = ctx.maxAxPredicates ?? DEFAULT_MAX_AX_PREDICATES;
    for (const e of candidates) {
      const args = labelArgs(e);
      const key = `${args.role} ${args.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add("ax_exists", args);
      if (seen.size >= cap) break;
    }
  }

  return out;
}

function labelArgs(e: UIElement): { role: string; label: string } {
  return { role: e.role, label: e.label ?? "" };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/trace.predicates.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trace/predicates.ts test/trace.predicates.test.ts
git commit -m "feat(trace): AX tree to reach-tagged predicate sets

A node's identity is its predicate set, so the stability filter is
deliberately aggressive: a clock or badge count left in makes every visit
to a state look new and the graph never merges. Extraction order is
independent of input order so the cap cannot itself cause a mismatch."
```

---

## Task 4: Layered anchor construction

**Files:**
- Create: `src/trace/anchors.ts`
- Test: `test/trace.anchors.test.ts`

**Interfaces:**
- Consumes: `Anchor`, `AnchorRegion`, `Rect`, `UIElement`, `Vec2` from `./types.js`; `nestAxElements` from `../capture/ax/tree.js`.
- Produces:
  - `axPathOf(elements: readonly UIElement[], index: number): string`
  - `hitTest(elements: readonly UIElement[], p: Vec2): number | undefined`
  - `interface AnchorInput { point: Vec2; displayId: string; windowBounds?: Rect; ax?: readonly UIElement[]; framePhash?: string; regions?: readonly AnchorRegion[] }`
  - `buildAnchor(input: AnchorInput): Anchor`
  - `anchorKey(a: Anchor): string`

**Background.** `anchorKey` is used by `merge.ts` for edge equivalence, so it must be stable and must prefer the AX layer when present — two recordings of the same click should key identically even though their raw pixels differ by a few px.

- [ ] **Step 1: Write the failing test**

```ts
// test/trace.anchors.test.ts
import { describe, expect, it } from "vitest";
import { anchorKey, axPathOf, buildAnchor, hitTest } from "../src/trace/anchors.js";
import type { UIElement } from "../src/embed/types.js";

// A small window: root -> group -> two buttons, with explicit parent links (a
// current sidecar build always emits them).
const tree: UIElement[] = [
  { role: "AXWindow", label: "New Message", x: 0, y: 0, w: 800, h: 600 },
  { role: "AXGroup", x: 0, y: 0, w: 800, h: 100, parent: 0 },
  { role: "AXButton", label: "Send", x: 700, y: 20, w: 80, h: 32, parent: 1 },
  { role: "AXButton", label: "Cancel", x: 600, y: 20, w: 80, h: 32, parent: 1 },
];

describe("axPathOf", () => {
  it("builds an ancestor chain with a per-role sibling ordinal", () => {
    expect(axPathOf(tree, 2)).toBe("AXWindow[0]>AXGroup[0]>AXButton[0]");
    expect(axPathOf(tree, 3)).toBe("AXWindow[0]>AXGroup[0]>AXButton[1]");
  });

  it("returns just the role for a root", () => {
    expect(axPathOf(tree, 0)).toBe("AXWindow[0]");
  });

  it("nests by containment when the capture predates parent back-references", () => {
    const flat = tree.map(({ parent: _parent, ...rest }) => rest);
    expect(axPathOf(flat, 2)).toBe("AXWindow[0]>AXGroup[0]>AXButton[0]");
  });
});

describe("hitTest", () => {
  it("returns the deepest element containing the point", () => {
    expect(hitTest(tree, { x: 720, y: 30 })).toBe(2);
  });

  it("prefers the smaller box when two overlap at equal depth", () => {
    const overlap: UIElement[] = [
      { role: "AXGroup", x: 0, y: 0, w: 100, h: 100 },
      { role: "AXButton", label: "Small", x: 10, y: 10, w: 20, h: 20 },
    ];
    expect(hitTest(overlap, { x: 15, y: 15 })).toBe(1);
  });

  it("returns undefined outside every box", () => {
    expect(hitTest(tree, { x: 5000, y: 5000 })).toBeUndefined();
  });

  it("returns undefined for an empty tree — the AX-blind case", () => {
    expect(hitTest([], { x: 1, y: 1 })).toBeUndefined();
  });
});

describe("buildAnchor", () => {
  it("fills all three layers when AX and a region are available", () => {
    const a = buildAnchor({
      point: { x: 720, y: 30 },
      displayId: "D1",
      windowBounds: { x: 500, y: 0, w: 800, h: 600 },
      ax: tree,
      framePhash: "0f1e2d3c4b5a6978",
      regions: [{ id: "r_big", x: 600, y: 0, w: 200, h: 100 }, { id: "r_send", x: 700, y: 20, w: 80, h: 32 }],
    });
    expect(a.ax).toEqual({ role: "AXButton", label: "Send", path: "AXWindow[0]>AXGroup[0]>AXButton[0]" });
    expect(a.visual?.regionId).toBe("r_send"); // tightest containing region wins
    expect(a.visual?.framePhash).toBe("0f1e2d3c4b5a6978");
    expect(a.point).toEqual({ x: 720, y: 30, displayId: "D1", windowRelative: { x: 220, y: 30 } });
  });

  it("degrades to point-only when AX is absent and no region contains the point", () => {
    const a = buildAnchor({ point: { x: 10, y: 10 }, displayId: "D2" });
    expect(a.ax).toBeUndefined();
    expect(a.visual).toBeUndefined();
    expect(a.point).toEqual({ x: 10, y: 10, displayId: "D2" });
  });

  it("omits windowRelative when window bounds are unknown", () => {
    const a = buildAnchor({ point: { x: 10, y: 10 }, displayId: "D1", ax: tree });
    expect(a.point.windowRelative).toBeUndefined();
  });

  it("omits the visual layer without a frame pHash — never a half-populated layer", () => {
    const a = buildAnchor({
      point: { x: 720, y: 30 },
      displayId: "D1",
      regions: [{ id: "r_send", x: 700, y: 20, w: 80, h: 32 }],
    });
    expect(a.visual).toBeUndefined();
  });
});

describe("anchorKey", () => {
  it("keys on the AX path when present, so small coordinate drift is irrelevant", () => {
    const base = { displayId: "D1", ax: tree };
    const a = buildAnchor({ ...base, point: { x: 720, y: 30 } });
    const b = buildAnchor({ ...base, point: { x: 724, y: 33 } });
    expect(anchorKey(a)).toBe(anchorKey(b));
  });

  it("distinguishes different AX targets", () => {
    const a = buildAnchor({ point: { x: 720, y: 30 }, displayId: "D1", ax: tree });
    const b = buildAnchor({ point: { x: 620, y: 30 }, displayId: "D1", ax: tree });
    expect(anchorKey(a)).not.toBe(anchorKey(b));
  });

  it("falls back to a quantized point when there is no AX layer", () => {
    const a = buildAnchor({ point: { x: 100, y: 100 }, displayId: "D1" });
    const b = buildAnchor({ point: { x: 103, y: 97 }, displayId: "D1" });
    expect(anchorKey(a)).toBe(anchorKey(b));
    const far = buildAnchor({ point: { x: 400, y: 400 }, displayId: "D1" });
    expect(anchorKey(a)).not.toBe(anchorKey(far));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.anchors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/trace/anchors.ts
/**
 * The layered anchor: up to three independent descriptions of one target,
 * resolved `ax -> visual -> point` at replay.
 *
 * All three are recorded here, at lift time, from the AX tree and regions
 * captured at that moment — never re-derived from one another later. A layer is
 * either fully populated or absent; a half-populated layer would resolve to
 * something plausible and wrong.
 *
 * Pure: no store, no clock, no I/O.
 */

import { nestAxElements } from "../capture/ax/tree.js";
import type { Anchor, AnchorRegion, Rect, UIElement, Vec2 } from "./types.js";

/** Grid used to key a point-only anchor, in px. */
const POINT_KEY_QUANTUM = 16;

const containsPoint = (e: { x: number; y: number; w: number; h: number }, p: Vec2): boolean =>
  p.x >= e.x && p.x <= e.x + e.w && p.y >= e.y && p.y <= e.y + e.h;

const area = (e: { w: number; h: number }): number => Math.max(0, e.w) * Math.max(0, e.h);

/**
 * `AXWindow[0]>AXGroup[0]>AXButton[1]` — the ancestor chain, with each step's
 * ordinal among siblings *of the same role*. Role+label alone is not unique
 * within a window, which is why the anchor stores a path.
 */
export function axPathOf(elements: readonly UIElement[], index: number): string {
  const nested = nestAxElements(elements);
  const chain: number[] = [];
  for (let i: number | undefined = index; i !== undefined; i = nested[i]?.parent) {
    chain.push(i);
    if (chain.length > 128) break; // defensive: a malformed parent cycle
  }
  chain.reverse();

  return chain
    .map((i) => {
      const el = nested[i]!;
      const siblings = nested
        .map((e, j) => ({ e, j }))
        .filter(({ e }) => e.parent === el.parent && e.role === el.role)
        .map(({ j }) => j);
      return `${el.role}[${siblings.indexOf(i)}]`;
    })
    .join(">");
}

/**
 * The deepest element containing `p`. Ties break to the smaller box, then to the
 * lower index — deterministic, because two captures of one screen must resolve a
 * click identically.
 */
export function hitTest(elements: readonly UIElement[], p: Vec2): number | undefined {
  if (elements.length === 0) return undefined;
  const nested = nestAxElements(elements);
  let best: number | undefined;
  for (let i = 0; i < nested.length; i++) {
    const e = nested[i]!;
    if (!containsPoint(e, p)) continue;
    if (best === undefined) {
      best = i;
      continue;
    }
    const cur = nested[best]!;
    const dDepth = (e.depth ?? 0) - (cur.depth ?? 0);
    if (dDepth > 0 || (dDepth === 0 && area(e) < area(cur))) best = i;
  }
  return best;
}

export interface AnchorInput {
  point: Vec2;
  displayId: string;
  /** Global bounds of the focused window, for `windowRelative`. */
  windowBounds?: Rect;
  ax?: readonly UIElement[];
  /** pHash of the frame the regions were proposed from. */
  framePhash?: string;
  regions?: readonly AnchorRegion[];
}

export function buildAnchor(input: AnchorInput): Anchor {
  const anchor: Anchor = {
    point: {
      x: input.point.x,
      y: input.point.y,
      displayId: input.displayId,
      ...(input.windowBounds !== undefined
        ? {
            windowRelative: {
              x: input.point.x - input.windowBounds.x,
              y: input.point.y - input.windowBounds.y,
            },
          }
        : {}),
    },
  };

  if (input.ax !== undefined && input.ax.length > 0) {
    const hit = hitTest(input.ax, input.point);
    if (hit !== undefined) {
      const el = nestAxElements(input.ax)[hit]!;
      anchor.ax = {
        role: el.role,
        ...(el.label !== undefined && el.label.length > 0 ? { label: el.label } : {}),
        path: axPathOf(input.ax, hit),
      };
    }
  }

  // The visual layer needs both a region and the pHash of the frame it came
  // from; without the pHash there is nothing for corroboration to key on, so the
  // layer is omitted rather than half-filled.
  if (input.framePhash !== undefined && input.regions !== undefined) {
    let tightest: AnchorRegion | undefined;
    for (const r of input.regions) {
      if (!containsPoint(r, input.point)) continue;
      if (tightest === undefined || area(r) < area(tightest)) tightest = r;
    }
    if (tightest !== undefined) {
      anchor.visual = {
        regionId: tightest.id,
        framePhash: input.framePhash,
        bbox: { x: tightest.x, y: tightest.y, w: tightest.w, h: tightest.h },
      };
    }
  }

  return anchor;
}

/**
 * Stable key for edge equivalence in `merge.ts`. Prefers the AX layer so two
 * recordings of the same click key identically despite a few px of drift; falls
 * back to a quantized point, which is coarse on purpose for the same reason.
 */
export function anchorKey(a: Anchor): string {
  if (a.ax !== undefined) return `ax:${a.ax.path}:${a.ax.label ?? ""}`;
  const qx = Math.round(a.point.x / POINT_KEY_QUANTUM);
  const qy = Math.round(a.point.y / POINT_KEY_QUANTUM);
  return `pt:${a.point.displayId}:${qx},${qy}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/trace.anchors.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trace/anchors.ts test/trace.anchors.test.ts
git commit -m "feat(trace): layered anchor construction

AX path + visual region + screen point, all recorded at lift time from the
tree captured at that moment. A layer is fully populated or absent, never
half-filled. anchorKey prefers AX so merge is not defeated by px drift."
```

---

## Task 5: Node identity

**Files:**
- Create: `src/trace/identity.ts`
- Test: `test/trace.identity.test.ts`

**Interfaces:**
- Consumes: `FrameRef`, `Predicate`, `TraceNode`, `VisualMatcher` from `./types.js`; `samePredicateSet` from `./predicates.js`.
- Produces:
  - `interface MatchOptions { visual?: VisualMatcher; visualThreshold?: number; visualMargin?: number }`
  - `interface MatchResult { nodeId?: string; layer: "predicate" | "visual" | "none"; confidence: number; ambiguous: boolean }`
  - `matchNode(candidate: TraceNode, existing: readonly TraceNode[], opts?: MatchOptions): Promise<MatchResult>`
  - `const DEFAULT_VISUAL_THRESHOLD = 0.92`, `const DEFAULT_VISUAL_MARGIN = 0.03`

**Background — the asymmetric bias.** Failing to merge leaves a redundant node that is visible and fixable. Merging wrongly corrupts the graph silently and sends replay down a branch belonging to another context. So *any* ambiguity returns `nodeId: undefined, ambiguous: true`, and the caller creates a distinct node.

- [ ] **Step 1: Write the failing test**

```ts
// test/trace.identity.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULT_VISUAL_THRESHOLD, matchNode } from "../src/trace/identity.js";
import type { FrameRef, Predicate, TraceNode, VisualMatcher } from "../src/trace/types.js";

const p = (label: string): Predicate => ({
  kind: "ax_exists",
  args: { role: "AXButton", label },
  reach: "achievable",
});

const node = (id: string, labels: string[], phash?: string): TraceNode => ({
  id,
  predicates: labels.map(p),
  ...(phash !== undefined ? { visual: { frameBlobId: `b_${id}`, phash } } : {}),
  intervene: "select",
  observations: 1,
});

/** Scores by a caller-supplied table keyed on the candidate's phash. */
const matcher = (scores: Record<string, number>): VisualMatcher => ({
  similar: async (_ref: FrameRef, candidates: readonly FrameRef[]) =>
    candidates.map((c) => scores[c.phash] ?? 0),
});

describe("matchNode", () => {
  it("matches on an identical predicate set", async () => {
    const r = await matchNode(node("new", ["Send"]), [node("a", ["Send"]), node("b", ["Cancel"])]);
    expect(r).toEqual({ nodeId: "a", layer: "predicate", confidence: 1, ambiguous: false });
  });

  it("does not match a merely overlapping predicate set", async () => {
    const r = await matchNode(node("new", ["Send"]), [node("a", ["Send", "Cancel"])]);
    expect(r.nodeId).toBeUndefined();
    expect(r.layer).toBe("none");
  });

  it("REFUSES to merge when two existing nodes match equally — the asymmetric bias", async () => {
    const r = await matchNode(node("new", ["Send"]), [node("a", ["Send"]), node("b", ["Send"])]);
    expect(r.nodeId).toBeUndefined();
    expect(r.ambiguous).toBe(true);
    expect(r.layer).toBe("predicate");
  });

  it("falls back to visual corroboration above the threshold", async () => {
    const r = await matchNode(
      node("new", ["Send"], "aaaa"),
      [node("a", ["Different"], "bbbb"), node("b", ["Other"], "cccc")],
      { visual: matcher({ bbbb: 0.97, cccc: 0.4 }) },
    );
    expect(r.nodeId).toBe("a");
    expect(r.layer).toBe("visual");
    expect(r.confidence).toBeCloseTo(0.97, 6);
  });

  it("does not visual-match below the threshold", async () => {
    const r = await matchNode(node("new", ["Send"], "aaaa"), [node("a", ["Other"], "bbbb")], {
      visual: matcher({ bbbb: DEFAULT_VISUAL_THRESHOLD - 0.01 }),
    });
    expect(r.nodeId).toBeUndefined();
    expect(r.layer).toBe("none");
  });

  it("REFUSES to merge when two visual candidates sit within the margin", async () => {
    const r = await matchNode(
      node("new", ["Send"], "aaaa"),
      [node("a", ["X"], "bbbb"), node("b", ["Y"], "cccc")],
      { visual: matcher({ bbbb: 0.97, cccc: 0.96 }) },
    );
    expect(r.nodeId).toBeUndefined();
    expect(r.ambiguous).toBe(true);
    expect(r.layer).toBe("visual");
  });

  it("degrades to predicate-only without a matcher, recording the layer", async () => {
    const r = await matchNode(node("new", ["Send"], "aaaa"), [node("a", ["Other"], "bbbb")]);
    expect(r.layer).toBe("none");
    expect(r.ambiguous).toBe(false);
  });

  it("skips visual corroboration when the candidate has no visual of its own", async () => {
    const r = await matchNode(node("new", ["Send"]), [node("a", ["Other"], "bbbb")], {
      visual: matcher({ bbbb: 0.99 }),
    });
    expect(r.nodeId).toBeUndefined();
    expect(r.layer).toBe("none");
  });

  it("returns none against an empty graph", async () => {
    const r = await matchNode(node("new", ["Send"]), []);
    expect(r).toEqual({ layer: "none", confidence: 0, ambiguous: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/trace/identity.ts
/**
 * Node identity — the hard problem the graph model buys. Merging depends on it,
 * and so does replay: arriving at a node is how you know where you are.
 *
 * Predicate set is primary and authoritative; visual similarity corroborates and
 * covers AX-blind applications. Predicates stay primary even where visual would
 * be easier, because a node whose identity cannot be read is a node that cannot
 * be debugged.
 *
 * The bias is deliberately asymmetric. Failing to merge leaves a redundant node
 * that is visible and fixable; merging wrongly corrupts the graph silently and
 * sends replay down a branch belonging to another context. So any ambiguity
 * declines to match.
 */

import { samePredicateSet } from "./predicates.js";
import type { FrameRef, TraceNode, VisualMatcher } from "./types.js";

export const DEFAULT_VISUAL_THRESHOLD = 0.92;
/** Runner-up within this of the best score means "cannot tell them apart". */
export const DEFAULT_VISUAL_MARGIN = 0.03;

export interface MatchOptions {
  visual?: VisualMatcher;
  visualThreshold?: number;
  visualMargin?: number;
}

export interface MatchResult {
  /** Undefined means "create a distinct node" — including on ambiguity. */
  nodeId?: string;
  /** Which layer decided. Recorded so brittleness is measurable, not guessed. */
  layer: "predicate" | "visual" | "none";
  confidence: number;
  ambiguous: boolean;
}

export async function matchNode(
  candidate: TraceNode,
  existing: readonly TraceNode[],
  opts: MatchOptions = {},
): Promise<MatchResult> {
  if (existing.length === 0) return { layer: "none", confidence: 0, ambiguous: false };

  const exact = existing.filter((n) => samePredicateSet(candidate.predicates, n.predicates));
  if (exact.length === 1) {
    return { nodeId: exact[0]!.id, layer: "predicate", confidence: 1, ambiguous: false };
  }
  if (exact.length > 1) {
    return { layer: "predicate", confidence: 1, ambiguous: true };
  }

  const matcher = opts.visual;
  if (matcher === undefined || candidate.visual === undefined) {
    return { layer: "none", confidence: 0, ambiguous: false };
  }

  const withVisual = existing.filter(
    (n): n is TraceNode & { visual: NonNullable<TraceNode["visual"]> } => n.visual !== undefined,
  );
  if (withVisual.length === 0) return { layer: "none", confidence: 0, ambiguous: false };

  const ref: FrameRef = { frameId: candidate.visual.frameBlobId, phash: candidate.visual.phash };
  const candidates: FrameRef[] = withVisual.map((n) => ({
    frameId: n.visual.frameBlobId,
    phash: n.visual.phash,
  }));
  const scores = await matcher.similar(ref, candidates);

  let bestIdx = -1;
  let best = -Infinity;
  let second = -Infinity;
  for (let i = 0; i < withVisual.length; i++) {
    const s = scores[i] ?? 0;
    if (s > best) {
      second = best;
      best = s;
      bestIdx = i;
    } else if (s > second) {
      second = s;
    }
  }

  const threshold = opts.visualThreshold ?? DEFAULT_VISUAL_THRESHOLD;
  const margin = opts.visualMargin ?? DEFAULT_VISUAL_MARGIN;
  if (bestIdx < 0 || best < threshold) {
    return { layer: "none", confidence: Math.max(0, best), ambiguous: false };
  }
  if (second > -Infinity && best - second < margin) {
    return { layer: "visual", confidence: best, ambiguous: true };
  }
  return { nodeId: withVisual[bestIdx]!.id, layer: "visual", confidence: best, ambiguous: false };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/trace.identity.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trace/identity.ts test/trace.identity.test.ts
git commit -m "feat(trace): node identity, predicate-primary with visual corroboration

Any ambiguity declines to match. The bias is asymmetric on purpose: a
redundant node is visible and fixable, a wrong merge is silent corruption
that sends replay into another context."
```

---

## Checkpoint — halfway

Tasks 1–5 are the pure leaves. Before continuing, run the whole suite and the typecheck together:

```bash
npm run typecheck && npm test
```

Everything green means the foundation holds and Tasks 6–11 (gesture grouping, lifting, merging, the language, persistence, and the barrel) can build on it. Those tasks compose these five and add no new mathematical machinery.

---

## Task 6: Gesture grouping

**Files:**
- Create: `src/trace/gestures.ts`
- Test: `test/trace.gestures.test.ts`

**Interfaces:**
- Consumes: `TraceEvent`, `Vec2` from `./types.js`; `PathSample` from `./paths.js`.
- Produces:
  - `type Gesture` (discriminated on `type`, see below)
  - `interface GestureOptions { dragThresholdPx?: number; doubleClickMs?: number; doubleClickPx?: number; hoverDwellMs?: number; idleGapMs?: number; scrollCoalesceMs?: number }`
  - `groupGestures(events: readonly TraceEvent[], opts?: GestureOptions): { gestures: Gesture[]; warnings: string[] }`
  - `const DEFAULT_GESTURE_OPTIONS: Required<GestureOptions>`

**Gesture shape** (define exactly this — Task 7 consumes it):

```ts
interface GestureBase { tMonoStart: number; tMonoEnd: number }
type Gesture =
  | (GestureBase & { type: "click"; point: Vec2; button: number; count: number })
  | (GestureBase & { type: "drag"; from: Vec2; to: Vec2; samples: PathSample[]; button: number })
  | (GestureBase & { type: "hover"; point: Vec2; dwellMs: number })
  | (GestureBase & { type: "scroll"; point: Vec2; delta: Vec2; steps: number })
  | (GestureBase & { type: "text"; text: string })
  | (GestureBase & { type: "chord"; keys: string[] })
  | (GestureBase & { type: "idle"; durationMs: number });
```

**Reminder — the known-degraded path.** Key events carry `{ keycode }` today. Read `data.char` and `data.modifiers` when present; when `char` is absent on a non-modifier key, push a warning and emit no `text` gesture. Do not build a keycode table.

- [ ] **Step 1: Write the failing test**

```ts
// test/trace.gestures.test.ts
import { describe, expect, it } from "vitest";
import { groupGestures } from "../src/trace/gestures.js";
import type { TraceEvent } from "../src/trace/types.js";

const ev = (tMono: number, kind: string, x?: number, y?: number, data?: unknown): TraceEvent => ({
  tMono,
  kind,
  x: x ?? null,
  y: y ?? null,
  data: data ?? null,
});

describe("groupGestures — pointer", () => {
  it("groups down/up without movement into a click", () => {
    const { gestures } = groupGestures([
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(160, "mouse_up", 11, 10, { button: 1 }),
    ]);
    expect(gestures).toEqual([
      { type: "click", point: { x: 10, y: 10 }, button: 1, count: 1, tMonoStart: 100, tMonoEnd: 160 },
    ]);
  });

  it("merges two nearby clicks into one double click", () => {
    const { gestures } = groupGestures([
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(140, "mouse_up", 10, 10, { button: 1 }),
      ev(220, "mouse_down", 12, 11, { button: 1 }),
      ev(260, "mouse_up", 12, 11, { button: 1 }),
    ]);
    expect(gestures).toHaveLength(1);
    expect(gestures[0]).toMatchObject({ type: "click", count: 2, tMonoEnd: 260 });
  });

  it("does not merge clicks that are far apart in space", () => {
    const { gestures } = groupGestures([
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(140, "mouse_up", 10, 10, { button: 1 }),
      ev(220, "mouse_down", 400, 400, { button: 1 }),
      ev(260, "mouse_up", 400, 400, { button: 1 }),
    ]);
    expect(gestures).toHaveLength(2);
    expect(gestures.every((g) => g.type === "click" && g.count === 1)).toBe(true);
  });

  it("groups down/move/up past the threshold into a drag carrying its samples", () => {
    const { gestures } = groupGestures([
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(120, "mouse_move", 30, 14),
      ev(140, "mouse_move", 60, 22),
      ev(160, "mouse_up", 90, 30, { button: 1 }),
    ]);
    expect(gestures).toHaveLength(1);
    const g = gestures[0]!;
    expect(g.type).toBe("drag");
    if (g.type !== "drag") throw new Error("expected drag");
    expect(g.from).toEqual({ x: 10, y: 10 });
    expect(g.to).toEqual({ x: 90, y: 30 });
    // Samples span the button-down interval, endpoints included.
    expect(g.samples).toHaveLength(4);
    expect(g.samples[0]).toEqual({ x: 10, y: 10, tMono: 100 });
    expect(g.samples.at(-1)).toEqual({ x: 90, y: 30, tMono: 160 });
  });

  it("ignores movement outside the button-down interval", () => {
    const { gestures } = groupGestures([
      ev(50, "mouse_move", 0, 0),
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(120, "mouse_move", 60, 22),
      ev(160, "mouse_up", 90, 30, { button: 1 }),
      ev(200, "mouse_move", 500, 500),
    ]);
    const drag = gestures.find((g) => g.type === "drag");
    expect(drag && drag.type === "drag" && drag.samples).toHaveLength(3);
  });

  it("warns and drops a down with no matching up", () => {
    const { gestures, warnings } = groupGestures([
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(120, "mouse_move", 30, 14),
    ]);
    expect(gestures.filter((g) => g.type === "click" || g.type === "drag")).toHaveLength(0);
    expect(warnings.join(" ")).toMatch(/mouse_down/);
  });

  it("emits a hover when the pointer dwells without clicking", () => {
    const { gestures } = groupGestures([
      ev(0, "mouse_move", 50, 50),
      ev(1200, "mouse_move", 51, 50),
      ev(1300, "mouse_down", 51, 50, { button: 1 }),
      ev(1340, "mouse_up", 51, 50, { button: 1 }),
    ]);
    expect(gestures[0]).toMatchObject({ type: "hover", dwellMs: 1200 });
    expect(gestures[1]).toMatchObject({ type: "click" });
  });

  it("coalesces a scroll burst into one gesture with summed delta", () => {
    const { gestures } = groupGestures([
      ev(100, "scroll", 200, 300, { rotation: -3, direction: 3 }),
      ev(160, "scroll", 200, 300, { rotation: -3, direction: 3 }),
      ev(220, "scroll", 200, 300, { rotation: -2, direction: 3 }),
    ]);
    expect(gestures).toHaveLength(1);
    expect(gestures[0]).toMatchObject({ type: "scroll", steps: 3, delta: { x: 0, y: -8 } });
  });

  it("splits scroll bursts separated by more than the coalesce window", () => {
    const { gestures } = groupGestures([
      ev(100, "scroll", 200, 300, { rotation: -3, direction: 3 }),
      ev(900, "scroll", 200, 300, { rotation: -3, direction: 3 }),
    ]);
    expect(gestures.filter((g) => g.type === "scroll")).toHaveLength(2);
  });
});

describe("groupGestures — keyboard", () => {
  it("coalesces printable keys into one text gesture", () => {
    const { gestures } = groupGestures([
      ev(100, "key_down", undefined, undefined, { keycode: 30, char: "h" }),
      ev(110, "key_up", undefined, undefined, { keycode: 30, char: "h" }),
      ev(160, "key_down", undefined, undefined, { keycode: 18, char: "i" }),
      ev(170, "key_up", undefined, undefined, { keycode: 18, char: "i" }),
    ]);
    expect(gestures).toEqual([{ type: "text", text: "hi", tMonoStart: 100, tMonoEnd: 170 }]);
  });

  it("emits a chord when modifiers are held", () => {
    const { gestures } = groupGestures([
      ev(100, "key_down", undefined, undefined, { keycode: 31, char: "s", modifiers: ["cmd"] }),
      ev(120, "key_up", undefined, undefined, { keycode: 31, char: "s", modifiers: ["cmd"] }),
    ]);
    expect(gestures).toEqual([{ type: "chord", keys: ["cmd", "s"], tMonoStart: 100, tMonoEnd: 120 }]);
  });

  it("warns and emits nothing for a key event with no resolved char", () => {
    const { gestures, warnings } = groupGestures([
      ev(100, "key_down", undefined, undefined, { keycode: 30 }),
      ev(110, "key_up", undefined, undefined, { keycode: 30 }),
    ]);
    expect(gestures).toHaveLength(0);
    expect(warnings.join(" ")).toMatch(/char/);
  });

  it("splits a text run at a focus change", () => {
    const { gestures } = groupGestures([
      ev(100, "key_down", undefined, undefined, { keycode: 1, char: "a" }),
      ev(110, "key_up", undefined, undefined, { keycode: 1, char: "a" }),
      ev(200, "focus_change", undefined, undefined, { app: "Mail" }),
      ev(300, "key_down", undefined, undefined, { keycode: 2, char: "b" }),
      ev(310, "key_up", undefined, undefined, { keycode: 2, char: "b" }),
    ]);
    expect(gestures.filter((g) => g.type === "text")).toEqual([
      { type: "text", text: "a", tMonoStart: 100, tMonoEnd: 110 },
      { type: "text", text: "b", tMonoStart: 300, tMonoEnd: 310 },
    ]);
  });
});

describe("groupGestures — idle", () => {
  it("emits an idle gesture for a gap above the threshold", () => {
    const { gestures } = groupGestures([
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(140, "mouse_up", 10, 10, { button: 1 }),
      ev(5000, "mouse_down", 10, 10, { button: 1 }),
      ev(5040, "mouse_up", 10, 10, { button: 1 }),
    ]);
    expect(gestures[1]).toMatchObject({ type: "idle", durationMs: 4860 });
  });

  it("emits nothing for an empty stream", () => {
    expect(groupGestures([])).toEqual({ gestures: [], warnings: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.gestures.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/trace/gestures.ts
/**
 * Raw events -> typed gestures. Split out of `lift.ts` because grouping is pure
 * and exhaustively testable against plain arrays, while resolving anchors
 * against AX trees is neither.
 *
 * KNOWN DEGRADED: key events carry `{ keycode }` today. Layout-resolved
 * characters and modifier state are capture requirement #2 in the design spec
 * and are not emitted yet. A key without `data.char` produces a warning and no
 * text gesture — deliberately, because fabricating typed content from a keycode
 * table would be worse than omitting it, and the omission is what keeps the
 * missing capture requirement visible.
 */

import type { PathSample } from "./paths.js";
import type { TraceEvent, Vec2 } from "./types.js";

interface GestureBase {
  tMonoStart: number;
  tMonoEnd: number;
}

export type Gesture =
  | (GestureBase & { type: "click"; point: Vec2; button: number; count: number })
  | (GestureBase & { type: "drag"; from: Vec2; to: Vec2; samples: PathSample[]; button: number })
  | (GestureBase & { type: "hover"; point: Vec2; dwellMs: number })
  | (GestureBase & { type: "scroll"; point: Vec2; delta: Vec2; steps: number })
  | (GestureBase & { type: "text"; text: string })
  | (GestureBase & { type: "chord"; keys: string[] })
  | (GestureBase & { type: "idle"; durationMs: number });

export interface GestureOptions {
  /** Movement beyond this during a button-down makes it a drag, not a click. */
  dragThresholdPx?: number;
  doubleClickMs?: number;
  doubleClickPx?: number;
  hoverDwellMs?: number;
  idleGapMs?: number;
  scrollCoalesceMs?: number;
}

export const DEFAULT_GESTURE_OPTIONS: Required<GestureOptions> = {
  dragThresholdPx: 4,
  doubleClickMs: 400,
  doubleClickPx: 6,
  hoverDwellMs: 800,
  idleGapMs: 1500,
  scrollCoalesceMs: 250,
};

interface KeyData {
  keycode?: number;
  char?: string;
  modifiers?: string[];
}

const asRecord = (d: unknown): Record<string, unknown> =>
  d !== null && typeof d === "object" ? (d as Record<string, unknown>) : {};

const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);

export function groupGestures(
  events: readonly TraceEvent[],
  opts: GestureOptions = {},
): { gestures: Gesture[]; warnings: string[] } {
  const o = { ...DEFAULT_GESTURE_OPTIONS, ...opts };
  const gestures: Gesture[] = [];
  const warnings: string[] = [];
  if (events.length === 0) return { gestures, warnings };

  const sorted = [...events].sort((a, b) => a.tMono - b.tMono);

  // Pointer state
  let downAt: { tMono: number; point: Vec2; button: number } | undefined;
  let dragSamples: PathSample[] = [];
  let lastMove: { tMono: number; point: Vec2 } | undefined;
  let lastMoveStart: { tMono: number; point: Vec2 } | undefined;

  // Keyboard state
  let textRun: { text: string; tMonoStart: number; tMonoEnd: number } | undefined;

  // Scroll state
  let scrollRun:
    | { point: Vec2; delta: Vec2; steps: number; tMonoStart: number; tMonoEnd: number }
    | undefined;

  const flushText = (): void => {
    if (textRun === undefined) return;
    gestures.push({
      type: "text",
      text: textRun.text,
      tMonoStart: textRun.tMonoStart,
      tMonoEnd: textRun.tMonoEnd,
    });
    textRun = undefined;
  };

  const flushScroll = (): void => {
    if (scrollRun === undefined) return;
    gestures.push({
      type: "scroll",
      point: scrollRun.point,
      delta: scrollRun.delta,
      steps: scrollRun.steps,
      tMonoStart: scrollRun.tMonoStart,
      tMonoEnd: scrollRun.tMonoEnd,
    });
    scrollRun = undefined;
  };

  const flushHover = (upTo: number): void => {
    if (lastMoveStart === undefined || lastMove === undefined) return;
    const dwell = Math.min(upTo, lastMove.tMono) - lastMoveStart.tMono;
    if (dwell >= o.hoverDwellMs) {
      gestures.push({
        type: "hover",
        point: lastMoveStart.point,
        dwellMs: dwell,
        tMonoStart: lastMoveStart.tMono,
        tMonoEnd: lastMoveStart.tMono + dwell,
      });
    }
    lastMoveStart = undefined;
    lastMove = undefined;
  };

  for (const e of sorted) {
    const d = asRecord(e.data);

    if (e.kind !== "scroll") flushScroll();
    if (e.kind !== "key_down" && e.kind !== "key_up") flushText();

    switch (e.kind) {
      case "mouse_down": {
        flushHover(e.tMono);
        if (downAt !== undefined) warnings.push(`mouse_down at ${downAt.tMono} had no matching mouse_up`);
        const point = { x: num(e.x, 0), y: num(e.y, 0) };
        downAt = { tMono: e.tMono, point, button: num(d.button, 1) };
        dragSamples = [{ ...point, tMono: e.tMono }];
        break;
      }

      case "mouse_move": {
        const point = { x: num(e.x, 0), y: num(e.y, 0) };
        if (downAt !== undefined) {
          dragSamples.push({ ...point, tMono: e.tMono });
        } else {
          // Track dwell: a run of near-stationary moves is a hover.
          if (
            lastMoveStart === undefined ||
            Math.hypot(point.x - lastMoveStart.point.x, point.y - lastMoveStart.point.y) > o.doubleClickPx
          ) {
            lastMoveStart = { tMono: e.tMono, point };
          }
          lastMove = { tMono: e.tMono, point };
        }
        break;
      }

      case "mouse_up": {
        if (downAt === undefined) {
          warnings.push(`mouse_up at ${e.tMono} had no matching mouse_down`);
          break;
        }
        const point = { x: num(e.x, 0), y: num(e.y, 0) };
        dragSamples.push({ ...point, tMono: e.tMono });
        const travel = Math.hypot(point.x - downAt.point.x, point.y - downAt.point.y);
        if (travel > o.dragThresholdPx) {
          gestures.push({
            type: "drag",
            from: downAt.point,
            to: point,
            samples: dragSamples,
            button: downAt.button,
            tMonoStart: downAt.tMono,
            tMonoEnd: e.tMono,
          });
        } else {
          const prev = gestures[gestures.length - 1];
          const isRepeat =
            prev !== undefined &&
            prev.type === "click" &&
            prev.button === downAt.button &&
            downAt.tMono - prev.tMonoEnd <= o.doubleClickMs &&
            Math.hypot(prev.point.x - downAt.point.x, prev.point.y - downAt.point.y) <= o.doubleClickPx;
          if (isRepeat && prev.type === "click") {
            prev.count += 1;
            prev.tMonoEnd = e.tMono;
          } else {
            gestures.push({
              type: "click",
              point: downAt.point,
              button: downAt.button,
              count: 1,
              tMonoStart: downAt.tMono,
              tMonoEnd: e.tMono,
            });
          }
        }
        downAt = undefined;
        dragSamples = [];
        break;
      }

      case "scroll": {
        flushHover(e.tMono);
        const point = { x: num(e.x, 0), y: num(e.y, 0) };
        // uiohook reports wheel rotation; direction 3 is vertical.
        const rotation = num(d.rotation, 0);
        const vertical = num(d.direction, 3) === 3;
        const step = { x: vertical ? 0 : rotation, y: vertical ? rotation : 0 };
        if (scrollRun !== undefined && e.tMono - scrollRun.tMonoEnd <= o.scrollCoalesceMs) {
          scrollRun.delta = { x: scrollRun.delta.x + step.x, y: scrollRun.delta.y + step.y };
          scrollRun.steps += 1;
          scrollRun.tMonoEnd = e.tMono;
        } else {
          flushScroll();
          scrollRun = { point, delta: step, steps: 1, tMonoStart: e.tMono, tMonoEnd: e.tMono };
        }
        break;
      }

      case "key_down": {
        const k = d as KeyData;
        const mods = Array.isArray(k.modifiers) ? k.modifiers.filter((m) => typeof m === "string") : [];
        if (k.char === undefined || k.char.length === 0) {
          warnings.push(
            `key event at ${e.tMono} has no resolved char (keycode ${String(k.keycode ?? "?")}); no text gesture emitted`,
          );
          break;
        }
        if (mods.length > 0) {
          flushText();
          gestures.push({
            type: "chord",
            keys: [...mods, k.char],
            tMonoStart: e.tMono,
            tMonoEnd: e.tMono,
          });
          break;
        }
        if (textRun === undefined) {
          textRun = { text: k.char, tMonoStart: e.tMono, tMonoEnd: e.tMono };
        } else {
          textRun.text += k.char;
          textRun.tMonoEnd = e.tMono;
        }
        break;
      }

      case "key_up": {
        // Extends the run's end stamp; the character was recorded on key_down.
        const prevChord = gestures[gestures.length - 1];
        if (textRun !== undefined) textRun.tMonoEnd = e.tMono;
        else if (prevChord !== undefined && prevChord.type === "chord") prevChord.tMonoEnd = e.tMono;
        break;
      }

      default:
        // focus_change, bookmark and anything else: a boundary for runs, but not
        // itself a gesture. Lifting reads these separately for node context.
        flushHover(e.tMono);
        break;
    }
  }

  flushText();
  flushScroll();
  flushHover(sorted[sorted.length - 1]!.tMono);
  if (downAt !== undefined) {
    warnings.push(`mouse_down at ${downAt.tMono} had no matching mouse_up`);
  }

  // Idle gaps, inserted between the gestures that survived.
  const withIdle: Gesture[] = [];
  for (const g of gestures) {
    const prev = withIdle[withIdle.length - 1];
    if (prev !== undefined) {
      const gap = g.tMonoStart - prev.tMonoEnd;
      if (gap >= o.idleGapMs) {
        withIdle.push({
          type: "idle",
          durationMs: gap,
          tMonoStart: prev.tMonoEnd,
          tMonoEnd: g.tMonoStart,
        });
      }
    }
    withIdle.push(g);
  }

  return { gestures: withIdle, warnings };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/trace.gestures.test.ts && npm run typecheck`
Expected: PASS. If the hover assertion is off by the ordering of `flushHover` relative to `mouse_down`, adjust `flushHover` to run *before* the down is recorded (as written) and re-run — the test expects hover at index 0 and click at index 1.

- [ ] **Step 5: Commit**

```bash
git add src/trace/gestures.ts test/trace.gestures.test.ts
git commit -m "feat(trace): group raw events into typed gestures

Clicks, drags (samples confined to the button-down interval), hovers,
coalesced scrolls, text runs, chords, and idle gaps. A key without a
resolved char warns and emits nothing rather than fabricating typed
content from a keycode table."
```

---

## Task 7: Lifting a session into a linear Trace

**Files:**
- Create: `src/trace/lift.ts`
- Test: `test/trace.lift.test.ts`

**Interfaces:**
- Consumes: `computeBoundaries` from `../segment/boundaries.js`; `groupGestures` from `./gestures.js`; `buildAnchor` from `./anchors.js`; `fitPath` from `./paths.js`; `extractPredicates` from `./predicates.js`; types from `./types.js`.
- Produces:
  - `interface AxSnapshot { elements: readonly UIElement[]; frameId: string; framePhash: string }`
  - `interface LiftInput { sessionId: string; events: readonly TraceEvent[]; endTMono: number; axAt?(tMono: number): AxSnapshot | undefined; regionsAt?(tMono: number): readonly AnchorRegion[]; displayIdAt?(p: Vec2): string; windowBoundsAt?(tMono: number): Rect | undefined; dwellGapMs?: number; gestures?: GestureOptions; idPrefix?: string }`
  - `liftTrace(input: LiftInput): Trace`
  - `slotNameFor(anchor: Anchor | undefined, index: number): string`

**Design notes for the implementer:**
- **Ids are deterministic**, derived from `idPrefix` (default the session id) plus an ordinal: `${prefix}:n${i}` / `${prefix}:e${i}`. Lifting must be reproducible — the same input yields the same ids, which is what makes re-lifting after a heuristic change a comparable operation. Do **not** use ULIDs here.
- **Callbacks, not a store.** `axAt`/`regionsAt`/`windowBoundsAt` keep `trace/` a leaf. All are optional; absent means the AX-blind path.
- **`wait` derivation.** For an `idle` gesture, `until` is the first predicate present in the *next* boundary's node but not the previous one (set difference, in extraction order). If the difference is empty, fall back to the `ax_focused` predicate of the following node. If there is none either, drop the wait and push a warning — do not emit a `wait` with a predicate that was already true, which would make it a no-op that looks like a check.
- **`timeoutMs`** = `Math.max(3000, Math.round(durationMs * 3))`.
- **Slot naming** from the focused element at the time of the text gesture: `slotNameFor` sanitizes `role`+`label` to `[a-z0-9_]+`, e.g. `AXTextField`/`To` → `axtextfield_to`. Falls back to `text_${index}`.

- [ ] **Step 1: Write the failing test**

```ts
// test/trace.lift.test.ts
import { describe, expect, it } from "vitest";
import { liftTrace, slotNameFor } from "../src/trace/lift.js";
import type { AxSnapshot } from "../src/trace/lift.js";
import type { TraceEvent } from "../src/trace/types.js";
import type { UIElement } from "../src/embed/types.js";

const ev = (tMono: number, kind: string, x?: number, y?: number, data?: unknown): TraceEvent => ({
  tMono,
  kind,
  x: x ?? null,
  y: y ?? null,
  data: data ?? null,
});

const composeTree: UIElement[] = [
  { role: "AXWindow", label: "New Message", x: 0, y: 0, w: 800, h: 600 },
  { role: "AXTextField", label: "To", x: 100, y: 50, w: 400, h: 24, parent: 0, focused: true },
  { role: "AXButton", label: "Send", x: 700, y: 20, w: 80, h: 32, parent: 0 },
];

const sentTree: UIElement[] = [
  { role: "AXWindow", label: "Inbox", x: 0, y: 0, w: 800, h: 600 },
  { role: "AXStaticText", label: "Message sent", x: 100, y: 50, w: 200, h: 20, parent: 0 },
  { role: "AXSheet", label: "Delivery Report", x: 200, y: 200, w: 300, h: 200, parent: 0 },
];

const axAt = (tMono: number): AxSnapshot =>
  tMono < 1000
    ? { elements: composeTree, frameId: "f_compose", framePhash: "1111" }
    : { elements: sentTree, frameId: "f_sent", framePhash: "2222" };

describe("slotNameFor", () => {
  it("derives a stable name from the focused role and label", () => {
    expect(
      slotNameFor({ ax: { role: "AXTextField", label: "To", path: "p" }, point: { x: 0, y: 0, displayId: "D1" } }, 0),
    ).toBe("axtextfield_to");
  });

  it("falls back to an ordinal without an AX layer", () => {
    expect(slotNameFor(undefined, 3)).toBe("text_3");
    expect(slotNameFor({ point: { x: 0, y: 0, displayId: "D1" } }, 1)).toBe("text_1");
  });
});

describe("liftTrace", () => {
  const events: TraceEvent[] = [
    ev(0, "focus_change", undefined, undefined, { app: "Mail", title: "New Message" }),
    ev(100, "mouse_down", 720, 30, { button: 1 }),
    ev(140, "mouse_up", 720, 30, { button: 1 }),
    ev(300, "key_down", undefined, undefined, { keycode: 1, char: "h" }),
    ev(310, "key_up", undefined, undefined, { keycode: 1, char: "h" }),
    ev(1000, "focus_change", undefined, undefined, { app: "Mail", title: "Inbox" }),
    ev(1100, "mouse_down", 250, 250, { button: 1 }),
    ev(1140, "mouse_up", 250, 250, { button: 1 }),
  ];

  const lifted = () =>
    liftTrace({
      sessionId: "s1",
      events,
      endTMono: 2000,
      axAt,
      regionsAt: () => [{ id: "r_send", x: 700, y: 20, w: 80, h: 32 }],
      displayIdAt: () => "D1",
    });

  it("produces a chain where edges[i] connects nodes[i] to nodes[i+1]", () => {
    const t = lifted();
    expect(t.sessionId).toBe("s1");
    expect(t.edges).toHaveLength(t.nodes.length - 1);
    t.edges.forEach((e, i) => {
      expect(e.from).toBe(t.nodes[i]!.id);
      expect(e.to).toBe(t.nodes[i + 1]!.id);
    });
  });

  it("cuts at the existing segment boundaries, not a new mechanism", () => {
    // session_start, focus_change at 1000, session_end => 3 nodes, 2 edges.
    const t = lifted();
    expect(t.nodes).toHaveLength(3);
    expect(t.edges).toHaveLength(2);
  });

  it("is deterministic — the same input yields the same ids", () => {
    expect(JSON.stringify(lifted())).toBe(JSON.stringify(lifted()));
  });

  it("resolves anchors against the AX tree captured at that moment", () => {
    const t = lifted();
    const click = t.edges[0]!.actions.find((a) => a.kind === "click");
    expect(click?.kind).toBe("click");
    if (click?.kind !== "click") throw new Error("expected click");
    expect(click.anchor.ax).toMatchObject({ role: "AXButton", label: "Send" });
    expect(click.anchor.visual?.regionId).toBe("r_send");
    expect(click.anchor.point.displayId).toBe("D1");
  });

  it("builds node predicates from the tree at each boundary", () => {
    const t = lifted();
    const first = t.nodes[0]!.predicates;
    expect(first).toContainEqual({ kind: "app", args: { app: "Mail" }, reach: "achievable" });
    expect(first).toContainEqual({
      kind: "ax_focused",
      args: { role: "AXTextField", label: "To" },
      reach: "achievable",
    });
  });

  it("names a type slot from the focused element and records one sample", () => {
    const t = lifted();
    const typed = t.edges[0]!.actions.find((a) => a.kind === "type");
    expect(typed).toEqual({ kind: "type", slot: "axtextfield_to", recorded: "h" });
    expect(t.slots).toContainEqual({ name: "axtextfield_to", samples: ["h"], secret: false });
  });

  it("defaults every node to intervene: select", () => {
    expect(lifted().nodes.every((n) => n.intervene === "select")).toBe(true);
  });

  it("records the frame reference for visual corroboration", () => {
    expect(lifted().nodes[0]!.visual).toEqual({ frameBlobId: "f_compose", phash: "1111" });
  });

  it("lifts an idle gap into a wait on a predicate that was NOT already true", () => {
    const t = liftTrace({
      sessionId: "s2",
      endTMono: 6000,
      axAt,
      events: [
        ev(0, "mouse_down", 720, 30, { button: 1 }),
        ev(40, "mouse_up", 720, 30, { button: 1 }),
        ev(4000, "mouse_down", 250, 250, { button: 1 }),
        ev(4040, "mouse_up", 250, 250, { button: 1 }),
      ],
    });
    const wait = t.edges.flatMap((e) => e.actions).find((a) => a.kind === "wait");
    expect(wait?.kind).toBe("wait");
    if (wait?.kind !== "wait") throw new Error("expected wait");
    // The dwell gap boundary put the sent-state tree after the gap, so the wait
    // must key on something new there, never on something already true before.
    expect(wait.until.kind === "ax_exists" || wait.until.kind === "ax_focused").toBe(true);
    expect(wait.timeoutMs).toBeGreaterThanOrEqual(3000);
  });

  it("degrades to point-only anchors with no AX source", () => {
    const t = liftTrace({
      sessionId: "s3",
      endTMono: 500,
      events: [ev(100, "mouse_down", 10, 10, { button: 1 }), ev(140, "mouse_up", 10, 10, { button: 1 })],
    });
    const click = t.edges.flatMap((e) => e.actions).find((a) => a.kind === "click");
    if (click?.kind !== "click") throw new Error("expected click");
    expect(click.anchor.ax).toBeUndefined();
    expect(click.anchor.point.displayId).toBe("D0");
  });

  it("carries gesture warnings onto the edge", () => {
    const t = liftTrace({
      sessionId: "s4",
      endTMono: 500,
      events: [ev(100, "mouse_down", 10, 10, { button: 1 })],
    });
    expect(t.edges.some((e) => (e.liftWarnings ?? []).some((w) => /mouse_down/.test(w)))).toBe(true);
  });

  it("fits a drag path and stores it endpoint-normalized", () => {
    const t = liftTrace({
      sessionId: "s5",
      endTMono: 500,
      events: [
        ev(100, "mouse_down", 10, 10, { button: 1 }),
        ev(120, "mouse_move", 40, 4),
        ev(140, "mouse_move", 70, 4),
        ev(160, "mouse_up", 100, 10, { button: 1 }),
      ],
    });
    const drag = t.edges.flatMap((e) => e.actions).find((a) => a.kind === "drag");
    if (drag?.kind !== "drag") throw new Error("expected drag");
    expect(drag.path.curve.at(-1)!.end).toEqual({ x: 1, y: 0 });
    expect(drag.path.durationMs).toBe(60);
    expect(drag.from.point).toMatchObject({ x: 10, y: 10 });
    expect(drag.to.point).toMatchObject({ x: 100, y: 10 });
  });

  it("returns a single-node trace with no edges for an empty event stream", () => {
    const t = liftTrace({ sessionId: "s6", events: [], endTMono: 1000 });
    expect(t.nodes.length).toBeGreaterThanOrEqual(1);
    expect(t.edges.every((e) => e.actions.length === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.lift.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/trace/lift.ts
/**
 * Lift one recorded session into a linear Trace.
 *
 * Reuses `computeBoundaries` rather than inventing a second notion of where
 * things break: focus_change / dwell_gap / bookmark are already the moments
 * where state settles, and `bookmark` is already a user-placed keypoint.
 *
 * Anchors resolve against the AX tree captured AT THAT MOMENT, never live — the
 * rule `StoredAxProvider` already enforces at represent time.
 *
 * Ids are deterministic (prefix + ordinal), not ULIDs: re-lifting after a
 * heuristic change must be diffable against the previous lift.
 */

import { computeBoundaries } from "../segment/boundaries.js";
import { buildAnchor } from "./anchors.js";
import { groupGestures, type Gesture, type GestureOptions } from "./gestures.js";
import { fitPath } from "./paths.js";
import { extractPredicates, predicateKey, type PredicateContext } from "./predicates.js";
import type {
  Action,
  Anchor,
  AnchorRegion,
  Predicate,
  Rect,
  Slot,
  Trace,
  TraceEdge,
  TraceEvent,
  TraceNode,
  UIElement,
  Vec2,
} from "./types.js";

export interface AxSnapshot {
  elements: readonly UIElement[];
  frameId: string;
  framePhash: string;
}

export interface LiftInput {
  sessionId: string;
  events: readonly TraceEvent[];
  endTMono: number;
  /** The stored AX snapshot nearest at/just before `tMono`. */
  axAt?(tMono: number): AxSnapshot | undefined;
  regionsAt?(tMono: number): readonly AnchorRegion[];
  displayIdAt?(p: Vec2): string;
  windowBoundsAt?(tMono: number): Rect | undefined;
  dwellGapMs?: number;
  gestures?: GestureOptions;
  /** Defaults to `sessionId`. Ids are `${prefix}:n0`, `${prefix}:e0`, ... */
  idPrefix?: string;
}

const MIN_WAIT_TIMEOUT_MS = 3000;

/** `AXTextField` + `To` -> `axtextfield_to`; without AX, `text_<index>`. */
export function slotNameFor(anchor: Anchor | undefined, index: number): string {
  const ax = anchor?.ax;
  if (ax === undefined) return `text_${index}`;
  const raw = `${ax.role}_${ax.label ?? ""}`;
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clean.length > 0 ? clean : `text_${index}`;
}

export function liftTrace(input: LiftInput): Trace {
  const prefix = input.idPrefix ?? input.sessionId;
  const events = [...input.events].sort((a, b) => a.tMono - b.tMono);
  const boundaries = computeBoundaries(events, input.endTMono, input.dwellGapMs);

  const nodes: TraceNode[] = boundaries.map((b, i) =>
    buildNode(`${prefix}:n${i}`, b.tMono, events, input),
  );

  const edges: TraceEdge[] = [];
  const slots = new Map<string, Slot>();
  let textIndex = 0;

  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!.tMono;
    const end = boundaries[i + 1]!.tMono;
    const span = events.filter((e) => e.tMono >= start && e.tMono < end);
    const { gestures, warnings } = groupGestures(span, input.gestures);

    const actions: Action[] = [];
    for (const g of gestures) {
      const action = toAction(g, input, nodes[i]!, nodes[i + 1]!, () => {
        const name = slotNameFor(focusedAnchor(g.tMonoStart, input), textIndex);
        textIndex += 1;
        return name;
      }, warnings);
      if (action !== undefined) actions.push(action);
      if (action?.kind === "type") {
        const existing = slots.get(action.slot);
        if (existing === undefined) {
          slots.set(action.slot, { name: action.slot, samples: [action.recorded], secret: false });
        } else if (!existing.samples.includes(action.recorded)) {
          existing.samples.push(action.recorded);
        }
      }
    }

    edges.push({
      id: `${prefix}:e${i}`,
      from: nodes[i]!.id,
      to: nodes[i + 1]!.id,
      actions,
      provenance: "recorded",
      observations: 1,
      outcomes: { attempts: 0, successes: 0 },
      ...(warnings.length > 0 ? { liftWarnings: warnings } : {}),
    });
  }

  return { sessionId: input.sessionId, nodes, edges, slots: [...slots.values()] };
}

function buildNode(id: string, tMono: number, events: readonly TraceEvent[], input: LiftInput): TraceNode {
  const snap = input.axAt?.(tMono);
  const ctx = focusContext(tMono, events);
  const predicates = extractPredicates(snap?.elements ?? [], ctx);
  return {
    id,
    predicates,
    ...(snap !== undefined ? { visual: { frameBlobId: snap.frameId, phash: snap.framePhash } } : {}),
    intervene: "select",
    observations: 1,
  };
}

/** The most recent `focus_change` at or before `tMono` supplies app/window. */
function focusContext(tMono: number, events: readonly TraceEvent[]): PredicateContext {
  let ctx: PredicateContext = {};
  for (const e of events) {
    if (e.tMono > tMono) break;
    if (e.kind !== "focus_change") continue;
    const d = e.data !== null && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {};
    ctx = {
      ...(typeof d.app === "string" ? { app: d.app } : {}),
      ...(typeof d.title === "string" ? { windowTitle: d.title } : {}),
    };
  }
  return ctx;
}

function anchorFor(point: Vec2, tMono: number, input: LiftInput): Anchor {
  const snap = input.axAt?.(tMono);
  return buildAnchor({
    point,
    displayId: input.displayIdAt?.(point) ?? "D0",
    ...(input.windowBoundsAt?.(tMono) !== undefined ? { windowBounds: input.windowBoundsAt(tMono)! } : {}),
    ...(snap !== undefined ? { ax: snap.elements, framePhash: snap.framePhash } : {}),
    ...(input.regionsAt !== undefined ? { regions: input.regionsAt(tMono) } : {}),
  });
}

/** Anchor of whatever had focus, used only to name a slot. */
function focusedAnchor(tMono: number, input: LiftInput): Anchor | undefined {
  const snap = input.axAt?.(tMono);
  const focused = snap?.elements.find((e) => e.focused === true);
  if (snap === undefined || focused === undefined) return undefined;
  return anchorFor({ x: focused.x + focused.w / 2, y: focused.y + focused.h / 2 }, tMono, input);
}

function toAction(
  g: Gesture,
  input: LiftInput,
  before: TraceNode,
  after: TraceNode,
  nextSlotName: () => string,
  warnings: string[],
): Action | undefined {
  switch (g.type) {
    case "click":
      return { kind: "click", anchor: anchorFor(g.point, g.tMonoStart, input), button: g.button, count: g.count };
    case "drag":
      return {
        kind: "drag",
        from: anchorFor(g.from, g.tMonoStart, input),
        to: anchorFor(g.to, g.tMonoEnd, input),
        path: fitPath(g.samples),
        button: g.button,
      };
    case "hover":
      return { kind: "hover", anchor: anchorFor(g.point, g.tMonoStart, input), dwellMs: g.dwellMs };
    case "scroll":
      return { kind: "scroll", anchor: anchorFor(g.point, g.tMonoStart, input), delta: g.delta, steps: g.steps };
    case "text":
      return { kind: "type", slot: nextSlotName(), recorded: g.text };
    case "chord":
      return { kind: "chord", keys: g.keys };
    case "idle": {
      const until = newlyTruePredicate(before, after);
      if (until === undefined) {
        warnings.push(
          `idle gap at ${g.tMonoStart} produced no newly-true predicate; wait dropped rather than emitted as a no-op`,
        );
        return undefined;
      }
      return {
        kind: "wait",
        until,
        timeoutMs: Math.max(MIN_WAIT_TIMEOUT_MS, Math.round(g.durationMs * 3)),
      };
    }
  }
}

/**
 * The first predicate true after the gap but not before. A `wait` on something
 * already true is a no-op that LOOKS like a check, which is worse than no wait
 * at all — so return undefined and let the caller warn.
 */
function newlyTruePredicate(before: TraceNode, after: TraceNode): Predicate | undefined {
  const had = new Set(before.predicates.map(predicateKey));
  const fresh = after.predicates.find((p) => !had.has(predicateKey(p)));
  if (fresh !== undefined) return fresh;
  return after.predicates.find((p) => p.kind === "ax_focused");
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/trace.lift.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trace/lift.ts test/trace.lift.test.ts
git commit -m "feat(trace): lift a session into a linear Trace

Cuts at the existing segment boundaries, groups gestures, resolves anchors
against the AX tree captured at that moment, and derives waits from idle
gaps. Ids are deterministic so a re-lift after a heuristic change is
diffable. A wait with no newly-true predicate is dropped with a warning
rather than emitted as a no-op that looks like a check."
```

---

## Task 8: Merging a Trace into a Graph

**Files:**
- Create: `src/trace/merge.ts`
- Test: `test/trace.merge.test.ts`

**Interfaces:**
- Consumes: `matchNode`, `MatchOptions` from `./identity.js`; `anchorKey` from `./anchors.js`; types from `./types.js`.
- Produces:
  - `edgeSignature(e: TraceEdge): string`
  - `actionSignature(a: Action): string`
  - `mergeTrace(graph: Graph | undefined, trace: Trace, opts?: MatchOptions): Promise<Graph>`

**The two assertions that carry the whole model** (make sure both tests exist and pass):
1. Two traces differing only in typed text produce **one edge with two slot samples** — slots are *discovered*, not declared.
2. Two traces diverging mid-way produce **a branch** — an observed alternative, not an invented one.

`edgeSignature` therefore compares action kinds, order, and `anchorKey`s, and deliberately **excludes** `recorded` text and the slot name.

- [ ] **Step 1: Write the failing test**

```ts
// test/trace.merge.test.ts
import { describe, expect, it } from "vitest";
import { edgeSignature, mergeTrace } from "../src/trace/merge.js";
import type { Anchor, Predicate, Trace, TraceEdge, TraceNode } from "../src/trace/types.js";

const p = (label: string): Predicate => ({
  kind: "ax_exists",
  args: { role: "AXButton", label },
  reach: "achievable",
});

const anchor = (path: string): Anchor => ({
  ax: { role: "AXButton", path },
  point: { x: 0, y: 0, displayId: "D1" },
});

const node = (id: string, labels: string[]): TraceNode => ({
  id,
  predicates: labels.map(p),
  intervene: "select",
  observations: 1,
});

const edge = (id: string, from: string, to: string, actions: TraceEdge["actions"]): TraceEdge => ({
  id,
  from,
  to,
  actions,
  provenance: "recorded",
  observations: 1,
  outcomes: { attempts: 0, successes: 0 },
});

/** compose -> type -> sent, with the typed text supplied by the caller. */
const typingTrace = (sessionId: string, text: string): Trace => ({
  sessionId,
  nodes: [node(`${sessionId}:n0`, ["Compose"]), node(`${sessionId}:n1`, ["Sent"])],
  edges: [
    edge(`${sessionId}:e0`, `${sessionId}:n0`, `${sessionId}:n1`, [
      { kind: "click", anchor: anchor("W>To"), button: 1, count: 1 },
      { kind: "type", slot: "axtextfield_to", recorded: text },
      { kind: "click", anchor: anchor("W>Send"), button: 1, count: 1 },
    ]),
  ],
  slots: [{ name: "axtextfield_to", samples: [text], secret: false }],
});

describe("edgeSignature", () => {
  it("ignores typed content — that is what makes slots discoverable", () => {
    const a = typingTrace("s1", "alice@example.com").edges[0]!;
    const b = typingTrace("s2", "bob@example.com").edges[0]!;
    expect(edgeSignature(a)).toBe(edgeSignature(b));
  });

  it("distinguishes different anchors", () => {
    const a = edge("e", "n0", "n1", [{ kind: "click", anchor: anchor("W>Send"), button: 1, count: 1 }]);
    const b = edge("e", "n0", "n1", [{ kind: "click", anchor: anchor("W>Cancel"), button: 1, count: 1 }]);
    expect(edgeSignature(a)).not.toBe(edgeSignature(b));
  });

  it("distinguishes different action order", () => {
    const a = edge("e", "n0", "n1", [
      { kind: "click", anchor: anchor("W>A"), button: 1, count: 1 },
      { kind: "chord", keys: ["cmd", "s"] },
    ]);
    const b = edge("e", "n0", "n1", [
      { kind: "chord", keys: ["cmd", "s"] },
      { kind: "click", anchor: anchor("W>A"), button: 1, count: 1 },
    ]);
    expect(edgeSignature(a)).not.toBe(edgeSignature(b));
  });
});

describe("mergeTrace", () => {
  it("seeds an empty graph from the first trace and sets the entry node", async () => {
    const g = await mergeTrace(undefined, typingTrace("s1", "alice@example.com"));
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(g.entry).toBe(g.nodes[0]!.id);
  });

  it("THE SLOT ASSERTION: two traces differing only in typed text merge to one edge with two samples", async () => {
    const g1 = await mergeTrace(undefined, typingTrace("s1", "alice@example.com"));
    const g2 = await mergeTrace(g1, typingTrace("s2", "bob@example.com"));

    expect(g2.nodes).toHaveLength(2);
    expect(g2.edges).toHaveLength(1);
    expect(g2.edges[0]!.observations).toBe(2);
    expect(g2.slots).toHaveLength(1);
    expect(g2.slots[0]!.samples).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("does not duplicate a sample recorded twice", async () => {
    const g1 = await mergeTrace(undefined, typingTrace("s1", "alice@example.com"));
    const g2 = await mergeTrace(g1, typingTrace("s2", "alice@example.com"));
    expect(g2.slots[0]!.samples).toEqual(["alice@example.com"]);
    expect(g2.edges[0]!.observations).toBe(2);
  });

  it("THE BRANCH ASSERTION: traces that diverge produce a parallel edge, not a rewritten one", async () => {
    const base = typingTrace("s1", "alice@example.com");
    const divergent: Trace = {
      sessionId: "s2",
      nodes: [node("s2:n0", ["Compose"]), node("s2:n1", ["Draft Saved"])],
      edges: [
        edge("s2:e0", "s2:n0", "s2:n1", [{ kind: "chord", keys: ["cmd", "s"] }]),
      ],
      slots: [],
    };
    const g1 = await mergeTrace(undefined, base);
    const g2 = await mergeTrace(g1, divergent);

    // The shared "Compose" state merged; the outcomes did not.
    expect(g2.nodes).toHaveLength(3);
    const fromCompose = g2.edges.filter((e) => e.from === g2.entry);
    expect(fromCompose).toHaveLength(2);
    expect(fromCompose.every((e) => e.provenance === "recorded")).toBe(true);
  });

  it("increments node observations on a merge", async () => {
    const g1 = await mergeTrace(undefined, typingTrace("s1", "a"));
    const g2 = await mergeTrace(g1, typingTrace("s2", "b"));
    expect(g2.nodes.every((n) => n.observations === 2)).toBe(true);
  });

  it("creates a distinct node rather than merging when identity is ambiguous", async () => {
    // Two existing nodes carry the same predicate set, so the incoming node
    // cannot be told apart from either.
    const seed: Trace = {
      sessionId: "s1",
      nodes: [node("s1:n0", ["Same"]), node("s1:n1", ["Same"])],
      edges: [edge("s1:e0", "s1:n0", "s1:n1", [{ kind: "chord", keys: ["tab"] }])],
      slots: [],
    };
    const g1 = await mergeTrace(undefined, seed);
    expect(g1.nodes).toHaveLength(2);

    const g2 = await mergeTrace(g1, {
      sessionId: "s2",
      nodes: [node("s2:n0", ["Same"])],
      edges: [],
      slots: [],
    });
    // Ambiguity declines to merge: a third node, not a silent wrong merge.
    expect(g2.nodes).toHaveLength(3);
  });

  it("leaves the input graph untouched", async () => {
    const g1 = await mergeTrace(undefined, typingTrace("s1", "alice@example.com"));
    const before = JSON.stringify(g1);
    await mergeTrace(g1, typingTrace("s2", "bob@example.com"));
    expect(JSON.stringify(g1)).toBe(before);
  });

  it("preserves the entry node across merges", async () => {
    const g1 = await mergeTrace(undefined, typingTrace("s1", "a"));
    const g2 = await mergeTrace(g1, typingTrace("s2", "b"));
    expect(g2.entry).toBe(g1.entry);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.merge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/trace/merge.ts
/**
 * Merge a linear Trace into a Graph. This is where variation stops being
 * something an AI invents and becomes something you recorded.
 *
 * Edge equivalence compares action kinds, order, and resolved anchors, but NOT
 * typed content — so two recordings differing only in what was typed collapse
 * into one edge with two slot observations. Slots are therefore discovered by
 * recording a task twice, not declared by hand.
 *
 * Merging never mutates its inputs: it builds a new Graph. A rejected or partial
 * merge therefore leaves the stored graph byte-identical.
 */

import { anchorKey } from "./anchors.js";
import { matchNode, type MatchOptions } from "./identity.js";
import type { Action, Graph, Slot, Trace, TraceEdge, TraceNode } from "./types.js";

/** Canonical per-action key. Excludes typed content and the slot name. */
export function actionSignature(a: Action): string {
  switch (a.kind) {
    case "click":
      return `click:${anchorKey(a.anchor)}:${a.button}:${a.count}`;
    case "drag":
      return `drag:${anchorKey(a.from)}->${anchorKey(a.to)}:${a.button}`;
    case "hover":
      return `hover:${anchorKey(a.anchor)}`;
    case "scroll":
      return `scroll:${anchorKey(a.anchor)}:${Math.sign(a.delta.x)},${Math.sign(a.delta.y)}`;
    case "type":
      // Neither the recorded value nor the slot name: two recordings that typed
      // into the same field are the same edge, and that is the whole point.
      return "type";
    case "chord":
      return `chord:${a.keys.join("+")}`;
    case "wait":
      return `wait:${a.until.kind}`;
  }
}

export function edgeSignature(e: TraceEdge): string {
  return e.actions.map(actionSignature).join("|");
}

export async function mergeTrace(
  graph: Graph | undefined,
  trace: Trace,
  opts: MatchOptions = {},
): Promise<Graph> {
  const next: Graph =
    graph === undefined
      ? { id: trace.sessionId, nodes: [], edges: [], slots: [], entry: "" }
      : {
          id: graph.id,
          nodes: graph.nodes.map((n) => ({ ...n, predicates: [...n.predicates] })),
          edges: graph.edges.map((e) => ({ ...e, actions: [...e.actions], outcomes: { ...e.outcomes } })),
          slots: graph.slots.map((s) => ({ ...s, samples: [...s.samples] })),
          entry: graph.entry,
        };

  // Map every trace node onto a graph node id, merging where identity allows.
  const idMap = new Map<string, string>();
  for (const tn of trace.nodes) {
    const result = await matchNode(tn, next.nodes, opts);
    if (result.nodeId !== undefined) {
      const existing = next.nodes.find((n) => n.id === result.nodeId)!;
      existing.observations += 1;
      idMap.set(tn.id, existing.id);
    } else {
      const fresh: TraceNode = { ...tn, predicates: [...tn.predicates] };
      next.nodes.push(fresh);
      idMap.set(tn.id, fresh.id);
    }
  }

  if (next.entry === "" && trace.nodes.length > 0) {
    next.entry = idMap.get(trace.nodes[0]!.id)!;
  }

  for (const te of trace.edges) {
    const from = idMap.get(te.from)!;
    const to = idMap.get(te.to)!;
    const sig = edgeSignature(te);
    const existing = next.edges.find((e) => e.from === from && e.to === to && edgeSignature(e) === sig);
    if (existing !== undefined) {
      existing.observations += 1;
      if (te.liftWarnings !== undefined) {
        existing.liftWarnings = [...(existing.liftWarnings ?? []), ...te.liftWarnings];
      }
    } else {
      next.edges.push({
        ...te,
        from,
        to,
        actions: [...te.actions],
        outcomes: { ...te.outcomes },
      });
    }
  }

  for (const s of trace.slots) {
    const existing = next.slots.find((x) => x.name === s.name);
    if (existing === undefined) {
      next.slots.push({ ...s, samples: [...s.samples] });
    } else {
      for (const sample of s.samples) {
        if (!existing.samples.includes(sample)) existing.samples.push(sample);
      }
    }
  }

  return next;
}

/** Slots with more than one observed value are the discovered variables. */
export function discoveredVariables(graph: Graph): Slot[] {
  return graph.slots.filter((s) => s.samples.length > 1);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/trace.merge.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trace/merge.ts test/trace.merge.test.ts
git commit -m "feat(trace): merge traces into a graph, discovering slots

Edge equivalence ignores typed content, so two recordings of one task
collapse into one edge with two slot samples - variables are discovered by
recording twice, not declared. Divergence becomes an observed branch.
Merging never mutates its inputs."
```

---

## Task 9: The language — print, parse, and validate interventions

**Files:**
- Create: `src/trace/language.ts`
- Test: `test/trace.language.test.ts`

**Interfaces:**
- Consumes: types from `./types.js`.
- Produces:
  - `printGraph(g: Graph): string`
  - `parseGraph(text: string): Graph`
  - `printInterventionRequest(req: InterventionRequest): string`
  - `parseInterventionResponse(text: string, req: InterventionRequest): InterventionResponse`

**The text format** (line-oriented, two-space indentation; `!` marks an assertable predicate):

```
graph g_01 entry=n0

node n0 intervene=select obs=3 visual=b_1/0f1e
  app app="Mail"
  window title="New Message"
  ax_exists role="AXButton" label="Send"
  ! display id="D1" w=2560 h=1440

edge e0 n0 -> n1 obs=2 recorded
  click ax="AXWindow[0]>AXButton[0]" label="Send" point=1420,386@D1 button=1 count=1
  type $recipient "guy@example.com"
  chord cmd+s
  wait ax_exists role="AXSheet" timeout=3000

slot recipient "alice@example.com" "bob@example.com"
```

**Round-trip is the contract.** `parseGraph(printGraph(g))` must deep-equal `g`. Where the text form cannot represent something losslessly (a fitted `Path`'s control points), serialize it explicitly rather than dropping it — `drag` lines carry `path=` with the numbers.

**Validation is the security boundary.** A response naming an unknown edge id, an undeclared slot, or synthesizing under `allow: "select"` becomes `{ abort }`. The model must not be able to widen its own permissions by malforming a reply.

- [ ] **Step 1: Write the failing test**

```ts
// test/trace.language.test.ts
import { describe, expect, it } from "vitest";
import { parseGraph, parseInterventionResponse, printGraph, printInterventionRequest } from "../src/trace/language.js";
import type { Graph, InterventionRequest } from "../src/trace/types.js";

const graph: Graph = {
  id: "g_01",
  entry: "n0",
  nodes: [
    {
      id: "n0",
      predicates: [
        { kind: "app", args: { app: "Mail" }, reach: "achievable" },
        { kind: "window", args: { title: "New Message" }, reach: "achievable" },
        { kind: "ax_exists", args: { role: "AXButton", label: "Send" }, reach: "achievable" },
        { kind: "display", args: { id: "D1", w: 2560, h: 1440 }, reach: "assertable" },
      ],
      visual: { frameBlobId: "b_1", phash: "0f1e2d3c4b5a6978" },
      intervene: "select",
      observations: 3,
    },
    { id: "n1", predicates: [], intervene: "synthesize", observations: 1 },
  ],
  edges: [
    {
      id: "e0",
      from: "n0",
      to: "n1",
      actions: [
        {
          kind: "click",
          anchor: {
            ax: { role: "AXButton", label: "Send", path: "AXWindow[0]>AXButton[0]" },
            visual: { regionId: "r_1", framePhash: "0f1e", bbox: { x: 1, y: 2, w: 3, h: 4 } },
            point: { x: 1420, y: 386, displayId: "D1", windowRelative: { x: 220, y: 118 } },
          },
          button: 1,
          count: 1,
        },
        { kind: "type", slot: "recipient", recorded: 'a "quoted" value' },
        { kind: "chord", keys: ["cmd", "s"] },
        { kind: "hover", anchor: { point: { x: 5, y: 6, displayId: "D1" } }, dwellMs: 1200 },
        { kind: "scroll", anchor: { point: { x: 5, y: 6, displayId: "D1" } }, delta: { x: 0, y: -450 }, steps: 6 },
        {
          kind: "drag",
          from: { point: { x: 0, y: 0, displayId: "D1" } },
          to: { point: { x: 100, y: 0, displayId: "D1" } },
          path: {
            curve: [{ c1: { x: 0.33, y: -0.2 }, c2: { x: 0.66, y: -0.2 }, end: { x: 1, y: 0 } }],
            durationMs: 840,
            velocity: [0, 0.5, 1],
            fitConfidence: 0.87,
          },
          button: 1,
        },
        {
          kind: "wait",
          until: { kind: "ax_exists", args: { role: "AXSheet" }, reach: "achievable" },
          timeoutMs: 3000,
        },
      ],
      provenance: "recorded",
      observations: 2,
      outcomes: { attempts: 5, successes: 4 },
      liftWarnings: ["a warning with \"quotes\""],
    },
  ],
  slots: [{ name: "recipient", samples: ["alice@example.com", "bob@example.com"], secret: false }],
};

describe("printGraph / parseGraph", () => {
  it("round-trips a graph exercising every action kind", () => {
    expect(parseGraph(printGraph(graph))).toEqual(graph);
  });

  it("round-trips twice to the identical text — printing is canonical", () => {
    const once = printGraph(graph);
    expect(printGraph(parseGraph(once))).toBe(once);
  });

  it("marks assertable predicates with a leading bang", () => {
    const text = printGraph(graph);
    expect(text).toMatch(/^\s*! display /m);
    expect(text).toMatch(/^\s*app app="Mail"/m);
  });

  it("round-trips an empty graph", () => {
    const empty: Graph = { id: "g", entry: "", nodes: [], edges: [], slots: [] };
    expect(parseGraph(printGraph(empty))).toEqual(empty);
  });

  it("throws on malformed input rather than returning a partial graph", () => {
    expect(() => parseGraph("this is not a graph")).toThrow();
    expect(() => parseGraph("graph g entry=n0\n\nedge e0 n0 -> ")).toThrow();
  });
});

describe("parseInterventionResponse", () => {
  const req: InterventionRequest = {
    goal: "send the message",
    atNode: [{ kind: "app", args: { app: "Mail" }, reach: "achievable" }],
    observed: [{ kind: "app", args: { app: "Mail" }, reach: "achievable" }],
    options: [
      { edgeId: "e0", summary: "click Send" },
      { edgeId: "e1", summary: "save a draft" },
    ],
    slots: [{ name: "recipient", samples: ["alice@example.com"] }],
    allow: "select",
  };

  it("accepts a valid choice with slot bindings", () => {
    const r = parseInterventionResponse('choose e0\nbind recipient="carol@example.com"', req);
    expect(r).toEqual({ choose: "e0", bind: { recipient: "carol@example.com" } });
  });

  it("accepts a bare abort with its reason", () => {
    expect(parseInterventionResponse("abort the window is not open", req)).toEqual({
      abort: "the window is not open",
    });
  });

  it("REJECTS an unknown edge id", () => {
    const r = parseInterventionResponse("choose e_does_not_exist", req);
    expect(r.choose).toBeUndefined();
    expect(r.abort).toMatch(/unknown edge/i);
  });

  it("REJECTS an undeclared slot", () => {
    const r = parseInterventionResponse('choose e0\nbind nickname="x"', req);
    expect(r.choose).toBeUndefined();
    expect(r.abort).toMatch(/undeclared slot/i);
  });

  it("REJECTS synthesis when the request only allowed select — no self-widening", () => {
    const r = parseInterventionResponse('synthesize\n  chord cmd+s', req);
    expect(r.synthesize).toBeUndefined();
    expect(r.abort).toMatch(/not permitted/i);
  });

  it("accepts synthesis when the request allowed it", () => {
    const r = parseInterventionResponse("synthesize\n  chord cmd+s", { ...req, allow: "synthesize" });
    expect(r.synthesize).toEqual([{ kind: "chord", keys: ["cmd", "s"] }]);
    expect(r.abort).toBeUndefined();
  });

  it("REJECTS unparseable text", () => {
    for (const bad of ["", "  ", "yes please", "{\"choose\":\"e0\"}", "choose"]) {
      expect(parseInterventionResponse(bad, req).abort, bad).toBeTruthy();
    }
  });

  it("never returns both a choice and an abort", () => {
    const r = parseInterventionResponse("choose e_nope", req);
    expect(r.choose === undefined || r.abort === undefined).toBe(true);
  });
});

describe("printInterventionRequest", () => {
  it("shows expectation and reality as a diff the model can read", () => {
    const text = printInterventionRequest({
      goal: "send",
      atNode: [{ kind: "app", args: { app: "Mail" }, reach: "achievable" }],
      observed: [{ kind: "app", args: { app: "Safari" }, reach: "achievable" }],
      options: [{ edgeId: "e0", summary: "click Send" }],
      slots: [],
      allow: "select",
    });
    expect(text).toMatch(/goal: send/);
    expect(text).toMatch(/expected/i);
    expect(text).toMatch(/observed/i);
    expect(text).toMatch(/e0/);
    expect(text).toMatch(/allow: select/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.language.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Write `src/trace/language.ts` implementing the format above. Structure it as four exported functions over two private helpers — a quoted-string writer and a key/value line tokenizer:

```ts
// src/trace/language.ts
/**
 * The language: a Graph's text projection.
 *
 * The persisted form is typed SQLite rows; this is the exchange form. Keeping
 * them separate means the AI never sees ids and foreign keys, and a malformed
 * response fails at the parser rather than halfway through a database write.
 *
 * `parseGraph(printGraph(g))` deep-equals `g` — the round trip is the contract,
 * and anything the text cannot represent losslessly is serialized explicitly
 * rather than dropped.
 *
 * Validation here is a security boundary, not a convenience: a response naming
 * an unknown edge, an undeclared slot, or synthesizing under `allow: "select"`
 * becomes an abort. A model must not widen its own permissions by malforming a
 * reply.
 */
```

Implementation requirements, each covered by a test above:

1. **`quote(s: string): string`** — JSON-style with escaped quotes and backslashes. `unquote` is its inverse. The `type` action test carries `a "quoted" value` specifically to catch a naive implementation.
2. **`printGraph`** — emit `graph <id> entry=<entry>`, a blank line, then each node, edge, and slot block. Predicates print as `<kind> k="v" k=n`, prefixed `! ` when `reach === "assertable"` (so reach is not stored twice and cannot disagree with `REACH_BY_KIND`). Nodes print `visual=<blobId>/<phash>` only when present.
3. **Action lines** — one per action, keyed by `kind`:
   - `click ax="<path>" label="<label>" point=<x>,<y>@<display> win=<wx>,<wy> region=<id>/<phash>/<x>,<y>,<w>,<h> button=<n> count=<n>` — omit any segment whose layer is absent.
   - `type $<slot> <quoted>`
   - `chord <k1>+<k2>`
   - `hover <anchor…> dwell=<ms>`
   - `scroll <anchor…> delta=<dx>,<dy> steps=<n>`
   - `drag from=<anchor…> to=<anchor…> path=<c1x>,<c1y>,<c2x>,<c2y>,<ex>,<ey> dur=<ms> vel=<n,n,…> fit=<n> button=<n>`
   - `wait <kind> k="v" timeout=<ms>`
4. **`parseGraph`** — line-oriented; blank lines separate blocks, two-space indent marks a block member. Throw an `Error` with the offending line number on anything unrecognized. Never return a partially built graph.
5. **`printInterventionRequest`** — a compact block with `goal:`, an `expected:` list, an `observed:` list, an `options:` list of `<edgeId> — <summary>`, a `slots:` list, and `allow: <mode>`.
6. **`parseInterventionResponse`** — accept `choose <edgeId>`, `bind <name>=<quoted>` (repeatable), `synthesize` followed by indented action lines, and `abort <reason>`. Validate in this order, returning `{ abort }` on the first failure: unparseable → unknown edge id → undeclared slot → synthesis not permitted. On success return only the fields present. **Never** return `choose` alongside `abort`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/trace.language.test.ts && npm run typecheck`
Expected: PASS. The round-trip test is the one that matters — if it fails, the missing information is almost always a `Path`'s `velocity` array or an anchor layer that printed but did not re-parse.

- [ ] **Step 5: Commit**

```bash
git add src/trace/language.ts test/trace.language.test.ts
git commit -m "feat(trace): the text projection and intervention parser

parse(print(g)) is the contract. Response validation is a security
boundary: unknown edge, undeclared slot, or synthesis under allow=select
all become aborts, so a model cannot widen its own permissions by
malforming a reply."
```

---

## Task 10: SQLite persistence

**Files:**
- Modify: `src/store/sqlite/schema.ts` (append four tables)
- Modify: `src/store/store.ts` (four methods)
- Modify: `src/store/types.ts` (add the four method signatures to the store interface)
- Test: `test/trace.store.test.ts`

**Interfaces:**
- Consumes: `Graph` from `../trace/types.js`.
- Produces, on `DualStore`:
  - `putGraph(graph: Graph): Promise<void>` — upsert, one transaction
  - `getGraph(id: string): Graph | undefined`
  - `listGraphs(): { id: string; nodes: number; edges: number; createdAt: number }[]`
  - `deleteGraph(id: string): Promise<void>`

**Why this task exists.** The spec commits to SQLite-only persistence but its module table covers only `src/trace/`, which is pure and cannot own a database. Persistence belongs in `store/`, which already owns every schema. Note the direction: `store/` imports the `Graph` *type* from `trace/`; `trace/` still imports nothing from `store/`.

**Why no Lance.** Visual corroboration reuses existing region/frame vectors by id, so the graph registers no vector space. There is no vector write here, therefore no SQLite-then-Lance ordering hazard and no `Mutex` requirement beyond the existing write serialization. Assert this explicitly in a test.

**Schema** (append to `SCHEMA_SQL`; the file uses `CREATE TABLE IF NOT EXISTS` applied on open, so this is additive and needs no migration):

```sql
CREATE TABLE IF NOT EXISTS trace_graph (
  id          TEXT PRIMARY KEY,
  entry_node  TEXT NOT NULL,
  created_at  INTEGER NOT NULL           -- wall-clock ms, DISPLAY ONLY
);

CREATE TABLE IF NOT EXISTS trace_node (
  id            TEXT PRIMARY KEY,
  graph_id      TEXT NOT NULL REFERENCES trace_graph(id) ON DELETE CASCADE,
  predicates    TEXT NOT NULL,           -- JSON Predicate[]
  visual        TEXT,                    -- JSON {frameBlobId, phash}
  intervene     TEXT NOT NULL,
  observations  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_node_graph ON trace_node(graph_id);

CREATE TABLE IF NOT EXISTS trace_edge (
  id            TEXT PRIMARY KEY,
  graph_id      TEXT NOT NULL REFERENCES trace_graph(id) ON DELETE CASCADE,
  from_node     TEXT NOT NULL,
  to_node       TEXT NOT NULL,
  actions       TEXT NOT NULL,           -- JSON Action[]
  guard         TEXT,                    -- JSON Predicate[]
  provenance    TEXT NOT NULL,
  observations  INTEGER NOT NULL,
  attempts      INTEGER NOT NULL,
  successes     INTEGER NOT NULL,
  lift_warnings TEXT                     -- JSON string[]
);
CREATE INDEX IF NOT EXISTS idx_trace_edge_graph ON trace_edge(graph_id, from_node);

CREATE TABLE IF NOT EXISTS trace_slot (
  graph_id  TEXT NOT NULL REFERENCES trace_graph(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  samples   TEXT NOT NULL,               -- JSON string[]
  PRIMARY KEY (graph_id, name)
);
```

- [ ] **Step 1: Write the failing test**

```ts
// test/trace.store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";
import type { Graph } from "../src/trace/types.js";

let dir: string;
let store: DualStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "deskrag-trace-"));
  store = await DualStore.open(dir);
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const graph = (id: string): Graph => ({
  id,
  entry: "n0",
  nodes: [
    {
      id: "n0",
      predicates: [{ kind: "app", args: { app: "Mail" }, reach: "achievable" }],
      visual: { frameBlobId: "b_1", phash: "0f1e" },
      intervene: "select",
      observations: 3,
    },
    { id: "n1", predicates: [], intervene: "none", observations: 1 },
  ],
  edges: [
    {
      id: "e0",
      from: "n0",
      to: "n1",
      actions: [{ kind: "chord", keys: ["cmd", "s"] }],
      guard: [{ kind: "window", args: { title: "New Message" }, reach: "achievable" }],
      provenance: "recorded",
      observations: 2,
      outcomes: { attempts: 5, successes: 4 },
      liftWarnings: ["one warning"],
    },
  ],
  slots: [{ name: "recipient", samples: ["a@b.com", "c@d.com"], secret: false }],
});

describe("graph persistence", () => {
  it("round-trips a graph", async () => {
    await store.putGraph(graph("g1"));
    expect(store.getGraph("g1")).toEqual(graph("g1"));
  });

  it("returns undefined for an unknown id", () => {
    expect(store.getGraph("nope")).toBeUndefined();
  });

  it("upserts — writing twice does not duplicate nodes or edges", async () => {
    await store.putGraph(graph("g1"));
    const grown = graph("g1");
    grown.nodes[0]!.observations = 9;
    await store.putGraph(grown);
    const read = store.getGraph("g1")!;
    expect(read.nodes).toHaveLength(2);
    expect(read.edges).toHaveLength(1);
    expect(read.nodes[0]!.observations).toBe(9);
  });

  it("drops nodes that a later write removed", async () => {
    await store.putGraph(graph("g1"));
    const shrunk: Graph = { ...graph("g1"), nodes: [graph("g1").nodes[0]!], edges: [] };
    await store.putGraph(shrunk);
    expect(store.getGraph("g1")!.nodes).toHaveLength(1);
    expect(store.getGraph("g1")!.edges).toHaveLength(0);
  });

  it("lists graphs with their counts", async () => {
    await store.putGraph(graph("g1"));
    await store.putGraph(graph("g2"));
    const list = store.listGraphs();
    expect(list.map((g) => g.id).sort()).toEqual(["g1", "g2"]);
    expect(list.find((g) => g.id === "g1")).toMatchObject({ nodes: 2, edges: 1 });
  });

  it("deletes a graph and everything under it", async () => {
    await store.putGraph(graph("g1"));
    await store.deleteGraph("g1");
    expect(store.getGraph("g1")).toBeUndefined();
    expect(store.listGraphs()).toHaveLength(0);
  });

  it("registers NO vector space — the graph reuses existing vectors by id", async () => {
    const before = await store.listVectorSpaces();
    await store.putGraph(graph("g1"));
    expect(await store.listVectorSpaces()).toEqual(before);
  });

  it("preserves an absent optional rather than materializing null", async () => {
    const bare: Graph = {
      id: "g3",
      entry: "n0",
      nodes: [{ id: "n0", predicates: [], intervene: "select", observations: 1 }],
      edges: [],
      slots: [],
    };
    await store.putGraph(bare);
    const read = store.getGraph("g3")!;
    expect(read.nodes[0]!.visual).toBeUndefined();
    expect("visual" in read.nodes[0]!).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.store.test.ts`
Expected: FAIL — `store.putGraph is not a function`.

If `DualStore.open` takes different arguments than shown, read `test/dual-store.crash.test.ts` and match its setup exactly rather than guessing.

- [ ] **Step 3: Write the implementation**

Append the four tables to `SCHEMA_SQL`, add the four signatures to the store interface in `src/store/types.ts`, and implement on `DualStore`:

- `putGraph` runs inside a single `better-sqlite3` transaction: upsert the `trace_graph` row, `DELETE FROM trace_node WHERE graph_id = ?` (likewise `trace_edge`, `trace_slot`), then insert the current rows. Delete-then-insert is what makes the shrink test pass and keeps the write idempotent.
- `getGraph` is a plain read; `JSON.parse` the blob columns and **omit** absent optionals rather than setting them to `undefined` (the last test checks `"visual" in node`). Build the object conditionally with spreads, as `buildAnchor` does.
- `listGraphs` uses `LEFT JOIN` counts.
- `deleteGraph` deletes the `trace_graph` row; the `ON DELETE CASCADE` clears the rest. Confirm `PRAGMA foreign_keys = ON` is set where the connection is opened (`src/store/sqlite/db.ts`); if it is not, delete the child rows explicitly in the same transaction.
- No Lance calls anywhere in this task.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/trace.store.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/sqlite/schema.ts src/store/store.ts src/store/types.ts test/trace.store.test.ts
git commit -m "feat(store): persist trace graphs, SQLite only

Four additive tables. No vector space is registered - visual corroboration
reuses existing region/frame vectors by id - so there is no SQLite-to-Lance
ordering hazard here. putGraph is delete-then-insert inside one
transaction, so it is idempotent and a shrink actually shrinks."
```

---

## Task 11: Barrel export and documentation

**Files:**
- Modify: `src/index.ts` (append a `trace/` section)
- Modify: `CLAUDE.md` (a short subsection under the pipeline description)
- Test: `test/trace.barrel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/trace.barrel.test.ts
import { describe, expect, it } from "vitest";
import * as deskrag from "../src/index.js";

describe("trace barrel exports", () => {
  it("exports the pure trace surface", () => {
    for (const name of [
      "liftTrace",
      "mergeTrace",
      "printGraph",
      "parseGraph",
      "parseInterventionResponse",
      "matchNode",
      "extractPredicates",
      "buildAnchor",
      "fitPath",
      "projectPath",
      "groupGestures",
      "REACH_BY_KIND",
    ]) {
      expect(deskrag, name).toHaveProperty(name);
    }
  });

  it("importing the barrel loads no native module", async () => {
    // trace/ is pure TS; if it ever pulls in a native adapter this fails loudly.
    const before = Object.keys(process.binding === undefined ? {} : {});
    expect(before).toEqual([]);
    expect(typeof deskrag.liftTrace).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.barrel.test.ts`
Expected: FAIL — the properties are missing.

- [ ] **Step 3: Append the barrel section**

```ts
/**
 * trace/ — the experience trace IR. A recorded session lifts into a linear
 * `Trace`; merging traces at equivalent states accretes a `Graph` whose nodes are
 * verified states and whose edges are action sequences. Variation therefore comes
 * from recording a task more than once, not from a model inventing alternatives.
 *
 * Pure TypeScript — no native modules, no subprocesses — which is why, unlike the
 * executor, it belongs in this barrel. Everything it needs from the store arrives
 * through injected callbacks (`VisualMatcher`, `LiftInput.axAt`).
 */
export * from "./trace/types.js";
export { fitPath, projectPath, VELOCITY_SAMPLES, type PathSample } from "./trace/paths.js";
export {
  extractPredicates,
  predicateKey,
  samePredicateSet,
  isVolatileLabel,
  DEFAULT_MAX_AX_PREDICATES,
  type PredicateContext,
} from "./trace/predicates.js";
export { buildAnchor, axPathOf, hitTest, anchorKey, type AnchorInput } from "./trace/anchors.js";
export {
  matchNode,
  DEFAULT_VISUAL_THRESHOLD,
  DEFAULT_VISUAL_MARGIN,
  type MatchOptions,
  type MatchResult,
} from "./trace/identity.js";
export {
  groupGestures,
  DEFAULT_GESTURE_OPTIONS,
  type Gesture,
  type GestureOptions,
} from "./trace/gestures.js";
export { liftTrace, slotNameFor, type LiftInput, type AxSnapshot } from "./trace/lift.js";
export { mergeTrace, edgeSignature, actionSignature, discoveredVariables } from "./trace/merge.js";
export {
  printGraph,
  parseGraph,
  printInterventionRequest,
  parseInterventionResponse,
} from "./trace/language.js";
```

- [ ] **Step 4: Add the CLAUDE.md subsection**

Under the pipeline section, after the retrieve description:

```markdown
### 3. Trace IR (`src/trace/`) — recorded behavior as a manipulable graph

A `Trace` is one recorded session lifted into a linear chain; a `Graph` accretes
from merging traces at equivalent states. Nodes are verified states (a predicate
set extracted from the AX tree, filtered to stable attributes), edges are action
sequences. **Variation comes from recording a task twice, not from a model
inventing it** — two recordings differing only in typed text merge into one edge
with two slot samples, which is how slots are discovered rather than declared.

- **Targets are layered anchors** (`ax → visual → point`), recorded independently
  at lift time and **never derived from one another** at replay time.
- **Paths are normalized to a unit box between their endpoints**, so retargeting
  is the same projection as verbatim replay — one code path, not two.
- **Predicates are tagged `achievable` or `assertable`.** Achievable ones have a
  repair path (pathfind to a node where they hold), assertable ones can only gate.
  Setup is therefore not a separate phase: it is the graph, and mid-replay
  recovery uses the same mechanism.
- **Identity is predicate-primary; ambiguity declines to merge.** A redundant node
  is visible and fixable; a wrong merge is silent corruption.
- **`trace/` is a leaf** — pure TS, in the barrel, and it never imports
  `store/`, `represent/` or `retrieve/`. External data arrives via injected
  callbacks and the minimal local `TraceEvent`/`AnchorRegion` shapes (the same
  pattern `segment/types.ts` uses for `SegEvent`). Graph *persistence* lives in
  `store/` (the `trace_*` tables), which imports the `Graph` type — one
  direction only.
- **Key events without a resolved `char` emit no text gesture, by design.**
  Layout-resolved characters are a capture requirement not yet implemented; a
  keycode table would fabricate typed content and hide the gap.
```

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run typecheck && npm test
git add src/index.ts CLAUDE.md test/trace.barrel.test.ts
git commit -m "feat(trace): export the trace IR from the barrel

trace/ is pure TypeScript, so unlike the executor it is barrel-safe.
Documents the seam in CLAUDE.md: leaf module, injected callbacks, and
persistence living in store/ in one direction only."
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: architecture and dependency rules → Tasks 1 and 11; anchors → Task 4; paths → Task 2; predicates and the achievable/assertable tag → Task 3; nodes, edges, slots, graph/trace → Task 1; lifting → Task 7 (with gesture grouping split into Task 6); merging and slot discovery → Task 8; node identity → Task 5; the language and the AI contract → Tasks 1 and 9; failure handling → distributed across the tasks that produce each condition, with the ambiguity bias tested in Tasks 5 and 8 and lift warnings in Tasks 6 and 7; testing strategy → each task's test file, matching the spec's named files.

**One spec requirement had no home and now has a task:** graph persistence. The spec commits to SQLite-only storage but its module table lists only `src/trace/`, which is pure and cannot own a database. Task 10 puts it in `store/`, preserving the one-directional dependency.

**One spec test file is deliberately absent.** The spec named `lift.test.ts` as "driven by the existing `SyntheticInputProducer`." Task 7 tests `liftTrace` against plain event arrays instead. `SyntheticInputProducer` emits through a `CaptureContext`, which requires a live `CaptureSession` and store — real integration machinery that would make the highest-value unit test slow and coupled to the store. The gesture and lift rules are pure functions over events, and testing them directly covers strictly more cases. A `SyntheticInputProducer`-driven end-to-end test belongs with the executor spec, where an actual round trip is the thing under test.

**Known-degraded behavior is load-bearing, not an oversight.** `groupGestures` emitting no text without `data.char` is asserted by a test. It stays failing-visibly until capture requirement #2 lands.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-30-experience-trace-ir.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
