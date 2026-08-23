# The Ledger Tells the Truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry sub-project B's `WalkAnalysis` across the DTO seam so the Habits ledger says which recordings followed the standard, the record's steps open their own moment, and a route started-and-dropped-early is disclosed on the row — with no score anywhere.

**Architecture:** One new pure module in `app/src/main` (`habit-marks.ts`) maps `WalkAnalysis` and `FlowWalk[]` into three new DTO fields; `deskrag-service.ts` only calls it, because it imports electron and the root suite cannot construct it. All display decisions live in `app/src/renderer/src/habits-view.ts`, which is `.ts` so the root suite can reach them. The `.tsx` draws and is verified by driving the running app.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), React 18, Vitest (root suite), one global `styles.css`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-08-23-habit-ledger-truth-design.md`

## Global Constraints

Every task's requirements implicitly include all of these. Violating one is a rejected task, not a nit.

- **No score of any kind.** No ratio, no percentage, no "3 of 4 conformant", no conformance bar, no streak, no grade. Counts and named states only. A habit-strength number is the `FrameResult.score` sin one layer up.
- **No `--data-warn`, `--data-alarm`, or `--data-ok` on a conformance state.** Conformance uses the neutral indexed slots only. `--data-ok` stays where it is, on `gained`.
- **`fit: null` NEVER draws as canonical.** Null means no standard exists (B's `count < 2` guard); canonical means a standard existed and this walk matched it.
- **Canonical keeps `--data-signal`.** A fully conforming library must be pixel-identical to today. The diff is the finding.
- **Never hand-edit a `--data-N` slot.** The data register is computed. Use the existing slots as they are.
- **Nothing in `walk-analysis.ts` or `walk-align.ts` changes.** A is merged; this is a consumer, exactly as B was.
- **No new MCP tool and no change under `app/src/main/mcp/`.** That is sub-project D.
- **Nothing pure goes in a `.tsx`.** The root `tsconfig.json` sets no `jsx`, so a root test touching a `.tsx` — even for a type — breaks `npm run typecheck`.
- **Nothing truncates.** A label fits or is withheld (`labelFits`). There is no `text-overflow: ellipsis` here.
- **Grep for a base class before minting one.** `styles.css` is one global sheet with no scoping, so a class name is a repo-wide identifier. Audit for undefined tokens — they fail silently.
- **NodeNext imports:** every relative import ends in `.js`. **`verbatimModuleSyntax`:** type-only imports written `import type`. **`noUncheckedIndexedAccess`:** `arr[i]` is `T | undefined`. **`exactOptionalPropertyTypes`:** build optionals with a spread.
- **`app/tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters`.** A helper introduced one task before its first caller fails the app gate. Introduce each in the task that uses it.
- **The app imports `dist/`, not `src/`.** A change to `src/` (the library) needs `npm run build` before `npm --prefix app run typecheck` sees it. No task here touches `src/`, but the gate below is the one that catches it if one does.
- **Gate after every task:** `npm run typecheck && npm --prefix app run typecheck && npm test`. Run them as three commands, not piped into `tail` — a pipe returns the exit code of `tail` and hides a failing typecheck.

---

### Task 1: `firstAt` becomes honest

The spec's riskiest open requirement, and it comes first because everything downstream opens a moment from this field.

`FlowStep.firstAt` documents itself as "the first recording that walked it" and reads `edge.sources[0]`. Sources accumulate in MERGE order as the graph is rebuilt, and nothing sorts them by time. Until now the field only fed text ("first at 20 Aug"), where being wrong is a cosmetic slip. Task 5 makes a step OPEN that moment, and a step that opens the wrong recording is a dead link wearing a working one.

**Files:**
- Modify: `app/src/main/flow-steps.ts` (`FlowStep.firstAt` gains `sessionId`; `stepsFor` picks the earliest source)
- Test: `test/flow-steps.test.ts`

**Interfaces:**
- Produces: `FlowStep.firstAt: { sessionId: string; startedAt: number; atSec: number } | null`.

- [ ] **Step 1: Write the failing test**

Append to `test/flow-steps.test.ts`. Reuse that file's existing `FlowsDTO` / edge builders — check the top of the file for their names before writing, and match them.

```ts
describe("firstAt is the EARLIEST source, not the first merged", () => {
  // Sources accumulate in merge order as the graph is rebuilt, so `sources[0]`
  // is whichever session was merged first — which is not the earliest whenever
  // a recording is re-indexed, or indexed out of order. The field's own name
  // promises otherwise, and Task 5 turns that promise into a link.
  const outOfOrder = (): FlowsDTO => {
    const f = oneEdgeFlows();
    f.graph.edges[0]!.sources = [
      { sessionId: "late", startedAt: 2_000_000_000_000, atSec: 1, throughSec: 2 },
      { sessionId: "early", startedAt: 1_000_000_000_000, atSec: 5, throughSec: 9 },
    ];
    return f;
  };

  it("picks the earliest by wall clock, whatever the array order", () => {
    const step = stepsFor(outOfOrder(), ["e0"], 2)[0]!;
    expect(step.firstAt?.sessionId).toBe("early");
    expect(step.firstAt?.startedAt).toBe(1_000_000_000_000);
  });

  it("carries the session id, because a moment needs a recording to open in", () => {
    const step = stepsFor(oneEdgeFlows(), ["e0"], 1)[0]!;
    expect(typeof step.firstAt?.sessionId).toBe("string");
    expect(step.firstAt?.sessionId).not.toBe("");
  });

  it("compares the MOMENT, not the recording's start", () => {
    // Two recordings on one day: the one that started later reached this edge
    // first. `startedAt` alone would pick the wrong one.
    const f = oneEdgeFlows();
    f.graph.edges[0]!.sources = [
      { sessionId: "a", startedAt: 1_000_000_000_000, atSec: 900, throughSec: 905 },
      { sessionId: "b", startedAt: 1_000_000_060_000, atSec: 2, throughSec: 6 },
    ];
    expect(stepsFor(f, ["e0"], 2)[0]!.firstAt?.sessionId).toBe("b");
  });

  it("is null when the edge carries no sources at all", () => {
    const f = oneEdgeFlows();
    f.graph.edges[0]!.sources = [];
    expect(stepsFor(f, ["e0"], 1)[0]!.firstAt).toBeNull();
  });
});
```

If `test/flow-steps.test.ts` has no single-edge fixture called `oneEdgeFlows`, write one beside the file's existing helpers: a `FlowsDTO` with two nodes, one edge `e0` between them, and one source. Do NOT invent a second fixture style — match what is there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/flow-steps.test.ts -t "EARLIEST source"`
Expected: FAIL — `sessionId` is not a property of `firstAt`, and the first case returns `"late"`.

- [ ] **Step 3: Widen the type**

In `app/src/main/flow-steps.ts`, replace the `firstAt` field of `FlowStep`:

```ts
  /**
   * The earliest recording that walked it, and where inside it. Null when the
   * edge carries no sources.
   *
   * `sources` can be SHORTER than `observations` — a graph lifted before
   * provenance has none at all, and deleting a recording removes its sources
   * while leaving the count it contributed. Never derive one from the other.
   *
   * SORTED, not `sources[0]`. Sources accumulate in the order sessions were
   * merged into the graph, which is not time order once anything is re-indexed;
   * the field's name promised otherwise and the Habits step instrument turns
   * that promise into a link. `atSec` is LANE seconds already — `toEdgeSources`
   * converts through `laneSec`, so nothing downstream may divide `tMono` again.
   */
  firstAt: { sessionId: string; startedAt: number; atSec: number } | null;
```

- [ ] **Step 4: Pick the earliest**

In `stepsFor`, replace `const first = edge.sources[0];` with:

```ts
    // The MOMENT, not the recording's start: a session that began later can
    // reach this edge first, and a route walked twice in one afternoon is the
    // ordinary case rather than the exotic one.
    const moment = (s: EdgeSourceDTO): number => s.startedAt + s.atSec * MS_PER_SEC;
    const first = [...edge.sources].sort((a, b) => moment(a) - moment(b))[0];
```

and the field:

```ts
      firstAt:
        first === undefined
          ? null
          : { sessionId: first.sessionId, startedAt: first.startedAt, atSec: first.atSec },
```

Add `MS_PER_SEC` beside the module's other constants if it has none:

```ts
const MS_PER_SEC = 1000;
```

and add `EdgeSourceDTO` to the `@shared/types` type import at the top of the file.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/flow-steps.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the gate**

Run these as three separate commands:
```
npm run typecheck
npm --prefix app run typecheck
npm test
```
Expected: all pass. `habit-doc.ts`'s `stepAt` reads `firstAt.startedAt + firstAt.atSec * 1000` and is unaffected by the added field; `mcp/flow-text.ts` reads `firstAt.startedAt` and `firstAt.atSec` and is likewise unaffected.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/flow-steps.ts test/flow-steps.test.ts
git commit -m "fix(flows): firstAt is the earliest source, and names its recording

The field documented itself as the first recording that walked an edge
and read sources[0]. Sources accumulate in MERGE order as the graph is
rebuilt, so the claim was true only until something was re-indexed. It
fed text, where being wrong is cosmetic; the Habits step instrument is
about to turn it into a link, and a step that opens the wrong recording
is a dead link wearing a working one.

Sorted by the MOMENT -- startedAt + atSec -- because a session that
began later can reach an edge first, and it now carries the sessionId a
jump needs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The DTO and the pure mapping

**Files:**
- Create: `app/src/main/habit-marks.ts`
- Create: `test/habit.marks.test.ts`
- Modify: `app/src/shared/types.ts` (three additions)
- Modify: `app/src/main/deskrag-service.ts` (two call sites)

**Interfaces:**
- Consumes: `walkAnalysis` and `type WalkAnalysis` from `./walk-analysis.js`; `flowWalks`, `type FlowWalk` from `./flow-steps.js`; `variantLetter` from `./habit-doc.js`.
- Produces:
  - `export function walkFits(flows: FlowsDTO, route: FlowRouteDTO): Map<string, WalkFitDTO>` — keyed by sessionId.
  - `export function habitWays(flows: FlowsDTO, route: FlowRouteDTO): HabitWayDTO[]`
  - `export function droppedEarlyOf(flows: FlowsDTO, route: FlowRouteDTO): DroppedEarlyDTO[]`

- [ ] **Step 1: Add the DTO fields**

In `app/src/shared/types.ts`, add above `WalkMarkDTO`:

```ts
/**
 * How one recording's walk compared to the standard — COUNTS, never a verdict.
 *
 * The three counts and `reachedEnd` are what `WalkFit` carries; the display
 * state is derived in `habits-view.ts`, which is `.ts` so the root suite can
 * watch it change. A `kind: "deviated"` field here would put that decision in
 * main, where no root test can see it.
 *
 * There is deliberately no ratio and no fitness float. `Baseline.reason` says
 * the standard is chosen from the recordings themselves and is frequently
 * tiebroken, so a deviation may be the BETTER path — a number would grade
 * something the record declines to grade.
 */
export interface WalkFitDTO {
  inserted: number;
  skipped: number;
  reordered: number;
  reachedEnd: boolean;
}
```

Add to `WalkMarkDTO`, after `walk`:

```ts
  /**
   * How this recording compared to the standard, or null when there is no
   * standard to compare against.
   *
   * NULL IS NOT "CONFORMANT". A habit recorded once has nothing to be
   * consistent with, and drawing it in the canonical hue would claim it passed
   * a check that was never run. Null under the same guard the record uses:
   * fewer than two recordings, or no baseline way.
   */
  fit: WalkFitDTO | null;
```

Add above `HabitDTO`:

```ts
/** One step of one Way, structured so it can be drawn as an instrument. */
export interface HabitStepDTO {
  index: number;
  edgeId: string;
  from: string;
  to: string;
  actions: { action: string; target: string }[];
  observations: number;
  everyRecording: boolean;
  /** The edge is not in the graph — an index defect, carried rather than dropped. */
  missing: boolean;
  /**
   * The earliest recording that walked it, in LANE seconds. Null when the edge
   * carries no sources, and then the step is drawn with its reason and nothing
   * to open — the `StageSpec.skipReason` rule.
   */
  firstAt: { sessionId: string; startedAt: number; atSec: number } | null;
}

/** One distinct path through the route, with the recordings that took it. */
export interface HabitWayDTO {
  /** "A", "B", … — the same letter the record prints. */
  letter: string;
  sessionIds: string[];
  steps: HabitStepDTO[];
}

/**
 * A shorter route whose places are a strict PREFIX of this one's — the same
 * work begun and abandoned partway.
 *
 * A DISCLOSURE and never a merge. Those recordings walked a DIFFERENT route
 * with its own key, so they are not in `binding.walks` and must never be drawn
 * on this habit's ledger; `binding.recordings` is untouched.
 */
export interface DroppedEarlyDTO {
  places: string[];
  count: number;
}
```

Add to `HabitDTO`, after `duplicates`:

```ts
  /** The record's Ways, structured, so its steps can open their own moment. */
  ways: HabitWayDTO[];
  /** Empty is the common case. See `DroppedEarlyDTO`. */
  droppedEarly: DroppedEarlyDTO[];
```

- [ ] **Step 2: Write the failing test**

Create `test/habit.marks.test.ts`. The `divergent()` fixture is the one B added to `test/habit.doc.test.ts` — copy it verbatim into this file rather than importing across test files, which the suite does not do anywhere.

```ts
import { describe, expect, it } from "vitest";
import { droppedEarlyOf, habitWays, walkFits } from "../app/src/main/habit-marks.js";
import type { FlowsDTO, GraphEdgeDTO, GraphNodeDTO } from "@shared/types";

/**
 * The mapping from B's projection to the three DTO fields the screen draws.
 *
 * In a pure module and not in `deskrag-service.ts`, which imports electron and
 * so cannot be constructed by the root suite at all — the same constraint that
 * produced `habit-doc.ts` and `probe:merge`.
 */

const node = (id: string, label: string, extra: Partial<GraphNodeDTO> = {}): GraphNodeDTO => ({
  id,
  label,
  chip: id,
  observations: 2,
  predicates: ["app(TextEdit)"],
  locatable: true,
  intervene: "none",
  rank: 0,
  sources: [],
  ...extra,
});

const T_TUE = Date.UTC(2026, 2, 3, 12, 0, 0);
const DAY_MS = 86_400_000;

/**
 * The same three-hop, three-Way fixture the record's own tests use.
 *
 *   s1 (Tue) e0,e1        1 skipped,              stops short
 *   s2 (Wed) e0,e3        2 skipped, 1 inserted,  stops short
 *   s3 (Thu) e0,e1,e2     the standard (newest, wins the 3-way tie)
 */
function divergent(): FlowsDTO {
  const mk = (
    id: string,
    from: string,
    to: string,
    sources: { sessionId: string; startedAt: number; atSec: number; throughSec: number }[],
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
  const at = (sessionId: string, day: number, atSec: number, throughSec: number) => ({
    sessionId,
    startedAt: T_TUE + day * DAY_MS,
    atSec,
    throughSec,
  });

  return {
    graph: {
      id: "g",
      entry: "n0",
      nodes: [
        node("n0", "Calculator", { app: "Calculator" }),
        node("n1", "TextEdit", { app: "TextEdit" }),
        node("n2", "Finder", { app: "Finder" }),
      ],
      edges: [
        mk("e0", "n0", "n1", [at("s1", 0, 2, 6), at("s2", 1, 2, 5), at("s3", 2, 2, 6)]),
        mk("e1", "n1", "n2", [at("s1", 0, 8, 12), at("s3", 2, 8, 11)]),
        mk("e2", "n2", "n0", [at("s3", 2, 14, 18)]),
        mk("e3", "n1", "n0", [at("s2", 1, 9, 10)]),
      ],
      slots: [],
    },
    excludedApps: [],
    routes: [
      {
        id: "Calculator → TextEdit",
        count: 3,
        label: "Calculator → TextEdit",
        name: null,
        nameObservations: 0,
        nodeIds: ["n0", "n1", "n2"],
        edgeIds: ["e0", "e1", "e2", "e3"],
        sessionIds: ["s1", "s2", "s3"],
        variants: [],
        walks: [
          { sessionId: "s1", edgeIds: ["e0", "e1"], atSec: 2, throughSec: 12 },
          { sessionId: "s2", edgeIds: ["e0", "e3"], atSec: 2, throughSec: 10 },
          { sessionId: "s3", edgeIds: ["e0", "e1", "e2"], atSec: 2, throughSec: 18 },
        ],
      },
    ],
  };
}

/** One recording, one edge — the case with no standard to compare against. */
function once(): FlowsDTO {
  const f = divergent();
  f.routes[0]!.count = 1;
  f.routes[0]!.sessionIds = ["s3"];
  f.routes[0]!.walks = [{ sessionId: "s3", edgeIds: ["e0"], atSec: 2, throughSec: 6 }];
  return f;
}

describe("walkFits", () => {
  it("gives one fit per recording that walked the route", () => {
    const f = divergent();
    const fits = walkFits(f, f.routes[0]!);
    expect([...fits.keys()].sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("counts the deviations by kind, and never a ratio", () => {
    const f = divergent();
    const fits = walkFits(f, f.routes[0]!);
    expect(fits.get("s2")).toEqual({ inserted: 1, skipped: 2, reordered: 0, reachedEnd: false });
  });

  it("gives the standard's own walk a clean fit", () => {
    const f = divergent();
    expect(walkFits(f, f.routes[0]!).get("s3")).toEqual({
      inserted: 0,
      skipped: 0,
      reordered: 0,
      reachedEnd: true,
    });
  });

  it("says a walk stopped before the end", () => {
    const f = divergent();
    expect(walkFits(f, f.routes[0]!).get("s1")?.reachedEnd).toBe(false);
  });

  it("is EMPTY for a route recorded once — null is not conformant", () => {
    // The record's own guard. One walk has nothing to be consistent with, and a
    // fit here would claim it passed a check that was never run.
    const f = once();
    expect(walkFits(f, f.routes[0]!).size).toBe(0);
  });
});

describe("habitWays", () => {
  it("returns one way per distinct path, lettered as the record letters them", () => {
    const f = divergent();
    const ways = habitWays(f, f.routes[0]!);
    expect(ways.map((w) => w.letter)).toEqual(["A", "B", "C"]);
  });

  it("carries the recordings that took each way", () => {
    const f = divergent();
    const all = habitWays(f, f.routes[0]!).flatMap((w) => w.sessionIds);
    expect(all.sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("carries each step's own moment, with the recording to open it in", () => {
    const f = divergent();
    const step = habitWays(f, f.routes[0]!)[0]!.steps[0]!;
    expect(step.firstAt?.sessionId).toBe("s1");
    expect(step.firstAt?.atSec).toBe(2);
  });

  it("names the places a step moves between", () => {
    const f = divergent();
    const step = habitWays(f, f.routes[0]!)[0]!.steps[0]!;
    expect(step.from).toBe("Calculator");
    expect(step.to).toBe("TextEdit");
  });

  it("carries no slot samples — a recorded keystroke never reaches the screen twice", () => {
    // `showSamples` is a per-habit toggle honoured by the RENDERED FILE. The DTO
    // that draws the instrument has no toggle, so it carries no values at all.
    const f = divergent();
    const json = JSON.stringify(habitWays(f, f.routes[0]!));
    expect(json).not.toMatch(/samples/);
  });
});

describe("droppedEarlyOf", () => {
  it("is empty when no route is a prefix of this one", () => {
    const f = divergent();
    expect(droppedEarlyOf(f, f.routes[0]!)).toEqual([]);
  });

  it("names the places a prefix route reached, and how many did it", () => {
    const f = divergent();
    f.routes.push({
      id: "Calculator",
      count: 2,
      label: "Calculator",
      name: null,
      nameObservations: 0,
      nodeIds: ["n0"],
      edgeIds: [],
      sessionIds: ["s8", "s9"],
      variants: [],
      walks: [],
    });
    expect(droppedEarlyOf(f, f.routes[0]!)).toEqual([{ places: ["Calculator"], count: 2 }]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/habit.marks.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Write the module**

Create `app/src/main/habit-marks.ts`:

```ts
/**
 * B's projection, mapped into the three fields the Habits screen draws.
 *
 * A pure module rather than a method on `DeskRagService`, which imports electron
 * and therefore cannot be constructed by the root suite at all — the same
 * constraint that produced `habit-doc.ts`, and the reason `probe:merge` and
 * `probe:reflect` exist. Everything decidable is decided here, where a test can
 * watch it.
 *
 * FACTS ONLY. The display state — canonical, deviated, stopped short — is
 * derived in `habits-view.ts`, which is `.ts` so the root suite can reach it
 * too. Deciding it here would put a rendering choice on the wrong side of the
 * process boundary, where no root test can see it change.
 */

import type {
  DroppedEarlyDTO,
  FlowRouteDTO,
  FlowsDTO,
  HabitStepDTO,
  HabitWayDTO,
  WalkFitDTO,
} from "@shared/types";
import { flowWalks, type FlowStep } from "./flow-steps.js";
import { variantLetter } from "./habit-doc.js";
import { walkAnalysis } from "./walk-analysis.js";

/**
 * Each recording's fit against the standard, keyed by session.
 *
 * EMPTY, never a map of zeroes, when there is no standard: `walkAnalysis`
 * returns `baseline.wayIndex === null` for a route recorded once, and a fit of
 * all-zeroes would be indistinguishable from a recording that matched. The
 * screen's `fit: null` says "nothing was compared" and must stay able to.
 */
export function walkFits(flows: FlowsDTO, route: FlowRouteDTO): Map<string, WalkFitDTO> {
  const out = new Map<string, WalkFitDTO>();
  if (route.count < 2) return out;

  const analysis = walkAnalysis({ flows, route });
  if (analysis.baseline.wayIndex === null || analysis.walks.length < 2) return out;

  for (const w of analysis.walks) {
    out.set(w.sessionId, {
      inserted: w.deviations.filter((d) => d.kind === "inserted").length,
      skipped: w.deviations.filter((d) => d.kind === "skipped").length,
      reordered: w.deviations.filter((d) => d.kind === "reordered").length,
      reachedEnd: w.reachedEnd,
    });
  }
  return out;
}

/**
 * A step, stripped to what the instrument draws.
 *
 * `FlowStepAction` carries a `slot` with its recorded `samples`; this drops it.
 * Whether the rendered FILE prints values is a per-habit toggle, and the DTO
 * that feeds a pixel has no toggle — so it carries no values at all, the same
 * rule `HabitBrief` holds against the model.
 */
function toStep(step: FlowStep): HabitStepDTO {
  return {
    index: step.index,
    edgeId: step.edgeId,
    from: step.from,
    to: step.to,
    actions: step.actions.map((a) => ({ action: a.action, target: a.target })),
    observations: step.observations,
    everyRecording: step.everyRecording,
    missing: step.missing,
    firstAt:
      step.firstAt === null
        ? null
        : {
            sessionId: step.firstAt.sessionId,
            startedAt: step.firstAt.startedAt,
            atSec: step.firstAt.atSec,
          },
  };
}

/**
 * The record's Ways, structured.
 *
 * `flowWalks` and `variantLetter` are the record's OWN functions, so the
 * instrument and the file cannot letter or order the ways differently. Two
 * renderers of one thing is the `ax-dump`/`ax-exec` drift hazard; they are safe
 * here only because both read this same `FlowWalk[]`, and neither parses the
 * other's output.
 */
export function habitWays(flows: FlowsDTO, route: FlowRouteDTO): HabitWayDTO[] {
  return flowWalks(flows, route).map((w) => ({
    letter: variantLetter(w.index),
    sessionIds: [...w.sessionIds],
    steps: w.steps.map(toStep),
  }));
}

/** A's strict-prefix relation, as the screen's own shape. */
export function droppedEarlyOf(flows: FlowsDTO, route: FlowRouteDTO): DroppedEarlyDTO[] {
  return walkAnalysis({ flows, route }).droppedEarly.map((p) => ({
    places: [...p.places],
    count: p.count,
  }));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/habit.marks.test.ts`
Expected: PASS. If `walkFits` returns a fit for `s3` with `reachedEnd: false`, re-read `chooseBaseline` — the standard's own walk must reach its own end.

- [ ] **Step 6: Wire the kept-habit site**

In `app/src/main/deskrag-service.ts`, add to the imports:

```ts
import { droppedEarlyOf, habitWays, walkFits } from "./habit-marks.js";
```

In the method that builds a `HabitDTO` (the one holding `const walks = walkMarks(walkIds, startedAt, gained, bound.route?.walks ?? []);`), replace that line with:

```ts
    // The fits come from the LIVE route, because that is what the ledger is
    // drawn against. With no live route there is nothing to compare and every
    // mark carries `fit: null` — which the screen draws as "no standard", never
    // as "conformant".
    const fits =
      flows !== null && bound.route !== null ? walkFits(flows, bound.route) : new Map();
    const walks = walkMarks(
      walkIds,
      startedAt,
      gained,
      bound.route?.walks ?? [],
      fits,
    );
```

and in the returned `HabitDTO` object literal, after `duplicates`:

```ts
      ways: flows !== null && bound.route !== null ? habitWays(flows, bound.route) : [],
      droppedEarly:
        flows !== null && bound.route !== null ? droppedEarlyOf(flows, bound.route) : [],
```

- [ ] **Step 7: Teach `walkMarks` the fit**

In `app/src/main/habit-bind.ts`, add a fifth parameter to `walkMarks` — OPTIONAL with an empty default, so no existing caller or test moves:

```ts
export function walkMarks(
  sessionIds: readonly string[],
  startedAt: ReadonlyMap<string, number>,
  gained: ReadonlySet<string>,
  walks: readonly RouteWalkDTO[] = [],
  /**
   * How each recording compared to the standard, keyed by session.
   *
   * Absent for a proposal and for an orphaned habit, and a session missing from
   * it gets `fit: null` — which means NO STANDARD EXISTED, not "it conformed".
   */
  fits: ReadonlyMap<string, WalkFitDTO> = new Map(),
): WalkMarkDTO[] {
```

and inside the loop, add to the pushed object:

```ts
      fit: fits.get(sessionId) ?? null,
```

Add `WalkFitDTO` to that file's `@shared/types` type import.

- [ ] **Step 8: Wire the proposal site**

A proposal has no keeping act, but it does have recordings that went different ways, and the proposal preview ledger is one of the two interactive ones. In the same file, replace:

```ts
        walks: walkMarks(route.sessionIds, startedAt, new Set(), route.walks),
```

with:

```ts
        // Never `gained`: nobody has kept this, so there is no keeping act for
        // a recording to have arrived after. The fits are real either way — a
        // proposal's recordings diverged or they did not.
        walks: walkMarks(
          route.sessionIds,
          startedAt,
          new Set(),
          route.walks,
          flows === null ? new Map() : walkFits(flows, route),
        ),
```

- [ ] **Step 9: Run the gate**

Run these as three separate commands:
```
npm run typecheck
npm --prefix app run typecheck
npm test
```
Expected: all pass. Existing fixtures need the new required fields. Find the `HabitDTO` literals with `grep -rn "duplicates:" test` and the `WalkMarkDTO` literals with `grep -rn "gained:" test` — the latter are not all near a `HabitDTO`, and `fit` is required on every one.

- [ ] **Step 10: Commit**

```bash
git add app/src/shared/types.ts app/src/main/habit-marks.ts app/src/main/habit-bind.ts app/src/main/deskrag-service.ts test/habit.marks.test.ts test/habits-view.test.ts test/mcp.tools.test.ts
git commit -m "feat(habits): carry the walk projection across the DTO seam

B computed conformance and held a no-DTO-widening constraint, so none of
it could reach a pixel: the ledger drew four identical dots for four
recordings that went four different ways.

The mapping is a pure module rather than a service method, because
deskrag-service.ts imports electron and the root suite cannot construct
it. It carries FACTS -- three counts and reachedEnd -- and leaves the
display state to habits-view.ts, which a root test can watch.

fit is null when there is no standard, and null is not conformant: a
habit recorded once has nothing to be consistent with, and a map of
zeroes would be indistinguishable from a recording that matched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `markStates` and the label clause

**Files:**
- Modify: `app/src/renderer/src/habits-view.ts`
- Test: `test/habits-view.test.ts`

**Interfaces:**
- Produces:
  - `export type MarkState = "lone" | "canonical" | "deviated" | "short" | null;`
  - `export function markStates(marks: readonly LedgerMark[]): MarkState[];`
  - `MarkReadout.fit: string | null`, joined by the existing `markLabel`.

- [ ] **Step 1: Write the failing test**

Append to `test/habits-view.test.ts`. Match that file's existing `WalkMarkDTO` builder — check its name before writing; the snippet below assumes one called `walk`.

```ts
const fit = (over: Partial<WalkFitDTO> = {}): WalkFitDTO => ({
  inserted: 0,
  skipped: 0,
  reordered: 0,
  reachedEnd: true,
  ...over,
});

const marksOf = (walks: readonly WalkMarkDTO[]): LedgerMark[] =>
  ledgerMarks(walks, { from: 0, to: 10_000 });

describe("markStates", () => {
  it("takes the ROW, because lone is a property of the row", () => {
    // A per-mark signature could not see it, which is the same positional
    // coupling `LedgerMark.walk` is carried to avoid.
    const one = marksOf([walk({ sessionId: "s1", at: 0 })]);
    expect(markStates(one)).toEqual(["lone"]);
  });

  it("is null when no standard exists, and null is not canonical", () => {
    const two = marksOf([
      walk({ sessionId: "s1", at: 0, fit: null }),
      walk({ sessionId: "s2", at: 5_000, fit: null }),
    ]);
    expect(markStates(two)).toEqual([null, null]);
  });

  it("calls a clean fit canonical", () => {
    const two = marksOf([
      walk({ sessionId: "s1", at: 0, fit: fit() }),
      walk({ sessionId: "s2", at: 5_000, fit: fit() }),
    ]);
    expect(markStates(two)).toEqual(["canonical", "canonical"]);
  });

  it("calls any non-zero count deviated", () => {
    const two = marksOf([
      walk({ sessionId: "s1", at: 0, fit: fit() }),
      walk({ sessionId: "s2", at: 5_000, fit: fit({ skipped: 1 }) }),
    ]);
    expect(markStates(two)[1]).toBe("deviated");
  });

  it("lets short OUTRANK deviated", () => {
    // Stopping before the end is the larger fact, and a walk that stopped will
    // almost always also show skipped steps — reporting it as merely deviated
    // would bury the reason. The card says both.
    const two = marksOf([
      walk({ sessionId: "s1", at: 0, fit: fit() }),
      walk({ sessionId: "s2", at: 5_000, fit: fit({ skipped: 3, reachedEnd: false }) }),
    ]);
    expect(markStates(two)[1]).toBe("short");
  });

  it("never returns a state for a lone mark, whatever its fit", () => {
    const one = marksOf([walk({ sessionId: "s1", at: 0, fit: fit({ skipped: 2 }) })]);
    expect(markStates(one)).toEqual(["lone"]);
  });
});

describe("the mark says how it compared", () => {
  const readoutOf = (w: WalkMarkDTO) =>
    markReadout(w, { wallClock: () => "18 Aug 2026", timecode: () => "00:00:05" });

  it("says nothing when there is no standard", () => {
    expect(readoutOf(walk({ sessionId: "s1", at: 0, fit: null })).fit).toBeNull();
  });

  it("says it followed the standard when it did", () => {
    expect(readoutOf(walk({ sessionId: "s1", at: 0, fit: fit() })).fit).toMatch(
      /followed the standard/,
    );
  });

  it("counts what differed, in the record's own words", () => {
    const r = readoutOf(walk({ sessionId: "s1", at: 0, fit: fit({ inserted: 1, skipped: 2 }) }));
    expect(r.fit).toMatch(/1 step not in the standard/);
    expect(r.fit).toMatch(/2 of the standard's steps not taken/);
  });

  it("says it stopped before the end", () => {
    const r = readoutOf(walk({ sessionId: "s1", at: 0, fit: fit({ reachedEnd: false }) }));
    expect(r.fit).toMatch(/Stopped before the end/);
  });

  it("reaches markLabel, so a screen reader hears it too", () => {
    const w = walk({ sessionId: "s1", at: 0, fit: fit({ skipped: 1 }) });
    expect(markLabel(readoutOf(w))).toMatch(/not taken/);
  });

  it("carries no percentage and no grade", () => {
    const r = readoutOf(walk({ sessionId: "s1", at: 0, fit: fit({ skipped: 1 }) }));
    expect(r.fit).not.toMatch(/\d+%/);
    expect(r.fit).not.toMatch(/wrong|failed|bad|worse|poor/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/habits-view.test.ts -t "markStates"`
Expected: FAIL — `markStates` is not exported.

- [ ] **Step 3: Write `markStates`**

In `app/src/renderer/src/habits-view.ts`, add below `ledgerMarks`:

```ts
/**
 * What a mark says about itself, per row.
 *
 * `lone` and conformance are MUTUALLY EXCLUSIVE BY CONSTRUCTION: the ring means
 * exactly one recording, and a standard needs two walks to exist at all. That is
 * the only reason a third channel fits on a seven-pixel dot — the ring is free
 * wherever conformance is possible.
 *
 * Takes the ROW, not one mark, because `lone` is a property of the row and a
 * per-mark signature could not see it.
 *
 * NULL IS NOT CANONICAL. Null means no standard existed; canonical means one
 * existed and this walk matched it. Drawing them alike would claim a habit
 * recorded once passed a check that was never run.
 */
export type MarkState = "lone" | "canonical" | "deviated" | "short" | null;

export function markStates(marks: readonly LedgerMark[]): MarkState[] {
  if (marks.length === 1) return ["lone"];
  return marks.map((m) => {
    const fit = m.walk.fit;
    if (fit === null) return null;
    // SHORT OUTRANKS DEVIATED. A walk that stopped will almost always also show
    // skipped steps, and reporting it as merely deviated buries the reason.
    if (!fit.reachedEnd) return "short";
    return fit.inserted + fit.skipped + fit.reordered > 0 ? "deviated" : "canonical";
  });
}
```

- [ ] **Step 4: Add the clause**

In the same file, add to `MarkReadout` after `steps`:

```ts
  /**
   * How this recording compared to the standard. Null when none exists.
   *
   * Worded from `differBlock`'s own sentences, so the file and the screen cannot
   * describe one recording differently — the same rule that made `differBlock`
   * carry `Baseline.reason` verbatim.
   */
  fit: string | null;
```

and in `markReadout`'s returned object, after `steps`:

```ts
    fit: fitClause(mark.fit),
```

Add above `markReadout`:

```ts
/** The fit in words, or null. COUNTS, never a grade — a deviation is not a failure. */
function fitClause(fit: WalkFitDTO | null): string | null {
  if (fit === null) return null;
  const bits: string[] = [];
  if (fit.inserted > 0) {
    bits.push(`${fit.inserted} step${fit.inserted === 1 ? "" : "s"} not in the standard`);
  }
  if (fit.skipped > 0) bits.push(`${fit.skipped} of the standard's steps not taken`);
  if (fit.reordered > 0) {
    bits.push(`${fit.reordered} step${fit.reordered === 1 ? "" : "s"} taken in a different order`);
  }
  const head = bits.length === 0 ? "Followed the standard" : bits.join(", ");
  return fit.reachedEnd ? `${head}.` : `${head}. Stopped before the end.`;
}
```

Add `WalkFitDTO` to the file's `@shared/types` type import.

- [ ] **Step 5: Join it in `markLabel`**

Replace `markLabel`'s array with:

```ts
  return [readout.when, readout.at, readout.steps, readout.fit, readout.note]
```

The fit sits before `note` because `note` is the affordance's caveat and reads last.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/habits-view.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the gate**

```
npm run typecheck
npm --prefix app run typecheck
npm test
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add app/src/renderer/src/habits-view.ts test/habits-view.test.ts
git commit -m "feat(habits): a mark says how that recording compared

markStates takes the ROW, because lone is a property of the row -- a
per-mark signature could not see it, the same positional coupling
LedgerMark.walk is carried to avoid. lone and conformance are mutually
exclusive by construction, which is the only reason a third channel fits
on a seven-pixel dot.

Short outranks deviated: a walk that stopped will almost always also
show skipped steps, and calling it merely deviated buries the reason.

The clause is worded from differBlock's own sentences so the file and
the screen cannot describe one recording differently, and it reaches
markLabel, so a screen reader hears what a pointer sees.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The ledger draws it

The first task with no root-suite coverage of its output. It is verified by driving the running app.

**Files:**
- Modify: `app/src/renderer/src/screens/HabitsScreen.tsx` (`Ledger`'s `tone`, `MarkCard`, a legend)
- Modify: `app/src/renderer/src/styles.css`

- [ ] **Step 1: Take the hues**

In `styles.css`, immediately after the `.ledger__mark.is-gained` rule, add:

```css
/* CONFORMANCE, in the NEUTRAL indexed slots and never in warn/alarm.
   Baseline.reason says the standard is chosen from the recordings themselves
   and is frequently tiebroken -- the record prints "a different recording could
   become the standard as soon as one more is made" -- so a deviation may be the
   BETTER path. Amber would make the screen assert what the file it mirrors
   deliberately declines to assert, and a graded ledger is the streak-shaped-UI
   backfire this screen exists to avoid.
   Canonical is left alone: it keeps --data-signal, so a library where every
   recording conformed is pixel-identical to before this shipped. */
.ledger__mark.is-deviated { background: var(--data-2); }
.ledger__mark.is-short { background: var(--data-3); }
```

Then change `.is-gained` from a fill to a ring, keeping its colour:

```css
/* Recorded AFTER the habit was kept -- the only evidence on this screen that
   something is still being practised rather than merely written down. A RING
   now rather than a fill: the fill carries conformance, and this is the channel
   that loses least, because a recording made after the keep is necessarily
   rightward on the axis and position already half-tells it. */
.ledger__mark.is-gained { box-shadow: 0 0 0 1.5px var(--data-ok); }
```

- [ ] **Step 2: Draw the state**

In `HabitsScreen.tsx`, add `markStates` to the `habits-view.js` import and replace the `lone` / `tone` pair inside `Ledger`:

```ts
  // A single mark is drawn HOLLOW. It is the one visual difference between an
  // observation and a habit, and it has to survive being glanced at.
  const states = markStates(marks);
  const tone = (m: LedgerMark, i: number): string => {
    const state = states[i];
    return [
      "ledger__mark",
      state === "lone" ? "is-lone" : "",
      state === "deviated" ? "is-deviated" : "",
      state === "short" ? "is-short" : "",
      // Last, so the ring composes over whichever fill the state chose.
      m.gained ? "is-gained" : "",
    ]
      .filter((c) => c !== "")
      .join(" ");
  };
```

and update both call sites to pass the index — `marks.map((m, i) => …)` in the `aria-hidden` branch and in the interactive one, each using `tone(m, i)`.

The `:hover` / `:focus-visible` rules already target `.ledger__mark:not(.is-lone)` and set `background`, so a deviated mark still highlights to `--accent` on hover with no CSS change.

- [ ] **Step 3: Say it on the card**

In `MarkCard`, after the `ledger__tip-at` block and before the note, add:

```tsx
      {readout.fit !== null && <div className="ledger__tip-fit">{readout.fit}</div>}
```

and in `styles.css`, beside the other `.ledger__tip-*` rules:

```css
.ledger__tip-fit { font-size: var(--t-meta); color: var(--text); margin-top: var(--s1); }
```

`--t-meta` and `--s1` are both already used by the neighbouring rules; do not introduce a raw pixel size.

- [ ] **Step 4: One legend, in the editor masthead**

Add above the `HabitsScreen` component:

```tsx
/**
 * What the three hues mean, said once.
 *
 * Beside the LEAD ledger only, never per row: four legends down a list is
 * chrome, and a row's ledger is `aria-hidden` decoration beside words that
 * already state the fact.
 *
 * The last sentence is load-bearing and is not decoration. A key reading
 * "followed / differed / stopped short" and stopping smuggles a grade back in
 * through the ordering alone — this is the one place in the sub-project where
 * the no-grade rule is carried by prose rather than by structure.
 */
function LedgerLegend(): React.JSX.Element {
  return (
    <div className="ledger-legend">
      <span className="ledger-legend__item">
        <span className="ledger__mark ledger-legend__swatch" /> followed the standard
      </span>
      <span className="ledger-legend__item">
        <span className="ledger__mark ledger-legend__swatch is-deviated" /> went another way
      </span>
      <span className="ledger-legend__item">
        <span className="ledger__mark ledger-legend__swatch is-short" /> stopped before the end
      </span>
      <p className="ledger-legend__note">
        The standard is whichever way these recordings most agreed on, and it moves as you
        record more. Going another way is not a mistake.
      </p>
    </div>
  );
}
```

Render it in the editor masthead directly below the lead `Ledger`, and ONLY when at least one mark has a fit:

```tsx
        {b.walks.some((w) => w.fit !== null) && <LedgerLegend />}
```

and in `styles.css`:

```css
/* Beside the LEAD ledger only. The swatch is the real mark class, so a hue can
   never be restated here and drift from the thing it explains. */
.ledger-legend { display: flex; flex-wrap: wrap; gap: var(--s2); margin-top: var(--s2); }
.ledger-legend__item {
  display: inline-flex; align-items: center; gap: var(--s1);
  font-size: var(--t-meta); color: var(--muted);
}
.ledger-legend__swatch { position: static; margin: 0; }
.ledger-legend__note {
  flex-basis: 100%; margin: 0; font-size: var(--t-meta); color: var(--muted);
}
```

Confirm `--s2` exists before using it; if the sheet's scale names differ, use the neighbouring rules' spacing tokens rather than a raw pixel value.

- [ ] **Step 5: Run the gate**

```
npm run typecheck
npm --prefix app run typecheck
npm test
```
Expected: all pass.

- [ ] **Step 6: Look at it in the running app**

Build and drive it — this repo's pixel rules were all found this way, never by reading CSS:

```
npm run build
npm run app:dev
```

Use the `run-app` skill to select the one kept habit and read, with `getBoundingClientRect()` and computed styles:

1. Three marks, of which two are `--data-2` violet or `--data-3` clay and one is `--data-signal`. (Measured on the real store: the recurring route has three Ways, s3 is the standard, s1 and s2 both stopped short.)
2. The mark is still exactly 9px in the lead ledger and 7px in a row — the ring must not have widened it. `box-shadow` does not affect layout; confirm rather than assume.
3. The legend renders once, and the page still does not scroll.
4. Hover a deviated mark: the card carries the fit clause and the mark highlights to `--accent`.
5. `Tab` to a mark and read its `aria-label` — the clause must be in it.
6. **Read the legend's last sentence on screen.** It is the one place in this
   sub-project where the no-grade rule is carried by prose rather than by
   structure, and the spec names it as an open derived requirement. If it reads
   as a scolding, or if the three items read as a ranking, rewrite it now —
   nothing downstream will catch it.

- [ ] **Step 7: Commit**

```bash
git add app/src/renderer/src/screens/HabitsScreen.tsx app/src/renderer/src/styles.css
git commit -m "feat(habits): the ledger says which recordings followed the standard

Neutral indexed hues, never warn or alarm. The record says the standard
is tiebroken and can move, so a deviation may be the better path, and
amber would make the screen assert what the file declines to. Canonical
keeps --data-signal, so a fully conforming library is pixel-identical to
before this shipped and the diff is the finding.

gained moves from fill to a ring, keeping --data-ok: the fill now
carries conformance, and gained is the channel that loses least, because
a recording made after the keep is necessarily rightward on the axis.

One legend, beside the lead ledger. Its last sentence says that going
another way is not a mistake -- the one place here the no-grade rule is
carried by prose rather than by structure.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The record well splits

**Files:**
- Modify: `app/src/renderer/src/habits-view.ts` (`recordTail`)
- Modify: `app/src/renderer/src/screens/HabitsScreen.tsx` (the steps instrument)
- Modify: `app/src/renderer/src/styles.css`
- Test: `test/habits-view.test.ts`

**Interfaces:**
- Produces: `export function recordTail(markdown: string): string;`

- [ ] **Step 1: Write the failing test**

Append to `test/habits-view.test.ts`:

```ts
describe("recordTail", () => {
  // The steps become an instrument, so the <pre> holds the record FROM THE NEXT
  // HEADING DOWN. `## How the recordings differ` only exists at count >= 2, so
  // the tail cannot be found by name — it is the first heading after the steps.
  const doc = (...sections: string[]): string =>
    ["---", "name: x", "---", "", "Prose.", "", ...sections].join("\n");

  it("starts at the heading after the recorded steps", () => {
    const md = doc("## Recorded steps", "", "1. A → B", "", "## What varies", "", "Nothing.");
    expect(recordTail(md)).toMatch(/^## What varies/);
  });

  it("finds it whatever the next heading is called", () => {
    // A single-recording habit has no "How the recordings differ" section.
    const md = doc("## Recorded steps", "", "1. A → B", "", "## Evidence", "", "Once.");
    expect(recordTail(md)).toMatch(/^## Evidence/);
  });

  it("is empty when the record ends at the steps", () => {
    expect(recordTail(doc("## Recorded steps", "", "1. A → B"))).toBe("");
  });

  it("keeps every later heading, not just the next one", () => {
    const md = doc(
      "## Recorded steps",
      "",
      "1. A → B",
      "",
      "## How the recordings differ",
      "",
      "All 2 recordings took the same path.",
      "",
      "## Evidence",
      "",
      "Recorded twice.",
    );
    const tail = recordTail(md);
    expect(tail).toMatch(/## How the recordings differ/);
    expect(tail).toMatch(/## Evidence/);
    expect(tail).not.toMatch(/## Recorded steps/);
  });

  it("returns the whole document when there is no steps heading at all", () => {
    // A defensive case, not a real one: if the record ever stops emitting the
    // heading, showing everything is the honest failure and showing nothing is
    // not.
    const md = doc("## Something else", "", "text");
    expect(recordTail(md)).toBe(md);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/habits-view.test.ts -t "recordTail"`
Expected: FAIL — not exported.

- [ ] **Step 3: Write it**

Add to `habits-view.ts`:

```ts
/**
 * The record BELOW the steps, because the steps are now an instrument.
 *
 * Two `indexOf` calls and no markdown parsing. Rendering the file in the
 * renderer would be the `ax-dump`/`ax-exec` drift hazard — `probe:habits` exists
 * because nothing in the suite can diff two renderers of one document. Finding
 * a heading boundary is the same class of operation as the `lastIndexOf` this
 * replaces, and it lives here rather than in the `.tsx` so the root suite can
 * hold it to the cases below.
 *
 * The tail cannot be found by NAME: `## How the recordings differ` renders only
 * at two or more recordings, so a habit recorded once would fall through to the
 * whole document.
 */
export function recordTail(markdown: string): string {
  const steps = markdown.lastIndexOf("## Recorded steps");
  if (steps < 0) return markdown;
  const next = markdown.indexOf("\n## ", steps + 1);
  return next < 0 ? "" : markdown.slice(next + 1);
}
```

- [ ] **Step 4: Draw the steps**

In `HabitsScreen.tsx`, add a component above the editor:

```tsx
/**
 * The recorded steps, as an instrument rather than as text.
 *
 * Ledger marks have been able to open a recording since `c205413`; the steps —
 * the part a person is actually asked to trust — could not, so the record was
 * trusted rather than verifiable. Drawn from `HabitDTO.ways`, which main built
 * from the same `FlowWalk[]` the file is rendered from: two renderers of one
 * thing is a drift hazard, and they are safe only because neither parses the
 * other's output.
 *
 * A step with no moment is DRAWN and states its reason — the
 * `StageSpec.skipReason` rule, and the same rule that already makes a mark with
 * no walk say why it cannot be followed. A disabled control with no explanation
 * is indistinguishable from one nobody implemented.
 */
function RecordedSteps({
  ways,
  onOpen,
}: {
  ways: readonly HabitWayDTO[];
  onOpen: (sessionId: string, atSec: number) => void;
}): React.JSX.Element | null {
  if (ways.length === 0) return null;
  const many = ways.length > 1;
  return (
    <div className="habitsteps">
      {many && (
        <p className="habitsteps__ways">
          The recordings did not take the same path. Each way below is a complete walk that a
          recording actually made — follow one of them, not all of them in sequence.
        </p>
      )}
      {ways.map((way) => (
        <section key={way.letter} className="habitsteps__way">
          {many && (
            <h4 className="habitsteps__wayhead">
              Way {way.letter} — {way.steps.length} step{way.steps.length === 1 ? "" : "s"},{" "}
              {way.sessionIds.length === 1 ? "1 recording" : `${way.sessionIds.length} recordings`}
            </h4>
          )}
          <ol className="habitsteps__list">
            {way.steps.map((step) => (
              <li key={`${way.letter}-${step.index}`} className="habitsteps__step">
                <div className="habitsteps__head">
                  <span className="habitsteps__places">
                    {step.missing
                      ? `edge ${step.edgeId} is not in the graph (index defect)`
                      : `${step.from} → ${step.to}`}
                  </span>
                  {step.firstAt === null ? (
                    <span className="habitsteps__noopen">
                      No recording carries this step, so there is no moment to open
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn ghost habitsteps__open"
                      onClick={() => {
                        const at = step.firstAt;
                        if (at !== null) onOpen(at.sessionId, at.atSec);
                      }}
                    >
                      Open this moment
                    </button>
                  )}
                </div>
                {step.actions.length === 0 ? (
                  <p className="habitsteps__action muted">(no actions recorded on this edge)</p>
                ) : (
                  step.actions.map((a, i) => (
                    <p key={i} className="habitsteps__action mono">
                      {a.action}
                      {a.target === "—" || a.target === "" ? "" : ` — ${a.target}`}
                    </p>
                  ))
                )}
                <p className="habitsteps__count">
                  {step.observations === 1
                    ? "walked once"
                    : `walked by ${step.observations} recordings`}
                </p>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
```

Add `HabitWayDTO` to the `@shared/types` type import.

- [ ] **Step 5: Split the well**

In the editor body, replace:

```tsx
  const cut = habit.markdown.lastIndexOf("## Recorded steps");
  const record = cut < 0 ? habit.markdown : habit.markdown.slice(cut);
```

with:

```tsx
  const record = recordTail(habit.markdown);
```

and replace the single `<pre>` block with:

```tsx
      <div className="habitedit__recordhead habitedit__recordhead--cut">
        <span className="eyebrow">The record — the recording, not editable</span>
      </div>
      <RecordedSteps ways={habit.ways} onOpen={onOpenRecording} />
      {record !== "" && <pre className="habitedit__record mono">{record}</pre>}
```

`onOpenRecording` must be threaded into the editor component the same way it already reaches the lead `Ledger` — check how that prop arrives before adding a second path for it.

Add `recordTail` to the `habits-view.js` import.

- [ ] **Step 6: Style it**

In `styles.css`, beside `.habitedit__record`:

```css
/* The steps as an instrument. The <pre> below still holds the rest of the
   record verbatim; this half is drawn from the DTO because a step that cannot
   be opened is a record you must take on trust. */
.habitsteps { display: flex; flex-direction: column; gap: var(--s3); }
.habitsteps__ways { margin: 0; font-size: var(--t-meta); color: var(--muted); }
.habitsteps__wayhead { margin: 0 0 var(--s2); font-size: var(--t-body); }
.habitsteps__list { margin: 0; padding-left: var(--s4); display: flex; flex-direction: column; gap: var(--s2); }
.habitsteps__head { display: flex; align-items: baseline; gap: var(--s2); flex-wrap: wrap; }
.habitsteps__places { font-weight: 600; }
/* Said in words, never a greyed control with no reason. */
.habitsteps__noopen { font-size: var(--t-nano); color: var(--muted); }
.habitsteps__action { margin: 0; font-size: var(--t-meta); color: var(--muted); }
.habitsteps__count { margin: 0; font-size: var(--t-nano); color: var(--muted); font-style: italic; }
```

Check every token used here exists in the sheet before committing — an undefined token fails silently, and a stray `*/` once ate `--t-nano`. Grep each one.

- [ ] **Step 7: Run the gate**

```
npm run typecheck
npm --prefix app run typecheck
npm test
```
Expected: all pass.

- [ ] **Step 8: Look at it, and open a moment**

```
npm run build
npm run app:dev
```

With the `run-app` skill:

1. The steps render as a list, and the `<pre>` below starts at `## How the recordings differ`.
2. The record is stated ONCE — grep the rendered text for a step's `from → to` and confirm it appears in the instrument and not also in the `<pre>`.
3. **Click "Open this moment" on a step and read where the Library lands.** Compare `currentTime` against that step's `firstAt.atSec`. This is the Task 1 hazard cashing out: if it lands ~1.9s early, `laneSec` was skipped somewhere; if it lands in the wrong recording, the sort is wrong.
4. The page still does not scroll at 1180x800, and `Copy HABIT.md` is still on screen.
5. No label is truncated.

- [ ] **Step 9: Commit**

```bash
git add app/src/renderer/src/habits-view.ts app/src/renderer/src/screens/HabitsScreen.tsx app/src/renderer/src/styles.css test/habits-view.test.ts
git commit -m "feat(habits): the recorded steps open their own moment

Marks could open a recording and steps -- the part a person is asked to
trust -- could not, so the record was trusted rather than verifiable.
The steps are now drawn from HabitDTO.ways and the <pre> holds the
record from the next heading down, so nothing is stated twice.

Not by parsing the markdown: two renderers of one file is the
ax-dump/ax-exec hazard. Both halves render from the same FlowWalk[] and
neither reads the other's output. recordTail is two indexOf calls,
in .ts where the root suite can hold it to a single-recording habit,
a multi-Way habit and a record that ends at the steps.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The dropped-early disclosure

**Files:**
- Modify: `app/src/renderer/src/habits-view.ts` (`droppedEarlyLine`)
- Modify: `app/src/renderer/src/screens/HabitsScreen.tsx` (the row)
- Test: `test/habits-view.test.ts`

**Interfaces:**
- Produces: `export function droppedEarlyLine(habit: HabitDTO): string | null;`

- [ ] **Step 1: Write the failing test**

Append to `test/habits-view.test.ts`:

```ts
describe("droppedEarlyLine", () => {
  it("is null when nothing was dropped early", () => {
    expect(droppedEarlyLine(habit())).toBeNull();
  });

  it("says how many times, and stops there", () => {
    // ON THE ROW, where the decision to open is made — the same argument that
    // put RECORDED ONCE into list_habits rather than only into the file.
    const h = habit({ droppedEarly: [{ places: ["Calculator"], count: 2 }] });
    expect(droppedEarlyLine(h)).toBe("also started and dropped early 2 further times");
  });

  it("says it in the singular when it happened once", () => {
    const h = habit({ droppedEarly: [{ places: ["Calculator"], count: 1 }] });
    expect(droppedEarlyLine(h)).toBe("also started and dropped early 1 further time");
  });

  it("sums several prefix routes rather than listing them", () => {
    // The row is not the place for the places. The record already names each
    // one; a row that listed three would push the evidence line off the card.
    const h = habit({
      droppedEarly: [
        { places: ["Calculator"], count: 2 },
        { places: ["Calculator", "TextEdit"], count: 1 },
      ],
    });
    expect(droppedEarlyLine(h)).toBe("also started and dropped early 3 further times");
  });

  it("never touches the recording count", () => {
    // A DISCLOSURE, never a merge: those recordings walked a different route.
    const h = habit({ droppedEarly: [{ places: ["Calculator"], count: 5 }] });
    expect(evidenceLine(h)).toBe(evidenceLine(habit()));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/habits-view.test.ts -t "droppedEarlyLine"`
Expected: FAIL — not exported.

- [ ] **Step 3: Write it**

Add to `habits-view.ts`, below `evidenceLine`:

```ts
/**
 * The same work begun and abandoned partway, said on the ROW.
 *
 * The record already discloses it through `cautionsFor`, but that is behind a
 * selection and the row is where the decision to open is made — the argument
 * that put `RECORDED ONCE` into `list_habits`. Saying it in both the row and the
 * editor masthead would be one fact stated three times on one screen, which is
 * what the `×N` glyph was deleted for.
 *
 * SUMMED, not listed: the record names each prefix route, and a row that listed
 * three would push the evidence line off the card. Never folded into the count —
 * those recordings walked a DIFFERENT route.
 */
export function droppedEarlyLine(habit: HabitDTO): string | null {
  const n = habit.droppedEarly.reduce((sum, d) => sum + d.count, 0);
  if (n === 0) return null;
  return `also started and dropped early ${n} further time${n === 1 ? "" : "s"}`;
}
```

- [ ] **Step 4: Draw it on the row**

In `HabitsScreen.tsx`, find where the row renders `evidenceLine(habit)` and add beneath it:

```tsx
                {droppedEarlyLine(habit) !== null && (
                  <span className="habitrow__dropped">{droppedEarlyLine(habit)}</span>
                )}
```

Match the surrounding row markup — if the evidence line is inside a `<span>` with a sibling structure, follow it rather than introducing a new block element into a flex row. Add `droppedEarlyLine` to the `habits-view.js` import, and in `styles.css`, beside the row's other meta rules:

```css
.habitrow__dropped { font-size: var(--t-nano); color: var(--muted); }
```

Grep for the row's existing class prefix first — `habitrow__` is the assumed name and may not be what the sheet uses.

- [ ] **Step 5: Run the gate**

```
npm run typecheck
npm --prefix app run typecheck
npm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/src/habits-view.ts app/src/renderer/src/screens/HabitsScreen.tsx app/src/renderer/src/styles.css test/habits-view.test.ts
git commit -m "feat(habits): disclose the work started and dropped early, on the row

The record already says it, but that is behind a selection and the row
is where the decision to open is made -- the argument that put RECORDED
ONCE into list_habits. Saying it in both places would be one fact stated
three times on one screen, which is what the xN glyph was deleted for.

Summed rather than listed, and never folded into the recording count:
those recordings walked a different route.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After the plan

- [ ] **Run `npm run probe:habits` and read what it says.**

It keeps a real route as a `HABIT.md`, diffs the clipboard against `get_habit` byte for byte, and asserts the geometry — **the page does not scroll** and **no title is truncated**. Both will have moved: the record well splits and a legend appears. Re-run, read the numbers, and if an assertion fails, **look at the screen before adjusting the assertion.**

Two things it will show, and neither is a defect:

- **`droppedEarly` will be empty.** `probe:baseline` found 0 routes with a strict-prefix route on this store, so Task 6 ships tested by fixtures and unexercised by real data — exactly the status B's own caution has.
- **Two of the three marks will be clay.** The real store's one recurring route has three Ways; s3 is the standard and s1 and s2 both stopped short. That is the ledger working.

- [ ] **Open a step's moment and check where it lands.**

The one thing no test here can reach. Compare the Library's `currentTime` against the step's `firstAt.atSec`. A ~1.9s-early landing means `laneSec` was skipped; a landing in the wrong recording means Task 1's sort is wrong. Three of this repo's worst bugs were invisible to `npm test` and obvious within minutes of doing this.

- [ ] **Record what shipped in `docs/todo.md`**, and leave C2 (portrait band, rhythm strip, fading band) and C3 (the Way A/B fork diff) as they are.
