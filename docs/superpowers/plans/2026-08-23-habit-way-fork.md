# Where the Ways Fork — Implementation Plan (Sub-project C3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw where a habit's Ways share a spine and where they fork, on both the rendered record and the Habits screen, and say whether one Way is faster only when two gates permit it.

**Architecture:** One new pure module, `app/src/main/way-fork.ts`, folds a pairwise LCS across the Ways' place-step sequences to find a spine, attributes the gaps to the Ways that filled them, and produces a verdict or a required reason for withholding one. Both formatters — `habit-doc.ts` (the file) and `HabitsScreen.tsx` (the pixels) — read that one projection, the way `flow-steps.ts` and `walk-analysis.ts` are already shared.

**Tech Stack:** TypeScript strict ESM (NodeNext, `.js` on relative imports), Vitest, React 18 + Electron for the app, plain CSS in one global sheet.

**Spec:** `docs/superpowers/specs/2026-08-23-habit-way-fork-design.md`

## Global Constraints

- **No score, ever.** No ratio, percentage, edit-distance, grade, average, median or fitness float reaches any surface. Counts, named facts and printed ranges only.
- **A withheld verdict states its reason.** `Verdict` is a discriminated union whose `withheld` arm carries a required `reason: string` — never optional, never an enum. This is the `StageSpec.skipReason` rule.
- **The floor is `FORK_VERDICT_MIN_WALKS = 2`** recordings per Way, and the second gate is **non-overlapping ranges**: the verdict fires only when the slowest recording of one Way beat the fastest recording of every other.
- **`recordedBlocks()` takes the route and nothing else.** It must not gain a body, prose or provider parameter. The fork is computed inside it from `flows` and `route`, exactly as `walkAnalysis` already is.
- **Phrasing lives in `way-fork.ts`**, not in the renderer and not in `habit-doc.ts`, so the file and the screen cannot disagree. This is the `differBlock`/`Baseline.reason` precedent.
- **Colour carries spine-versus-fork, never Way identity.** The fork band is `--data-6` (periwinkle) at varying lightness via `color-mix(in oklab, var(--data-6) N%, transparent)`. Ways are told apart by their printed letter and lane position, so hue is never the only channel.
- **`styles.css` is one global sheet with no scoping** — a class name is a repo-wide identifier. All new classes are prefixed `wayfork__`. Grep before minting. Sizes come from the `--s*` (`--s0:2px` … `--s6:32px`) and `--t-*` (`--t-nano:9px` … `--t-head:20px`) scales; radius from `--radius: 10px` / `--radius-sm: 7px`. A raw `font-size: <n>px` is the regression.
- **Pure renderer modules must be `.ts`, never `.tsx`**, so the root suite reaches them. The root `tsconfig.json` sets no `jsx`.
- **Relative imports carry `.js`** (NodeNext). `@shared/types` is the alias for `app/src/shared/types.ts`.
- **`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on.** Indexing an array yields `T | undefined`; use `!` only where the invariant is stated in a comment. `app/tsconfig.json` additionally sets `noUnusedLocals` / `noUnusedParameters`.
- **The gate is three unpiped commands**, each run whole: `npm test`; `npm run typecheck`; `npm run build && npm --prefix app run typecheck`. Piping through `tail` returns `tail`'s exit code and hides failures.
- **The app imports `dist/`, not `src/`.** Driving the app needs `npm run build && npm --prefix app run build` first.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `app/src/main/flow-steps.ts` *(modify)* | Gains `variantLetter`, moved from `habit-doc.ts`. It owns `FlowWalk.index`, whose comment already says the index exists so a formatter can label variants. Moving it breaks the import cycle `habit-doc → way-fork → habit-doc`. |
| `app/src/main/way-fork.ts` *(create)* | The whole projection: `placeKey`, `spineOf`, `forkRows`, `verdictFor`, `runPhrase`, `secs`, and the `wayFork` entry point. Pure — `FlowsDTO` in, plain objects out. Root-suite reachable. |
| `app/src/main/habit-doc.ts` *(modify)* | `differBlock` deleted, `forkBlock` added; `timeBlock` names its baseline Way and discloses single-duration rows; `variantLetter` re-exported from its new home; local `secs` replaced by the one in `way-fork.ts`. |
| `app/src/shared/types.ts` *(modify)* | `HabitWayDTO.totalsMs`, `HabitForkRowDTO`, `HabitForkDTO`, `HabitDTO.fork`. |
| `app/src/main/habit-marks.ts` *(modify)* | `habitWays` fills `totalsMs`; new `habitFork(flows, route): HabitForkDTO \| null`. |
| `app/src/main/deskrag-service.ts` *(modify)* | One line in `toHabitDTO` wiring `fork:`. |
| `app/src/renderer/src/way-fork-view.ts` *(create)* | Folds the flat `HabitForkRowDTO[]` into the nested shape JSX needs. Pure `.ts`, root-suite reachable. |
| `app/src/renderer/src/screens/HabitsScreen.tsx` *(modify)* | `RecordedSteps` draws the fork instrument when there are several Ways; unchanged at one Way. |
| `app/src/renderer/src/styles.css` *(modify)* | `.wayfork*`, appended after the `.habitsteps*` block. |
| `scripts/fork-probe.ts` *(create)* | `npm run probe:fork` — read-only, headless, prints the corpus before any reading. |
| `scripts/baseline-probe.ts` *(modify)* | Pass a `sessionStart` resolver so its edge sources stop being silently dropped. |
| `package.json` *(modify)* | The `probe:fork` script. |
| `CLAUDE.md`, `docs/todo.md` *(modify)* | The probe table entry; what shipped and what is unswept. |

---

## Task 1: Move `variantLetter`, then find the spine

**Files:**
- Modify: `app/src/main/flow-steps.ts` (append after `allSteps`, around line 158)
- Modify: `app/src/main/habit-doc.ts:66-68` (delete the function, re-export instead)
- Modify: `app/src/main/habit-marks.ts:25` (import from the new home)
- Create: `app/src/main/way-fork.ts`
- Test: `test/way-fork.test.ts`

**Interfaces:**
- Consumes: `FlowWalk` and `FlowStep` from `./flow-steps.js`.
- Produces: `variantLetter(index: number): string` from `flow-steps.ts`; `placeKey(s: FlowStep): string` and `spineOf(ways: readonly FlowWalk[]): string[]` from `way-fork.ts`.

- [ ] **Step 1: Move `variantLetter` into `flow-steps.ts`**

Cut this from `app/src/main/habit-doc.ts` (lines 57–68, the doc comment and the function) and paste it into `app/src/main/flow-steps.ts` immediately after `allSteps`:

```ts
/**
 * A variant's label: A, B, C…
 *
 * A LETTER, never a number, because the steps inside a variant are numbered and
 * "2.3" would read as a sub-step of a single procedure — which is the exact
 * misreading the variant machinery exists to stop. Past Z it falls back to the
 * index, which no real route reaches and which is still unambiguous.
 *
 * It lives HERE rather than in `habit-doc.ts` because this file owns
 * `FlowWalk.index`, whose comment already says that index exists so a formatter
 * can label variants without knowing how they were ordered — and because
 * `way-fork.ts` needs it while `habit-doc.ts` imports `way-fork.ts`, so leaving
 * it there is an import cycle.
 */
export function variantLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `#${index + 1}`;
}
```

In `app/src/main/habit-doc.ts`, add `variantLetter` to the existing `./flow-steps.js` import block (lines 26–34) and re-export it so nothing outside has to move:

```ts
export { variantLetter } from "./flow-steps.js";
```

In `app/src/main/habit-marks.ts`, change line 25 from `import { variantLetter } from "./habit-doc.js";` to add `variantLetter` to its existing `./flow-steps.js` import instead, and delete the `habit-doc.js` import if `variantLetter` was its only member.

- [ ] **Step 2: Run the suite to confirm the move broke nothing**

Run: `npm test`
Expected: PASS, same counts as before the move.

- [ ] **Step 3: Write the failing spine test**

Create `test/way-fork.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { placeKey, spineOf } from "../app/src/main/way-fork.js";
import type { FlowStep, FlowWalk } from "../app/src/main/flow-steps.js";

/**
 * The four Ways below are the REAL ones, read off the store on 2026-08-23:
 * the Calculator → TextEdit route, 4 recordings, 4 Ways, one recording each.
 * They are here rather than as tidy synthetic letters because two of their
 * shapes killed a design — Way C's `n0 — no state` head makes the common
 * PREFIX across all four empty, and Way D repeats `TextEdit → TextEdit` five
 * times in a row.
 */
const step = (index: number, from: string, to: string): FlowStep => ({
  index,
  edgeId: `e${index}`,
  from,
  to,
  actions: [],
  observations: 1,
  everyRecording: false,
  firstAt: null,
  sourcesBelowObservations: false,
  liftWarnings: [],
  missing: false,
});

/** `[["A","B"],["B","C"]]` -> a walk of two steps. */
const way = (index: number, sessionIds: string[], hops: [string, string][]): FlowWalk => ({
  index,
  sessionIds,
  steps: hops.map(([from, to], i) => step(i, from, to)),
});

const CALC = "Calculator";
const TE = "TextEdit";
const FI = "Finder";
const NO = "n0 — no state";

const WAY_A = way(0, ["sA"], [[CALC, CALC], [CALC, CALC], [CALC, TE], [TE, TE], [TE, TE]]);
const WAY_B = way(1, ["sB"], [[CALC, CALC], [CALC, CALC], [CALC, TE], [TE, TE]]);
const WAY_C = way(2, ["sC"], [[NO, CALC], [CALC, CALC], [CALC, TE], [TE, TE]]);
const WAY_D = way(3, ["sD"], [
  [CALC, CALC], [CALC, CALC], [CALC, TE], [TE, TE], [TE, TE], [TE, TE], [TE, TE],
  [TE, TE], [TE, FI], [FI, FI], [FI, FI], [FI, TE], [TE, TE],
]);

describe("spineOf", () => {
  it("is empty for no ways", () => {
    expect(spineOf([])).toEqual([]);
  });

  it("is the whole walk for a single way", () => {
    expect(spineOf([WAY_B])).toEqual([
      placeKey(step(0, CALC, CALC)),
      placeKey(step(0, CALC, CALC)),
      placeKey(step(0, CALC, TE)),
      placeKey(step(0, TE, TE)),
    ]);
  });

  it("drops the step one way lacks", () => {
    // A has a trailing TextEdit step that B does not.
    expect(spineOf([WAY_A, WAY_B])).toHaveLength(4);
  });

  it("finds the three-step spine of the four REAL ways", () => {
    // Calculator work, hand off to TextEdit, TextEdit work.
    expect(spineOf([WAY_A, WAY_B, WAY_C, WAY_D])).toEqual([
      placeKey(step(0, CALC, CALC)),
      placeKey(step(0, CALC, TE)),
      placeKey(step(0, TE, TE)),
    ]);
  });

  it("survives an empty common PREFIX", () => {
    // Way C begins at `n0 — no state` and the others begin at Calculator, so
    // the longest common prefix is empty. A prefix/suffix rule reports
    // "everything differed" here; a subsequence does not.
    const spine = spineOf([WAY_A, WAY_C]);
    expect(spine.length).toBeGreaterThan(0);
    expect(spine[0]).toBe(placeKey(step(0, CALC, CALC)));
  });

  it("does not over-match a place label that repeats", () => {
    // D holds five consecutive TextEdit → TextEdit steps. The spine may claim
    // at most as many as the SHORTEST way has.
    const spine = spineOf([WAY_B, WAY_D]);
    const tt = spine.filter((k) => k === placeKey(step(0, TE, TE))).length;
    expect(tt).toBe(1);
  });

  it("is a subsequence of every way it was folded from", () => {
    const spine = spineOf([WAY_A, WAY_B, WAY_C, WAY_D]);
    for (const w of [WAY_A, WAY_B, WAY_C, WAY_D]) {
      const keys = w.steps.map(placeKey);
      let k = 0;
      for (const key of keys) if (k < spine.length && key === spine[k]) k += 1;
      expect(k).toBe(spine.length);
    }
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npx vitest run test/way-fork.test.ts`
Expected: FAIL — `Failed to resolve import "../app/src/main/way-fork.js"`.

- [ ] **Step 5: Write `way-fork.ts` with the fold**

Create `app/src/main/way-fork.ts`:

```ts
/**
 * Where a habit's Ways share a spine, and where they fork.
 *
 * The record prints each Way as an independent numbered list, so a reader has
 * to diff four procedures by eye. This is the diff, and it is the ONE
 * implementation both formatters read — `habit-doc.ts` renders it into the
 * file and `HabitsScreen.tsx` draws it. Two readers of one tree is the
 * `ax-dump`/`ax-exec` drift hazard by name.
 *
 * Pure: `FlowsDTO` in, plain objects out. No store, no Electron, no model —
 * the same contract `flow-steps.ts` and `walk-analysis.ts` hold, and what keeps
 * this file in the ROOT suite.
 *
 * IT ALIGNS ON PLACE LABELS, NOT ON EDGE IDS, and that is a measurement rather
 * than a preference. Read off the real store on 2026-08-23: the one route with
 * several Ways has FOUR of them and they share EXACTLY ONE EDGE between them.
 * Aligning on edge ids yields two disjoint lists with zero matches — not a
 * fork. The cause is structural and no corpus growth fixes it: a node's
 * identity is what the task does next, so two recordings of the same button
 * mashing lift to different nodes and therefore different edges. It is the same
 * fact that made `FlowRouteDTO.id` a place-label sequence, where edge-id and
 * node-id keys both split five identical walks into nine routes of ×1.
 *
 * THERE IS NO SCORE HERE. `walk-align.ts` states the rule for its own numbers
 * and it holds here: an edit-distance ratio is exactly the figure this repo
 * refuses to print. What comes out is a spine a person can check against a
 * screen, the runs that hang off it, and — behind two gates — one sentence
 * comparing printed ranges.
 */

import type { FlowRouteDTO, FlowsDTO } from "@shared/types";
import { flowWalks, variantLetter, type FlowStep, type FlowWalk } from "./flow-steps.js";

/**
 * A step's place identity: where it came from and where it went.
 *
 * A NUL delimiter, for the reason `src/store/store.ts` uses one — a place label
 * cannot contain one, so the joined key cannot collide. Written as an ESCAPE
 * rather than a literal byte, because two literal NULs in `store.ts` are why
 * `grep` silently skips that file.
 */
export const placeKey = (s: FlowStep): string => `${s.from}\0${s.to}`;

/**
 * The longest common subsequence of two key sequences.
 *
 * Standard O(nm) DP with a forward traceback. The tie-break prefers advancing
 * `a`, which makes the result deterministic — a spine that moved between runs
 * would re-order the record on every read.
 */
function lcs(a: readonly string[], b: readonly string[]): string[] {
  const n = a.length;
  const m = b.length;
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      len[i]![j] = a[i] === b[j] ? len[i + 1]![j + 1]! + 1 : Math.max(len[i + 1]![j]!, len[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(a[i]!);
      i += 1;
      j += 1;
    } else if (len[i + 1]![j]! >= len[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return out;
}

/**
 * A place-step sequence every Way contains, in order.
 *
 * Folded pairwise: the first Way, then LCS'd against each subsequent one. An
 * N-way LCS is NP-hard, so this is the standard progressive approximation and
 * is NOT claimed to be the longest such sequence — only to be one every Way
 * contains, which is true of any fold result and is the property both surfaces
 * rely on. `test/way-fork.test.ts` asserts exactly that property rather than a
 * length.
 */
export function spineOf(ways: readonly FlowWalk[]): string[] {
  if (ways.length === 0) return [];
  let spine = ways[0]!.steps.map(placeKey);
  for (let i = 1; i < ways.length; i += 1) {
    if (spine.length === 0) break;
    spine = lcs(spine, ways[i]!.steps.map(placeKey));
  }
  return spine;
}
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `npx vitest run test/way-fork.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Run the whole gate**

Run each whole, unpiped:
```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add app/src/main/way-fork.ts app/src/main/flow-steps.ts app/src/main/habit-doc.ts app/src/main/habit-marks.ts test/way-fork.test.ts
git commit -m "feat(habits): the spine, because edge ids do not align"
```

---

## Task 2: The rows — spine, forks, and the runs that hang off them

**Files:**
- Modify: `app/src/main/way-fork.ts`
- Test: `test/way-fork.test.ts`

**Interfaces:**
- Consumes: `placeKey`, `spineOf`, `FlowStep`, `FlowWalk`.
- Produces:
  ```ts
  export interface SpineAt { wayIndex: number; step: FlowStep }
  export interface ForkRun { wayIndex: number; steps: FlowStep[] }
  export type ForkRow =
    | { kind: "spine"; from: string; to: string; at: SpineAt[] }
    | { kind: "fork"; after: number; runs: ForkRun[] };
  export function forkRows(ways: readonly FlowWalk[], spine: readonly string[]): ForkRow[];
  export function runPhrase(run: ForkRun, after: number): string;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/way-fork.test.ts`, and add `forkRows`, `runPhrase` and the types to the import at the top:

```ts
describe("forkRows", () => {
  const rows = forkRows([WAY_A, WAY_B, WAY_C, WAY_D], spineOf([WAY_A, WAY_B, WAY_C, WAY_D]));
  const spines = rows.filter((r) => r.kind === "spine");
  const forks = rows.filter((r) => r.kind === "fork");

  it("emits one spine row per spine position, in order", () => {
    expect(spines.map((r) => (r.kind === "spine" ? `${r.from}>${r.to}` : ""))).toEqual([
      `${CALC}>${CALC}`,
      `${CALC}>${TE}`,
      `${TE}>${TE}`,
    ]);
  });

  it("carries EVERY way's own step on a spine row", () => {
    // The step differs per way even where the PLACES agree — this is what lets
    // both surfaces show that one recording pasted where another retyped.
    const first = spines[0];
    expect(first?.kind === "spine" && first.at.map((a) => a.wayIndex)).toEqual([0, 1, 2, 3]);
  });

  it("emits a fork row only where at least one way filled the gap", () => {
    // Gap 0 (Way C's `n0` head), gap 1 (the extra Calculator step), and the
    // trailing gap. The gap between `Calculator → TextEdit` and
    // `TextEdit → TextEdit` is empty in all four and must not be drawn.
    expect(forks.map((r) => (r.kind === "fork" ? r.after : NaN))).toEqual([-1, 0, 2]);
  });

  it("keeps a way with nothing to add PRESENT with an empty run", () => {
    // "B did nothing here" and "B is not in this picture" are different facts.
    const leading = forks[0];
    expect(leading?.kind === "fork" && leading.runs.map((r) => r.steps.length)).toEqual([0, 0, 1, 0]);
  });

  it("attributes the whole Finder excursion to one trailing run", () => {
    const trailing = forks[2];
    const d = trailing?.kind === "fork" ? trailing.runs.find((r) => r.wayIndex === 3) : undefined;
    expect(d?.steps).toHaveLength(9);
  });

  it("draws no fork rows at all when the ways agree", () => {
    const same = forkRows([WAY_B, { ...WAY_B, index: 1, sessionIds: ["sX"] }], spineOf([WAY_B]));
    expect(same.every((r) => r.kind === "spine")).toBe(true);
  });
});

describe("runPhrase", () => {
  it("names both places for a single step, because the FROM is the news", () => {
    // Way C's leading run: the interesting fact is that it came from no state.
    expect(runPhrase({ wayIndex: 2, steps: [step(0, NO, CALC)] }, -1)).toBe(
      `first, 1 step: ${NO} → ${CALC}`,
    );
  });

  it("counts and lists the places for a run of several", () => {
    expect(
      runPhrase(
        { wayIndex: 3, steps: [step(0, TE, TE), step(1, TE, FI), step(2, FI, TE)] },
        2,
      ),
    ).toBe(`then 3 steps, via ${TE}, ${FI}`);
  });

  it("says nothing happened rather than going blank", () => {
    expect(runPhrase({ wayIndex: 1, steps: [] }, 0)).toBe("nothing here");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run test/way-fork.test.ts`
Expected: FAIL — `forkRows is not exported`.

- [ ] **Step 3: Implement the rows**

Append to `app/src/main/way-fork.ts`:

```ts
/** One Way's own step at a spine position. */
export interface SpineAt {
  wayIndex: number;
  step: FlowStep;
}

/** What one Way did in the gap between two spine positions. May be empty. */
export interface ForkRun {
  wayIndex: number;
  steps: FlowStep[];
}

export type ForkRow =
  /** A place-step every Way took, with each Way's own step at that position. */
  | { kind: "spine"; from: string; to: string; at: SpineAt[] }
  /** The gap AFTER spine position `after`. `-1` is the gap before the first. */
  | { kind: "fork"; after: number; runs: ForkRun[] };

/**
 * One Way scanned forward against the spine.
 *
 * Greedy leftmost matching, which always succeeds when the spine is a
 * subsequence of the Way — and `spineOf` guarantees that it is, so `at` is
 * fully populated. `runs` has `spine.length + 1` entries: `runs[k]` is what
 * this Way did BEFORE spine position `k`, and `runs[spine.length]` is what it
 * did after the last one.
 */
function scan(
  steps: readonly FlowStep[],
  spine: readonly string[],
): { at: (FlowStep | undefined)[]; runs: FlowStep[][] } {
  const at = new Array<FlowStep | undefined>(spine.length).fill(undefined);
  const runs: FlowStep[][] = Array.from({ length: spine.length + 1 }, () => []);
  let k = 0;
  for (const s of steps) {
    if (k < spine.length && placeKey(s) === spine[k]) {
      at[k] = s;
      k += 1;
    } else {
      runs[k]!.push(s);
    }
  }
  return { at, runs };
}

/**
 * The spine and its forks, as one ordered list a formatter can walk.
 *
 * A fork row is emitted ONLY where at least one Way filled the gap — a row of
 * four "nothing here"s is noise, and `cautionsFor` already paid for that shape
 * once by printing one fact twelve times in an eighteen-bullet section. But
 * within a row that IS drawn, every Way appears, empty run and all: "B did
 * nothing here" and "B is not in this picture" are different facts.
 */
export function forkRows(ways: readonly FlowWalk[], spine: readonly string[]): ForkRow[] {
  const scans = ways.map((w) => scan(w.steps, spine));
  const out: ForkRow[] = [];

  const gap = (k: number): void => {
    const runs = scans.map((s, i) => ({ wayIndex: ways[i]!.index, steps: s.runs[k]! }));
    if (runs.some((r) => r.steps.length > 0)) out.push({ kind: "fork", after: k - 1, runs });
  };

  for (let k = 0; k < spine.length; k += 1) {
    gap(k);
    const at: SpineAt[] = [];
    for (let i = 0; i < ways.length; i += 1) {
      const s = scans[i]!.at[k];
      // Cannot be undefined — the spine is a subsequence of every Way and
      // greedy leftmost matching of a subsequence always succeeds. Guarded
      // rather than asserted so a future spine rule that breaks the invariant
      // degrades to a thinner row instead of throwing at render time.
      if (s !== undefined) at.push({ wayIndex: ways[i]!.index, step: s });
    }
    const first = at[0];
    out.push({
      kind: "spine",
      from: first?.step.from ?? "",
      to: first?.step.to ?? "",
      at,
    });
  }
  gap(spine.length);
  return out;
}

/**
 * What one Way did in a gap, in words.
 *
 * The words live HERE rather than in either formatter, so the file and the
 * screen cannot disagree about them — the same reason `differBlock` prints
 * `Baseline.reason` verbatim.
 *
 * A single step names BOTH its places, because on the real store the one
 * single-step run is Way C's `n0 — no state → Calculator`, where the FROM is
 * the entire news. A longer run names its distinct destinations instead: nine
 * lines of `TextEdit → TextEdit` is not a reading.
 */
export function runPhrase(run: ForkRun, after: number): string {
  const lead = after < 0 ? "first, " : "then ";
  const n = run.steps.length;
  if (n === 0) return "nothing here";
  const one = run.steps[0]!;
  if (n === 1) return `${lead}1 step: ${one.from} → ${one.to}`;
  const via = [...new Set(run.steps.map((s) => s.to))].join(", ");
  return `${lead}${n} steps, via ${via}`;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run test/way-fork.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Run the whole gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add app/src/main/way-fork.ts test/way-fork.test.ts
git commit -m "feat(habits): the forks that hang off the spine, empty runs included"
```

---

## Task 3: The verdict, behind two gates

**Files:**
- Modify: `app/src/main/way-fork.ts`
- Test: `test/way-fork.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const FORK_VERDICT_MIN_WALKS = 2;
  export const secs: (ms: number) => string;
  export interface WaySummary {
    wayIndex: number; letter: string; steps: number; sessionIds: string[]; totalsMs: number[];
  }
  export type Verdict =
    | { kind: "named"; text: string }
    | { kind: "withheld"; reason: string };
  export function verdictFor(ways: readonly WaySummary[]): Verdict;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/way-fork.test.ts`, adding `FORK_VERDICT_MIN_WALKS`, `verdictFor` and `type WaySummary` to the import:

```ts
const summary = (letter: string, totalsMs: number[], wayIndex = 0): WaySummary => ({
  wayIndex,
  letter,
  steps: 4,
  sessionIds: totalsMs.map((_, i) => `${letter}${i}`),
  totalsMs,
});

describe("verdictFor", () => {
  it("withholds, with a reason, when there is only one way", () => {
    const v = verdictFor([summary("A", [1000, 2000])]);
    expect(v.kind).toBe("withheld");
    expect(v.kind === "withheld" && v.reason).toMatch(/only one way/i);
  });

  it("withholds below the floor and NAMES the thin ways", () => {
    // This is the real store as of 2026-08-23: four ways, one recording each.
    const v = verdictFor([summary("A", [39300]), summary("B", [24000], 1)]);
    expect(v.kind).toBe("withheld");
    expect(v.kind === "withheld" && v.reason).toBe(
      "Way A, Way B have fewer than 2 timed recordings, so nothing here says one way is better.",
    );
  });

  it("withholds on OVERLAPPING ranges and prints both", () => {
    const v = verdictFor([summary("A", [24000, 39300]), summary("B", [22100, 39900], 1)]);
    expect(v.kind).toBe("withheld");
    expect(v.kind === "withheld" && v.reason).toBe(
      "Their times overlap (B 22.1–39.9s, A 24.0–39.3s), so these recordings do not say one is faster.",
    );
  });

  it("fires only when the SLOWEST of one beat the FASTEST of every other", () => {
    const v = verdictFor([summary("B", [22100, 25900]), summary("D", [60200, 62300], 1)]);
    expect(v).toEqual({
      kind: "named",
      text: "Every recording of Way B (22.1–25.9s) was faster than every recording of Way D (60.2–62.3s).",
    });
  });

  it("lists every other way when there are more than two", () => {
    const v = verdictFor([
      summary("B", [22100, 25900]),
      summary("A", [30000, 39300], 1),
      summary("D", [60200, 62300], 2),
    ]);
    expect(v.kind === "named" && v.text).toBe(
      "Every recording of Way B (22.1–25.9s) was faster than every recording of Way A (30.0–39.3s) and Way D (60.2–62.3s).",
    );
  });

  it("withholds when fewer than two ways have any timed recording", () => {
    const v = verdictFor([summary("A", [22100, 25900]), summary("B", [], 1)]);
    expect(v.kind).toBe("withheld");
    expect(v.kind === "withheld" && v.reason).toMatch(/timed recording/i);
  });

  it("holds the floor at 2", () => {
    expect(FORK_VERDICT_MIN_WALKS).toBe(2);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run test/way-fork.test.ts`
Expected: FAIL — `verdictFor is not exported`.

- [ ] **Step 3: Implement the verdict**

Append to `app/src/main/way-fork.ts`:

```ts
/**
 * Recordings a Way needs before it may take part in a comparison.
 *
 * UNSWEPT. It needs a route walked several times along at least two Ways, and
 * the library that exists holds four Ways of one recording each — so on the
 * store this shipped against, the floor is what speaks, every time. Two is the
 * smallest number for which "every recording of B beat every recording of D"
 * says anything at all; one recording each is one afternoon against another.
 * Re-read this when the library grows, the way C2's two floors want re-reading.
 */
export const FORK_VERDICT_MIN_WALKS = 2;

/** One decimal and a unit. Durations are read beside each other, so width matters. */
export const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export interface WaySummary {
  wayIndex: number;
  letter: string;
  steps: number;
  sessionIds: string[];
  /** Each recording's own whole-walk duration, in the Way's session order. */
  totalsMs: number[];
}

/**
 * Whether one Way was faster, or why that cannot be said.
 *
 * `withheld.reason` is REQUIRED and is never an enum. A surface that merely
 * goes quiet is indistinguishable from one nobody implemented — the
 * `StageSpec.skipReason` rule, which the Indexing ladder pays for one screen
 * over.
 */
export type Verdict = { kind: "named"; text: string } | { kind: "withheld"; reason: string };

const range = (w: WaySummary): { letter: string; lo: number; hi: number } => ({
  letter: w.letter,
  lo: Math.min(...w.totalsMs),
  hi: Math.max(...w.totalsMs),
});

const printed = (r: { letter: string; lo: number; hi: number }): string =>
  `Way ${r.letter} (${secs(r.lo)}–${secs(r.hi)})`;

/**
 * TWO GATES, and neither is a statistic.
 *
 * A floor of `FORK_VERDICT_MIN_WALKS` recordings per Way, then a
 * NON-OVERLAPPING RANGE test: the verdict fires only where the slowest
 * recording of one Way beat the fastest recording of every other. No mean, no
 * median, no ratio, no significance test — a rule a person can check against
 * the numbers printed beside it, which is the standard `FrameResult.score`
 * established when the UI chose rank and evidence over the figure.
 *
 * The times themselves are printed beside every Way regardless of both gates.
 * Facts always; a verdict only when it is earned.
 */
export function verdictFor(ways: readonly WaySummary[]): Verdict {
  if (ways.length < 2) {
    return {
      kind: "withheld",
      reason: "There is only one way through this route, so there is nothing to compare.",
    };
  }
  const timed = ways.filter((w) => w.totalsMs.length > 0);
  if (timed.length < 2) {
    return {
      kind: "withheld",
      reason:
        "Fewer than two ways have a timed recording, so nothing here says one way is better.",
    };
  }
  const thin = timed.filter((w) => w.totalsMs.length < FORK_VERDICT_MIN_WALKS);
  if (thin.length > 0) {
    const names = thin.map((w) => `Way ${w.letter}`).join(", ");
    return {
      kind: "withheld",
      reason:
        `${names} ${thin.length === 1 ? "has" : "have"} fewer than ${FORK_VERDICT_MIN_WALKS} ` +
        `timed recordings, so nothing here says one way is better.`,
    };
  }

  const ranges = timed.map(range).sort((a, b) => a.hi - b.hi || a.letter.localeCompare(b.letter));
  const fastest = ranges[0]!;
  const rest = ranges.slice(1);
  const overlapping = rest.filter((r) => r.lo <= fastest.hi);
  if (overlapping.length > 0) {
    const shown = [fastest, ...overlapping]
      .map((r) => `${r.letter} ${secs(r.lo)}–${secs(r.hi)}`)
      .join(", ");
    return {
      kind: "withheld",
      reason: `Their times overlap (${shown}), so these recordings do not say one is faster.`,
    };
  }

  const others =
    rest.length === 1
      ? printed(rest[0]!)
      : `${rest.slice(0, -1).map(printed).join(", ")} and ${printed(rest[rest.length - 1]!)}`;
  return {
    kind: "named",
    text: `Every recording of ${printed(fastest)} was faster than every recording of ${others}.`,
  };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run test/way-fork.test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 5: Run the whole gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add app/src/main/way-fork.ts test/way-fork.test.ts
git commit -m "feat(habits): a floor and a range test, so better must be earned"
```

---

## Task 4: `wayFork` — the entry point both formatters call

**Files:**
- Modify: `app/src/main/way-fork.ts`
- Test: `test/way-fork.test.ts`

**Interfaces:**
- Consumes: `spineOf`, `forkRows`, `verdictFor`, `variantLetter`, `flowWalks`.
- Produces:
  ```ts
  export interface WayFork { ways: WaySummary[]; rows: ForkRow[]; verdict: Verdict }
  export interface WayForkInput { flows: FlowsDTO; route: FlowRouteDTO }
  export function wayFork(input: WayForkInput): WayFork | null;
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/way-fork.test.ts`. It needs a `FlowsDTO`, built the way `test/walk-analysis.test.ts` builds one — copy these helpers in and add the imports:

```ts
import type {
  EdgeSourceDTO, FlowRouteDTO, FlowsDTO, GraphEdgeDTO, GraphNodeDTO, RouteWalkDTO,
} from "@shared/types";
import { wayFork } from "../app/src/main/way-fork.js";

const gnode = (id: string, label: string): GraphNodeDTO => ({
  id, label, chip: id, observations: 1, predicates: ["app(Test)"],
  locatable: true, intervene: "none", rank: 0, sources: [],
});
const gedge = (id: string, from: string, to: string, sources: EdgeSourceDTO[]): GraphEdgeDTO => ({
  id, from, to, actions: [], back: false, provenance: "recorded",
  observations: Math.max(1, sources.length), sources,
});
const rwalk = (sessionId: string, edgeIds: string[], atSec: number, throughSec: number): RouteWalkDTO =>
  ({ sessionId, edgeIds, atSec, throughSec });

describe("wayFork", () => {
  /**
   * Two recordings over the places Calc, Calc, TextEdit — one of which takes a
   * detour through Finder before arriving. Distinct EDGE ids per session,
   * because that is what the real store holds and it is the whole reason the
   * alignment is on places.
   */
  const build = (): { flows: FlowsDTO; route: FlowRouteDTO } => {
    const nodes = [gnode("c", "Calculator"), gnode("t", "TextEdit"), gnode("f", "Finder")];
    const edges = [
      gedge("s1:e0", "c", "c", [{ sessionId: "s1", startedAt: 1000, atSec: 0, throughSec: 5 }]),
      gedge("s1:e1", "c", "t", [{ sessionId: "s1", startedAt: 1000, atSec: 5, throughSec: 8 }]),
      gedge("s2:e0", "c", "c", [{ sessionId: "s2", startedAt: 2000, atSec: 0, throughSec: 4 }]),
      gedge("s2:e1", "c", "f", [{ sessionId: "s2", startedAt: 2000, atSec: 4, throughSec: 9 }]),
      gedge("s2:e2", "f", "t", [{ sessionId: "s2", startedAt: 2000, atSec: 9, throughSec: 12 }]),
    ];
    const route: FlowRouteDTO = {
      id: "Calculator → TextEdit",
      count: 2,
      label: "Calculator → TextEdit",
      name: null,
      edgeIds: edges.map((e) => e.id),
      nodeIds: ["c", "t", "f"],
      sessionIds: ["s1", "s2"],
      variants: 0,
      walks: [
        rwalk("s1", ["s1:e0", "s1:e1"], 0, 8),
        rwalk("s2", ["s2:e0", "s2:e1", "s2:e2"], 0, 12),
      ],
    };
    return { flows: { graph: { id: "g", entry: "c", nodes, edges, slots: [] }, routes: [route], excludedApps: [] }, route };
  };

  it("is null when the route has a single way", () => {
    const { flows, route } = build();
    const one: FlowRouteDTO = { ...route, count: 1, sessionIds: ["s1"], walks: [route.walks[0]!] };
    expect(wayFork({ flows, route: one })).toBeNull();
  });

  it("letters the ways the same way the record does", () => {
    const { flows, route } = build();
    expect(wayFork({ flows, route })?.ways.map((w) => w.letter)).toEqual(["A", "B"]);
  });

  it("carries each recording's own whole-walk total", () => {
    const { flows, route } = build();
    const ways = wayFork({ flows, route })!.ways;
    expect(ways.map((w) => w.totalsMs)).toEqual([[8000], [12000]]);
  });

  it("finds the shared spine and puts the detour in a fork", () => {
    const { flows, route } = build();
    const fork = wayFork({ flows, route })!;
    const spines = fork.rows.filter((r) => r.kind === "spine");
    expect(spines).toHaveLength(1);
    expect(spines[0]?.kind === "spine" && `${spines[0].from}>${spines[0].to}`).toBe(
      "Calculator>Calculator",
    );
    const forks = fork.rows.filter((r) => r.kind === "fork");
    expect(forks).toHaveLength(1);
  });

  it("withholds the verdict at one recording per way", () => {
    const { flows, route } = build();
    expect(wayFork({ flows, route })!.verdict.kind).toBe("withheld");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run test/way-fork.test.ts`
Expected: FAIL — `wayFork is not exported`.

- [ ] **Step 3: Implement `wayFork`**

Append to `app/src/main/way-fork.ts`:

```ts
export interface WayFork {
  ways: WaySummary[];
  rows: ForkRow[];
  verdict: Verdict;
}

export interface WayForkInput {
  flows: FlowsDTO;
  route: FlowRouteDTO;
}

/**
 * The fork, or null when there is no fork to draw.
 *
 * Null below two Ways, which is the healthy case and the one every route with
 * a single procedure is in — the caller keeps drawing exactly what it drew
 * before. Shaped like `walkAnalysis({flows, route})` on purpose: one input
 * object, so a third reader cannot be built that takes a different one.
 *
 * A Way's total is the WHOLE-WALK span from `RouteWalkDTO`, never a sum of step
 * durations. Steps are not shared between Ways — measured, the four real Ways
 * share exactly one edge — so a per-step comparison across Ways has nothing to
 * compare. The whole walk does.
 */
export function wayFork(input: WayForkInput): WayFork | null {
  const { flows, route } = input;
  const ways = flowWalks(flows, route);
  if (ways.length < 2) return null;

  const totalMs = new Map(
    route.walks.map((w) => [
      w.sessionId,
      Math.max(0, Math.round((w.throughSec - w.atSec) * 1000)),
    ]),
  );

  const summaries: WaySummary[] = ways.map((w) => ({
    wayIndex: w.index,
    letter: variantLetter(w.index),
    steps: w.steps.length,
    sessionIds: [...w.sessionIds],
    totalsMs: w.sessionIds.flatMap((id) => {
      const ms = totalMs.get(id);
      // A session with no walk span is DROPPED, never zeroed. A zero would read
      // as an instantaneous recording and would drag a range's floor to 0.0s.
      return ms === undefined ? [] : [ms];
    }),
  }));

  return {
    ways: summaries,
    rows: forkRows(ways, spineOf(ways)),
    verdict: verdictFor(summaries),
  };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run test/way-fork.test.ts`
Expected: PASS, 28 tests.

- [ ] **Step 5: Run the whole gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add app/src/main/way-fork.ts test/way-fork.test.ts
git commit -m "feat(habits): one entry point, so both formatters read one fork"
```

---

## Task 5: The record — replace `How the recordings differ`

**Files:**
- Modify: `app/src/main/habit-doc.ts` — delete `differBlock` (lines 261–316) and its call (line 529); add `forkBlock`; change `timeBlock` (lines 318–356); delete the local `secs` (line 255) in favour of the one from `way-fork.ts`
- Test: `test/habit.doc.test.ts`

**Interfaces:**
- Consumes: `wayFork`, `runPhrase`, `secs`, `type WayFork` from `./way-fork.js`; `variantLetter` from `./flow-steps.js`.
- Produces: nothing new outside the file.

- [ ] **Step 1: Write the failing tests**

Add to `test/habit.doc.test.ts`. Match the file's existing fixture style; the assertions are on the rendered string:

```ts
describe("## Where the ways fork", () => {
  it("replaces the old heading entirely", () => {
    const md = renderRecordWithTwoWays();   // the file's existing multi-way fixture
    expect(md).not.toContain("## How the recordings differ");
    expect(md).toContain("## Where the ways fork");
  });

  it("keeps the agreement sentence when there is one way", () => {
    // Going silent here would make "they all did the same thing"
    // indistinguishable from "nothing was measured".
    const md = renderRecordWithOneWayAndThreeRecordings();
    expect(md).toContain("All 3 recordings took the same path.");
  });

  it("lists each way with its step count, recordings and own times", () => {
    const md = renderRecordWithTwoWays();
    expect(md).toMatch(/- \*\*Way A\*\* — \d+ steps?, \d+ recordings?, [\d.]+s/);
  });

  it("numbers the spine and indents the forks under it", () => {
    const md = renderRecordWithTwoWays();
    expect(md).toMatch(/^1\. \*\*.+ → .+\*\*$/m);
    expect(md).toMatch(/^ {3}- Way [A-Z]: /m);
  });

  it("prints the withheld reason when the verdict cannot fire", () => {
    const md = renderRecordWithTwoWays();
    expect(md).toMatch(/nothing here says one way is better\./);
  });
});

describe("## Where the time goes", () => {
  it("names the way it is about", () => {
    const md = renderRecordWithTwoWays();
    expect(md).toMatch(/These are Way [A-Z]'s steps/);
  });

  it("discloses that every row holds a single observation", () => {
    // Measured on the real store: the ways share no steps, so every row has
    // exactly one duration and the comma list READS like a comparison.
    const md = renderRecordWithTwoWays();
    expect(md).toContain("one recording each, so these are observations rather than a comparison");
  });
});
```

If `test/habit.doc.test.ts` has no multi-way fixture, add these two helpers to it, built on whatever `FlowsDTO` builder the file already uses:

```ts
/** Two ways over one route, distinct edge ids per session — the real shape. */
function renderRecordWithTwoWays(): string { /* build flows+route, call recordedBlocks */ }
/** Three recordings that all walked the identical edge sequence. */
function renderRecordWithOneWayAndThreeRecordings(): string { /* … */ }
```

Build them exactly as `wayFork`'s `build()` in Task 4 does — `gnode` / `gedge` / `rwalk` — and call `recordedBlocks({ flows, route, showSamples: false })`.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run test/habit.doc.test.ts`
Expected: FAIL — the old heading is still present.

- [ ] **Step 3: Delete `differBlock` and write `forkBlock`**

In `app/src/main/habit-doc.ts`: delete the whole `differBlock` function and its doc comment, delete the local `const secs = …`, and add to the imports:

```ts
import { runPhrase, secs, wayFork, type WayFork } from "./way-fork.js";
```

Add in its place:

```ts
/**
 * Where the ways fork.
 *
 * REPLACES `## How the recordings differ`, and nothing is lost. That block
 * reported per-RECORDING deviation counts against a baseline which, on the real
 * store, is chosen by tiebreak and moves between runs; this names which
 * recordings took each way directly and needs no standard at all. Keeping both
 * would print one fact twice — `cautionsFor` already paid for that shape once,
 * printing one fact TWELVE times in an eighteen-bullet section.
 *
 * The agreement sentence is preserved verbatim, for `differBlock`'s own stated
 * reason: going silent when they all did the same thing would make that
 * indistinguishable from nothing having been measured.
 */
function forkBlock(fork: WayFork | null, count: number): string[] {
  if (count < 2) return [];
  if (fork === null) {
    return ["## Where the ways fork", "", `All ${count} recordings took the same path.`, ""];
  }

  const out = [
    "## Where the ways fork",
    "",
    "The numbered steps are the part every way has in common. The indented lines are where they differ — a way with nothing indented under a step did only that step there.",
    "",
  ];
  for (const w of fork.ways) {
    const n = w.sessionIds.length;
    const times = w.totalsMs.length === 0 ? "no timed recording" : w.totalsMs.map(secs).join(", ");
    out.push(
      `- **Way ${w.letter}** — ${w.steps} step${w.steps === 1 ? "" : "s"}, ` +
        `${n === 1 ? "1 recording" : `${n} recordings`}, ${times}`,
    );
  }
  out.push("");

  const letterOf = new Map(fork.ways.map((w) => [w.wayIndex, w.letter]));
  let n = 0;
  for (const row of fork.rows) {
    if (row.kind === "spine") {
      n += 1;
      out.push(`${n}. **${row.from} → ${row.to}**`);
      continue;
    }
    for (const run of row.runs) {
      if (run.steps.length === 0) continue;
      const letter = letterOf.get(run.wayIndex) ?? String(run.wayIndex);
      // A leading fork has no numbered step to sit under, so it is a top-level
      // bullet. Everything else indents beneath the step it followed.
      const indent = row.after < 0 ? "- " : "   - ";
      out.push(`${indent}Way ${letter}: ${runPhrase(run, row.after)}`);
    }
  }

  out.push("");
  out.push(fork.verdict.kind === "named" ? fork.verdict.text : fork.verdict.reason);
  out.push("");
  return out;
}
```

Change the call site (was line 528–529) to:

```ts
  const analysis = walkAnalysis({ flows, route });
  const fork = wayFork({ flows, route });
  out.push(...forkBlock(fork, route.count));
```

- [ ] **Step 4: Change `timeBlock` to name its Way and disclose single rows**

Replace `timeBlock`'s signature and its opening lines. The function currently takes `(steps, baseWay)`; give it the Way's letter too, and compute the disclosure:

```ts
function timeBlock(
  steps: readonly StepCost[],
  baseWay: FlowWalk | undefined,
  letter: string,
): string[] {
  if (baseWay === undefined) return [];
  const rows = steps.filter((s) => s.durations.length > 0);
  if (rows.length === 0) return [];

  // EVERY row holding exactly one duration is the normal case on a real store
  // and it is not obvious from the output: the comma list reads like a
  // comparison. Measured — the ways share no steps, so a step's durations can
  // only ever come from the recordings of the ONE way it belongs to.
  const single = rows.every((r) => r.durations.length === 1);

  const out = [
    "## Where the time goes",
    "",
    `These are Way ${letter}'s steps, each with its own recorded span. They are durations, not targets.` +
      (single
        ? " Every step below was walked by one recording each, so these are observations rather than a comparison."
        : ""),
    "",
  ];
  // … the existing per-row loop is unchanged …
```

And its call site (was line 534):

```ts
  const baseIndex = analysis.baseline.wayIndex;
  const baseWay = baseIndex === null ? undefined : walks[baseIndex];
  if (route.count > 1 && baseIndex !== null) {
    out.push(...timeBlock(analysis.steps, baseWay, variantLetter(baseIndex)));
  }
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run test/habit.doc.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

Expected: all clean. If any existing `habit.doc` or `mcp.flow-text` test asserts on the string `"How the recordings differ"`, update it to the new heading — that is the point of this task, not a regression.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/habit-doc.ts test/habit.doc.test.ts
git commit -m "feat(habits): the record says where the ways fork, not how they deviate"
```

---

## Task 6: The seam — the DTO and the service

**Files:**
- Modify: `app/src/shared/types.ts` — `HabitWayDTO` (line 1391), new `HabitForkRowDTO`/`HabitForkDTO`, `HabitDTO.fork`
- Modify: `app/src/main/habit-marks.ts` — `habitWays` fills `totalsMs`; new `habitFork`
- Modify: `app/src/main/deskrag-service.ts:1924` — wire `fork:`
- Test: `test/habit.marks.test.ts`

**Interfaces:**
- Consumes: `wayFork`, `runPhrase` from `./way-fork.js`.
- Produces:
  ```ts
  // @shared/types
  export interface HabitWayDTO { letter: string; sessionIds: string[]; steps: HabitStepDTO[]; totalsMs: number[] }
  export type HabitForkRowDTO =
    | { kind: "spine"; from: string; to: string; at: { way: number; step: number }[] }
    | { kind: "fork"; after: number; runs: { way: number; steps: number[]; phrase: string }[] };
  export interface HabitForkDTO {
    rows: HabitForkRowDTO[];
    verdict: { kind: "named"; text: string } | { kind: "withheld"; reason: string };
  }
  // habit-marks.ts
  export function habitFork(flows: FlowsDTO, route: FlowRouteDTO): HabitForkDTO | null;
  ```

- [ ] **Step 1: Add the DTOs**

In `app/src/shared/types.ts`, add `totalsMs` to `HabitWayDTO`:

```ts
export interface HabitWayDTO {
  /** "A", "B", … — the same letter the record prints. */
  letter: string;
  sessionIds: string[];
  steps: HabitStepDTO[];
  /**
   * Each recording's own WHOLE-WALK duration, in `sessionIds` order. A session
   * with no walk span is dropped rather than zeroed, so this may be shorter
   * than `sessionIds` — a zero would read as an instantaneous recording.
   *
   * Whole-walk, never a sum of step durations: the ways share no steps
   * (measured — four real ways share exactly one edge), so there is nothing to
   * add up across them.
   */
  totalsMs: number[];
}
```

And after `HabitWayDTO`, the fork:

```ts
/**
 * One row of the fork picture: a step every way took, or the gap after it.
 *
 * Steps are referenced BY INDEX into `HabitDTO.ways`, never embedded. `way`
 * indexes `ways`; `step` indexes `ways[way].steps`. That keeps the payload
 * small and makes the two structures provably consistent — the fork cannot
 * name a step the ways do not have.
 */
export type HabitForkRowDTO =
  | { kind: "spine"; from: string; to: string; at: { way: number; step: number }[] }
  /** The gap AFTER spine position `after`. `-1` is the gap before the first. */
  | { kind: "fork"; after: number; runs: { way: number; steps: number[]; phrase: string }[] };

/**
 * Where the ways fork, and whether one of them was faster.
 *
 * Null when the route has fewer than two ways, which is the healthy case. The
 * `phrase` on a run and the verdict text are both composed in
 * `app/src/main/way-fork.ts` rather than here or in the renderer, so the
 * rendered file and the screen cannot disagree about the words — the same
 * reason `differBlock` printed `Baseline.reason` verbatim.
 */
export interface HabitForkDTO {
  rows: HabitForkRowDTO[];
  verdict: { kind: "named"; text: string } | { kind: "withheld"; reason: string };
}
```

And on `HabitDTO`, immediately after `ways`:

```ts
  /** Where the Ways fork. Null below two Ways. See `HabitForkDTO`. */
  fork: HabitForkDTO | null;
```

- [ ] **Step 2: Write the failing test**

Add to `test/habit.marks.test.ts` (reuse the `build()` fixture shape from Task 4):

```ts
describe("habitFork", () => {
  it("is null for a single-way route", () => {
    const { flows, route } = buildTwoWayRoute();
    const one = { ...route, count: 1, sessionIds: ["s1"], walks: [route.walks[0]!] };
    expect(habitFork(flows, one)).toBeNull();
  });

  it("references steps by index, never by embedding them", () => {
    const { flows, route } = buildTwoWayRoute();
    const fork = habitFork(flows, route)!;
    const ways = habitWays(flows, route);
    for (const row of fork.rows) {
      if (row.kind === "spine") {
        for (const a of row.at) expect(ways[a.way]?.steps[a.step]).toBeDefined();
      } else {
        for (const r of row.runs) for (const s of r.steps) expect(ways[r.way]?.steps[s]).toBeDefined();
      }
    }
  });

  it("carries the run phrase so the screen composes no words of its own", () => {
    const { flows, route } = buildTwoWayRoute();
    const fork = habitFork(flows, route)!;
    const forks = fork.rows.filter((r) => r.kind === "fork");
    expect(forks.length).toBeGreaterThan(0);
    for (const row of forks) {
      if (row.kind === "fork") for (const r of row.runs) expect(r.phrase.length).toBeGreaterThan(0);
    }
  });

  it("fills each way's own totals", () => {
    const { flows, route } = buildTwoWayRoute();
    expect(habitWays(flows, route).map((w) => w.totalsMs)).toEqual([[8000], [12000]]);
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx vitest run test/habit.marks.test.ts`
Expected: FAIL — `habitFork is not exported`.

- [ ] **Step 4: Implement in `habit-marks.ts`**

Add to the imports:

```ts
import { runPhrase, wayFork } from "./way-fork.js";
import type { HabitForkDTO, HabitForkRowDTO } from "@shared/types";
```

Change `habitWays` to fill totals — it must use the SAME totals `wayFork` computes, so read them from `wayFork` when it is non-null and compute them the same way otherwise:

```ts
export function habitWays(flows: FlowsDTO, route: FlowRouteDTO): HabitWayDTO[] {
  const totalMs = new Map(
    route.walks.map((w) => [
      w.sessionId,
      Math.max(0, Math.round((w.throughSec - w.atSec) * 1000)),
    ]),
  );
  return flowWalks(flows, route).map((w) => ({
    letter: variantLetter(w.index),
    sessionIds: [...w.sessionIds],
    steps: w.steps.map(toStep),
    // Dropped, never zeroed — a zero would read as an instantaneous recording
    // and would drag a printed range's floor to 0.0s.
    totalsMs: w.sessionIds.flatMap((id) => {
      const ms = totalMs.get(id);
      return ms === undefined ? [] : [ms];
    }),
  }));
}

/**
 * Where the ways fork, as the screen's own shape.
 *
 * Indices, not embedded steps: `way` indexes what `habitWays` returned for the
 * same route, and `step` indexes that way's steps. `FlowStep.index` IS the
 * step's position in its way — `stepsFor` mints it from the edge order — so the
 * mapping is a read, not a search.
 */
export function habitFork(flows: FlowsDTO, route: FlowRouteDTO): HabitForkDTO | null {
  const fork = wayFork({ flows, route });
  if (fork === null) return null;
  const rows: HabitForkRowDTO[] = fork.rows.map((row) =>
    row.kind === "spine"
      ? {
          kind: "spine",
          from: row.from,
          to: row.to,
          at: row.at.map((a) => ({ way: a.wayIndex, step: a.step.index })),
        }
      : {
          kind: "fork",
          after: row.after,
          runs: row.runs.map((r) => ({
            way: r.wayIndex,
            steps: r.steps.map((s) => s.index),
            phrase: runPhrase(r, row.after),
          })),
        },
  );
  return { rows, verdict: fork.verdict };
}
```

- [ ] **Step 5: Wire it into the service**

In `app/src/main/deskrag-service.ts`, add `habitFork` to the `./habit-marks.js` import on line 76, and add one line to `toHabitDTO`'s return immediately after `ways:` (line 1924):

```ts
      fork: flows !== null && bound.route !== null ? habitFork(flows, bound.route) : null,
```

- [ ] **Step 6: Run and watch it pass**

Run: `npx vitest run test/habit.marks.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

Expected: clean. Any test or fixture constructing a `HabitDTO` or `HabitWayDTO` literal now needs `fork: null` / `totalsMs: []` — `test/habits-view.test.ts` and `test/mcp.tools.test.ts` are the two that needed the equivalent when C2 added `apps`.

- [ ] **Step 8: Commit**

```bash
git add app/src/shared/types.ts app/src/main/habit-marks.ts app/src/main/deskrag-service.ts test/habit.marks.test.ts test/habits-view.test.ts test/mcp.tools.test.ts
git commit -m "feat(habits): the fork crosses the seam, by index and never by copy"
```

---

## Task 7: The screen

**Files:**
- Create: `app/src/renderer/src/way-fork-view.ts`
- Modify: `app/src/renderer/src/screens/HabitsScreen.tsx` — `RecordedSteps` (lines 618–692) and its call site (line 1145)
- Modify: `app/src/renderer/src/styles.css` — append after `.habitsteps__count` (line 4316)
- Test: `test/way-fork-view.test.ts`

**Interfaces:**
- Consumes: `HabitForkDTO`, `HabitForkRowDTO`, `HabitWayDTO` from `@shared/types`.
- Produces:
  ```ts
  export interface ForkRunView { way: number; letter: string; steps: number[]; phrase: string }
  export interface ForkStepView { n: number; from: string; to: string;
    at: { way: number; letter: string; step: number }[]; after: ForkRunView[] }
  export interface ForkView { leading: ForkRunView[]; steps: ForkStepView[] }
  export function foldFork(fork: HabitForkDTO, ways: readonly HabitWayDTO[]): ForkView;
  export function waySecs(ms: number): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/way-fork-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { foldFork, waySecs } from "../app/src/renderer/src/way-fork-view.js";
import type { HabitForkDTO, HabitWayDTO } from "@shared/types";

const way = (letter: string, n: number): HabitWayDTO => ({
  letter,
  sessionIds: ["s"],
  totalsMs: [1000],
  steps: Array.from({ length: n }, (_, i) => ({
    index: i, edgeId: `e${i}`, from: "A", to: "B", actions: [],
    observations: 1, everyRecording: true, missing: false, firstAt: null,
  })),
});

const fork: HabitForkDTO = {
  rows: [
    { kind: "fork", after: -1, runs: [{ way: 0, steps: [], phrase: "nothing here" },
                                      { way: 1, steps: [0], phrase: "first, 1 step: X → Y" }] },
    { kind: "spine", from: "A", to: "B", at: [{ way: 0, step: 0 }, { way: 1, step: 1 }] },
    { kind: "fork", after: 0, runs: [{ way: 0, steps: [1, 2], phrase: "then 2 steps, via B" },
                                     { way: 1, steps: [], phrase: "nothing here" }] },
  ],
  verdict: { kind: "withheld", reason: "one each" },
};

describe("foldFork", () => {
  const view = foldFork(fork, [way("A", 3), way("B", 2)]);

  it("hoists a leading fork out of the numbered list", () => {
    // There is no step 0 for it to sit under.
    expect(view.leading.map((r) => r.letter)).toEqual(["A", "B"]);
    expect(view.steps).toHaveLength(1);
  });

  it("numbers the spine from one", () => {
    expect(view.steps[0]?.n).toBe(1);
  });

  it("attaches a trailing fork to the step it followed", () => {
    expect(view.steps[0]?.after.map((r) => r.phrase)).toEqual([
      "then 2 steps, via B",
      "nothing here",
    ]);
  });

  it("resolves every way index to its letter", () => {
    expect(view.steps[0]?.at.map((a) => a.letter)).toEqual(["A", "B"]);
  });

  it("composes no words of its own — every phrase comes from the DTO", () => {
    const phrases = [...view.leading, ...view.steps.flatMap((s) => s.after)].map((r) => r.phrase);
    const fromDto = fork.rows.flatMap((r) => (r.kind === "fork" ? r.runs.map((x) => x.phrase) : []));
    expect(phrases).toEqual(fromDto);
  });
});

describe("waySecs", () => {
  it("matches the record's one-decimal form", () => {
    expect(waySecs(24_000)).toBe("24.0s");
    expect(waySecs(62_349)).toBe("62.3s");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run test/way-fork-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the fold**

Create `app/src/renderer/src/way-fork-view.ts`:

```ts
/**
 * The fork rows, folded into the shape JSX needs.
 *
 * `HabitForkRowDTO[]` is FLAT — spine rows and fork rows interleaved — because
 * that is the order both formatters walk and a flat list cannot disagree with
 * itself about nesting. A list needs the nesting, so it happens here, in a
 * `.ts` module the ROOT suite can reach. Renderer modules that hold a judgement
 * must not be `.tsx`: the root `tsconfig.json` sets no `jsx`.
 *
 * IT COMPOSES NO WORDS. Every phrase is carried on the DTO, written by
 * `app/src/main/way-fork.ts`, so the screen and the rendered file cannot say
 * different things about the same run — the `differBlock`/`Baseline.reason`
 * precedent.
 */

import type { HabitForkDTO, HabitWayDTO } from "@shared/types";

export interface ForkRunView {
  way: number;
  letter: string;
  steps: number[];
  phrase: string;
}

export interface ForkStepView {
  /** One-based, for display. */
  n: number;
  from: string;
  to: string;
  at: { way: number; letter: string; step: number }[];
  /** The gap that followed this step. Empty when nothing forked there. */
  after: ForkRunView[];
}

export interface ForkView {
  /** The gap BEFORE the first spine step. It has no step to sit under. */
  leading: ForkRunView[];
  steps: ForkStepView[];
}

/** One decimal and a unit — the same form `way-fork.ts` prints into the file. */
export const waySecs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function foldFork(fork: HabitForkDTO, ways: readonly HabitWayDTO[]): ForkView {
  const letterOf = (way: number): string => ways[way]?.letter ?? String(way);
  const leading: ForkRunView[] = [];
  const steps: ForkStepView[] = [];

  for (const row of fork.rows) {
    if (row.kind === "spine") {
      steps.push({
        n: steps.length + 1,
        from: row.from,
        to: row.to,
        at: row.at.map((a) => ({ way: a.way, letter: letterOf(a.way), step: a.step })),
        after: [],
      });
      continue;
    }
    const runs: ForkRunView[] = row.runs.map((r) => ({
      way: r.way,
      letter: letterOf(r.way),
      steps: [...r.steps],
      phrase: r.phrase,
    }));
    // `after === -1` is the leading gap. Everything else attaches to the step
    // it followed; the rows arrive in order, so that is always the last one
    // pushed.
    const last = steps[steps.length - 1];
    if (row.after < 0 || last === undefined) leading.push(...runs);
    else last.after.push(...runs);
  }

  return { leading, steps };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run test/way-fork-view.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Draw it**

In `app/src/renderer/src/screens/HabitsScreen.tsx`, add to the imports:

```ts
import { foldFork, waySecs } from "../way-fork-view.js";
import type { HabitForkDTO } from "@shared/types";
```

Add a `fork` prop to `RecordedSteps` and branch on it. Replace the component's opening (the `if (ways.length === 0) return null;` line and the `many` block) so that a fork, when present, is drawn INSTEAD of the per-Way lists:

```tsx
function RecordedSteps({
  ways,
  fork,
  onOpen,
}: {
  ways: readonly HabitWayDTO[];
  fork: HabitForkDTO | null;
  onOpen: (sessionId: string, atSec: number) => void;
}): React.JSX.Element | null {
  if (ways.length === 0) return null;
  if (fork !== null) return <WayForkView ways={ways} fork={fork} onOpen={onOpen} />;
  // ONE way is the healthy case and renders exactly as it always did.
  return (
    <div className="habitsteps">
      {/* … the existing single-way body, with `many` now always false … */}
    </div>
  );
}
```

Add the instrument above `RecordedSteps`:

```tsx
/**
 * Where the ways fork.
 *
 * COLOUR CARRIES SPINE-VERSUS-FORK, NEVER WAY IDENTITY. Ways are told apart by
 * their printed letter and their lane position, so hue is never the only
 * channel and the palette does not have to stretch to N ways. The band is
 * `--data-6`, the one unclaimed indexed slot — `--data-0` is C2's portrait,
 * `--data-2`/`--data-3` are C1's deviated and short, and 1/4/5/7 are the
 * semantic aliases.
 *
 * A step keeps its actions and its "Open this moment" wherever it is drawn:
 * C1's rule that the record is verifiable rather than merely trusted does not
 * weaken inside a fork.
 */
function WayForkView({
  ways,
  fork,
  onOpen,
}: {
  ways: readonly HabitWayDTO[];
  fork: HabitForkDTO;
  onOpen: (sessionId: string, atSec: number) => void;
}): React.JSX.Element {
  const view = foldFork(fork, ways);
  return (
    <div className="wayfork">
      <p className="wayfork__lead">
        These recordings took different paths. The numbered steps are the part every way has in
        common; the band beneath a step is where they differ.
      </p>
      <div className="wayfork__chips">
        {ways.map((w) => (
          <span key={w.letter} className="wayfork__chip">
            <b>Way {w.letter}</b> · {w.steps.length} step{w.steps.length === 1 ? "" : "s"} ·{" "}
            {w.sessionIds.length === 1 ? "1 recording" : `${w.sessionIds.length} recordings`}
            {w.totalsMs.length > 0 && <> · {w.totalsMs.map(waySecs).join(", ")}</>}
          </span>
        ))}
      </div>
      {view.leading.length > 0 && <Band runs={view.leading} />}
      <ol className="wayfork__spine">
        {view.steps.map((s) => (
          <li key={s.n} className="wayfork__step">
            <span className="wayfork__places">
              {s.from} → {s.to}
            </span>
            <div className="wayfork__ats">
              {s.at.map((a) => {
                const at = ways[a.way]?.steps[a.step]?.firstAt ?? null;
                return (
                  <span key={a.way} className="wayfork__at">
                    Way {a.letter}
                    {at === null ? (
                      <span className="wayfork__noopen">no moment to open</span>
                    ) : (
                      <button
                        type="button"
                        className="btn ghost wayfork__open"
                        onClick={() => onOpen(at.sessionId, at.atSec)}
                      >
                        Open
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
            {s.after.length > 0 && <Band runs={s.after} />}
          </li>
        ))}
      </ol>
      <p className="wayfork__verdict">
        {fork.verdict.kind === "named" ? fork.verdict.text : fork.verdict.reason}
      </p>
    </div>
  );
}

/** One gap, one line per way. Every way appears, empty run included. */
function Band({ runs }: { runs: readonly ForkRunView[] }): React.JSX.Element {
  return (
    <div className="wayfork__band">
      {runs.map((r) => (
        <p key={r.way} className="wayfork__run">
          Way {r.letter}: {r.phrase}
        </p>
      ))}
    </div>
  );
}
```

Add `import type { ForkRunView } from "../way-fork-view.js";` and update the call site at line 1145:

```tsx
      <RecordedSteps ways={habit.ways} fork={habit.fork} onOpen={onOpenRecording} />
```

- [ ] **Step 6: Add the styles**

Append to `app/src/renderer/src/styles.css` after `.habitsteps__count` (line 4316):

```css
/* Where the ways fork (C3). --data-6 is the one unclaimed indexed slot, and the
   palette's own note at the top of this file calls it an instrument colour and a
   lane colour. Colour carries SPINE vs FORK; a way is identified by its printed
   letter, never by hue. */
.wayfork { display: flex; flex-direction: column; gap: var(--s3); }
.wayfork__lead { margin: 0; font-size: var(--t-meta); color: var(--muted); }
.wayfork__chips { display: flex; flex-wrap: wrap; gap: var(--s2); }
.wayfork__chip {
  font-size: var(--t-meta);
  padding: var(--s1) var(--s2);
  border-radius: var(--radius-sm);
  background: color-mix(in oklab, var(--data-6) 12%, transparent);
}
.wayfork__spine {
  margin: 0;
  padding-left: var(--s4);
  display: flex;
  flex-direction: column;
  gap: var(--s3);
}
.wayfork__step { display: flex; flex-direction: column; gap: var(--s1); }
.wayfork__places { font-weight: 600; }
.wayfork__ats { display: flex; flex-wrap: wrap; gap: var(--s2); align-items: baseline; }
.wayfork__at {
  display: inline-flex;
  gap: var(--s1);
  align-items: baseline;
  font-size: var(--t-meta);
  color: var(--muted);
}
.wayfork__noopen { font-size: var(--t-nano); color: var(--muted); }
.wayfork__band {
  display: flex;
  flex-direction: column;
  gap: var(--s1);
  padding: var(--s1) var(--s2);
  border-left: 2px solid color-mix(in oklab, var(--data-6) 55%, transparent);
  background: color-mix(in oklab, var(--data-6) 8%, transparent);
}
.wayfork__run { margin: 0; font-size: var(--t-meta); color: var(--muted); }
.wayfork__verdict { margin: 0; font-size: var(--t-meta); }
```

- [ ] **Step 7: Run the whole gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

- [ ] **Step 8: Look at it in the running app**

```bash
npm run build && npm --prefix app run build
node .claude/skills/run-app/scripts/habits-screen-probe.mjs
```

Then drive it yourself and READ THE SCREENSHOT — nearly every rule in `docs/internals/app-ui.md` was found this way and none by reading CSS. Quit any dev instance first. Check specifically: no label's `scrollWidth` exceeds its `clientWidth` (nothing truncates), the band's left edge aligns with the step text above it, and the chips wrap rather than overflow.

- [ ] **Step 9: Commit**

```bash
git add app/src/renderer/src/way-fork-view.ts app/src/renderer/src/screens/HabitsScreen.tsx app/src/renderer/src/styles.css test/way-fork-view.test.ts
git commit -m "feat(habits): draw the spine and the band where they part"
```

---

## Task 8: `probe:fork`, and the blind probe it found

**Files:**
- Create: `scripts/fork-probe.ts`
- Modify: `scripts/baseline-probe.ts:60` — the `sessionStart` resolver
- Modify: `package.json:44` — the script
- Modify: `CLAUDE.md` — the probe table

**Interfaces:**
- Consumes: `readGraph`, `DEFAULT_DB` from `./lib/read-store.js`; `frequentRoutes`, `toGraphDTO` from `../app/src/main/graph-view.js`; `wayFork`, `runPhrase`, `secs` from `../app/src/main/way-fork.js`.

- [ ] **Step 1: Fix `baseline-probe.ts`**

Its `toGraphDTO(graph)` call passes no `sessionStart`, and `toEdgeSources` drops every source whose session cannot be dated — so every edge comes back with `sources: []`, every `firstAt` is null, and its "Other readings" section has been measuring an empty graph. Replace line 60:

```ts
    const routes = frequentRoutes(graph);
    // WITHOUT this resolver `toEdgeSources` drops EVERY source — it flatMaps
    // away any whose session it cannot date — so every edge arrives with
    // `sources: []`, every `firstAt` is null, and the readings below are about
    // an empty graph. It read that way until 2026-08-23. The deviation table
    // does not touch sources and was never affected.
    const startedAt = new Map(
      (db.prepare("SELECT id, started_at FROM session").all() as
        { id: string; started_at: number }[]).map((r) => [r.id, r.started_at]),
    );
    const flows: FlowsDTO = {
      graph: toGraphDTO(graph, { sessionStart: (id) => startedAt.get(id) }),
      routes,
      excludedApps: [],
    };
```

- [ ] **Step 2: Confirm the fix changed a number**

Run: `npm run probe:baseline`
Expected: exit 0, and the "Other readings" block now reports against real sources. Note the before/after in the commit message — a fix that changes nothing observable was not a fix.

- [ ] **Step 3: Write the probe**

Create `scripts/fork-probe.ts`:

```ts
/**
 * Where do a habit's ways actually fork, on the library that exists?
 *
 * `test/way-fork.test.ts` proves the fold. It cannot tell you the fold produces
 * a READING — a spine of length 0 is a legal fold result and a useless picture,
 * and that is precisely how the prefix/suffix design was falsified: Way C
 * begins at `n0 — no state`, so the common PREFIX across the four real ways is
 * empty. This prints what the real store folds to.
 *
 * READ-ONLY, and HEADLESS for `probe:baseline`'s reason: DeskRAGApp takes no
 * single-instance lock and WRITES on startup, so launching it would make a
 * second owner of SQLite and LanceDB. It opens `app.db` readonly and never
 * through `DualStore`, which drops retired vector spaces on open.
 *
 * It PRINTS THE CORPUS BEFORE ANY READING (the `probe:habits` precedent) and
 * exits non-zero when no route has more than one way — there is no fork to
 * measure there and the output would be an empty table wearing a verdict.
 *
 * Run:  npm run probe:fork
 */

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { DEFAULT_DB, readGraph } from "./lib/read-store.js";
import { frequentRoutes, toGraphDTO } from "../app/src/main/graph-view.js";
import { runPhrase, secs, wayFork } from "../app/src/main/way-fork.js";
import type { FlowsDTO } from "@shared/types";

const dbPath = process.argv[2] ?? DEFAULT_DB;
if (!existsSync(dbPath)) {
  console.error(`No store at ${dbPath}`);
  process.exit(1);
}

console.log("\nStore");
console.log(`  path : ${dbPath}`);

const db = new Database(dbPath, { readonly: true });
try {
  const graphIds = (db.prepare("SELECT id FROM trace_graph").all() as { id: string }[]).map((r) => r.id);
  const graph = readGraph(db, graphIds[0] ?? "default");
  if (graph === undefined) {
    console.log("\nNo trace graph. Record a session, let indexing finish, and run this again.");
    process.exit(1);
  }

  const startedAt = new Map(
    (db.prepare("SELECT id, started_at FROM session").all() as
      { id: string; started_at: number }[]).map((r) => [r.id, r.started_at]),
  );
  const routes = frequentRoutes(graph);
  const flows: FlowsDTO = {
    graph: toGraphDTO(graph, { sessionStart: (id) => startedAt.get(id) }),
    routes,
    excludedApps: [],
  };

  const forked = routes
    .map((route) => ({ route, fork: wayFork({ flows, route }) }))
    .filter((x): x is { route: (typeof routes)[number]; fork: NonNullable<ReturnType<typeof wayFork>> } =>
      x.fork !== null);

  console.log("\nCorpus");
  console.log(`  recordings          : ${(db.prepare("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n}`);
  console.log(`  routes              : ${routes.length}`);
  console.log(`  routes with 2+ ways : ${forked.length}`);

  if (forked.length === 0) {
    console.log(
      "\nNO ROUTE HAS MORE THAN ONE WAY, so there is no fork to measure. Record the same\n" +
        "task again, taking a different path through it, and run this again.",
    );
    process.exit(1);
  }

  for (const { route, fork } of forked) {
    console.log(`\n=== ${route.name ?? route.label}`);
    for (const w of fork.ways) {
      const times = w.totalsMs.length === 0 ? "no timed recording" : w.totalsMs.map(secs).join(", ");
      console.log(
        `  Way ${w.letter} — ${w.steps} steps, ${w.sessionIds.length} recording(s), ${times}`,
      );
    }
    const spine = fork.rows.filter((r) => r.kind === "spine").length;
    console.log(`  spine: ${spine} step(s) shared by every way`);
    let n = 0;
    for (const row of fork.rows) {
      if (row.kind === "spine") {
        n += 1;
        console.log(`   ${String(n).padStart(2)}. ${row.from} → ${row.to}`);
        continue;
      }
      for (const run of row.runs) {
        if (run.steps.length === 0) continue;
        const letter = fork.ways.find((w) => w.wayIndex === run.wayIndex)?.letter ?? "?";
        console.log(`       Way ${letter}: ${runPhrase(run, row.after)}`);
      }
    }
    console.log(
      `  verdict: ${fork.verdict.kind === "named" ? fork.verdict.text : `withheld — ${fork.verdict.reason}`}`,
    );
    if (spine === 0) {
      console.log("  FINDING: the ways share NO place-step. The picture here is four disjoint lists.");
    }
  }
} finally {
  db.close();
}
```

- [ ] **Step 4: Add the script**

In `package.json`, after the `probe:baseline` line:

```json
    "probe:fork": "tsx scripts/fork-probe.ts",
```

- [ ] **Step 5: Run it against the real store**

Run: `npm run probe:fork`
Expected: exit 0. On the store as of 2026-08-23 it should print the Calculator → TextEdit route with four Ways (39.3s / 24.0s / 28.1s / 62.3s), a **three-step spine**, Way C's `n0 — no state` leading fork, and a **withheld** verdict citing the floor. If the spine is not three steps, that is a finding — write down what it actually was rather than adjusting the fold to match this paragraph.

- [ ] **Step 6: Add it to CLAUDE.md's probe table**

In the `## Commands` block, after the `npm run probe:baseline` entry, matching the surrounding style (what it measures, why it is safe, and what it refuses to report):

```
npm run probe:fork            # where a habit's ways actually fork, on the library that
                              # exists. Read-only and HEADLESS for probe:baseline's reason:
                              # the app takes no single-instance lock and WRITES on startup.
                              # PRINTS THE CORPUS FIRST and exits 1 when no route has more
                              # than one way -- there is no fork to measure and the output
                              # would be an empty table wearing a verdict. The fold is
                              # proven by the suite; what this answers is whether it yields
                              # a READING, which is how the prefix/suffix design was
                              # falsified (Way C begins at `n0 - no state`, so the common
                              # PREFIX across the four real ways is empty).
```

- [ ] **Step 7: Run the whole gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add scripts/fork-probe.ts scripts/baseline-probe.ts package.json CLAUDE.md
git commit -m "probe(habits): fold the real store, and un-blind the probe that could not see sources"
```

---

## Task 9: Write down what is unswept

**Files:**
- Modify: `docs/todo.md`

- [ ] **Step 1: Record C3**

Append to `docs/todo.md`, in the voice of the C1 and C2 entries — what shipped, what it read on the real store, and what remains unfalsifiable:

```
- HABIT INSIGHT, SUB-PROJECT C3 — SHIPPED 2026-08-23 (`design/habit-way-fork`). The record
  and the screen now draw WHERE THE WAYS FORK instead of listing them side by side.
  `way-fork.ts` folds a pairwise LCS across the ways' PLACE-STEP sequences — not edge ids,
  and that is measured rather than preferred: the four real ways of the one multi-way route
  share EXACTLY ONE EDGE, so an edge-level alignment is two disjoint lists with zero matches.
  It is structural and no corpus growth fixes it (a node's identity is what the task does
  next), and it is the same fact that made `FlowRouteDTO.id` a place-label sequence.
  On the real store the spine is THREE steps — Calculator work, hand off, TextEdit work —
  and the three forks are exactly the three real differences: Way C started from
  `n0 — no state`, Way C did one fewer Calculator step, Way D took a nine-step excursion
  through Finder and came back. `## How the recordings differ` is REPLACED, its agreement
  sentence preserved verbatim.
  ONE UNSWEPT FLOOR ships with it, joining C2's two and the four fixture-tested paths from
  B and C1: `FORK_VERDICT_MIN_WALKS = 2`. Every way on this store has ONE recording, so the
  verdict has never fired and the floor's reason is the only thing that has ever printed.
  The second gate — the verdict fires only where the slowest recording of one way beat the
  FASTEST of every other — has likewise never been exercised on real data. It needs a route
  walked several times along at least two ways.
  `npm run probe:fork` prints the fold against the real store and exits 1 when no route has
  two ways, so it stays a measurement rather than becoming a green no-op.
  NOT DONE, still D (the agent surface).
- A ZERO-PREDICATE HEAD SURVIVES ON ONE REAL WALK. `liftTrace` takes `startTMono` to stop
  minting `n0 — no state`, and CLAUDE.md records that as fixed — but Way C of the
  Calculator → TextEdit route still begins `n0 — no state → Calculator` (session
  01M0P5D7B3XMMR8FY5FRPSA8MW). Read it before trusting the invariant; a zero-predicate node
  is vacuously true of every desktop, which is what made `matchNode` merge every session's
  first node into a fake root.
- `probe:baseline` WAS BLIND TO EDGE SOURCES until 2026-08-23. It called `toGraphDTO(graph)`
  with no `sessionStart`, and `toEdgeSources` flatMaps away every source whose session it
  cannot date — so every edge had `sources: []`, every `firstAt` was null, and its "Other
  readings" section was measuring an empty graph. Fixed. CHECK EVERY PROBE'S RESOLVERS: a
  probe that silently measures nothing looks exactly like a probe that found nothing.
```

- [ ] **Step 2: Run the whole gate one last time**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
npm run probe:fork
npm run probe:habits
```

`probe:habits` is the guard that nothing in C3 reached `HABIT.md`'s clipboard/`get_habit` equality — it asserts the two strings are byte-identical. C3 *does* change what the record says, so expect the byte count to differ from the last run; what must hold is that the two strings still match each other.

- [ ] **Step 3: Commit**

```bash
git add docs/todo.md
git commit -m "docs: what C3 shipped, the floor nothing has swept, and a probe that was blind"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: the spine and the LCS fold (Task 1), the rows and the empty-run rule (Task 2), the two gates (Task 3), the `wayFork` entry (Task 4), the record replacement and the `timeBlock` clause (Task 5), the DTO and the seam (Task 6), the screen and `--data-6` (Task 7), `probe:fork` and the `baseline-probe` fix (Task 8), and `docs/todo.md` (Task 9). The spec's "not a merge / not a recommendation" and "not model-touchable" constraints need no task — they are properties preserved by *not* widening `recordedBlocks`, which Task 5 states explicitly.

**Placeholder scan.** Task 5's two fixture helpers are named and their construction is pointed at Task 4's concrete `build()` rather than being described — that is the one place a reader has to look at a neighbouring task, and it is deliberate, because repeating a forty-line `FlowsDTO` builder twice invites the two copies to drift. Everything else carries its code inline.

**Type consistency.** `wayIndex` is the field name throughout the main-side types (`SpineAt`, `ForkRun`, `WaySummary`); the DTO deliberately shortens it to `way`, and Task 6's mapper is the single place the two meet. `secs` is exported once from `way-fork.ts` and imported by `habit-doc.ts`; the renderer's `waySecs` is a second implementation on purpose — the renderer must not import from `app/src/main`, and Task 7's test pins the two to the same output.
