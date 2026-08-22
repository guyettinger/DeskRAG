# The walk projection — what a habit's own recordings say about how it is going

**Date:** 2026-08-22
**Status:** designed
**Builds on:** `2026-08-06-flows-graph-exploration-design.md` (the routes and walks this
reads) and `2026-08-17-skills-from-experience-design.md` (the habit this eventually
informs). Neither changes. Nothing in this spec alters `frequentRoutes`, `route-cluster.ts`,
`bindHabit`, or any stored `routeKey`.

**Sub-project A of four.** The other three are recorded as starting prompts in
`docs/todo.md` under `HABIT INSIGHT, SUB-PROJECT B/C/D`. This spec covers A only.

## Why

A habit today is a route plus a count. `habit-doc.ts` renders what the recordings did and is
structurally silent about **how it went** — and `TraceEdge.outcomes` is `{attempts: 0,
successes: 0}` on every graph on disk, because passive recording cannot observe a failure.
The user did the thing, so it succeeded.

That is true about *outcomes* and it is not true about *consistency*. The store already
holds, for every walk of a route, the exact edge sequence it took and when it took each edge
(`RouteWalkDTO.edgeIds` is ordered by the moment each was walked, and every edge carries per-
session sources with `atSec`). Process mining calls the comparison of a model against its own
log **conformance checking**, and it is the entire second pillar of the field. DeskRAG does
discovery and stops.

The consequence is that the screen can say *six recordings walked this* and cannot say
whether the last three skipped a step, whether one step costs four times any other, what was
on screen immediately before the work started, or whether six walks happened across five
weeks or in one March afternoon. Each of those is a fact already on disk that nothing reads.

`docs/post.md` names three lessons and the app serves one. **Consistency wins** is served
thoroughly — bands, the ledger, the RECORDED ONCE disclosures. **Identity and action** and
**power to change** have no surface at all, and both are unreachable without the
measurements below. That is what this sub-project produces: the measurements, and nothing
else.

## What this is not

**Not a score.** Nothing here returns a fitness float, a strength percentage, a confidence,
or any number that orders one habit against another. `FrameResult.score` is an ordering and
not a confidence, and the UI and the MCP tool show rank and evidence lanes rather than the
number. A "conformance: 0.83" would be exactly the number this repo refuses to print. What
this returns is **counts and named facts**.

**Not a merge.** `frequentRoutes` gives every recording exactly one route key, and that
partition is load-bearing: it is what makes `bindHabit`'s strict-majority rule a proof rather
than a threshold, because a session cannot lie in two routes and so more than half of a set
can lie in at most one part. The prefix relation below is a **disclosure**, in the shape of
`duplicates`. Merging a prefix route into its parent would inflate `route.count`, and that
count is what the whole recurrence argument rests on.

**Not a renderer and not a screen.** This module produces a projection. Sub-project B renders
it into the record; sub-project C draws it. Nothing here decides wording or pixels.

**Not a widening of any DTO.** `FlowsDTO` does not gain fields for this. See the injection
below.

## Placement

Two modules, split the way `route-cluster.ts` is split from `graph-view.ts`, and for the
reason that file states: a DTO-free core is what lets the app and a probe read **one**
implementation. Two readers of one tree is the `ax-dump`/`ax-exec` drift hazard by name, and
it has already been paid for once in this repo.

- **`app/src/main/walk-align.ts`** — DTO-free. Speaks in edge-id sequences. Takes a baseline
  sequence and one walk's sequence, returns a named deviation list. No `FlowsDTO`, no store,
  no Electron.
- **`app/src/main/walk-analysis.ts`** — takes `FlowsDTO` + `FlowRouteDTO` exactly as
  `flow-steps.ts` does, calls the core, and assembles the whole projection.

Both are `.ts` in `app/src/main/`, which is what makes them reachable from the **root** test
suite, like `graph-view.ts`, `session-tracks.ts` and `route-cluster.ts`. A `.tsx` would not
be: the root `tsconfig.json` sets no `jsx`.

## The one injection

Antecedents — what was on screen and in front immediately before a walk began — need the
focus/event stream around the walk's start. `FlowsDTO` does not carry it, and widening the
DTO to carry it would put store-shaped data into a projection that every other consumer reads
without needing it.

So it is injected:

```ts
export interface WalkAnalysisHooks {
  /** What was in front just before this walk started, or null. */
  antecedentAt?(sessionId: string, atSec: number): Antecedent | null;
}

export function walkAnalysis(
  input: { flows: FlowsDTO; route: FlowRouteDTO },
  hooks?: WalkAnalysisHooks,
): WalkAnalysis;
```

`DeskRagService` supplies it. This is `briefFor`'s precedent exactly — that function takes
`reflections` as a parameter "because this module is pure and a reflection lives in the
store" — and `LiftInput.visualAt` is the same shape one layer down.

**No hook means no antecedents**, an empty array, and B renders nothing. Never a guess.

## What it returns

```ts
export type BaselineRule = "majority" | "recent" | "none";

export interface WalkAnalysis {
  /** Which Way is the standard, and WHY — the reason is always populated. */
  baseline: { rule: BaselineRule; wayIndex: number | null; reason: string };
  /** One per recording, oldest first. */
  walks: WalkFit[];
  /** One per baseline step. Empty when the baseline rule is "none". */
  steps: StepCost[];
  antecedents: AntecedentFact[];
  rhythm: RhythmFacts;
  /** Routes that are a strict prefix of this one. A disclosure, never a merge. */
  droppedEarly: PrefixFact[];
}
```

### `WalkFit` — how one recording differed

```ts
export type DeviationKind = "skipped" | "inserted" | "reordered";

export interface Deviation {
  kind: DeviationKind;
  /** Index into the BASELINE's steps. */
  stepIndex: number;
  edgeId: string;
  /** "Google Chrome → Ghostty", from the same labelling the record uses. */
  label: string;
}

export interface WalkFit {
  sessionId: string;
  /**
   * Wall clock of the recording's start, or null.
   *
   * NOT on `RouteWalkDTO`, which carries only lane seconds. It is resolved the
   * way `flow-steps.ts` already resolves `FlowStep.firstAt` — from an edge
   * source's `startedAt` for this session. Null when no source resolves, which
   * is the `sourcesBelowObservations` case: a recording this walk came from has
   * been deleted. Null is drawn, never invented.
   */
  at: number | null;
  reachedEnd: boolean;
  deviations: Deviation[];
}
```

Counts and names. `deviations.length` is a fact; there is no ratio and no normalisation.

### `StepCost` — where the time goes

```ts
export interface StepCost {
  stepIndex: number;
  edgeId: string;
  durations: { sessionId: string; ms: number }[];
  /**
   * True for a walk's FINAL step, which has no successor edge to measure
   * against. Its extent is bounded by the walk's `throughSec` and is
   * DISCLOSED, never estimated — the `clippedStart`/`clippedEnd` rule.
   */
  openEnded: boolean;
}
```

Durations come from consecutive edge `atSec` within one walk. A step present in the baseline
and absent from a walk contributes no entry, so `durations.length` can be below the walk
count and that difference is itself readable.

### `AntecedentFact` — the cue

```ts
export interface Antecedent {
  /** "Slack", "github.com/…", "10:00–11:00 Tue" — one observed fact. */
  what: string;
  kind: "app" | "place" | "phase";
}

export interface AntecedentFact extends Antecedent {
  /** How many walks showed it, out of how many were examined. */
  observations: number;
  of: number;
}
```

Agreement is carried, never smoothed — the same disclosure pattern as
`nameObservations < count`. B decides at what agreement a fact is worth printing; A only
counts.

### `RhythmFacts` — when, not how often

```ts
export interface RhythmFacts {
  /** Milliseconds between consecutive walks, oldest first. Empty below 2 walks. */
  intervalsMs: number[];
  /** Local hour of each walk, 0–23, and local day, 0–6. Parallel to `walks`. */
  hours: number[];
  days: number[];
}
```

Raw facts. **No automaticity score and no regularity coefficient** — the literature's
own numbers (median ~66 days to automaticity, range 18–254) are population statistics and
say nothing about one person's one route. C draws these; B may only say "weekly" where the
intervals actually support it.

### `PrefixFact` — started and dropped early

```ts
export interface PrefixFact {
  /** The shorter route's own `FlowRouteDTO.id`. */
  routeKey: string;
  /** Its place labels — `routeKey.split(" → ")`. See below. */
  places: readonly string[];
  /** How many recordings walked the shorter route. */
  count: number;
  sessionIds: string[];
}
```

A route whose place sequence is a **strict prefix** of this route's, found by scanning
`FlowsDTO.routes` — which carries every route, so this needs no new input.

**Places come from splitting the key, and that is safe by definition rather than by
convenience:** `FlowRouteDTO` exposes no `places` array, but its `id` *is*
`places.join(" → ")` in `frequentRoutes`, and the labels are de-duplicated before the join.
The same containment reasoning `route-cluster.ts` performs, over the same sequences, with no
new source of truth. If `frequentRoutes` ever stops keying on the joined label sequence, this
breaks — and so does `route-cluster.ts`, `bindHabit`, and every stored `routeKey`, so it is
not a risk this module carries alone.

It carries `sessionIds` and **not** `WalkMarkDTO[]`: wall clocks are minted in main for the
habits screen, and a projection that returned them would be a second place that decides what
a walk's wall clock is. C joins them the way the ledger already does.

Not merged, not counted into `route.count`, and it renames nothing.

## The three baseline rules

All three ship. `probe:baseline` picks the default, exactly as `route-cluster.ts` ships
`exact` / `insertions` / `lcs` / `jaccard` so `npm run probe:routes` can measure the choice
on a real library instead of asserting it.

| rule | the standard is | what it gets right | what it gets wrong |
| --- | --- | --- | --- |
| `majority` | the Way with the most recordings; ties → the Way holding the newest walk | frequency-honest | a better path adopted recently reads as the deviation |
| `recent` | the Way the newest walk took | improvement reads correctly — older walks converge toward it | one fumbled session becomes the baseline, with nothing marking it an outlier |
| `none` | nothing | cannot mislead | can say "steps 2 and 5 vary", never "the last three skipped step 4" |

Under `none`, `steps` is empty and every `WalkFit.deviations` is empty; the per-step
agreement B would print is derivable from `walks` alone.

`baseline.reason` is required and is a sentence, not an enum — "the Way 4 of 6 recordings
took" or "no Way holds a majority, and no walk is called deviant". A rule that merely applied
without saying which Way won and why is the `StageSpec.skipReason` failure one screen over: a
thing that never appears is indistinguishable from a thing nobody implemented.

## The alignment

`walk-align.ts`, DTO-free:

```ts
export function alignWalk(
  baseline: readonly string[],
  walk: readonly string[],
): { deviations: Deviation[]; reachedEnd: boolean };
```

A **monotone forward scan** over both sequences — the same shape `scripts/transfer-probe.ts`
already uses to verify a route's states against a held-out recording's own AX moments. Walk
both cursors forward: a baseline edge the walk never reaches is `skipped`, and a walk edge
absent from the baseline is `inserted`. `reachedEnd` is whether the walk consumed the
baseline's final edge.

**`reordered` is a POST-PASS, not something the scan can see.** A monotone scan is
order-preserving by construction, so a pair of edges the walk performed in the opposite order
emerges as one `skipped` plus one `inserted` and the fact that it is the *same edge, moved*
is lost. So after the scan: any `edgeId` appearing in both the `skipped` set and the
`inserted` set is removed from both and emitted once as `reordered`, carrying its **baseline**
`stepIndex`. Two deviations collapse into one, which is the honest count — "you did steps 3
and 4 the other way round" is one difference, and reporting it as two overstates the
divergence in exactly the way `cautionsFor` already guards against when it counts distinct
edges rather than flattened variant steps.

Not an edit distance and not a similarity float. The output is a list a person can check
against a screen — the same reason `route-cluster.ts` ships `insertions` as a **count** and
says so: "these two are the same walk, but one of them also passed through Finder" is
checkable, and "cosine 0.83" is not.

## Testing

**`test/walk-analysis.test.ts`**, in the root suite, covering both modules. The pure halves
are reachable there because both files are `.ts` under `app/src/main/`.

Fixtures alone are not sufficient and this repo has three bugs on record that prove it —
synthetic fixtures agree with whatever the code assumes. So:

**`npm run probe:baseline`** — read-only. Launches the real app and reads `flows.graph()`
over IPC exactly as `scripts/routes-probe.ts` does; opens SQLite readonly; writes nothing.
It:

1. **Prints the corpus FIRST**, and says plainly when it is too small to be a measurement.
   `probe:routes` carries this warning for a reason: the numbers quoted in `graph-view.ts`
   came from a 9-recording store that no longer exists.
2. Runs all three rules over every route with two or more walks, reporting for each: how many
   walks are called deviant, the total deviation count by kind, and how many routes have no
   qualifying baseline at all.
3. Reports **baseline stability** across the re-mine that `probe:stability` already performs —
   a baseline that moves between re-indexes is a baseline that cannot be quoted in a file.

The probe ships **with** A, not after it. Choosing three rules is only meaningful if
something measures them; without the probe the default is picked by argument, which is the
thing this repo's probes exist to replace.

## Honest states, and the risk on the record

On a library where most routes are walked once or twice, all three rules coincide, every
walk is its own Way, and this projection produces almost nothing. **That is the honest state,
not a defect.** It means sub-project B must render *nothing at all* in that case — the way
`## What varies` already says "Nothing was typed on this route, so it has no recorded
inputs." A thin block that exists to look busy is worse than silence, and would be the first
place in `HABIT.md` that asserted more than the evidence carries.

`probe:baseline` is therefore also the check on whether B is worth building yet.

## Committed carry-over to sub-project B

One consumer is committed here rather than left to B's discretion, because it is the reason
`droppedEarly` is computed at all:

> The strict-prefix relation is disclosed in the record as a caution-style line — "this work
> was started and dropped early N further times" — so the fact reaches `get_habit` before any
> pixel exists.

Everything else in `WalkAnalysis` is available to B and C to use or not.

## Open derived requirements

- **Correction rate is not reachable from the digest.** Typed text is coalesced at session
  scope **with backspace already applied**, so the fact that something was corrected is gone
  by the time anything downstream sees it. It is recoverable from the raw `key_down` events,
  but that is a separate pass over a different table and is not in A.
- **App-switch churn is a session property, not a route property.** A→B→A→B is a fact about
  a recording, not about any one route, so it does not belong on the Habits screen and is not
  in A.
- **`RhythmFacts` uses local time**, which means a route walked at 09:00 in two time zones
  reports two different phases. Nothing in the store records the zone. Named here rather than
  solved.
