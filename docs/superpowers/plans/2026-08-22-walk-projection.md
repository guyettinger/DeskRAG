# Walk Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure projection that reads a habit's own recorded walks and reports how consistently, how quickly, after what, and how often the work was actually done — as counts and named facts, never a score.

**Architecture:** Two new pure modules in `app/src/main/`. `walk-align.ts` is DTO-free and does one thing: a monotone forward scan comparing two edge-id sequences, plus a post-pass that collapses a skip/insert pair on the same edge into one `reordered`. `walk-analysis.ts` takes `FlowsDTO` + `FlowRouteDTO` exactly as `flow-steps.ts` does, chooses a baseline Way under one of three rules, and assembles the whole `WalkAnalysis`. A headless read-only probe (`scripts/baseline-probe.ts`) measures the three rules against the real library and picks the shipped default. Nothing renders, nothing writes, nothing merges.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Vitest (root suite), `tsx` for the probe, `better-sqlite3` in `readonly` mode.

**Spec:** `docs/superpowers/specs/2026-08-22-walk-projection-design.md`

## Global Constraints

Every task's requirements implicitly include all of these. They are copied from the spec and from `CLAUDE.md`; violating one is a rejected task, not a nit.

- **No score of any kind.** No fitness float, no strength percentage, no confidence, no normalised ratio. Counts and named facts only. `FrameResult.score` is an ordering and not a confidence, and this repo's UI and MCP tool deliberately show rank and evidence rather than a number.
- **No merge.** `droppedEarly` is a disclosure in the shape of `duplicates`. Nothing in this plan changes `frequentRoutes`, `route-cluster.ts`, `bindHabit`, `route.count`, or any stored `routeKey`.
- **No DTO widening.** `app/src/shared/types.ts` is not modified by any task in this plan.
- **Pure modules.** No `import` of `electron`, no store access, no model call, no `fetch`, no filesystem, in either new module. The probe is the only file that touches a database.
- **Both modules are `.ts` under `app/src/main/`.** That is what makes them reachable from the ROOT suite (`test/`), like `graph-view.ts`, `flow-steps.ts`, `session-tracks.ts` and `route-cluster.ts`. A `.tsx` would not be — the root `tsconfig.json` sets no `jsx`.
- **NodeNext imports:** every relative import ends in `.js`, even from a `.ts` file. Example: `import { alignWalk } from "./walk-align.js";`
- **`verbatimModuleSyntax` is on:** type-only imports must be written `import type { ... }`.
- **`noUncheckedIndexedAccess` is on:** `arr[i]` has type `T | undefined`. Use `arr[i]!` only where an adjacent bound check makes it provably safe, and prefer restructuring over asserting.
- **`exactOptionalPropertyTypes` is on:** `{ a?: number }` does not accept `{ a: undefined }`. Build optional properties with a spread: `...(x !== undefined ? { a: x } : {})`.
- **Sorting is stable and explicitly tie-broken.** Never leave an order to `Map` iteration where a reader will see it.
- **Comments carry the reason, not the restatement.** This repo's modules explain *why* a rule exists and what measurement produced it. A comment that says what the next line does is noise; a comment naming the failure the line prevents is the house style. Read the top of `flow-steps.ts` and `route-cluster.ts` before writing either file's header.
- **Gate after every task:** `npm run typecheck && npm test` must both pass before the commit step. `npm test` is ~6s.

---

### Task 1: The alignment core (`walk-align.ts`)

DTO-free. Two edge-id sequences in, a named deviation list out. This is the only file in the plan that could ever be reused by something that is not the app.

**Files:**
- Create: `app/src/main/walk-align.ts`
- Test: `test/walk-align.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `type DeviationKind = "skipped" | "inserted" | "reordered"`
  - `interface EdgeDeviation { kind: DeviationKind; stepIndex: number; edgeId: string }`
  - `interface Alignment { deviations: EdgeDeviation[]; reachedEnd: boolean }`
  - `function alignWalk(baseline: readonly string[], walk: readonly string[]): Alignment`

- [ ] **Step 1: Write the failing test**

Create `test/walk-align.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { alignWalk } from "../app/src/main/walk-align.js";

/**
 * The scan is order-preserving by construction, which is why `reordered` cannot
 * come out of it directly — a swapped pair emerges as one skip plus one insert,
 * and the fact that it is the SAME edge moved is only recoverable afterwards.
 * That post-pass is the interesting half of this file and most of these cases
 * exist to pin it.
 */
describe("alignWalk", () => {
  it("reports nothing when the walk is the baseline", () => {
    const out = alignWalk(["a", "b", "c"], ["a", "b", "c"]);
    expect(out.deviations).toEqual([]);
    expect(out.reachedEnd).toBe(true);
  });

  it("reports a baseline edge the walk never took as skipped, at its baseline index", () => {
    const out = alignWalk(["a", "b", "c"], ["a", "c"]);
    expect(out.deviations).toEqual([{ kind: "skipped", stepIndex: 1, edgeId: "b" }]);
    expect(out.reachedEnd).toBe(true);
  });

  it("reports an edge the baseline does not contain as inserted", () => {
    const out = alignWalk(["a", "b"], ["a", "x", "b"]);
    expect(out.deviations).toEqual([{ kind: "inserted", stepIndex: 1, edgeId: "x" }]);
    expect(out.reachedEnd).toBe(true);
  });

  it("collapses a swapped pair into ONE reordered, not a skip plus an insert", () => {
    const out = alignWalk(["a", "b", "c", "d"], ["a", "c", "b", "d"]);
    // Two deviations would overstate the divergence: doing b and c the other
    // way round is ONE difference. The surviving entry carries the BASELINE
    // index of the edge the scan saw move — here `c`, which the walk performed
    // early and the baseline expects at index 2.
    expect(out.deviations).toEqual([{ kind: "reordered", stepIndex: 2, edgeId: "c" }]);
    expect(out.reachedEnd).toBe(true);
  });

  it("reports a substitution as a skip AND an insert at the same index", () => {
    // Neither edge can ever match, so both cursors advance together. Advancing
    // only the baseline would drag the mismatch down the rest of the sequence
    // and manufacture a `reordered` out of an edge that never moved.
    const out = alignWalk(["a", "b", "c"], ["a", "x", "c"]);
    expect(out.deviations).toEqual([
      { kind: "skipped", stepIndex: 1, edgeId: "b" },
      { kind: "inserted", stepIndex: 1, edgeId: "x" },
    ]);
    expect(out.reachedEnd).toBe(true);
  });

  it("does not call an edge reordered when only one side has it", () => {
    const out = alignWalk(["a", "b"], ["a", "x"]);
    expect(out.deviations).toEqual([
      { kind: "skipped", stepIndex: 1, edgeId: "b" },
      { kind: "inserted", stepIndex: 1, edgeId: "x" },
    ]);
    expect(out.reachedEnd).toBe(false);
  });

  it("reports reachedEnd false when the walk stops before the baseline's last edge", () => {
    const out = alignWalk(["a", "b", "c"], ["a", "b"]);
    expect(out.deviations).toEqual([{ kind: "skipped", stepIndex: 2, edgeId: "c" }]);
    expect(out.reachedEnd).toBe(false);
  });

  it("attributes trailing extra edges to one past the baseline's end", () => {
    const out = alignWalk(["a", "b"], ["a", "b", "z"]);
    expect(out.deviations).toEqual([{ kind: "inserted", stepIndex: 2, edgeId: "z" }]);
    expect(out.reachedEnd).toBe(true);
  });

  it("treats an empty baseline as vacuously reached, and every walk edge as inserted", () => {
    const out = alignWalk([], ["a"]);
    expect(out.deviations).toEqual([{ kind: "inserted", stepIndex: 0, edgeId: "a" }]);
    expect(out.reachedEnd).toBe(true);
  });

  it("handles a repeated edge — a loop — without pairing the two occurrences", () => {
    // A session can walk one edge more than once; `frequentRoutes` orders a
    // walk by the recorded moment precisely because of it. The scan must not
    // match the walk's second `a` against the baseline's first.
    const out = alignWalk(["a", "b", "a"], ["a", "b"]);
    expect(out.deviations).toEqual([{ kind: "skipped", stepIndex: 2, edgeId: "a" }]);
    expect(out.reachedEnd).toBe(false);
  });

  it("returns deviations in baseline order", () => {
    const out = alignWalk(["a", "b", "c", "d"], ["a", "d"]);
    expect(out.deviations.map((d) => d.stepIndex)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/walk-align.test.ts`
Expected: FAIL — `Failed to resolve import "../app/src/main/walk-align.js"`.

- [ ] **Step 3: Write the implementation**

Create `app/src/main/walk-align.ts`:

```ts
/**
 * How one recording's walk differed from the standard, as named facts.
 *
 * DTO-free on purpose. `route-cluster.ts` is split from `graph-view.ts` for the
 * same reason and states it: a core that speaks only in sequences is what lets
 * the app and a probe read ONE implementation. Two readers of one tree is the
 * `ax-dump`/`ax-exec` drift hazard by name — two binaries reading one AX tree
 * disagreed on exactly one of 48 elements, and that single label was enough to
 * stop any node from verifying at replay.
 *
 * There is NO score here and there will not be one. `FrameResult.score` is an
 * ordering rather than a confidence, and the UI and the MCP tool show rank and
 * evidence instead of the number; an edit-distance ratio would be exactly the
 * figure this repo refuses to print. What comes out is a list a person can
 * check against a screen, which is the same standard `route-cluster.ts` holds
 * when it ships `insertions` as a COUNT: "the same walk, but one of them also
 * passed through Finder" is checkable and "cosine 0.83" is not.
 */

export type DeviationKind = "skipped" | "inserted" | "reordered";

/** A difference, located at an index into the BASELINE. No label: see below. */
export interface EdgeDeviation {
  kind: DeviationKind;
  stepIndex: number;
  edgeId: string;
}

export interface Alignment {
  deviations: EdgeDeviation[];
  /** Whether the walk consumed the baseline's final edge. Vacuously true when the baseline is empty. */
  reachedEnd: boolean;
}

/**
 * A monotone forward scan, then a post-pass.
 *
 * The scan is the shape `scripts/transfer-probe.ts` already uses to verify a
 * route's states against a held-out recording's own AX moments. It is
 * order-preserving by construction, which is exactly why `reordered` cannot
 * fall out of it: a swapped pair emerges as one `skipped` plus one `inserted`,
 * and that the same edge merely MOVED is only visible once both lists exist.
 *
 * Lookahead breaks the tie when neither cursor matches. Whichever side finds
 * its counterpart sooner is the side that advances, so a single insertion in a
 * long walk costs one deviation rather than realigning everything after it.
 * `indexOf` from the live cursor, never from 0 — a session can walk one edge
 * more than once (`frequentRoutes` orders a walk by the recorded moment
 * precisely because of that), and searching from the start would pair a walk's
 * second visit with the baseline's first.
 */
export function alignWalk(baseline: readonly string[], walk: readonly string[]): Alignment {
  const skipped: EdgeDeviation[] = [];
  const inserted: EdgeDeviation[] = [];
  const matched = new Array<boolean>(baseline.length).fill(false);

  let b = 0;
  let w = 0;
  while (b < baseline.length && w < walk.length) {
    const wantEdge = baseline[b]!;
    const gotEdge = walk[w]!;
    if (wantEdge === gotEdge) {
      matched[b] = true;
      b += 1;
      w += 1;
      continue;
    }
    const wantLaterInWalk = walk.indexOf(wantEdge, w + 1);
    const gotLaterInBaseline = baseline.indexOf(gotEdge, b + 1);

    if (wantLaterInWalk === -1 && gotLaterInBaseline === -1) {
      // A SUBSTITUTION: neither edge can ever match, so advancing only one
      // cursor drags the mismatch along the rest of the sequence. Measured on
      // paper before it was written: advancing the baseline alone turned
      // `[a,b,c]` against `[a,x,c]` into "c skipped AND c inserted", which the
      // post-pass then collapsed into a `reordered` c that never moved. Both
      // cursors advance, and both deviations take index `b` — the position a
      // reader is looking at.
      skipped.push({ kind: "skipped", stepIndex: b, edgeId: wantEdge });
      inserted.push({ kind: "inserted", stepIndex: b, edgeId: gotEdge });
      b += 1;
      w += 1;
    } else if (wantLaterInWalk === -1) {
      skipped.push({ kind: "skipped", stepIndex: b, edgeId: wantEdge });
      b += 1;
    } else if (gotLaterInBaseline === -1) {
      inserted.push({ kind: "inserted", stepIndex: b, edgeId: gotEdge });
      w += 1;
    } else if (wantLaterInWalk - w <= gotLaterInBaseline - b) {
      // Both reappear. Whichever finds its counterpart sooner is the side that
      // advances, so one insertion in a long walk costs one deviation rather
      // than realigning everything after it.
      inserted.push({ kind: "inserted", stepIndex: b, edgeId: gotEdge });
      w += 1;
    } else {
      skipped.push({ kind: "skipped", stepIndex: b, edgeId: wantEdge });
      b += 1;
    }
  }
  while (b < baseline.length) {
    skipped.push({ kind: "skipped", stepIndex: b, edgeId: baseline[b]! });
    b += 1;
  }
  while (w < walk.length) {
    // Past the end there is no baseline index to point at, so they attribute to
    // one PAST the last step rather than to it — a trailing extra is not a
    // property of the final step.
    inserted.push({ kind: "inserted", stepIndex: baseline.length, edgeId: walk[w]! });
    w += 1;
  }

  const deviations = collapseReordered(skipped, inserted);
  deviations.sort((x, y) => x.stepIndex - y.stepIndex || x.edgeId.localeCompare(y.edgeId));

  return {
    deviations,
    reachedEnd: baseline.length === 0 || matched[baseline.length - 1] === true,
  };
}

/**
 * An edge in BOTH lists was moved, not dropped and separately added.
 *
 * Collapsing is the honest count: doing steps 3 and 4 the other way round is
 * ONE difference, and reporting it as two overstates the divergence in the same
 * way `cautionsFor` guards against when it counts distinct EDGES rather than
 * flattened variant steps — that miscount inflated a denominator to 54 against
 * a graph holding 53.
 *
 * It keeps the BASELINE index, because that is the position a reader is looking
 * at when they ask what moved.
 */
function collapseReordered(
  skipped: readonly EdgeDeviation[],
  inserted: readonly EdgeDeviation[],
): EdgeDeviation[] {
  const insertedEdges = new Set(inserted.map((d) => d.edgeId));
  const movedEdges = new Set(skipped.filter((d) => insertedEdges.has(d.edgeId)).map((d) => d.edgeId));
  if (movedEdges.size === 0) return [...skipped, ...inserted];

  const out: EdgeDeviation[] = [];
  for (const d of skipped) {
    out.push(movedEdges.has(d.edgeId) ? { ...d, kind: "reordered" } : d);
  }
  for (const d of inserted) {
    if (!movedEdges.has(d.edgeId)) out.push(d);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/walk-align.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/walk-align.ts test/walk-align.test.ts
git commit -m "feat(habits): how one walk differed from the standard, as named facts

A monotone forward scan over two edge sequences, then a post-pass that
collapses a skip and an insert on the same edge into one reordered --
the scan is order-preserving by construction so it cannot see a move,
and reporting a swap as two differences overstates the divergence.

DTO-free, like route-cluster.ts and for its reason: one implementation
readable by both the app and a probe. No ratio, no distance, no score.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The module skeleton and baseline selection

`walk-analysis.ts` comes into existence returning a real `baseline` and empty everything else. That makes the shape end-to-end from the first commit, and each later task fills one field.

**Files:**
- Create: `app/src/main/walk-analysis.ts`
- Test: `test/walk-analysis.test.ts`

**Interfaces:**
- Consumes: `alignWalk` and `type EdgeDeviation` from `./walk-align.js` (Task 1) — those two only. `flowWalks` and `FlowWalk` from `./flow-steps.js` (existing). `FlowsDTO`, `FlowRouteDTO` from `@shared/types` (existing).
- Produces:
  - `type BaselineRule = "majority" | "recent" | "none"`
  - `interface Baseline { rule: BaselineRule; wayIndex: number | null; reason: string }`
  - `interface Deviation extends EdgeDeviation { label: string }`
  - `interface WalkFit { sessionId: string; at: number | null; reachedEnd: boolean; deviations: Deviation[] }`
  - `interface StepCost { stepIndex: number; edgeId: string; durations: { sessionId: string; ms: number }[]; gapsAfter: { sessionId: string; ms: number }[] }`
  - `interface Antecedent { what: string; kind: "app" | "place" | "phase" }`
  - `interface AntecedentFact extends Antecedent { observations: number; of: number }`
  - `interface RhythmFacts { intervalsMs: number[]; hours: number[]; days: number[] }`
  - `interface PrefixFact { routeKey: string; places: readonly string[]; count: number; sessionIds: string[] }`
  - `interface WalkAnalysis { baseline: Baseline; walks: WalkFit[]; steps: StepCost[]; antecedents: AntecedentFact[]; rhythm: RhythmFacts; droppedEarly: PrefixFact[] }`
  - `interface WalkAnalysisHooks { antecedentAt?(sessionId: string, atSec: number): Antecedent | null }`
  - `interface WalkAnalysisInput { flows: FlowsDTO; route: FlowRouteDTO; rule?: BaselineRule }`
  - `function sessionStartedAt(flows: FlowsDTO): Map<string, number>`
  - `function chooseBaseline(ways: readonly FlowWalk[], rule: BaselineRule, startedAt: ReadonlyMap<string, number>): Baseline`
  - `function walkAnalysis(input: WalkAnalysisInput, hooks?: WalkAnalysisHooks): WalkAnalysis`

- [ ] **Step 1: Write the failing test**

Create `test/walk-analysis.test.ts`. This file grows in every later task; the fixture builders at the top are used by all of them, so write them now exactly as given.

```ts
import { describe, expect, it } from "vitest";
import {
  chooseBaseline,
  sessionStartedAt,
  walkAnalysis,
  type WalkAnalysisInput,
} from "../app/src/main/walk-analysis.js";
import { flowWalks } from "../app/src/main/flow-steps.js";
import type {
  EdgeSourceDTO,
  FlowRouteDTO,
  FlowsDTO,
  GraphEdgeDTO,
  GraphNodeDTO,
  RouteWalkDTO,
} from "@shared/types";

const DAY = 86_400_000;
/** 2026-03-02T09:00:00Z — a fixed Monday, so day/hour assertions are stable. */
const T0 = Date.UTC(2026, 2, 2, 9, 0, 0);

const node = (id: string, label: string): GraphNodeDTO => ({
  id,
  label,
  chip: id,
  observations: 1,
  predicates: ["app(Test)"],
  locatable: true,
  intervene: "none",
  rank: 0,
  sources: [],
});

const source = (
  sessionId: string,
  startedAt: number,
  atSec: number,
  throughSec: number,
): EdgeSourceDTO => ({ sessionId, startedAt, atSec, throughSec });

const edge = (
  id: string,
  from: string,
  to: string,
  sources: EdgeSourceDTO[] = [],
): GraphEdgeDTO => ({
  id,
  from,
  to,
  actions: [],
  back: false,
  provenance: "recorded",
  observations: Math.max(1, sources.length),
  sources,
});

const routeWalk = (sessionId: string, edgeIds: string[]): RouteWalkDTO => ({
  sessionId,
  edgeIds,
  atSec: 0,
  throughSec: 10,
});

/** A route over nodes n0..nN with one edge per hop, named e0, e1, … */
const chain = (n: number): { nodes: GraphNodeDTO[]; edgeIds: string[] } => {
  const nodes = Array.from({ length: n + 1 }, (_, i) => node(`n${i}`, `Place ${i}`));
  const edgeIds = Array.from({ length: n }, (_, i) => `e${i}`);
  return { nodes, edgeIds };
};

interface Fixture {
  flows: FlowsDTO;
  route: FlowRouteDTO;
}

/**
 * A route plus the graph it lives in, from a list of `[sessionId, edgeIds]`.
 *
 * Every edge carries a source for each session that walked it, because that is
 * where BOTH the wall clock and the per-step extent come from — the projection
 * reads `EdgeSourceDTO`, never `RouteWalkDTO`, for timing.
 */
const fixture = (
  hops: number,
  walks: { sessionId: string; edgeIds: string[]; startedAt: number; secPerStep?: number }[],
  extraRoutes: FlowRouteDTO[] = [],
): Fixture => {
  const { nodes, edgeIds } = chain(hops);
  const sourcesByEdge = new Map<string, EdgeSourceDTO[]>();
  for (const w of walks) {
    const step = w.secPerStep ?? 2;
    w.edgeIds.forEach((id, i) => {
      const list = sourcesByEdge.get(id) ?? [];
      list.push(source(w.sessionId, w.startedAt, i * step, i * step + 1));
      sourcesByEdge.set(id, list);
    });
  }
  const edges = edgeIds.map((id, i) => edge(id, `n${i}`, `n${i + 1}`, sourcesByEdge.get(id) ?? []));
  const route: FlowRouteDTO = {
    id: nodes.map((n) => n.label).join(" → "),
    count: walks.length,
    label: nodes.map((n) => n.label).join(" → "),
    name: null,
    nameObservations: 0,
    nodeIds: nodes.map((n) => n.id),
    edgeIds,
    sessionIds: walks.map((w) => w.sessionId),
    walks: walks.map((w) => routeWalk(w.sessionId, w.edgeIds)),
    variants: [],
  };
  const flows: FlowsDTO = {
    graph: { id: "g", entry: "n0", nodes, edges, slots: [] },
    routes: [route, ...extraRoutes],
    excludedApps: [],
  };
  return { flows, route };
};

const input = (f: Fixture, rule?: WalkAnalysisInput["rule"]): WalkAnalysisInput =>
  rule === undefined ? { flows: f.flows, route: f.route } : { flows: f.flows, route: f.route, rule };

describe("sessionStartedAt", () => {
  it("resolves a wall clock per session from the graph's edge sources", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1"], startedAt: T0 + DAY },
    ]);
    const map = sessionStartedAt(f.flows);
    expect(map.get("s1")).toBe(T0);
    expect(map.get("s2")).toBe(T0 + DAY);
  });

  it("has no entry for a session with no sources — evidence was deleted", () => {
    const f = fixture(1, [{ sessionId: "s1", edgeIds: ["e0"], startedAt: T0 }]);
    expect(sessionStartedAt(f.flows).has("ghost")).toBe(false);
  });
});

describe("chooseBaseline", () => {
  const startedAt = new Map([
    ["s1", T0],
    ["s2", T0 + DAY],
    ["s3", T0 + 2 * DAY],
  ]);

  it("picks the Way most recordings took, and says how many", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0"], startedAt: T0 + 2 * DAY },
    ]);
    const ways = flowWalks(f.flows, f.route);
    const out = chooseBaseline(ways, "majority", startedAt);
    expect(out.rule).toBe("majority");
    expect(out.wayIndex).toBe(0);
    expect(out.reason).toBe("The Way 2 of the 3 recordings took.");
  });

  it("breaks a majority tie on the newest walk, and SAYS it was a tie", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s3", edgeIds: ["e0"], startedAt: T0 + 2 * DAY },
    ]);
    const ways = flowWalks(f.flows, f.route);
    const out = chooseBaseline(ways, "majority", startedAt);
    // The tiebreak carries the whole decision here, and a standard chosen that
    // way is one recording away from moving. Saying so is the point.
    expect(out.reason).toBe(
      "2 Ways tie at 1 recording each; the standard is the one holding the newest walk.",
    );
    expect(out.wayIndex).toBe(1);
  });

  it("picks the Way the newest recording took under `recent`", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0"], startedAt: T0 + 2 * DAY },
    ]);
    const ways = flowWalks(f.flows, f.route);
    const out = chooseBaseline(ways, "recent", startedAt);
    expect(out.wayIndex).toBe(1);
    expect(out.reason).toBe("The Way the newest recording took, on 2026-03-04.");
  });

  it("names no Way under `none`", () => {
    const f = fixture(1, [{ sessionId: "s1", edgeIds: ["e0"], startedAt: T0 }]);
    const out = chooseBaseline(flowWalks(f.flows, f.route), "none", startedAt);
    expect(out.wayIndex).toBeNull();
    expect(out.reason).toBe("No Way is the standard, so no walk is called deviant.");
  });

  it("names no Way when the route has none", () => {
    const out = chooseBaseline([], "majority", startedAt);
    expect(out.wayIndex).toBeNull();
    expect(out.reason).toBe("This route has no recorded walks.");
  });
});

describe("walkAnalysis", () => {
  it("returns the baseline and defaults the rule to majority", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1"], startedAt: T0 + DAY },
    ]);
    const out = walkAnalysis(input(f));
    expect(out.baseline.rule).toBe("majority");
    expect(out.baseline.wayIndex).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/walk-analysis.test.ts`
Expected: FAIL — `Failed to resolve import "../app/src/main/walk-analysis.js"`.

- [ ] **Step 3: Write the implementation**

Create `app/src/main/walk-analysis.ts`. Later tasks fill the fields returned empty here; do not delete the empty initialisers, replace them.

```ts
/**
 * What a habit's own recordings say about how it is going.
 *
 * `habit-doc.ts` renders what the recordings DID and is structurally silent
 * about how it went — and rightly so for outcomes: `TraceEdge.outcomes` is
 * `{attempts: 0, successes: 0}` on every graph on disk, because passive
 * recording cannot observe a failure. The user did the thing, so it succeeded.
 *
 * That is true about outcomes and false about CONSISTENCY. The store already
 * holds, per walk, the exact edge sequence taken and when each edge was walked;
 * process mining calls comparing a model against its own log conformance
 * checking, and DeskRAG does discovery and stops. This module is that
 * comparison, plus the three other facts sitting unread beside it: what a step
 * costs, what preceded the work, and how the walks are spaced in a life.
 *
 * Pure: `FlowsDTO` in, plain objects out. No store, no Electron, no model — the
 * same contract `flow-steps.ts` holds, and what keeps this file in the ROOT
 * suite.
 *
 * THREE RULES IT DOES NOT BREAK:
 *
 * - **No score.** Counts and named facts only. A conformance ratio would be
 *   exactly the number `FrameResult.score` established this repo does not print.
 * - **No merge.** `droppedEarly` is a disclosure in the shape of `duplicates`.
 *   Merging a prefix route into its parent would inflate `route.count`, and that
 *   count is what the entire recurrence argument rests on.
 * - **No DTO widening.** What is not on `FlowsDTO` arrives through a hook.
 */

import type { FlowRouteDTO, FlowsDTO } from "@shared/types";
import { flowWalks, type FlowWalk } from "./flow-steps.js";
import { alignWalk, type EdgeDeviation } from "./walk-align.js";

/**
 * Which Way is the standard.
 *
 * All three ship, and `npm run probe:baseline` picks the default — exactly as
 * `route-cluster.ts` ships four cluster rules so `probe:routes` can measure the
 * choice on a real library instead of asserting it. Each is wrong in a way the
 * others are not: `majority` calls a recently adopted better path the
 * deviation, `recent` lets one fumbled session become the standard, and `none`
 * cannot say when the variation happened.
 */
export type BaselineRule = "majority" | "recent" | "none";

export interface Baseline {
  rule: BaselineRule;
  /** Index into `flowWalks(...)`. Null when no Way qualifies. */
  wayIndex: number | null;
  /**
   * WHY this Way, as a sentence.
   *
   * Required, and never an enum. A rule that merely applied without saying
   * which Way won and why is the `StageSpec.skipReason` failure one screen
   * over: a thing that never appears is indistinguishable from a thing nobody
   * implemented.
   */
  reason: string;
}

/** An `EdgeDeviation` with the step label resolved from the graph. */
export interface Deviation extends EdgeDeviation {
  /** "Place 1 → Place 2", from the same node labels the record prints. */
  label: string;
}

export interface WalkFit {
  sessionId: string;
  /**
   * Wall clock of the recording's start, or null.
   *
   * NOT on `RouteWalkDTO`, which carries lane seconds only. Resolved from an
   * `EdgeSourceDTO.startedAt`, the way `FlowStep.firstAt` already is. Null when
   * no source resolves — the `sourcesBelowObservations` case, where a recording
   * this walk came from has been deleted. Null is carried, never invented.
   */
  at: number | null;
  /** Vacuously true under the `none` rule, which names no end to reach. */
  reachedEnd: boolean;
  deviations: Deviation[];
}

export interface StepCost {
  stepIndex: number;
  edgeId: string;
  /** The step's OWN extent per recording — `throughSec - atSec`, never a difference between edges. */
  durations: { sessionId: string; ms: number }[];
  /** Idle between this step ending and the next beginning. Empty on the last step. */
  gapsAfter: { sessionId: string; ms: number }[];
}

export interface Antecedent {
  /** "Slack", "github.com/…", "Tue 09:00" — one observed fact. */
  what: string;
  kind: "app" | "place" | "phase";
}

export interface AntecedentFact extends Antecedent {
  observations: number;
  of: number;
}

export interface RhythmFacts {
  /** Milliseconds between consecutive walks, oldest first. Empty below 2 dated walks. */
  intervalsMs: number[];
  /** Local hour (0–23) and day (0–6) of each dated walk, oldest first. */
  hours: number[];
  days: number[];
}

export interface PrefixFact {
  routeKey: string;
  places: readonly string[];
  count: number;
  sessionIds: string[];
}

export interface WalkAnalysis {
  baseline: Baseline;
  walks: WalkFit[];
  steps: StepCost[];
  antecedents: AntecedentFact[];
  rhythm: RhythmFacts;
  droppedEarly: PrefixFact[];
}

export interface WalkAnalysisHooks {
  /**
   * What was in front just before this walk started, or null.
   *
   * Injected because it needs the focus/event stream and `FlowsDTO` does not
   * carry it — `briefFor` takes `reflections` for the same stated reason, and
   * `LiftInput.visualAt` is the same shape one layer down. No hook means no
   * antecedents, and the consumer renders nothing. Never a guess.
   */
  antecedentAt?(sessionId: string, atSec: number): Antecedent | null;
}

export interface WalkAnalysisInput {
  flows: FlowsDTO;
  route: FlowRouteDTO;
  /**
   * Provisional default until `npm run probe:baseline` reports on the real
   * library. `majority` is the conservative pick: it is frequency-honest, and
   * being wrong about a recently improved path is a milder failure than letting
   * one bad session become the standard.
   */
  rule?: BaselineRule;
}

const DEFAULT_RULE: BaselineRule = "majority";

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Session -> the wall clock its recording started at.
 *
 * FIRST source wins, and the walk order does not matter: every source for one
 * session carries the same `startedAt`, because it is the recording's own start
 * rather than the moment of the edge.
 */
export function sessionStartedAt(flows: FlowsDTO): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of flows.graph.edges) {
    for (const s of e.sources) {
      if (!out.has(s.sessionId)) out.set(s.sessionId, s.startedAt);
    }
  }
  return out;
}

/** The newest wall clock among a Way's recordings, or null when none is dated. */
function newestAt(way: FlowWalk, startedAt: ReadonlyMap<string, number>): number | null {
  let best: number | null = null;
  for (const id of way.sessionIds) {
    const at = startedAt.get(id);
    if (at !== undefined && (best === null || at > best)) best = at;
  }
  return best;
}

export function chooseBaseline(
  ways: readonly FlowWalk[],
  rule: BaselineRule,
  startedAt: ReadonlyMap<string, number>,
): Baseline {
  if (rule === "none") {
    return { rule, wayIndex: null, reason: "No Way is the standard, so no walk is called deviant." };
  }
  if (ways.length === 0) {
    return { rule, wayIndex: null, reason: "This route has no recorded walks." };
  }

  if (rule === "recent") {
    // A `for` loop, NOT `ways.forEach`. TypeScript does not widen a `let`
    // narrowed at its declaration just because a callback assigns to it, so
    // `let bestAt: number | null = null` stays narrowed to `null` after a
    // `forEach` and the date branch below becomes unreachable-looking. The loop
    // keeps the narrowing honest instead of needing an annotation to undo it.
    let bestIndex = 0;
    let bestAt: number | null = null;
    for (let i = 0; i < ways.length; i += 1) {
      const at = newestAt(ways[i]!, startedAt);
      if (at !== null && (bestAt === null || at > bestAt)) {
        bestAt = at;
        bestIndex = i;
      }
    }
    return {
      rule,
      wayIndex: bestIndex,
      reason:
        bestAt === null
          ? "The Way the newest recording took; none of them carries a date."
          : `The Way the newest recording took, on ${iso(bestAt)}.`,
    };
  }

  const total = ways.reduce((n, w) => n + w.sessionIds.length, 0);
  const top = Math.max(...ways.map((w) => w.sessionIds.length));
  const tied = ways
    .map((w, i) => ({ way: w, i }))
    .filter(({ way }) => way.sessionIds.length === top);

  if (tied.length === 1) {
    const only = tied[0]!;
    return {
      rule,
      wayIndex: only.i,
      reason: `The Way ${top} of the ${total} recordings took.`,
    };
  }

  // A TIE means the tiebreak is carrying the whole decision, and a standard
  // chosen that way is one more recording away from moving. It is said out
  // loud for the same reason `nameObservations < count` is.
  let winner = tied[0]!;
  let winnerAt = newestAt(winner.way, startedAt);
  for (const cand of tied.slice(1)) {
    const at = newestAt(cand.way, startedAt);
    if (at !== null && (winnerAt === null || at > winnerAt)) {
      winner = cand;
      winnerAt = at;
    }
  }
  return {
    rule,
    wayIndex: winner.i,
    reason:
      `${tied.length} Ways tie at ${top} recording${top === 1 ? "" : "s"} each; ` +
      `the standard is the one holding the newest walk.`,
  };
}

export function walkAnalysis(
  input: WalkAnalysisInput,
  _hooks?: WalkAnalysisHooks,
): WalkAnalysis {
  const { flows, route } = input;
  const rule = input.rule ?? DEFAULT_RULE;
  const ways = flowWalks(flows, route);
  const startedAt = sessionStartedAt(flows);
  const baseline = chooseBaseline(ways, rule, startedAt);

  return {
    baseline,
    walks: [],
    steps: [],
    antecedents: [],
    rhythm: { intervalsMs: [], hours: [], days: [] },
    droppedEarly: [],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/walk-analysis.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/walk-analysis.ts test/walk-analysis.test.ts
git commit -m "feat(habits): choose the Way a route's walks are measured against

Three rules ship and probe:baseline picks the default, the way
route-cluster.ts ships four and probe:routes chooses. Each is wrong
differently: majority calls a recently adopted better path the
deviation, recent lets one fumbled session become the standard, none
cannot say when the variation happened.

A tie is DISCLOSED, not silently broken -- when the tiebreak carries
the decision the standard is one recording away from moving.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `walks` — how each recording differed

**Files:**
- Modify: `app/src/main/walk-analysis.ts` (replace `walks: []` in `walkAnalysis`, add helpers)
- Test: `test/walk-analysis.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `alignWalk` (Task 1); `chooseBaseline`, `sessionStartedAt`, `WalkFit`, `Deviation` (Task 2).
- Produces: `WalkAnalysis.walks` populated — one `WalkFit` per recording, oldest first, dated walks before undated.

- [ ] **Step 1: Write the failing test**

Append to `test/walk-analysis.test.ts`:

```ts
describe("walkAnalysis — walks", () => {
  it("returns one fit per RECORDING, not one per Way", () => {
    // Two recordings walked identically, so `flowWalks` collapses them into one
    // Way. A fit is per recording: the count is what the recurrence argument
    // rests on, and reporting one row for two walks would lose a recording.
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1"], startedAt: T0 + DAY },
    ]);
    const out = walkAnalysis(input(f));
    expect(out.walks.map((w) => w.sessionId)).toEqual(["s1", "s2"]);
  });

  it("orders oldest first", () => {
    const f = fixture(1, [
      { sessionId: "late", edgeIds: ["e0"], startedAt: T0 + DAY },
      { sessionId: "early", edgeIds: ["e0"], startedAt: T0 },
    ]);
    expect(walkAnalysis(input(f)).walks.map((w) => w.sessionId)).toEqual(["early", "late"]);
  });

  it("names a skipped step against the baseline, with the label the record prints", () => {
    const f = fixture(3, [
      { sessionId: "s1", edgeIds: ["e0", "e1", "e2"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1", "e2"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0", "e2"], startedAt: T0 + 2 * DAY },
    ]);
    const out = walkAnalysis(input(f));
    const odd = out.walks.find((w) => w.sessionId === "s3");
    expect(odd?.deviations).toEqual([
      { kind: "skipped", stepIndex: 1, edgeId: "e1", label: "Place 1 → Place 2" },
    ]);
    expect(odd?.reachedEnd).toBe(true);
  });

  it("gives the baseline's own recordings no deviations", () => {
    const f = fixture(3, [
      { sessionId: "s1", edgeIds: ["e0", "e1", "e2"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1", "e2"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0", "e2"], startedAt: T0 + 2 * DAY },
    ]);
    const out = walkAnalysis(input(f));
    expect(out.walks.filter((w) => w.deviations.length === 0).map((w) => w.sessionId)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("labels an edge missing from the graph rather than dropping the deviation", () => {
    // `FlowStep.missing` exists because a step that vanished makes a flow read
    // as shorter than it was. The same holds for a deviation.
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1"], startedAt: T0 + DAY },
    ]);
    f.route.walks.push(routeWalk("s3", ["e0", "gone"]));
    f.route.sessionIds.push("s3");
    const out = walkAnalysis(input(f));
    const odd = out.walks.find((w) => w.sessionId === "s3");
    expect(odd?.deviations).toContainEqual({
      kind: "inserted",
      stepIndex: 1,
      edgeId: "gone",
      label: "edge gone is not in the graph",
    });
  });

  it("carries a null wall clock rather than inventing one", () => {
    const f = fixture(1, [{ sessionId: "s1", edgeIds: ["e0"], startedAt: T0 }]);
    f.route.walks.push(routeWalk("ghost", ["e0"]));
    f.route.sessionIds.push("ghost");
    const out = walkAnalysis(input(f));
    expect(out.walks.find((w) => w.sessionId === "ghost")?.at).toBeNull();
  });

  it("sorts undated walks LAST, so an unknown date never reads as the oldest", () => {
    const f = fixture(1, [{ sessionId: "s1", edgeIds: ["e0"], startedAt: T0 }]);
    f.route.walks.unshift(routeWalk("ghost", ["e0"]));
    f.route.sessionIds.unshift("ghost");
    expect(walkAnalysis(input(f)).walks.map((w) => w.sessionId)).toEqual(["s1", "ghost"]);
  });

  it("calls no walk deviant under `none`", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0"], startedAt: T0 + DAY },
    ]);
    const out = walkAnalysis(input(f, "none"));
    expect(out.walks).toHaveLength(2);
    expect(out.walks.every((w) => w.deviations.length === 0)).toBe(true);
    expect(out.walks.every((w) => w.reachedEnd)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/walk-analysis.test.ts -t "walks"`
Expected: FAIL — the first case gets `[]` instead of `["s1", "s2"]`.

- [ ] **Step 3: Write the implementation**

In `app/src/main/walk-analysis.ts`, add these helpers above `walkAnalysis`:

```ts
/**
 * "Place 1 → Place 2" for an edge, or a named absence.
 *
 * The absence is spelled out rather than skipped, for `FlowStep.missing`'s
 * reason: a step that vanished makes a flow read as shorter than it was, and a
 * deviation that vanished makes a walk read as closer to the standard than it
 * was — which is the one direction this module must never err in.
 */
function edgeLabel(flows: FlowsDTO, edgeId: string): string {
  const edge = flows.graph.edges.find((e) => e.id === edgeId);
  if (edge === undefined) return `edge ${edgeId} is not in the graph`;
  const label = (id: string): string => flows.graph.nodes.find((n) => n.id === id)?.label ?? id;
  return `${label(edge.from)} → ${label(edge.to)}`;
}

/** Every recording's own edge sequence, in the order `frequentRoutes` recorded it. */
function walkedEdges(route: FlowRouteDTO): { sessionId: string; edgeIds: readonly string[] }[] {
  if (route.walks.length > 0) {
    return route.walks.map((w) => ({ sessionId: w.sessionId, edgeIds: w.edgeIds }));
  }
  // `flowWalks` degrades the same way for the one input that cannot distinguish
  // a route with no walks from a route walked once — a hand-built fixture.
  return [{ sessionId: route.sessionIds[0] ?? "", edgeIds: route.edgeIds }];
}
```

Then replace the `walks: []` initialiser. The body of `walkAnalysis` becomes:

```ts
export function walkAnalysis(
  input: WalkAnalysisInput,
  _hooks?: WalkAnalysisHooks,
): WalkAnalysis {
  const { flows, route } = input;
  const rule = input.rule ?? DEFAULT_RULE;
  const ways = flowWalks(flows, route);
  const startedAt = sessionStartedAt(flows);
  const baseline = chooseBaseline(ways, rule, startedAt);

  const baseWay = baseline.wayIndex === null ? null : (ways[baseline.wayIndex] ?? null);
  const baseEdges = baseWay === null ? null : baseWay.steps.map((s) => s.edgeId);

  const walks: WalkFit[] = walkedEdges(route).map(({ sessionId, edgeIds }) => {
    const at = startedAt.get(sessionId) ?? null;
    if (baseEdges === null) {
      // `none` names no end, so `reachedEnd` is vacuous rather than false —
      // false would assert the walk fell short of a standard that does not
      // exist.
      return { sessionId, at, reachedEnd: true, deviations: [] };
    }
    const aligned = alignWalk(baseEdges, edgeIds);
    return {
      sessionId,
      at,
      reachedEnd: aligned.reachedEnd,
      deviations: aligned.deviations.map((d) => ({ ...d, label: edgeLabel(flows, d.edgeId) })),
    };
  });

  // Oldest first, and an UNDATED walk sorts last rather than first: a missing
  // date is not a very old one, and letting null sort to the front would put
  // deleted evidence at the head of a ledger that reads left-to-right in time.
  walks.sort((a, b) => {
    if (a.at === null && b.at === null) return a.sessionId.localeCompare(b.sessionId);
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at - b.at || a.sessionId.localeCompare(b.sessionId);
  });

  return {
    baseline,
    walks,
    steps: [],
    antecedents: [],
    rhythm: { intervalsMs: [], hours: [], days: [] },
    droppedEarly: [],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/walk-analysis.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/walk-analysis.ts test/walk-analysis.test.ts
git commit -m "feat(habits): how each recording differed from the standard

One fit per RECORDING, never one per Way -- two identical walks collapse
into one Way and losing one of them would lose a recording, which is
what the whole recurrence argument rests on.

An undated walk sorts LAST: a missing date is not a very old one, and
null-first would put deleted evidence at the head of a ledger that
reads left to right in time.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `steps` — where the time goes

**Files:**
- Modify: `app/src/main/walk-analysis.ts` (replace `steps: []`, add a helper)
- Test: `test/walk-analysis.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `Baseline`, `StepCost` (Task 2); the baseline Way computed in `walkAnalysis` (Task 3).
- Produces: `WalkAnalysis.steps` populated — one `StepCost` per baseline step, empty under `none`.

- [ ] **Step 1: Write the failing test**

Append to `test/walk-analysis.test.ts`:

```ts
describe("walkAnalysis — steps", () => {
  it("measures a step by its OWN span, not by the gap to the next edge", () => {
    // `EdgeSourceDTO` carries atSec AND throughSec per recording, so a step's
    // extent is its own. Differencing consecutive atSec would fold the idle
    // time before the next step into this one's cost and hide the hesitation.
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0, secPerStep: 5 },
    ]);
    const out = walkAnalysis(input(f));
    // sources are atSec = i*5, throughSec = i*5 + 1 -> every step lasts 1s
    expect(out.steps.map((s) => s.durations)).toEqual([
      [{ sessionId: "s1", ms: 1000 }],
      [{ sessionId: "s1", ms: 1000 }],
    ]);
  });

  it("reports the idle between steps separately", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0, secPerStep: 5 },
    ]);
    const out = walkAnalysis(input(f));
    // e0 ends at 1s, e1 begins at 5s -> 4s of hesitation
    expect(out.steps[0]?.gapsAfter).toEqual([{ sessionId: "s1", ms: 4000 }]);
    expect(out.steps[1]?.gapsAfter).toEqual([]);
  });

  it("omits a recording that did not walk the step, rather than recording a zero", () => {
    const f = fixture(3, [
      { sessionId: "s1", edgeIds: ["e0", "e1", "e2"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1", "e2"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0", "e2"], startedAt: T0 + 2 * DAY },
    ]);
    const out = walkAnalysis(input(f));
    expect(out.steps[1]?.durations.map((d) => d.sessionId)).toEqual(["s1", "s2"]);
  });

  it("indexes and identifies each step against the baseline Way", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
    ]);
    const out = walkAnalysis(input(f));
    expect(out.steps.map((s) => [s.stepIndex, s.edgeId])).toEqual([
      [0, "e0"],
      [1, "e1"],
    ]);
  });

  it("has no steps under `none`, because there is no baseline to have them", () => {
    const f = fixture(2, [{ sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 }]);
    expect(walkAnalysis(input(f, "none")).steps).toEqual([]);
  });

  it("orders durations oldest recording first, matching `walks`", () => {
    const f = fixture(1, [
      { sessionId: "late", edgeIds: ["e0"], startedAt: T0 + DAY },
      { sessionId: "early", edgeIds: ["e0"], startedAt: T0 },
    ]);
    expect(walkAnalysis(input(f)).steps[0]?.durations.map((d) => d.sessionId)).toEqual([
      "early",
      "late",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/walk-analysis.test.ts -t "steps"`
Expected: FAIL — `out.steps` is `[]`.

- [ ] **Step 3: Write the implementation**

Add above `walkAnalysis`:

```ts
const MS_PER_SEC = 1000;

/**
 * Every recording's source on one edge, keyed by session.
 *
 * `EdgeSourceDTO` is where BOTH the wall clock and the extent live; `atSec` on
 * `RouteWalkDTO` is the whole walk's span and cannot answer for a single step.
 */
function sourcesOf(
  flows: FlowsDTO,
  edgeId: string,
): Map<string, { atSec: number; throughSec: number }> {
  const out = new Map<string, { atSec: number; throughSec: number }>();
  const edge = flows.graph.edges.find((e) => e.id === edgeId);
  if (edge === undefined) return out;
  for (const s of edge.sources) {
    if (!out.has(s.sessionId)) out.set(s.sessionId, { atSec: s.atSec, throughSec: s.throughSec });
  }
  return out;
}

/**
 * The baseline's steps, costed per recording.
 *
 * `order` is the session order `walks` already settled on, so a reader
 * comparing a step's durations against the ledger sees the same recordings in
 * the same sequence. Two orders for one set is the drift `shared/evidence.ts`
 * exists to stop.
 */
function stepCosts(
  flows: FlowsDTO,
  baseEdges: readonly string[],
  order: readonly string[],
): StepCost[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const bySession = baseEdges.map((edgeId) => sourcesOf(flows, edgeId));
  const byRank = <T extends { sessionId: string }>(list: T[]): T[] =>
    list.sort(
      (a, b) =>
        (rank.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER) ||
        a.sessionId.localeCompare(b.sessionId),
    );

  return baseEdges.map((edgeId, i) => {
    const here = bySession[i]!;
    const next = i + 1 < baseEdges.length ? bySession[i + 1] : undefined;

    const durations = byRank(
      [...here.entries()].map(([sessionId, s]) => ({
        sessionId,
        ms: Math.max(0, Math.round((s.throughSec - s.atSec) * MS_PER_SEC)),
      })),
    );

    const gapsAfter =
      next === undefined
        ? []
        : byRank(
            [...here.entries()].flatMap(([sessionId, s]) => {
              const after = next.get(sessionId);
              if (after === undefined) return [];
              // Clamped at zero rather than dropped: overlapping spans mean the
              // recording did the next thing before this one finished, which is
              // a real shape and not a negative pause.
              return [
                {
                  sessionId,
                  ms: Math.max(0, Math.round((after.atSec - s.throughSec) * MS_PER_SEC)),
                },
              ];
            }),
          );

    return { stepIndex: i, edgeId, durations, gapsAfter };
  });
}
```

Then, inside `walkAnalysis`, after `walks.sort(...)`, replace `steps: []` with a computed value:

```ts
  const order = walks.map((w) => w.sessionId);
  const steps = baseEdges === null ? [] : stepCosts(flows, baseEdges, order);

  return {
    baseline,
    walks,
    steps,
    antecedents: [],
    rhythm: { intervalsMs: [], hours: [], days: [] },
    droppedEarly: [],
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/walk-analysis.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/walk-analysis.ts test/walk-analysis.test.ts
git commit -m "feat(habits): what each step of a habit costs, and the idle between

A step's extent is its OWN span -- EdgeSourceDTO carries atSec and
throughSec per recording -- never a difference between consecutive
edges, which would fold hesitation before the next step into this
step's cost and hide it. The two are separated because both are
readings of where the time goes.

A recording that did not walk a step contributes no entry, so a short
durations list is itself readable. It is never a zero.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `rhythm` — when, not how often

**Files:**
- Modify: `app/src/main/walk-analysis.ts` (replace the `rhythm` initialiser, add a helper)
- Test: `test/walk-analysis.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `walks: WalkFit[]` (Task 3), already sorted oldest first with undated last.
- Produces: `WalkAnalysis.rhythm` populated.

- [ ] **Step 1: Write the failing test**

Append to `test/walk-analysis.test.ts`:

```ts
describe("walkAnalysis — rhythm", () => {
  it("reports the gaps between consecutive walks, oldest first", () => {
    const f = fixture(1, [
      { sessionId: "s1", edgeIds: ["e0"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0"], startedAt: T0 + 4 * DAY },
    ]);
    expect(walkAnalysis(input(f)).rhythm.intervalsMs).toEqual([DAY, 3 * DAY]);
  });

  it("has no intervals below two dated walks", () => {
    const f = fixture(1, [{ sessionId: "s1", edgeIds: ["e0"], startedAt: T0 }]);
    expect(walkAnalysis(input(f)).rhythm.intervalsMs).toEqual([]);
  });

  it("reports each walk's local hour and day", () => {
    const f = fixture(1, [
      { sessionId: "s1", edgeIds: ["e0"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0"], startedAt: T0 + DAY },
    ]);
    const { hours, days } = walkAnalysis(input(f)).rhythm;
    expect(hours).toHaveLength(2);
    expect(days).toHaveLength(2);
    // Local, deliberately: the question is when in this person's day it
    // happened. Asserted against Date rather than a constant so the suite is
    // not pinned to the machine's zone.
    expect(hours[0]).toBe(new Date(T0).getHours());
    expect(days[0]).toBe(new Date(T0).getDay());
    // Consecutive days differ by one, whatever the zone.
    expect((days[0]! + 1) % 7).toBe(days[1]);
  });

  it("excludes an undated walk from every rhythm reading", () => {
    // An interval computed across a gap of unknown length is not a long gap,
    // it is no measurement at all.
    const f = fixture(1, [
      { sessionId: "s1", edgeIds: ["e0"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0"], startedAt: T0 + DAY },
    ]);
    f.route.walks.push(routeWalk("ghost", ["e0"]));
    f.route.sessionIds.push("ghost");
    const r = walkAnalysis(input(f)).rhythm;
    expect(r.intervalsMs).toEqual([DAY]);
    expect(r.hours).toHaveLength(2);
    expect(r.days).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/walk-analysis.test.ts -t "rhythm"`
Expected: FAIL — `intervalsMs` is `[]`.

- [ ] **Step 3: Write the implementation**

Add above `walkAnalysis`:

```ts
/**
 * When the walks happened, as raw facts.
 *
 * NO automaticity score and no regularity coefficient. The habit literature's
 * numbers — a median around 66 days to automaticity, over a range of 18 to 254 —
 * are population statistics and say nothing about one person's one route.
 * Turning them into a per-habit figure would be the invented confidence this
 * module refuses everywhere else.
 *
 * LOCAL time on purpose: the question a rhythm answers is when in a person's
 * day and week this happened. Nothing in the store records the zone the
 * recording was made in, so a route walked at 09:00 in two zones reports two
 * phases — named in the spec's open requirements, not solved here.
 */
function rhythmOf(walks: readonly WalkFit[]): RhythmFacts {
  const dated = walks
    .map((w) => w.at)
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b);

  const intervalsMs: number[] = [];
  for (let i = 1; i < dated.length; i += 1) intervalsMs.push(dated[i]! - dated[i - 1]!);

  return {
    intervalsMs,
    hours: dated.map((at) => new Date(at).getHours()),
    days: dated.map((at) => new Date(at).getDay()),
  };
}
```

In `walkAnalysis`, replace the `rhythm` initialiser:

```ts
    rhythm: rhythmOf(walks),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/walk-analysis.test.ts`
Expected: PASS, 26 tests.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/walk-analysis.ts test/walk-analysis.test.ts
git commit -m "feat(habits): when a habit is practised, not only how often

Intervals, local hours and local days -- raw facts, no automaticity
score. The literature's ~66-day median over an 18-254 day range is a
population statistic and says nothing about one person's one route.

An undated walk is excluded from every reading: an interval measured
across a gap of unknown length is not a long gap, it is no measurement.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `antecedents` — the cue, through the injected hook

**Files:**
- Modify: `app/src/main/walk-analysis.ts` (replace `antecedents: []`, rename `_hooks` to `hooks`, add a helper)
- Test: `test/walk-analysis.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `WalkAnalysisHooks`, `Antecedent`, `AntecedentFact` (Task 2); `walks` order (Task 3).
- Produces: `WalkAnalysis.antecedents` populated — most-observed first, with `observations` and `of`.

- [ ] **Step 1: Write the failing test**

Append to `test/walk-analysis.test.ts`:

```ts
describe("walkAnalysis — antecedents", () => {
  const f3 = () =>
    fixture(1, [
      { sessionId: "s1", edgeIds: ["e0"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0"], startedAt: T0 + 2 * DAY },
    ]);

  it("is empty with no hook — never a guess", () => {
    expect(walkAnalysis(input(f3())).antecedents).toEqual([]);
  });

  it("counts agreement across walks and carries the denominator", () => {
    const out = walkAnalysis(input(f3()), {
      antecedentAt: (sessionId) =>
        sessionId === "s3" ? { what: "Mail", kind: "app" } : { what: "Slack", kind: "app" },
    });
    expect(out.antecedents).toEqual([
      { what: "Slack", kind: "app", observations: 2, of: 3 },
      { what: "Mail", kind: "app", observations: 1, of: 3 },
    ]);
  });

  it("counts a walk that returned null in the denominator, not out of it", () => {
    // Two of three walks showed Slack is a different claim from two of two.
    // Dropping the silent walk would report unanimity that was not observed.
    const out = walkAnalysis(input(f3()), {
      antecedentAt: (sessionId) => (sessionId === "s1" ? null : { what: "Slack", kind: "app" }),
    });
    expect(out.antecedents).toEqual([{ what: "Slack", kind: "app", observations: 2, of: 3 }]);
  });

  it("keeps the same text under two kinds apart", () => {
    const out = walkAnalysis(input(f3()), {
      antecedentAt: (sessionId) =>
        sessionId === "s1"
          ? { what: "Slack", kind: "app" }
          : { what: "Slack", kind: "place" },
    });
    expect(out.antecedents).toEqual([
      { what: "Slack", kind: "place", observations: 2, of: 3 },
      { what: "Slack", kind: "app", observations: 1, of: 3 },
    ]);
  });

  it("is asked at the moment THIS recording walked the route", () => {
    const f = f3();
    f.route.walks[1] = { sessionId: "s2", edgeIds: ["e0"], atSec: 42, throughSec: 50 };
    const asked: { sessionId: string; atSec: number }[] = [];
    walkAnalysis(input(f), {
      antecedentAt: (sessionId, atSec) => {
        asked.push({ sessionId, atSec });
        return null;
      },
    });
    expect(asked).toContainEqual({ sessionId: "s2", atSec: 42 });
  });

  it("orders most-observed first, ties broken on the text so the order is stable", () => {
    const out = walkAnalysis(input(f3()), {
      antecedentAt: (sessionId) =>
        sessionId === "s1"
          ? { what: "Zed", kind: "app" }
          : sessionId === "s2"
            ? { what: "Ada", kind: "app" }
            : { what: "Mail", kind: "app" },
    });
    expect(out.antecedents.map((a) => a.what)).toEqual(["Ada", "Mail", "Zed"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/walk-analysis.test.ts -t "antecedents"`
Expected: FAIL — the second case gets `[]`.

- [ ] **Step 3: Write the implementation**

Add above `walkAnalysis`:

```ts
/**
 * What preceded the work, with the agreement it was observed at.
 *
 * `of` is EVERY walk asked, including the ones the hook could not answer for.
 * Two of three walks showing Slack is a different claim from two of two, and
 * shrinking the denominator to the walks that answered would report unanimity
 * nobody observed — the `nameObservations` versus `count` rule, one level down.
 *
 * The hook is asked at the moment THIS recording walked the route, which is
 * `RouteWalkDTO.atSec` — lane seconds, the axis the rail is drawn in. Never
 * `tMono / 1000`: that was the measured Flows bug that landed every jump ~1.9s
 * early.
 */
function antecedentsOf(
  route: FlowRouteDTO,
  order: readonly string[],
  hooks: WalkAnalysisHooks | undefined,
): AntecedentFact[] {
  const ask = hooks?.antecedentAt;
  if (ask === undefined) return [];

  const atSecOf = new Map(route.walks.map((w) => [w.sessionId, w.atSec]));
  const counts = new Map<string, AntecedentFact>();
  let of = 0;

  for (const sessionId of order) {
    of += 1;
    const found = ask(sessionId, atSecOf.get(sessionId) ?? 0);
    if (found === null) continue;
    // A space is an unambiguous delimiter here: `kind` is a closed set of
    // three tokens and none contains one, so no two distinct pairs collide.
    const key = `${found.kind} ${found.what}`;
    const seen = counts.get(key);
    if (seen === undefined) {
      counts.set(key, { what: found.what, kind: found.kind, observations: 1, of: 0 });
    } else {
      seen.observations += 1;
    }
  }

  const out = [...counts.values()].map((f) => ({ ...f, of }));
  out.sort(
    (a, b) =>
      b.observations - a.observations || a.what.localeCompare(b.what) || a.kind.localeCompare(b.kind),
  );
  return out;
}
```

In `walkAnalysis`, rename the second parameter from `_hooks` to `hooks` and replace the `antecedents` initialiser:

```ts
    antecedents: antecedentsOf(route, order, hooks),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/walk-analysis.test.ts`
Expected: PASS, 32 tests.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/walk-analysis.ts test/walk-analysis.test.ts
git commit -m "feat(habits): what preceded the work, at the agreement it was seen

Every habit until now was a routine with no cue. The antecedent arrives
through an injected hook, because it needs the focus stream and FlowsDTO
does not carry it -- briefFor takes reflections for the same reason.

No hook means no antecedents and the consumer renders nothing. A walk
the hook could not answer for stays in the DENOMINATOR: two of three is
a different claim from two of two, and shrinking it would report
unanimity nobody observed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `droppedEarly` — the work started and not finished

**Files:**
- Modify: `app/src/main/walk-analysis.ts` (replace `droppedEarly: []`, add a helper)
- Test: `test/walk-analysis.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `PrefixFact` (Task 2); `FlowsDTO.routes` (existing).
- Produces: `WalkAnalysis.droppedEarly` populated — strict prefixes only, longest first.

- [ ] **Step 1: Write the failing test**

Append to `test/walk-analysis.test.ts`:

```ts
/** A bare route carrying only what the prefix scan reads. */
const otherRoute = (places: string[], sessionIds: string[]): FlowRouteDTO => ({
  id: places.join(" → "),
  count: sessionIds.length,
  label: places.join(" → "),
  name: null,
  nameObservations: 0,
  nodeIds: [],
  edgeIds: [],
  sessionIds,
  walks: [],
  variants: [],
});

describe("walkAnalysis — droppedEarly", () => {
  const base = () =>
    fixture(
      3,
      [{ sessionId: "s1", edgeIds: ["e0", "e1", "e2"], startedAt: T0 }],
      [
        otherRoute(["Place 0", "Place 1"], ["a", "b"]),
        otherRoute(["Place 0", "Place 1", "Place 2"], ["c"]),
        otherRoute(["Place 0", "Place 9"], ["d"]),
        otherRoute(["Place 0", "Place 1", "Place 2", "Place 3", "Place 4"], ["e"]),
      ],
    );

  it("finds routes whose places are a strict prefix of this route's", () => {
    const out = walkAnalysis(input(base())).droppedEarly;
    expect(out.map((p) => p.routeKey)).toEqual([
      "Place 0 → Place 1 → Place 2",
      "Place 0 → Place 1",
    ]);
  });

  it("carries the shorter route's own count and recordings", () => {
    const out = walkAnalysis(input(base())).droppedEarly;
    const two = out.find((p) => p.routeKey === "Place 0 → Place 1");
    expect(two?.count).toBe(2);
    expect(two?.sessionIds).toEqual(["a", "b"]);
    expect(two?.places).toEqual(["Place 0", "Place 1"]);
  });

  it("excludes a route that diverges, however early", () => {
    const out = walkAnalysis(input(base())).droppedEarly;
    expect(out.map((p) => p.routeKey)).not.toContain("Place 0 → Place 9");
  });

  it("excludes a LONGER route — a prefix is strictly shorter", () => {
    const out = walkAnalysis(input(base())).droppedEarly;
    expect(out.map((p) => p.routeKey)).not.toContain(
      "Place 0 → Place 1 → Place 2 → Place 3 → Place 4",
    );
  });

  it("never includes the route itself", () => {
    const f = base();
    const out = walkAnalysis(input(f)).droppedEarly;
    expect(out.map((p) => p.routeKey)).not.toContain(f.route.id);
  });

  it("does not change the route's own count", () => {
    // The whole reason this is a disclosure and not a merge: route.count is
    // what the recurrence argument rests on, and folding a prefix in would
    // claim recordings that did not do the work.
    const f = base();
    const before = f.route.count;
    walkAnalysis(input(f));
    expect(f.route.count).toBe(before);
  });

  it("orders longest first — the nearest miss is the most interesting", () => {
    const out = walkAnalysis(input(base())).droppedEarly;
    expect(out.map((p) => p.places.length)).toEqual([3, 2]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/walk-analysis.test.ts -t "droppedEarly"`
Expected: FAIL — `droppedEarly` is `[]`.

- [ ] **Step 3: Write the implementation**

Add above `walkAnalysis`:

```ts
/**
 * The separator `frequentRoutes` joins a route's places with. Named once.
 *
 * `FlowRouteDTO` exposes no `places` array, but its `id` IS
 * `places.join(" → ")` and the labels are de-duplicated before the join — so
 * splitting the key recovers the sequence exactly. Safe by definition rather
 * than by convenience: if the key ever stops being the joined label sequence,
 * `route-cluster.ts`, `bindHabit` and every stored `routeKey` break with it.
 */
const PLACE_SEP = " → ";

/**
 * Routes whose places are a STRICT prefix of this one's — work begun and
 * dropped early.
 *
 * A DISCLOSURE, in the shape of `duplicates`, and never a merge. Every
 * recording gets exactly one route key, and that partition is what makes
 * `bindHabit`'s strict-majority rule a proof rather than a threshold: a session
 * cannot lie in two routes, so more than half of a set can lie in at most one
 * part. Folding a prefix into its parent would inflate `route.count` — the one
 * number the whole recurrence argument rests on — with recordings that did not
 * do the work.
 *
 * Longest first: the nearest miss is the one worth reading.
 */
function prefixRoutes(flows: FlowsDTO, route: FlowRouteDTO): PrefixFact[] {
  const places = route.id.split(PLACE_SEP);
  const out: PrefixFact[] = [];
  for (const other of flows.routes) {
    if (other.id === route.id) continue;
    const theirs = other.id.split(PLACE_SEP);
    if (theirs.length >= places.length) continue;
    if (!theirs.every((p, i) => p === places[i])) continue;
    out.push({
      routeKey: other.id,
      places: theirs,
      count: other.count,
      sessionIds: [...other.sessionIds],
    });
  }
  out.sort((a, b) => b.places.length - a.places.length || a.routeKey.localeCompare(b.routeKey));
  return out;
}
```

In `walkAnalysis`, replace the `droppedEarly` initialiser:

```ts
    droppedEarly: prefixRoutes(flows, route),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/walk-analysis.test.ts`
Expected: PASS, 39 tests.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/walk-analysis.ts test/walk-analysis.test.ts
git commit -m "feat(habits): the work begun and dropped early, as a disclosure

frequentRoutes gives every recording exactly one route key, so a session
that started the work and bailed gets its own shorter key and is
invisible from the full route's side. A strict-prefix relation finds it
using the same place-sequence containment route-cluster.ts already
reasons over.

A DISCLOSURE, in the shape of duplicates, never a merge: folding a
prefix into its parent would inflate route.count with recordings that
did not do the work, and that count is what the whole recurrence
argument rests on.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: `probe:baseline` — measure the three rules on the real library

The projection is finished. This is what decides which rule ships, and it is the only file in the plan that touches a database.

**Files:**
- Create: `scripts/baseline-probe.ts`
- Modify: `package.json` (add one script)
- Modify: `CLAUDE.md` (add the probe to the commands block, in the established voice)

**Interfaces:**
- Consumes: `walkAnalysis`, `BaselineRule` (Tasks 2–7); `readGraph`, `DEFAULT_DB` from `./lib/read-store.js` (existing); `frequentRoutes`, `toGraphDTO` from `../app/src/main/graph-view.js` (existing).
- Produces: an `npm run probe:baseline` script. No importable API.

- [ ] **Step 1: Write the probe**

There is no unit test for a probe — `scripts/routes-probe.ts` has none either, and the gate for this task is that it runs against the real store and prints an honest report. Create `scripts/baseline-probe.ts`:

```ts
/**
 * Which baseline rule should a habit's walks be measured against?
 *
 * `walk-analysis.ts` ships three — `majority`, `recent` and `none` — and each is
 * wrong in a way the others are not. This decides which one ships, on the
 * library that actually exists, the way `probe:routes` decides the cluster rule.
 *
 * READ-ONLY, and HEADLESS on purpose. It opens `app.db` with better-sqlite3 in
 * `readonly` mode and marshals the `trace_*` tables into a `Graph`. It never
 * launches the app: DeskRAGApp takes no single-instance lock, so a second
 * instance against the same data dir is a SECOND OWNER of SQLite and LanceDB —
 * and it writes on startup (`adoptUnclosedSessions`, the index worker). It also
 * never opens the store through `DualStore`, which drops retired vector spaces
 * on open. Reading rows is the only way in here that cannot change what it is
 * measuring.
 *
 * It calls the app's own `frequentRoutes`, `toGraphDTO` and `walkAnalysis` —
 * there is no second implementation of anything with a JUDGEMENT in it, so what
 * is compared below is what ships.
 *
 * It PRINTS THE LIBRARY IT FOUND BEFORE JUDGING ANYTHING (the `probe:habits`
 * precedent). A verdict drawn from two recordings is not a verdict.
 *
 * Run:  npm run probe:baseline
 */

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { DEFAULT_DB, readGraph } from "./lib/read-store.js";
import { frequentRoutes, toGraphDTO } from "../app/src/main/graph-view.js";
import { walkAnalysis, type BaselineRule } from "../app/src/main/walk-analysis.js";
import type { FlowsDTO } from "@shared/types";

const RULES: BaselineRule[] = ["majority", "recent", "none"];

const dbPath = process.argv[2] ?? DEFAULT_DB;
if (!existsSync(dbPath)) {
  console.error(`No store at ${dbPath}`);
  process.exit(1);
}

console.log("\nStore");
console.log(`  path            : ${dbPath}`);

const db = new Database(dbPath, { readonly: true });
try {
  const graphIds = (db.prepare("SELECT id FROM trace_graph").all() as { id: string }[]).map(
    (r) => r.id,
  );
  const graph = readGraph(db, graphIds[0] ?? "default");
  const totalSessions = (db.prepare("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n;

  if (graph === undefined) {
    console.log("\nNo trace graph. Record a session and let indexing finish, then run this again.");
    process.exitCode = 1;
  } else {
    const routes = frequentRoutes(graph);
    const flows: FlowsDTO = { graph: toGraphDTO(graph), routes, excludedApps: [] };
    const repeated = routes.filter((r) => r.walks.length > 1);
    const inGraph = new Set(routes.flatMap((r) => r.sessionIds));

    console.log("\nCorpus");
    console.log(`  recordings        : ${totalSessions}`);
    console.log(`  in the graph      : ${inGraph.size}`);
    console.log(`  routes            : ${routes.length}`);
    console.log(`  walked 2+ times   : ${repeated.length}`);

    // A rule can only be COMPARED on a route several recordings walked. Said
    // before the table, not after it, because a reader who sees numbers first
    // has already believed them.
    if (repeated.length === 0) {
      console.log(
        "\nNO ROUTE WAS WALKED MORE THAN ONCE, so all three rules are identical here and\n" +
          "nothing below is a measurement. Record the same task again and re-run.",
      );
      process.exitCode = 1;
    } else if (repeated.length < 3) {
      console.log(
        `\nONLY ${repeated.length} ROUTE${repeated.length === 1 ? " WAS" : "S WERE"} WALKED MORE ` +
          `THAN ONCE. The table below is an observation, not a verdict.`,
      );
    }

    console.log("\nRules");
    console.log("  rule       routes  deviant walks  deviations (skip/ins/reorder)");
    for (const rule of RULES) {
      let deviantWalks = 0;
      let totalWalks = 0;
      let skipped = 0;
      let inserted = 0;
      let reordered = 0;
      let noBaseline = 0;
      for (const route of repeated) {
        const out = walkAnalysis({ flows, route, rule });
        if (out.baseline.wayIndex === null) noBaseline += 1;
        for (const w of out.walks) {
          totalWalks += 1;
          if (w.deviations.length > 0) deviantWalks += 1;
          for (const d of w.deviations) {
            if (d.kind === "skipped") skipped += 1;
            else if (d.kind === "inserted") inserted += 1;
            else reordered += 1;
          }
        }
      }
      console.log(
        `  ${rule.padEnd(10)} ${String(repeated.length - noBaseline).padStart(6)}  ` +
          `${String(deviantWalks).padStart(6)}/${String(totalWalks).padEnd(6)}  ` +
          `${skipped}/${inserted}/${reordered}`,
      );
    }

    // THE FRAGILITY THAT MATTERS. Under `majority` a tie means the tiebreak is
    // carrying the whole decision, and a standard chosen that way is one more
    // recording away from moving. Cross-re-index stability is a different
    // question and belongs to probe:stability, which re-mines against a clone —
    // a read-only headless probe cannot answer it.
    const byTiebreak = repeated.filter((route) =>
      walkAnalysis({ flows, route, rule: "majority" }).baseline.reason.includes("tie at"),
    );
    console.log("\nFragility (majority)");
    console.log(`  chosen by tiebreak: ${byTiebreak.length} of ${repeated.length}`);
    for (const route of byTiebreak.slice(0, 5)) {
      console.log(`    ${route.name ?? route.label}`);
    }

    console.log("\nOther readings (majority)");
    let withAntecedents = 0;
    let withPrefix = 0;
    let dropped = 0;
    for (const route of repeated) {
      const out = walkAnalysis({ flows, route });
      if (out.antecedents.length > 0) withAntecedents += 1;
      if (out.droppedEarly.length > 0) {
        withPrefix += 1;
        dropped += out.droppedEarly.reduce((n, p) => n + p.count, 0);
      }
    }
    console.log(`  routes with a prefix route : ${withPrefix}`);
    console.log(`  recordings that dropped early: ${dropped}`);
    // Zero is EXPECTED here and says so, because this probe passes no hook —
    // antecedents need the focus stream, which lives in DeskRagService.
    console.log(
      `  routes with antecedents    : ${withAntecedents} (0 is expected: this probe passes no hook)`,
    );
    console.log("");
  }
} finally {
  db.close();
}
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add the entry immediately after `"probe:routes"` so the probes stay grouped:

```json
    "probe:baseline": "tsx scripts/baseline-probe.ts",
```

- [ ] **Step 3: Run the typecheck**

Run: `npm run typecheck`
Expected: PASS. (`scripts` is in the root `tsconfig.json` `include`, so the probe is gated like every other `.ts` probe.)

- [ ] **Step 4: Run the probe against the real store**

Run: `npm run probe:baseline`

Expected: it prints `Store`, `Corpus`, `Rules`, `Fragility (majority)` and `Other readings (majority)`. **Read the corpus line before reading anything else.** Three legitimate outcomes:

- *No trace graph* — exit code 1, with the instruction to record and index. Nothing to conclude.
- *No route walked more than once* — exit code 1, and the honest report is "the store cannot answer this yet." Do NOT change the default rule on this run.
- *Routes walked 2+ times* — the table is real. Record the numbers in the commit message.

- [ ] **Step 5: Document the probe in `CLAUDE.md`**

Add this entry to the commands block, immediately after the `npm run probe:routes` entry, matching the surrounding voice (a rule, then the measurement behind it):

```
npm run probe:baseline        # which rule a habit's walks should be measured against.
                              # walk-analysis.ts ships three -- majority, recent, none --
                              # and each is wrong differently: majority calls a recently
                              # adopted better path the deviation, recent lets one fumbled
                              # session become the standard, none cannot say WHEN the
                              # variation happened. Read-only and HEADLESS for probe:routes'
                              # reason: the app takes no single-instance lock and WRITES on
                              # startup, so launching it would make a second owner of SQLite.
                              # PRINTS THE CORPUS FIRST and exits 1 when no route was walked
                              # more than once -- there all three rules coincide and the
                              # table is not a measurement. Also reports how many baselines
                              # were chosen by TIEBREAK, which is the fragility that matters:
                              # a standard picked that way is one recording from moving.
```

- [ ] **Step 6: Run the gate**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 7: Commit**

Replace the bracketed figures with what the probe actually printed. If the corpus was too small to measure, say that instead of quoting a table — an unmeasured number in a commit message is how `graph-view.ts` came to quote a store that no longer exists.

```bash
git add scripts/baseline-probe.ts package.json CLAUDE.md
git commit -m "feat(habits): measure the three baseline rules on the real library

Read-only and headless for probe:routes' stated reason -- the app takes
no single-instance lock and writes on startup, so launching it would
make a second owner of SQLite and LanceDB.

Prints the corpus before the table and exits 1 when no route was walked
more than once, because there all three rules coincide and nothing
below the corpus line is a measurement.

Measured: [N recordings, M routes, K walked 2+ times; per-rule deviant
walks; T of K baselines chosen by tiebreak].

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After the plan

`walkAnalysis` has no caller yet — that is intentional and is what makes A independently reviewable. Wiring it into `DeskRagService` (which supplies the `antecedentAt` hook) and rendering it belongs to **sub-project B**, whose starting prompt is in `docs/todo.md`.

One thing to carry forward, and it is the honest outcome rather than a caveat: if `probe:baseline` reports that no route in the library was walked more than once, the projection is correct and produces nearly nothing. That is the state of the evidence, not a defect in the code — and it is also the signal that sub-project B should wait until the library can support it. Do not paper over it by rendering a thin block.
