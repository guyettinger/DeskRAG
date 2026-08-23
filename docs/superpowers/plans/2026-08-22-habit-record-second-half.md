# The Record's Second Half — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render sub-project A's `WalkAnalysis` into `HABIT.md` as three template-only record blocks, plus the duplicates differentiator, `HabitBrief.consistency`, and A's committed prefix disclosure — so a habit file says how consistently the work was done, where the time went and when it happens, without printing a score.

**Architecture:** Pure additions to `app/src/main/habit-doc.ts`, which already holds `flows` and `route` — the exact input `walkAnalysis` needs — so `recordedBlocks`'s signature does not change and no caller in `deskrag-service.ts` moves. One internal signature change in `app/src/main/mcp/habit-text.ts` (`lines` gains a resolver). One new field and one new prompt rule in `src/embed/habit-prose.ts`.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Vitest (root suite). No new dependency.

**Spec:** `docs/superpowers/specs/2026-08-22-habit-record-second-half-design.md`

## Global Constraints

Every task's requirements implicitly include all of these. Violating one is a rejected task, not a nit.

- **No score of any kind.** No reliability percentage, no fitness float, no streak, no grade, no "N% consistent". Counts and named facts only.
- **`recordedBlocks(input)` keeps its exact signature** — `{ flows, route, showSamples }`. It must never take a body, a prose object, a provider, or a `WalkAnalysis`. This is the property that makes "a model cannot rewrite the record" structural; `test/habit.doc.test.ts` asserts it and that assertion must keep passing unchanged.
- **No DTO widening.** `app/src/shared/types.ts` is not modified by any task in this plan.
- **No renderer file.** Nothing under `app/src/renderer/` is touched. That is sub-project C.
- **No new MCP tool.** `habit-text.ts` gains a differentiator inside an existing line, nothing more. That is sub-project D.
- **Nothing in `app/src/main/walk-analysis.ts` or `walk-align.ts` changes.** A is merged and B is a consumer. In particular `antecedentAt` stays declared and unimplemented — see the spec's *The cue is not observable*.
- **A block renders only when it has something to say.** Follow `## What this evidence does not say`, which is already conditional. A single-recording habit must render **none** of the three new blocks and its file must be byte-identical to what it renders today.
- **NodeNext imports:** every relative import ends in `.js`. **`verbatimModuleSyntax`:** type-only imports written `import type`. **`noUncheckedIndexedAccess`:** `arr[i]` is `T | undefined`. **`exactOptionalPropertyTypes`:** build optionals with a spread.
- **Never assert a literal local hour or weekday in a test.** `RhythmFacts` uses local time and the suite runs in whatever zone the machine is in. Either assert with a regex, or use fixture timestamps at midday UTC mid-week so a ±14h shift cannot move the weekday. Both techniques appear below.
- **Comments carry the reason, not the restatement.** Read the header of `habit-doc.ts` and `cautionsFor` before writing either.
- **Gate after every task:** `npm run typecheck && npm --prefix app run typecheck && npm test` must all pass before the commit step.

---

### Task 1: `## How the recordings differ`

**Files:**
- Modify: `app/src/main/habit-doc.ts` (add imports, `secs`, `differBlock`; call it in `recordedBlocks`)
- Test: `test/habit.doc.test.ts` (append a `describe`, add one fixture builder)

**Interfaces:**
- Consumes: `walkAnalysis`, `type WalkAnalysis` from `./walk-analysis.js`.
- Produces: `function differBlock(analysis: WalkAnalysis, count: number): string[]` (module-private), and the block in the rendered record.

- [ ] **Step 1: Add the fixture builder to the test file**

The existing `flows()` has one edge and two identical walks, which is the *agreement* case. These blocks also need a *divergence* case. Append this beside the existing helpers in `test/habit.doc.test.ts` (after the `flows()` function):

```ts
/**
 * A three-hop route walked three different ways.
 *
 * Timestamps are midday UTC on a Tuesday, Wednesday and Thursday ON PURPOSE:
 * `RhythmFacts` reads LOCAL time and the suite runs in whatever zone the machine
 * is in, so a ±14h shift must not be able to move the weekday. Midday mid-week
 * survives it; 23:00 on a Friday would not.
 */
const T_TUE = Date.UTC(2026, 2, 3, 12, 0, 0);
const DAY_MS = 86_400_000;

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

  // THREE DISTINCT edge sequences, one recording each. That is what produces a
  // TIE, and the tie is what several assertions below are about — two
  // recordings walking the SAME sequence would be collapsed into one Way by
  // `flowWalks` and the majority rule would pick it outright.
  //
  //   s1 (Tue) e0,e1        — stops one step short
  //   s2 (Wed) e0,e3        — substitutes e3 for e1, then stops
  //   s3 (Thu) e0,e1,e2     — NEWEST, so the tiebreak makes it the standard
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

/**
 * What the fixture aligns to, traced by hand so the assertions below are not
 * guesses. Baseline is s3's way `[e0, e1, e2]` (three Ways tie at one recording
 * each; the newest holds the tiebreak).
 *
 *   s1 [e0,e1]    e0 ok, e1 ok, e2 unreached  -> 1 skipped,               stops short
 *   s2 [e0,e3]    e0 ok, e1/e3 SUBSTITUTION,
 *                 e2 unreached                -> 2 skipped, 1 inserted,   stops short
 *   s3 [e0,e1,e2] exact                       -> followed the standard
 *
 * Durations on the baseline's steps: e0 has all three recordings, e1 has two
 * (s1, s3), e2 has one (s3). Step 2 is therefore the case where a recording is
 * OMITTED rather than given a zero.
 */

const rec = (f: FlowsDTO): string =>
  recordedBlocks({ flows: f, route: f.routes[0]!, showSamples: false });
```

- [ ] **Step 2: Write the failing test**

Append to `test/habit.doc.test.ts`:

```ts
describe("## How the recordings differ", () => {
  it("says they did not differ, rather than going silent", () => {
    // The agreement case is the Consistency Wins statement and is the single
    // most valuable line in the block. Silence here would make "no deviations"
    // and "not enough recordings to compare" look identical.
    const md = rec(flows());
    expect(md).toMatch(/## How the recordings differ/);
    expect(md).toMatch(/All 2 recordings took the same path\./);
  });

  it("renders nothing at all for a habit recorded once", () => {
    const f = flows();
    f.routes[0]!.count = 1;
    f.routes[0]!.sessionIds = ["s1"];
    f.routes[0]!.walks = [{ sessionId: "s1", edgeIds: ["e0"], atSec: 0, throughSec: 0 }];
    expect(rec(f)).not.toMatch(/## How the recordings differ/);
  });

  it("prints ONE line per recording, never one per deviation", () => {
    // `cautionsFor` already paid for the alternative: a per-step bullet printed
    // one fact TWELVE times in an eighteen-bullet section.
    const md = rec(divergent());
    const block = md.split("## How the recordings differ")[1]!.split("\n## ")[0]!;
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
  });

  it("carries Baseline.reason verbatim, so the file and the probe agree", () => {
    const md = rec(divergent());
    // Three ways, one recording each: a tie, decided by the newest walk.
    expect(md).toMatch(/Ways tie at 1 recording each; the standard is the one holding the newest walk\./);
  });

  it("warns that a tiebroken standard can move, and only on a tie", () => {
    expect(rec(divergent())).toMatch(/could become the standard as soon as one more is made/);
    expect(rec(flows())).not.toMatch(/could become the standard/);
  });

  it("names each recording by date, and counts what it did differently", () => {
    const md = rec(divergent());
    expect(md).toMatch(/- 2026-03-03 — 1 of the standard's steps not taken\./);
    expect(md).toMatch(/- 2026-03-04 — 1 step not in the standard, 2 of the standard's steps not taken\./);
  });

  it("says when a recording stopped before the end", () => {
    // s1 and s2 both stop short of the baseline's last step.
    const md = rec(divergent());
    const block = md.split("## How the recordings differ")[1]!.split("\n## ")[0]!;
    expect(block.match(/Stopped before the end\./g)).toHaveLength(2);
  });

  it("says a recording followed the standard when it did", () => {
    // s3 IS the baseline, so it can only agree with itself.
    expect(rec(divergent())).toMatch(/- 2026-03-05 — followed the standard\./);
  });

  it("names an undated recording by its session id rather than inventing a date", () => {
    const f = divergent();
    // Strip s3's only source, so nothing can date it.
    f.graph.edges = f.graph.edges.map((e) => ({
      ...e,
      sources: e.sources.filter((s) => s.sessionId !== "s3"),
    }));
    expect(rec(f)).toMatch(/- s3 — /);
  });

  it("prints no score, ratio or percentage", () => {
    const md = rec(divergent());
    expect(md).not.toMatch(/\d+%/);
    expect(md).not.toMatch(/consisten(t|cy) (score|rating)/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/habit.doc.test.ts -t "How the recordings differ"`
Expected: FAIL — the heading is absent, so every case misses.

- [ ] **Step 4: Add the imports and the helper**

In `app/src/main/habit-doc.ts`, add to the imports:

```ts
import { walkAnalysis, type WalkAnalysis, type WalkFit } from "./walk-analysis.js";
```

Add above `recordedBlocks`:

```ts
/** One decimal and a unit. Durations are read beside each other, so the width matters. */
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** A recording's name in a record block: its date, or its id when nothing can date it. */
const walkName = (w: WalkFit): string => (w.at === null ? w.sessionId : iso(w.at));

/**
 * How each recording differed from the standard.
 *
 * COUNTS PER RECORDING, never a bullet per deviation. Measured on the real
 * store: the one recurring route yields 9 skipped and 16 inserted across two
 * deviant walks, which is 25 bullets for three recordings. `cautionsFor` already
 * paid for that shape once — a per-step bullet fired on nearly every step of
 * every variant and printed one fact TWELVE times in an eighteen-bullet section
 * — and the fix there was to state it once about the route.
 *
 * The lead is `Baseline.reason` VERBATIM rather than a second sentence saying
 * the same thing, so this file and `probe:baseline` cannot disagree about how
 * the standard was picked. That string was written for a probe and is
 * user-facing from here on.
 */
function differBlock(analysis: WalkAnalysis, count: number): string[] {
  // Nothing to compare against: one recording, or a rule that names no standard.
  if (count < 2 || analysis.baseline.wayIndex === null) return [];
  if (analysis.walks.length < 2) return [];

  const out = ["## How the recordings differ", ""];

  const deviant = analysis.walks.filter((w) => w.deviations.length > 0 || !w.reachedEnd);
  if (deviant.length === 0) {
    // The agreement case IS the finding. Going silent here would make "they all
    // did the same thing" indistinguishable from "nothing was measured".
    out.push(`All ${analysis.walks.length} recordings took the same path.`, "");
    return out;
  }

  const tied = /tie at /.test(analysis.baseline.reason);
  out.push(
    `The standard below is chosen from the recordings themselves. ${analysis.baseline.reason}` +
      (tied ? " A different recording could become the standard as soon as one more is made." : ""),
    "",
  );

  for (const w of analysis.walks) {
    const inserted = w.deviations.filter((d) => d.kind === "inserted").length;
    const skipped = w.deviations.filter((d) => d.kind === "skipped").length;
    const moved = w.deviations.filter((d) => d.kind === "reordered").length;
    const bits: string[] = [];
    if (inserted > 0) bits.push(`${inserted} step${inserted === 1 ? "" : "s"} not in the standard`);
    if (skipped > 0) {
      bits.push(`${skipped} of the standard's steps not taken`);
    }
    if (moved > 0) bits.push(`${moved} step${moved === 1 ? "" : "s"} taken in a different order`);

    const head = bits.length === 0 ? "followed the standard" : bits.join(", ");
    // `reachedEnd` is only news when it is false, or when it is true DESPITE
    // deviations — on a walk that followed the standard it says nothing.
    const tail = !w.reachedEnd ? " Stopped before the end." : bits.length > 0 ? " Reached the end." : "";
    out.push(`- ${walkName(w)} — ${head}.${tail}`);
  }
  out.push("");
  return out;
}
```

- [ ] **Step 5: Call it from `recordedBlocks`**

In `recordedBlocks`, immediately after the `## What varies` section's trailing `out.push("")` and **before** `const cautions = cautionsFor(...)`, insert:

```ts
  // The projection needs exactly `flows` and `route`, which this function already
  // holds — so it is computed HERE rather than passed in. A `WalkAnalysis`
  // parameter would be the first crack in the property this signature exists to
  // guarantee: `recordedBlocks` takes no body, no prose and no provider, and
  // that is what makes "a model cannot rewrite the record" structural.
  const analysis = walkAnalysis({ flows, route });
  out.push(...differBlock(analysis, route.count));
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/habit.doc.test.ts`
Expected: PASS. The existing byte-identity assertion still passes because it compares `tail(attack)` against a freshly computed `recordedBlocks(...)` — both sides gain the block together.

- [ ] **Step 7: Run the gate**

Run: `npm run typecheck && npm --prefix app run typecheck && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add app/src/main/habit-doc.ts test/habit.doc.test.ts
git commit -m "feat(habits): how each recording differed, in the record

Counts per recording, never a bullet per deviation: the real store's one
recurring route yields 25 deviations across three recordings, and
cautionsFor already paid for that shape by printing one fact twelve
times in an eighteen-bullet section.

The lead is Baseline.reason verbatim so the file and probe:baseline
cannot disagree about how the standard was picked, and a tiebroken
standard says out loud that it can move.

recordedBlocks keeps its signature -- walkAnalysis needs exactly the
flows and route it already holds.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `## Where the time goes`

**Files:**
- Modify: `app/src/main/habit-doc.ts` (add `timeBlock`; call it)
- Test: `test/habit.doc.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `WalkAnalysis.steps` (`StepCost[]`), the baseline `FlowWalk` from `flowWalks` (Task 1's `analysis`).
- Produces: `function timeBlock(steps: readonly StepCost[], baseWay: FlowWalk | undefined): string[]` (module-private).

- [ ] **Step 1: Write the failing test**

Append to `test/habit.doc.test.ts`:

```ts
describe("## Where the time goes", () => {
  it("gives each recording's own duration for each step", () => {
    // The fixture's one edge runs 2s→6s for s1 and 3s→7s for s2.
    const md = rec(flows());
    expect(md).toMatch(/## Where the time goes/);
    expect(md).toMatch(/4\.0s, 4\.0s/);
  });

  it("says these are durations and not targets, IN THE FILE", () => {
    // The file is the thing that gets pasted somewhere else — the same reason
    // the showSamples warning travels in the file rather than only in the UI.
    expect(rec(flows())).toMatch(/durations, not targets/);
  });

  it("renders nothing for a habit recorded once", () => {
    const f = flows();
    f.routes[0]!.count = 1;
    f.routes[0]!.sessionIds = ["s1"];
    f.routes[0]!.walks = [{ sessionId: "s1", edgeIds: ["e0"], atSec: 0, throughSec: 0 }];
    expect(rec(f)).not.toMatch(/## Where the time goes/);
  });

  it("omits a recording that did not walk the step instead of writing a zero", () => {
    // Zero is a real duration. Only s1 and s2 walk e0, so its list has two
    // entries even though the route has three recordings.
    // The baseline's step 2 (e1) was walked by s1 and s3 but not s2, so its
    // list carries two durations for a route with three recordings.
    const md = rec(divergent());
    const block = md.split("## Where the time goes")[1]!.split("\n## ")[0]!;
    const second = block.split("\n").find((l) => l.startsWith("2. "))!;
    expect(second.match(/\d+\.\ds/g)).toHaveLength(2);
  });

  it("names the step by the places it moves between", () => {
    expect(rec(flows())).toMatch(/1\. Ghostty → Google Chrome — github\.com\/user\/repo — /);
  });

  it("reports the idle between steps separately from the steps", () => {
    // s1 and s3 both leave 2s between e0 ending and e1 starting.
    expect(rec(divergent())).toMatch(/idle before the next step: 2\.0s, 2\.0s/);
  });

  it("prints no total, no average and no fastest", () => {
    const md = rec(divergent());
    const block = md.split("## Where the time goes")[1]!.split("\n## ")[0]!;
    expect(block).not.toMatch(/total|average|mean|median|fastest|slowest/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/habit.doc.test.ts -t "Where the time goes"`
Expected: FAIL — heading absent.

- [ ] **Step 3: Write the helper**

Add to `app/src/main/habit-doc.ts` below `differBlock`, and add `type StepCost` to the `walk-analysis.js` import:

```ts
/**
 * Each recording's own time on each step.
 *
 * A step's duration is its OWN span (`throughSec - atSec` from that recording's
 * `EdgeSourceDTO`), never the gap to the next step — differencing consecutive
 * starts folds the idle before the next step into this one's cost and hides the
 * hesitation. The idle is reported separately, and only when some of it is
 * non-zero: a tight sequence should not carry a row of noughts.
 *
 * `StepCost.stepIndex` indexes the BASELINE Way's steps, so the label is read
 * from that Way directly rather than looked up from the graph. One lookup fewer
 * is also one drift hazard fewer: `walk-analysis.ts` has its own `edgeLabel`,
 * and two functions naming one edge is the `ax-dump`/`ax-exec` shape.
 */
function timeBlock(steps: readonly StepCost[], baseWay: FlowWalk | undefined): string[] {
  if (baseWay === undefined) return [];
  const rows = steps.filter((s) => s.durations.length > 0);
  if (rows.length === 0) return [];

  const out = [
    "## Where the time goes",
    "",
    "Each recording's own time on each step, from the recorded spans. These are durations, not targets.",
    "",
  ];
  for (const cost of rows) {
    const step = baseWay.steps[cost.stepIndex];
    const label =
      step === undefined || step.missing
        ? `edge \`${cost.edgeId}\` is not in the graph`
        : `${step.from} → ${step.to}`;
    out.push(`${cost.stepIndex + 1}. ${label} — ${cost.durations.map((d) => secs(d.ms)).join(", ")}`);
    if (cost.gapsAfter.some((g) => g.ms > 0)) {
      out.push(`   *idle before the next step: ${cost.gapsAfter.map((g) => secs(g.ms)).join(", ")}*`);
    }
  }
  out.push("");
  return out;
}
```

- [ ] **Step 4: Call it from `recordedBlocks`**

Immediately after the `differBlock` call added in Task 1:

```ts
  const baseWay = analysis.baseline.wayIndex === null ? undefined : walks[analysis.baseline.wayIndex];
  // Only when there is a second recording to read a duration AGAINST. One
  // recording's timings are a fact about one afternoon, not about a habit.
  if (route.count > 1) out.push(...timeBlock(analysis.steps, baseWay));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/habit.doc.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the gate**

Run: `npm run typecheck && npm --prefix app run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/habit-doc.ts test/habit.doc.test.ts
git commit -m "feat(habits): where the time goes, per step and per recording

A step's duration is its own span, never the gap to the next step --
differencing consecutive starts folds the idle into the previous step
and hides the hesitation. The idle is reported separately and only when
some of it is non-zero.

A recording that did not walk a step is omitted from its list rather
than given a zero, because zero is a real duration. No total, no
average, no fastest.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `## When it happens`, and the unobservable cue

**Files:**
- Modify: `app/src/main/habit-doc.ts` (add `rhythmBlock`; call it)
- Test: `test/habit.doc.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `WalkAnalysis.rhythm` (`RhythmFacts`).
- Produces: `function rhythmBlock(rhythm: RhythmFacts): string[]` (module-private).

- [ ] **Step 1: Write the failing test**

Append to `test/habit.doc.test.ts`:

```ts
describe("## When it happens", () => {
  it("reports the weekday shape and an hour range", () => {
    // NOT a literal hour: RhythmFacts reads LOCAL time and the suite runs in
    // whatever zone the machine is in. The fixture's midday-mid-week timestamps
    // are what make the WEEKDAY half safe under a ±14h shift; the hour half is
    // asserted structurally for the same reason.
    const md = rec(divergent());
    expect(md).toMatch(/## When it happens/);
    expect(md).toMatch(/All 3 recordings on a weekday/);
    expect(md).toMatch(/(between \d\d:\d\d and \d\d:\d\d|around \d\d:\d\d) local time/);
  });

  it("reports the gaps between recordings", () => {
    expect(rec(divergent())).toMatch(/Gaps between them: 1 day, 1 day/);
  });

  it("states that the cue cannot be recovered, whenever the block renders", () => {
    // Measured: for all 3 recordings of the real store's only recurring route,
    // the sole application in front before the work is DeskRAG's own Recorder.
    // Without this paragraph an absent cue reads as "there was no cue".
    const md = rec(divergent());
    expect(md).toMatch(/recording starts when you press record/);
    expect(md).toMatch(/cannot be recovered/);
  });

  it("never claims what preceded the work", () => {
    const md = rec(divergent());
    expect(md).not.toMatch(/## What preceded it/);
    expect(md).not.toMatch(/after (Mail|Slack|Finder|DeskRAG|Electron)/i);
  });

  it("renders nothing when fewer than two recordings can be dated", () => {
    const f = divergent();
    f.graph.edges = f.graph.edges.map((e) => ({ ...e, sources: e.sources.slice(0, 1) }));
    f.routes[0]!.walks = [{ sessionId: "s1", edgeIds: ["e0"], atSec: 2, throughSec: 6 }];
    f.routes[0]!.sessionIds = ["s1"];
    f.routes[0]!.count = 1;
    expect(rec(f)).not.toMatch(/## When it happens/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/habit.doc.test.ts -t "When it happens"`
Expected: FAIL — heading absent.

- [ ] **Step 3: Write the helper**

Add `type RhythmFacts` to the `walk-analysis.js` import, and add below `timeBlock`:

```ts
/** Sat and Sun as `Date#getDay` numbers them. Local, like everything in `RhythmFacts`. */
const WEEKEND = new Set([0, 6]);

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** A gap in whole days, or in hours when it is under one. */
const gapText = (ms: number): string => {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(ms / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"}`;
};

/**
 * When the work happens, and why nothing says what preceded it.
 *
 * The second paragraph is the POINT of this block, not a footnote. A's
 * `AntecedentFact` anticipated an app cue reached through `antecedentAt`, and
 * against the real store the naive implementation is wrong in a way no corpus
 * growth fixes: for all three recordings of the only recurring route, the only
 * application in front before the work begins is DeskRAG's own Recorder. That is
 * structural — a recording begins when you press record, so the cue happens
 * before the evidence exists — and reporting it would violate "the recorder is
 * not part of the work it records". Excluding it, as that invariant requires,
 * leaves null every time. So the block says so, because an absent cue and an
 * unobservable one are different facts.
 *
 * Weekday-shape and an hour RANGE are the two statements this data supports.
 * Anything sharper ("every Tuesday at 9") needs a corpus this library does not
 * have, and is C's rhythm strip to draw rather than this file's to assert.
 */
function rhythmBlock(rhythm: RhythmFacts): string[] {
  const n = rhythm.days.length;
  if (n < 2) return [];

  const weekend = rhythm.days.filter((d) => WEEKEND.has(d)).length;
  const shape =
    weekend === 0
      ? "on a weekday"
      : weekend === n
        ? "at the weekend"
        : `on ${n - weekend} weekday${n - weekend === 1 ? "" : "s"} and ${weekend} weekend day${weekend === 1 ? "" : "s"}`;

  const lo = Math.min(...rhythm.hours);
  const hi = Math.max(...rhythm.hours);
  const when =
    rhythm.hours.length === 0
      ? ""
      : lo === hi
        ? `, around ${pad2(lo)}:00 local time`
        : `, between ${pad2(lo)}:00 and ${pad2(hi + 1)}:00 local time`;

  const out = ["## When it happens", "", `All ${n} recordings ${shape}${when}.`];
  if (rhythm.intervalsMs.length > 0) {
    out.push(`Gaps between them: ${rhythm.intervalsMs.map(gapText).join(", ")}.`);
  }
  out.push(
    "",
    "The application in front beforehand cannot be recovered: recording starts when you press record, so a recording contains no evidence of what preceded it.",
    "",
  );
  return out;
}
```

- [ ] **Step 4: Call it from `recordedBlocks`**

Immediately after the `timeBlock` call:

```ts
  out.push(...rhythmBlock(analysis.rhythm));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/habit.doc.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the gate**

Run: `npm run typecheck && npm --prefix app run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/habit-doc.ts test/habit.doc.test.ts
git commit -m "feat(habits): when the work happens, and why the cue is unknowable

Measured: for all 3 recordings of the real store's only recurring route,
the sole application in front before the work is DeskRAG's own Recorder.
An in-session cue is unobservable by construction -- a recording begins
when you press record, so the cue happens before the evidence exists --
and excluding the Recorder, as the invariant requires, leaves null every
time.

So the block renders the phase from RhythmFacts and STATES the
impossibility. An absent cue and an unobservable one are different
facts, and without the sentence the first reads as the second.

antecedentAt stays declared and unimplemented: it is the seam a
cross-session or calendar cue would enter through.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: A's committed prefix disclosure

A committed one consumer to B. It lands as a caution, so it reaches `get_habit` and the model's brief for free — both already read `cautionsFor`.

**Files:**
- Modify: `app/src/main/habit-doc.ts` (`cautionsFor` gains a 4th parameter; both call sites pass it)
- Test: `test/habit.doc.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `WalkAnalysis.droppedEarly` (`PrefixFact[]`).
- Produces: `cautionsFor(flows, route, walks, droppedEarly?: readonly PrefixFact[])` — the 4th parameter is **optional with a `[]` default**, so every existing call site and test keeps compiling.

- [ ] **Step 1: Write the failing test**

Append to `test/habit.doc.test.ts`:

```ts
describe("work started and dropped early", () => {
  const withPrefix = (): FlowsDTO => {
    const f = divergent();
    // A SHORTER route whose places are a strict prefix of this one's.
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
    return f;
  };

  it("discloses it as a caution, in the record", () => {
    expect(rec(withPrefix())).toMatch(
      /started and dropped early 2 further times|dropped early/i,
    );
  });

  it("does not change the recording count", () => {
    // A DISCLOSURE, never a merge. route.count is the number of recordings that
    // walked THIS route, and the prefix relation must not touch it.
    const f = withPrefix();
    expect(f.routes[0]!.count).toBe(3);
    expect(rec(f)).toMatch(/Recorded 3 times/);
  });

  it("says nothing when no route is a prefix of this one", () => {
    expect(rec(divergent())).not.toMatch(/dropped early/i);
  });

  it("keeps cautionsFor callable with three arguments", () => {
    // The 4th parameter is optional so no existing caller moves.
    const f = flows();
    expect(() => cautionsFor(f, f.routes[0]!, flowWalks(f, f.routes[0]!))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/habit.doc.test.ts -t "dropped early"`
Expected: FAIL — no such caution.

- [ ] **Step 3: Add the parameter and the caution**

Add `type PrefixFact` to the `walk-analysis.js` import. Change the signature of `cautionsFor`:

```ts
export function cautionsFor(
  flows: FlowsDTO,
  route: FlowRouteDTO,
  walks: readonly FlowWalk[],
  /**
   * Routes whose places are a strict PREFIX of this one's — the same work begun
   * and abandoned partway.
   *
   * Passed in rather than computed here, and OPTIONAL so no existing caller
   * moves. A's committed carry-over: the fact reaches `get_habit` before any
   * pixel exists, because both the record and the model's brief already read
   * this function.
   */
  droppedEarly: readonly PrefixFact[] = [],
): string[] {
```

At the END of `cautionsFor`, immediately before `return out;`:

```ts
  // A DISCLOSURE, in the shape of `duplicates`, and never a merge: `route.count`
  // is untouched and nothing is folded in. DeskRAG's route partition gives every
  // recording exactly one route key, which is what makes `bindHabit`'s
  // strict-majority rule a proof rather than a threshold — and it is also why
  // abandonment is invisible from the full route's side without this line.
  for (const p of droppedEarly) {
    const n = p.count;
    out.push(
      `This work was started and dropped early ${n} further time${n === 1 ? "" : "s"}: ` +
        `${n === 1 ? "a recording" : `${n} recordings`} went as far as ${p.places.join(" → ")} ` +
        `and stopped. Those are not counted among the ${route.count} above.`,
    );
  }

  return out;
```

- [ ] **Step 4: Pass it at both call sites**

In `recordedBlocks`, change the cautions line to:

```ts
  const cautions = cautionsFor(flows, route, walks, analysis.droppedEarly);
```

In `briefFor`, compute the projection and pass it — the model should see the disclosure for the same reason the reader does:

```ts
  const analysis = walkAnalysis({ flows, route });
  const cautions = cautionsFor(flows, route, walks, analysis.droppedEarly);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/habit.doc.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the gate**

Run: `npm run typecheck && npm --prefix app run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/habit-doc.ts test/habit.doc.test.ts
git commit -m "feat(habits): disclose the work started and dropped early

Sub-project A's committed carry-over. It lands as a caution because
both the record and the model's brief already read cautionsFor, so the
fact reaches get_habit before any pixel exists.

A disclosure and never a merge: route.count is untouched. The route
partition gives every recording exactly one route key, which is what
makes bindHabit's strict-majority rule a proof -- and also why
abandonment is invisible from the full route's side without this line.

The 4th parameter is optional, so no existing caller moves.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The `duplicates` differentiator

**Files:**
- Modify: `app/src/main/mcp/habit-text.ts` (`lines` gains a resolver; `renderHabitList` builds it)
- Test: `test/mcp.tools.test.ts` (append a `describe`) — or a new `test/mcp.habit-text.test.ts` if no habit-list fixture exists there; check first with `grep -n "renderHabitList" test/*.ts`.

**Interfaces:**
- Consumes: `HabitDTO` (unchanged).
- Produces: `function lines(s: HabitDTO, others: ReadonlyMap<string, HabitDTO>): string[]` — the map is keyed by habit **id**.

- [ ] **Step 1: Write the failing test**

`HabitDTO.duplicates` holds **ULIDs**, not slugs — `duplicateHabits` groups by `liveRouteKey` and emits `s.id`. Build two active habits on one route. Append:

```ts
describe("the duplicates differentiator", () => {
  it("names the other habit's slug and quotes what it says", () => {
    // Two habits on one route have BYTE-IDENTICAL records: the record is
    // re-rendered from the same live route either way. So the only thing that
    // can differ is prose, and an agent handed two ULIDs has nothing to choose
    // with — the resolution-ambiguity failure named in the skill-retrieval work.
    const out = renderHabitList(twoOnOneRoute(), "no graph");
    expect(out).toMatch(/ALSO DESCRIBED BY — compute-sum-paste \(/);
    expect(out).toMatch(/The recorded steps are identical/);
    expect(out).toMatch(/differ only in how they are described/);
    expect(out).toMatch(/That one says: "Use when you need to total a column/);
  });

  it("keeps the id as well as the slug, because get_habit takes the id", () => {
    expect(renderHabitList(twoOnOneRoute(), "no graph")).toMatch(/\(01[0-9A-HJKMNP-TV-Z]+\)/);
  });

  it("degrades to the plain sentence when the other description is empty", () => {
    const h = twoOnOneRoute();
    h.habits[1]!.description = "";
    const out = renderHabitList(h, "no graph");
    expect(out).toMatch(/answer to the same recorded route; nobody has merged them/);
    expect(out).not.toMatch(/That one says/);
  });

  it("degrades to the plain sentence when the other habit is not in the set", () => {
    // A lookup that cannot fail is a lookup that will.
    const h = twoOnOneRoute();
    h.habits = [h.habits[0]!];
    expect(renderHabitList(h, "no graph")).toMatch(/nobody has merged them/);
  });
});
```

Write `twoOnOneRoute(): HabitsDTO` beside the other fixtures in that file, reusing whatever `HabitDTO` builder it already has. Both habits must be `state: "active"` with the same `binding.liveRouteKey`, ids `01J...A` and `01J...B`, slugs `compute-sum-paste` and `total-and-note`, and distinct descriptions — the second's beginning `"Use when you need to total a column and drop it into a note."`. Set `duplicates` on each to the other's id, since `renderHabitList` renders the DTO as given.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/mcp.tools.test.ts -t "differentiator"`
Expected: FAIL — the current line prints only joined ids.

- [ ] **Step 3: Write the implementation**

In `app/src/main/mcp/habit-text.ts`, change `lines`:

```ts
function lines(s: HabitDTO, others: ReadonlyMap<string, HabitDTO>): string[] {
```

and replace the duplicates block with:

```ts
  // Two files describing one procedure. Said in the list because an agent that
  // fetches both and finds them near-identical cannot tell whether that is a
  // duplicate or two genuinely different ways of doing the same work.
  //
  // Their RECORDS are byte-identical by construction — both are re-rendered from
  // the same live route, which is what made them duplicates — so the only thing
  // that CAN differ is the prose. Naming the ids alone left an agent with two
  // opaque keys and nothing to choose with.
  if (s.duplicates.length > 0) {
    const named = s.duplicates.map((id) => {
      const other = others.get(id);
      return other === undefined || other.slug === "" ? id : `${other.slug} (${id})`;
    });
    const quoted = s.duplicates
      .map((id) => others.get(id))
      .find((o) => o !== undefined && o.description !== "");
    out.push(
      `  ALSO DESCRIBED BY — ${named.join(", ")}. The recorded steps are identical; ` +
        (quoted === undefined
          ? "these habits answer to the same recorded route; nobody has merged them."
          : `these two differ only in how they are described. That one says: ${JSON.stringify(quoted.description)}`),
    );
  }
```

In `renderHabitList`, build the map from the rendered set and pass it:

```ts
  // Keyed by id, because `duplicates` holds ids. Built from `habits.habits`
  // rather than `kept`: `duplicateHabits` pairs only ACTIVE habits, so both
  // members are present, but reading from the wider set means a filter change
  // upstream cannot silently turn every differentiator back into a bare id.
  const byId = new Map(habits.habits.map((h) => [h.id, h]));
  const body = kept.map((s) => lines(s, byId).join("\n")).join("\n\n");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/mcp.tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the endpoint is still read-only**

Run: `npx vitest run test/mcp.readonly.test.ts`
Expected: PASS. Nothing here writes, but that guard is the whole safety story for the MCP surface and this task is the only one that touches it.

- [ ] **Step 6: Run the gate**

Run: `npm run typecheck && npm --prefix app run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/mcp/habit-text.ts test/mcp.tools.test.ts
git commit -m "feat(habits): give an agent something to choose between duplicates

Two habits on one route have byte-identical records -- both are
re-rendered from the same live route, which is what made them
duplicates -- so an agent that fetches both and diffs them finds
nothing. duplicates holds ULIDs, so the line named two opaque keys and
offered no way to weigh them.

It now names the other habit's slug, keeps its id (get_habit takes the
id), and quotes its description, which is the only thing that can
differ. Degrades to the old sentence when the other habit is absent or
says nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `HabitBrief.consistency` and the prompt rule

**Files:**
- Modify: `src/embed/habit-prose.ts` (add the field, render it in `habitPrompt`, add one rule to `HABIT_SYSTEM`)
- Modify: `app/src/main/habit-doc.ts` (`briefFor` populates it)
- Test: `test/habit.prose.test.ts` and `test/habit.doc.test.ts`

**Interfaces:**
- Consumes: `WalkAnalysis` (already computed in `briefFor` by Task 4).
- Produces: `HabitBrief.consistency: string[]`. `HabitProse` is **unchanged** — still four string fields, none of them a step.

- [ ] **Step 1: Write the failing tests**

Append to `test/habit.prose.test.ts`:

```ts
describe("consistency facts", () => {
  it("reaches the prompt as facts under their own heading", () => {
    const p = habitPrompt({ ...brief(), consistency: ["2 of the 3 recordings took a different path."] });
    expect(p).toMatch(/How consistently it was done/);
    expect(p).toMatch(/2 of the 3 recordings took a different path\./);
  });

  it("tells the model to state variation and never to assess it", () => {
    expect(HABIT_SYSTEM).toMatch(/state it as fact|never as an assessment/i);
  });

  it("says nothing at all when there are no consistency facts", () => {
    expect(habitPrompt({ ...brief(), consistency: [] })).not.toMatch(/How consistently/);
  });

  it("still carries no recorded value", () => {
    // The rule this module exists for. A new field is a new way to leak one.
    const p = habitPrompt({ ...brief(), consistency: ["3 recordings, all the same path."] });
    expect(p).not.toContain(SECRET);
  });
});
```

(`brief()` is that file's existing `HabitBrief` builder; add `consistency: []` to it so every other test keeps compiling. `SECRET` is its existing sample constant — reuse whatever it is called there.)

Append to `test/habit.doc.test.ts`:

```ts
describe("briefFor carries consistency", () => {
  it("states how many recordings took the standard way", () => {
    const f = divergent();
    const b = briefFor(f, f.routes[0]!);
    expect(b.consistency.join(" ")).toMatch(/3 recordings/);
    expect(b.consistency.join(" ")).toMatch(/different path/);
  });

  it("says they agreed when they did", () => {
    const f = flows();
    expect(briefFor(f, f.routes[0]!).consistency.join(" ")).toMatch(/same path/);
  });

  it("is empty for a habit recorded once", () => {
    const f = flows();
    f.routes[0]!.count = 1;
    f.routes[0]!.sessionIds = ["s1"];
    f.routes[0]!.walks = [{ sessionId: "s1", edgeIds: ["e0"], atSec: 0, throughSec: 0 }];
    expect(briefFor(f, f.routes[0]!).consistency).toEqual([]);
  });

  it("carries no percentage and no sample", () => {
    const f = divergent();
    const b = briefFor(f, f.routes[0]!);
    expect(b.consistency.join(" ")).not.toMatch(/\d+%/);
    expect(b.consistency.join(" ")).not.toContain(SECRET);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/habit.prose.test.ts test/habit.doc.test.ts -t "consistency"`
Expected: FAIL — `consistency` is not a property of `HabitBrief`.

- [ ] **Step 3: Add the field and the prompt rule**

In `src/embed/habit-prose.ts`, add to `HabitBrief` after `cautions`:

```ts
  /**
   * Neutral counts about how consistently this route was walked.
   *
   * Facts, in the shape `cautions` already uses. The prose may STATE them and
   * may not assess them — the record prints the same counts a few lines below,
   * so a sentence here can only agree with something the reader can check
   * directly. Empty for a habit recorded once: one walk has nothing to be
   * consistent WITH.
   */
  consistency: string[];
```

In `habitPrompt`, immediately before the `cautions` block:

```ts
  if (b.consistency.length > 0) {
    out.push("", "How consistently it was done (state these as facts; do not grade them):");
    for (const c of b.consistency) out.push(`- ${c}`);
  }
```

In `HABIT_SYSTEM`, after the "Never guess what a variable contained" sentence:

```ts
  "You may be told how consistently the task was done. State it as fact and " +
  "never as an assessment: no \"reliable\", \"inconsistent\", \"messy\" or " +
  "\"error-prone\", and no advice about doing it better. The same counts are " +
  "printed in the record below your text, where a reader can check them.\n" +
```

- [ ] **Step 4: Populate it in `briefFor`**

In `app/src/main/habit-doc.ts`, add above `briefFor`:

```ts
/**
 * The consistency facts a model may state.
 *
 * COUNTS, and deliberately not the per-recording breakdown the record carries:
 * the model is writing four short prose fields, and handing it three lines per
 * recording invites it to narrate the ledger instead of describing the work.
 */
function consistencyFacts(analysis: WalkAnalysis, count: number): string[] {
  if (count < 2 || analysis.baseline.wayIndex === null || analysis.walks.length < 2) return [];
  const deviant = analysis.walks.filter((w) => w.deviations.length > 0 || !w.reachedEnd).length;
  const out = [
    deviant === 0
      ? `All ${analysis.walks.length} recordings took the same path.`
      : `${deviant} of the ${analysis.walks.length} recordings took a different path from the standard.`,
  ];
  const days = analysis.rhythm.days;
  if (days.length >= 2 && days.every((d) => d !== 0 && d !== 6)) {
    out.push("Every recording was made on a weekday.");
  }
  return out;
}
```

and in the returned object, after `cautions`:

```ts
    consistency: consistencyFacts(analysis, route.count),
```

- [ ] **Step 5: Fix the other `HabitBrief` literals**

`consistency` is required, so every object literal typed as `HabitBrief` must gain it. Find them:

Run: `grep -rn --include='*.ts' "HabitBrief" src app/src test scripts`

Add `consistency: []` to each fixture that is not `briefFor`'s own return. `FakeHabitProseProvider` reads the brief and does not build one; check it does not need changing.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/habit.prose.test.ts test/habit.doc.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the gate**

Run: `npm run typecheck && npm --prefix app run typecheck && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/embed/habit-prose.ts app/src/main/habit-doc.ts test/habit.prose.test.ts test/habit.doc.test.ts
git commit -m "feat(habits): let the prose state how consistently it was done

HabitBrief gains consistency: string[] -- neutral counts, in the shape
cautions already uses -- and HABIT_SYSTEM gains one rule: state
variation as fact, never as an assessment.

Withholding the facts entirely was the alternative, and it would let
the prose describe a habit as though it always went smoothly while the
block directly below says it went three different ways. Passing them
with no rule was the other, rejected because this repo has measured
twice that prompt tweaks read as noise under three runs, so a model
drifting into evaluative prose would be very hard to detect afterwards.

Counts only, never the per-recording breakdown: the model writes four
short fields, and the ledger is the record's job.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After the plan

`npm run probe:habits` is the end-to-end check. It keeps a real route as a `HABIT.md`, asserts the clipboard string and `get_habit`'s are byte-identical, and survives a real model call — so it exercises all six tasks against the real store for free, including the one real habit with three recordings and three distinct Ways. **Run it once at the end** and read what the new blocks actually rendered; three of this repo's worst bugs were invisible to `npm test` and obvious within minutes of reading real output.

Two things it will show, and neither is a defect:

- **`droppedEarly` will not fire.** `probe:baseline` reported 0 routes with a prefix route on this store, so Task 4 ships tested against fixtures and unexercised by real data.
- **The baseline sentence will say the standard was tiebroken**, because it was — 1 of 1, measured. That is the block working, not failing.

Sub-projects C (the Habits screen as a mirror) and D (the agent surface) remain recorded in `docs/todo.md`, along with `probe:describe` and the corpus floor it needs.
