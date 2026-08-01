# Progressive anchor resolution — segmenting a plan at the resolution frontier

**Date:** 2026-08-01
**Status:** Design approved and validated — **the gate is closed**. Five
corrections are folded in below, two of them fixes to already-shipped code that
no test could have caught. Ready for an implementation plan.

## Context

The executor's loop closed once on 2026-07-31 — one click, in one app, with the
target app already frontmost. The app-activation spec then removed the
**predicate** obstacle to a cross-app plan: an unmet `app` predicate is repaired
by activating the application, as a visible plan step.

It deliberately did not remove the second obstacle, and stated so:

> Anchors belonging to steps in the not-yet-frontmost app still cannot resolve at
> plan time, so those edges still measure 0% and the brittleness gate still
> refuses. That is the **resolution-timing** obstacle, and it is not cross-app
> specific: no multi-step plan can be fully resolved in advance, because later
> steps expect states that do not exist yet.

This spec removes it.

### What reading the code established

Recorded here rather than assumed, because three of these changed the design.

1. **The dry-run promise is already partly false for exactly the steps this
   feature targets.** When `buildPlan` cannot resolve a later anchor,
   `resolveAnchor` does not report "unknown". It falls through the ladder and
   returns `{ layer: "point", point: <recorded coordinate>, confidence: 0.30 }`.
   The plan then displays a specific pixel that the executor genuinely would
   click, and that pixel is stale. The brittleness gate is the only thing
   standing between that display and a real click.

   So the trade is not "a real safety property for a weaker one". Today's plan
   over-specifies where it cannot know.

2. **`execute.ts` never verifies at node boundaries**, though the executor
   spec's Semantics says execution "walks `steps` in order, verifying at each
   node boundary". `verifyNode` exists and is used only at plan time.

3. **One deferred resolution was already designed and never built.**
   `plan.ts:186` comments that a drag's `to` endpoint "is resolved at execution
   time against the same ladder"; `execute.ts:135` uses `action.to.point` raw.

4. **Nothing in the repo derives `fromNodeId` live.** `buildPlan` takes it as an
   input, no committed code supplies it, and there is no driver script — the
   2026-07-31 run was ad hoc. A loop that re-plans after every segment must
   close this.

5. **The obvious locator does not work.** `trace/identity.ts:45` matches on
   `samePredicateSet` — exact set equality. That is correct for merging and
   wrong here, for the reason the executor spec already documented about
   verification: a live screen that gained anything since recording will not
   match exactly, and given how aggressive the stability filter is, that is the
   common case rather than the exception.

6. **The barrel inertness guard is opt-in per file.**
   `test/replay.barrel.test.ts` lists filenames literally in all three checks.
   A new file in `src/replay/` is uncovered until someone remembers to add it —
   and that guard is the entire safety story.

7. **The recorded Dock click still executes alongside the repair.** `buildPlan`
   inserts the activation `RepairStep` and then plans the edge's recorded
   actions, including the point-only Dock click. A cross-app edge would activate
   Chrome *and* post a stale Dock coordinate. It is also the action dominating
   that edge's AX rate, so it decides whether cross-app runs can arm at all.

### What the recorded graph established

Measured with `scripts/replay-probe.mjs --offline` against the graph on disk,
before any of this was implemented. The graph turned out to be richer than the
gate assumed — it already spans **Electron → TextEdit → Google Chrome**, so the
cross-app case was already recorded rather than needing a new session.

5 nodes, 7 edges, **4 of them crossing applications**.

| Node | App | Window |
| --- | --- | --- |
| n0 | — | — (zero predicates) |
| n1 | Electron | DeskRAG |
| n2 | TextEdit | Untitled.rtf |
| n3 / n4 | Google Chrome | a PR page / the repo page |

**Descriptor availability across the 8 spatial actions:** `identifier` 25%,
`label` 13%, `path` 50%, `visual` 25%, **no AX layer at all 50%**.

That last figure is the finding. **Every point-only anchor in this graph is an
app switch** — all 4 of them, all Dock clicks (y = 1006, 1017, 1035, matching the
activation spec's measurements). Remove them and every remaining spatial anchor
carries an AX layer.

**The effect of supersession on arming, which is what this design turns on:**

| Edge | Transition | `axUpperBound` before | after | arms? |
| --- | --- | --- | --- | --- |
| e1 | Electron → TextEdit | 0% | 100% | no → **yes** |
| e2 | TextEdit → Google Chrome | 50% | 100% | yes → yes |
| e4 | Google Chrome → TextEdit | 0% | 100% | no → **yes** |
| e5 | TextEdit → Electron | 50% | 100% | yes → yes |

**Cross-app edges below `BRITTLENESS_FLOOR`: 2/4 → 0/4.** Supersession is not a
tidiness fix; it is the difference between a cross-app plan that refuses to arm
and one that arms cleanly.

### Correction: the supersession rule as first written is falsified

The rule was anchored on the edge's `wait { until: app(X) }`. Real data
contradicts it in two ways.

**It fires on only half the cross-app edges.** `e1` and `e4` are a *bare single
Dock click* with no `wait` at all:

```
e1  Electron -> TextEdit
    [0] click (523,295)  [NONE]  <<< LAST
```

A wait-anchored rule never fires there, leaving the stray click in place on
exactly the two edges that could not arm without it.

**Where waits do exist, they are on the wrong side.** In `e2` and `e5` the app
waits sit at indices [1,4] and [1,3] — *before* the switching click, which is
last:

```
e5  TextEdit -> Electron
    [0] click (529,352)  [identifier,path(d=3)]
    [1] wait   until=app("Electron")
    [2] type   slot=textarea "!"
    [3] wait   until=app("Electron")
    [4] click (1268,1006) [NONE]  <<< LAST
```

"The contiguous tail ending at the wait" therefore *excludes* the very action it
exists to suppress. The direction was simply backwards.

**What the data does support is simpler and structurally guaranteed:** the
switching action is the edge's **final** action, in **4 of 4** cross-app edges.
That is not a coincidence to be re-measured per app — `computeBoundaries` cuts a
boundary at the focus change, so the action causing the switch is by construction
the last one before it. The revised rule is in Semantics.

### Correction: the activation repair is inserted at the wrong position

`plan.ts:162` pushes the `RepairStep` **before** the edge's actions. The `app`
predicate it repairs lives on the **destination** node, so it must hold at the
edge's *end*; the edge's own actions run in the *source* app.

`e2` makes the consequence concrete — a TextEdit click, ⌘A, typing "this is a new
line", then the Dock click. Activating Chrome first would post all of that into
Chrome. The shipped activation repair has this latent, and it has never been
observed only because the brittleness gate stops cross-app plans from arming at
all.

Supersession fixes it as a side effect: the repair **replaces the edge's final
action** rather than preceding its first.

### Correction: a zero-predicate node verifies against everything

`n0` carries no predicates. Under the subset rule an empty predicate set is
vacuously satisfied by every observation, so `n0` verifies against any desktop
whatsoever. The locator must exclude empty-predicate nodes outright rather than
rank them last.

### Correction: the long-lived sidecar could not observe the desktop at all

Found by the live half of the gate, and it blocked every other live measurement.

`ax-exec` reported a **frozen** frontmost application. Measured with
`scripts/replay-probe.mjs --diagnose-frontmost`, which samples a long-lived
sidecar against a freshly spawned one each second: **14 disagreements in 20
samples**, the long-lived process pinned to the app that was frontmost when it
started while fresh spawns tracked the desktop.

**Cause.** `NSWorkspace.shared.frontmostApplication` is backed by workspace
notifications delivered to the main run loop. `ax-exec` blocks in `readLine()`
and spins no run loop, so the value never updates. `ax-dump` was never exposed —
it is a fresh process per invocation — which is why capture data has always been
correct while replay was not.

**Blast radius: the whole sidecar, not the app name.** `rootElement()` took its
pid from the same call, so after any app change every `dump` and `locate` walked
the *wrong application's* tree. Consequently:

- `runRepair` activates an app then polls `observe()` for the `app` predicate.
  Against a pinned value that poll can only ever time out — **the activation
  repair merged in `99d3844` could not work.**
- `wait { until: app(X) }` could never be satisfied, for the same reason.
- This design's segment loop re-observes at every boundary to locate the new node
  and resolve the next segment's anchors. Against a frozen tree there is nothing
  to re-observe, so **progressive anchor resolution was unimplementable** until
  this was fixed.

The executor's one successful run (2026-07-31) missed it by being single-app with
the target already frontmost — exactly the case where a pinned value is the
correct value.

**Fix.** `drainRunLoop()`, called once at the top of the command dispatch so
every command sees current state and a command added later cannot forget it.
`dump` additionally now resolves the frontmost app **once**, feeding both the
tree's pid and the reported name; it previously read `NSWorkspace` twice, so the
tree and the name could describe two different applications — the same split-fact
hazard the file's own comment warns about, immediately above the second call.

**Verified** with the same diagnostic: 0 lagged samples, and the 4 remaining
disagreements confirmed as the desktop moving mid-sample by a trailing read.

**A rejected fix, recorded so it is not retried.** `AXUIElementCreateSystemWide()`
with `kAXFocusedApplicationAttribute` looked like the better answer — a live
query needing no run loop, fixing the pid and the name through one mechanism.
Measured, it returns nothing at all: `(none)` on 20 of 20 samples.

**Testing.** The behaviour cannot be unit-tested — reproducing it requires the
frontmost app to change mid-process, which no test may cause without posting a
real event. `test/replay.sidecar.test.ts` therefore carries a source-level guard
(drain present, before dispatch; `dump` resolving the app exactly once), in the
same shape as the barrel inertness guard. It was mutation-checked: removing the
drain fails it.

### Correction: node identity encoded document identity, not state

The live gate found that **no recorded node could be located at all**. `n2`
missed by 3 predicates of 19 — the other 16 held — and all three were the
identity of one document rather than a state:

```
window(title="Untitled.rtf")
ax_exists(role="Window",  label="Untitled.rtf")
ax_exists(role="MenuButton", label="Edited")
```

A window's label *is* its title, so a trace recorded in one document could never
be located in another, though the UI is identical and the recorded task —
type in the text area, switch to Chrome — is document-independent. `Edited` is
the unsaved-changes indicator: present the moment you type, gone on save. That is
precisely the clock/badge-count class the stability filter exists to remove, and
it got through.

**Dropping the titles alone caused a wrong merge.** Measured on this graph: the
two Chrome nodes — a pull request page and a repository home — became
byte-identical 32-predicate sets. `e3` would degenerate into a self-loop and the
goal node become unreachable. That is silent corruption, which the IR ranks as
strictly worse than a redundant node.

**The cause was the 32-predicate cap.** Candidates sort shallowest-first, so the
entire budget went to browser chrome and nothing page-specific survived. At 64
the same two pages yield 61 and 62 predicates and differ by **25**, on controls
already covered by `STABLE_ROLES` (`Edit title` vs `Add file`). The heaviest tree
measured — 973 elements — produces 62, so 64 clears the observed ceiling rather
than merely the observed collision. Native apps never came close: TextEdit
produces 16 predicates and the Electron app 12.

**Fix**, in `src/trace/predicates.ts`: stop emitting `window`; remove `Window`
from `STABLE_ROLES` (`Sheet` and `Dialog` stay — their titles name a state,
"Open" or "Save", not which file is open); add an anchored `Edited|Modified`
volatile pattern so `Edited by Sam` is unaffected; raise
`DEFAULT_MAX_AX_PREDICATES` to 64.

**Verified** by re-extracting all 13 stored `ax_snapshot` rows: zero window
predicates, zero `Edited`, the two Chrome pages still distinct, and the TextEdit
snapshot reduced to exactly the 16 predicates that already held live.

**Consequence: existing graphs must be re-lifted.** Their nodes were built under
the old filter. The stored `ax_snapshot` rows are sufficient, so nothing needs
re-recording — but nothing in `app/` currently exposes re-indexing; trace
indexing runs only on recording stop. That is a derived requirement below.

**A false trail, recorded so it is not repeated.** An intermediate measurement
concluded that node identity was structurally blind to web page content, because
two different Chrome pages produced identical predicate sets at *every* cap. The
comparison was broken: both content markers matched the same snapshot, since a
GitHub pull request page contains the repository's own name, so a page was being
diffed against itself. Select snapshots by id, never by searching their contents.

## The decision this spec turns on

Three shapes were considered.

**Rejected — defer with a predicted rung and a no-downgrade gate.** Mark
unresolvable steps deferred, preview them with the recorded target plus a rung
predicted from which descriptors the anchor carries, resolve at arrival, and
abort if the real resolution is worse than the armed one. One approval, one
plan. Rejected because it invents a confidence forecast the system has no
grounds for, and still leaves the promise weakened: real events get posted
against targets nobody saw at their true resolution.

**Rejected — arm the run once and auto-continue.** Later segments build and
auto-arm unless a gate trips. The only option that works unattended, and the
only one that posts real events from a plan the user never saw.

**Chosen — segment the plan and re-arm each segment.** `buildPlan` cuts the plan
at the point where greedy resolution stops working. The segment is fully
resolved and previewed exactly, as today. The rest of the path is *disclosed but
unresolved*, so the reviewer knows the shape and length of the run they are
starting. Executing a segment re-observes the world, re-plans, and asks again.

**The dry-run promise is therefore restated, not weakened:**

> Nothing is posted from a plan you have not reviewed at exact resolution.

It holds verbatim. What it costs is approvals — and how many is a measurement,
not a guess. See the validation gate.

## Decisions taken during design

- **The segment boundary is measured, not predicted.** The plan cuts where
  resolution actually failed, rather than at structurally guessed state changes.
  A plan whose anchors all resolve is one segment with one arming, identical to
  today — the 2026-07-31 single-click run does not change shape. Segmentation
  appears only where resolution genuinely broke.
- **The cut is at an EDGE boundary, never mid-edge.** A node boundary is the
  only place the world can be re-observed and verified; stopping between the
  actions of one edge leaves the run in a state no node describes. The whole
  edge containing the failing anchor moves to the remainder.
- **A point-only anchor never causes a cut.** An anchor with no `ax` layer
  resolving to `point` is at its permanent best — deferring cannot improve it.
  Only an anchor that *carries* AX descriptors and reaches no AX rung is
  evidence that the described state does not exist yet.
- **The remainder discloses descriptors, not predictions.** Which descriptors an
  anchor carries is a fact about the recording. What it will resolve to is not
  knowable, and the remainder does not claim it.
- **Blockers span the whole run; brittleness does not.** `assertable` means no UI
  action can produce it, so checking a remainder node's assertable predicates
  against the present observation is valid — an unreachable goal is knowable
  before anything is posted.
- **The remainder carries a deductive brittleness bound.** An anchor with no
  `ax` layer can never resolve to an AX rung, at any time, by any mechanism, so
  a remainder edge's AX rate has a computable upper bound. Without it a reviewer
  can arm segment 1, change the real world, and only then discover segment 2 can
  never arm — a dead end reached by acting, which is the worst outcome available
  in this design.
- **The arming decision is injected into the run loop.** `replay/` still cannot
  decide to act on its own; the caller supplies `arm`, the same seam pattern as
  `Actuator`, `VisualMatcher` and `LiftInput.axAt`.
- **Drift needs no mechanism.** Re-planning after a segment is the same
  operation as planning the first one, so recovering from an unexpected landing
  is the loop rather than a subsystem — the same claim `achievable`/`assertable`
  already makes about setup.
- **Suppression of a superseded action is visible, never silent.** A suppressed
  action stays in `steps` as a marked entry, the way `RepairStep` is visible.

### Explicit decision: the node locator uses the subset rule, not `matchNode`

Locating the live node reuses `verifyNode`'s subset check: candidates are the
recorded nodes whose every predicate holds in the observation. Exact-set
matching is kept where it belongs — merging asks "is this the same state?",
locating asks "which recorded state is still true here?", and those need
different comparisons for the reason the executor spec already gave.

`matchNode`'s visual fallback is not reused either, and could not be: there is no
live frame at replay time, which is the same reason `resolve.ts:181` records the
visual rung as "no live frame to corroborate against".

Subset matching is monotone — a node carrying only `app` is satisfied by every
observation in that app — so candidates are ranked by **predicate count, largest
wins**, the most specific recorded description that still holds. A tie for
largest **declines**, matching the bias that ambiguity never guesses.

Ranking by strict superset-nesting instead of by count is more principled and was
considered. It risks declining constantly, and how often several nodes verify
against one observation — and whether they nest — is measurable from the
validation recording rather than arguable now. Count is the provisional rule; see
the validation gate.

### Explicit decision: chord-based app switching is out

The supersession rule below covers point-only spatial switches, which is what
every recording measured so far contains — 4 of 4 cross-app edges, all Dock
clicks at y = 1006, 1017 and 1035 on a 1080-tall screen. A ⌘-Tab switch is a
`chord` with no anchor and would not be suppressed, so it would be posted after
activation and switch to a third app.

That is not designed for, because no recording has contained one. The anchor
ladder has already been falsified twice by generalizing from unmeasured cases,
each time by recording in one more application. It is a derived requirement.

## Architecture

Two new files, four changed, plus the test guard. No new dependency, no change to
`trace/`, and `replay/` stays a leaf.

| File | Change |
| --- | --- |
| `src/replay/locate.ts` | **New.** `locateNode` — the subset locator. |
| `src/replay/run.ts` | **New.** `executeRun` — the observe/plan/arm/execute loop. |
| `src/replay/plan.ts` | Greedy cut, remainder disclosure, supersession, **repair moved to the edge's end**. |
| `src/replay/execute.ts` | Node-boundary verification; drag `to` resolution. |
| `src/replay/types.ts` | `SegmentCut`, `RemainderEdge`, run types, field additions. |
| `src/index.ts` | Export `locateNode`, `executeRun` and the new types. |
| `test/replay.barrel.test.ts` | Glob `src/replay/*.ts` instead of listing files. |
| `scripts/replay-probe.mjs` | **New, already written.** The validation harness. |

### The validation harness

`scripts/replay-probe.mjs` measures the gate below against a real graph and a
real desktop. It is **structurally read-only**: the `Actuator` is wrapped in a
proxy that throws on `activate`, `moveTo`, `click`, `dragPath`, `scroll` and
`key`, so it cannot post an event even by mistake — the same principle as the
barrel inertness guard, and the reason it is safe to run against a live desktop.

```
node scripts/replay-probe.mjs --offline                       # graph only, no permissions
node scripts/replay-probe.mjs --wait-for TextEdit --goal n4   # live probe
```

`--wait-for` polls until the named app is frontmost, which exists because the
probe cannot be started without focusing a terminal — which would otherwise be
the app it then measures.

### The run loop

```ts
export interface RunInput extends ReplayInput {
  goalNodeId: string;
  /** The review gate. `replay/` never decides to act; the caller does. */
  arm: (plan: Plan) => Promise<boolean>;
  slotBindings?: Record<string, string>;
  allowLaunch?: boolean;
  override?: boolean;
  /** Runaway guard. Default 8. */
  maxSegments?: number;
}

export async function executeRun(input: RunInput): Promise<RunOutcome>;
```

Each turn:

```
dump()  →  observe()  →  locateNode()  →  findPath()  →  buildPlan()
        →  arm(plan)  →  executePlan()  →  repeat
```

One `dump()` per boundary serves locating, verifying and resolving. That is
forced rather than incidental: `AxObservation` already bundles tree, app and
window in one call *because* sourcing halves of one fact separately is what made
boundary snapshots describe the previous application.

### The barrel guard

`test/replay.barrel.test.ts` currently enumerates `src/replay/*.ts` by hand in
three checks. It changes to read the directory, so every present and future file
is covered by default, with `sidecar.ts` the single named exemption from the
`spawn` check. A safety guard that must be remembered is a guard that will
eventually be forgotten.

## The data model

```ts
/** Where greedy resolution stopped, and why. */
export interface SegmentCut {
  /** Node to re-observe and re-plan from — the `from` of the first unplanned edge. */
  resumeAt: string;
  /** The edge whose anchor could not resolve. */
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
```

`Plan` gains three fields. A plan that resolves all the way to the goal leaves
all three empty and is otherwise identical to today's:

```ts
cut?: SegmentCut;
remainder: RemainderEdge[];
drift?: { expected: string; observed: string };
```

`Plan.to` remains the **final goal**, not the segment's end; `cut.resumeAt` is
where the next segment begins.

Two existing types gain a field:

```ts
Blocker.scope: "segment" | "remainder";
EdgeBrittleness.bound: "measured" | "upper";
```

A step can now be a third thing — an action the plan will *not* post:

```ts
export interface SupersededStep {
  superseded: "activate";
  edgeId: string;
  action: Action;
  /** The repair that replaces it, so the review explains itself. */
  reason: string;
}

export type PlanStep = PlannedAction | RepairStep | SupersededStep;

export const isSupersededStep = (s: PlanStep): s is SupersededStep => "superseded" in s;
```

`isRepairStep` is unchanged. Both guards key on a field name unique to their
variant, so a `PlannedAction` remains the fall-through case — callers that only
know about actions keep working, which matters because `app/` will grow a review
surface against this shape.

The run's result:

```ts
export interface RunOutcome {
  goalNodeId: string;
  reached: boolean;
  segments: { plan: Plan; outcome: ExecOutcome }[];
  stopped?:
    | "declined"       // the caller's `arm` returned false
    | "not-located"    // no node verified, or several tied
    | "no-path"        // located, but no route to the goal
    | "no-progress"    // a segment planned zero steps at an unchanged node
    | "max-segments"
    | "failed";        // a step threw; `segments` carries the ExecOutcome
}
```

## Semantics

### Segmentation

`buildPlan` walks the path resolving anchors as it does today, and cuts at the
first anchor for which **both** hold:

1. `resolveAnchor` returned `layer: "point"`, and
2. the anchor carries an `ax` layer.

The edge containing that anchor, and every edge after it, become `remainder`.
`cut.resumeAt` is that edge's `from` node.

**When the FIRST edge fails to resolve, the segment is empty.** The loop then
stops with `no-progress`, and that is the correct outcome: edge 1 starts at the
node just located and verified, so an anchor that cannot resolve there is an
element that is genuinely gone rather than one whose state has not arrived. The
distinction between "not yet" and "gone" falls out of the segmentation rule
without a separate test for it.

### Supersession

> On an edge where a `RepairStep` for app X was inserted:
>
> 1. Suppress the edge's **final** action when it is spatial and its anchor
>    carries **no `ax` layer** — that is the recorded switch.
> 2. Suppress any `wait { until: app(X) }` anywhere on the edge.
> 3. Place the `RepairStep` where the suppressed final action was — at the edge's
>    **end**, not its start.
>
> Everything else is posted as recorded.

Each clause is load-bearing, and each is measured rather than argued:

- **"Final action" is structurally guaranteed, not a heuristic.**
  `computeBoundaries` cuts a boundary at the focus change, so the action that
  causes the switch is by construction the last one before it. Holds in **4 of 4**
  cross-app edges measured.
- **No `ax` layer is equally structural.** The switch target sits outside the
  focused window's AX tree by definition — that is *why* the Dock click is
  point-only. An action targeting an element in the app's own tree cannot have
  been the switch. Also 4 of 4.
- **Both conditions are required**, so a final action that *does* carry an AX
  layer is posted as recorded. The conservative default is today's behaviour, and
  absence of evidence never produces a silent change.
- **The waits are independently safe to drop** — `runRepair` already polls that
  exact predicate before returning, so removing one is a no-op rather than a
  skipped check. They are dropped wherever they appear, because measurement put
  them mid-edge rather than adjacent to the switch.
- **Position 3 is a correction to shipped behaviour**, not a new feature. See the
  correction above: the `app` predicate is on the destination node, so the repair
  belongs at the edge's end.

A suppressed action becomes a `SupersededStep`, visible in the review: *"the
recorded Dock click will not be posted; activating Google Chrome replaces it."*

**Measured effect:** every cross-app edge's `axUpperBound` goes to 100%, and
cross-app edges below the brittleness floor go from 2/4 to 0/4.

### Locating

```ts
export function locateNode(
  observed: readonly Predicate[],
  nodes: readonly TraceNode[],
): { nodeId?: string; candidates: number; ambiguous: boolean };
```

Candidates are nodes that carry **at least one predicate** and have no
`verifyNode` violations against `observed`. The candidate with the most
predicates wins; a tie for the most declines with `ambiguous: true`. `candidates`
is reported whatever the outcome, so a failure to locate is debuggable rather
than opaque.

**The non-empty test is not a guard against a hypothetical.** `n0` in the
recorded graph has zero predicates, and an empty set is vacuously a subset of
every observation — it would verify against any desktop at all. Ranking it last
is not enough, because it would still be returned when it is the only candidate.

### Arming

`canArm` refuses when:

- any `Blocker` exists, in the segment **or** the remainder — unchanged in being
  non-overridable;
- any edge is below `BRITTLENESS_FLOOR`, whether `measured` (segment) or `upper`
  (remainder) — overridable, as today.

Arming a segment authorizes that segment only.

### Execution

`executePlan` runs the segment's steps as it does today, with two additions:

- **Node-boundary verification.** When a step completes an edge, observe once and
  require the destination node's predicates to hold by the subset rule. A
  violation aborts, naming the predicate. That observation is the one the next
  turn re-plans from — one dump, three uses.
- **The drag `to` endpoint resolves at execution**, closing the gap between
  `plan.ts:186`'s comment and `execute.ts:135`'s behaviour. Same ladder, same
  `resolveAnchor`; a `to` that fails to resolve aborts the action rather than
  falling back to the recorded coordinate.

A `SupersededStep` is a no-op at execution. It exists to be reviewed.

### Drift and termination

The next turn observes and re-locates regardless of where the previous segment
was supposed to land. When the located node is not the previous segment's
destination, `Plan.drift` records `{ expected, observed }` and the review leads
with it. The user has to arm again in any case, so drift is disclosed for free.

`no-progress` — a segment that plans zero steps and resumes at the same node — is
the loop's only way to spin forever, and is the reason it is a distinct stop
reason rather than an error.

## Failure handling

| Condition | Behavior |
| --- | --- |
| Anchor with an `ax` layer resolves to `point` | Cut. Its whole edge and everything after become remainder. |
| Anchor with no `ax` layer resolves to `point` | Not a cut. Counts against the edge's AX rate, exactly as today. |
| The first edge cannot resolve | Segment is empty → `no-progress`. The element is gone, not pending. |
| No recorded node verifies against the observation | Stop with `not-located`, reporting the observed predicate set. |
| Several nodes tie for most-specific | Stop with `not-located`, `ambiguous: true`. Never guess. |
| Located, but no path to the goal | Stop with `no-path`. |
| Node-boundary verification fails mid-segment | Abort the segment, naming the predicate. The next turn re-locates. |
| Landed at an unexpected node | Not a failure. Re-pathfind; `Plan.drift` discloses it. |
| Remainder holds an `assertable` blocker | `canArm` refuses now, before anything is posted. |
| Remainder edge's upper-bound AX rate below the floor | `canArm` refuses; overridable, as today. |
| `arm` returns false | Stop with `declined`. Nothing further is posted. |
| A segment posted events and the run then stops | No rollback exists. `RunOutcome.segments` reports exactly how far it got; the world is left where it is. |

The last row is the honest cost of this design and is stated rather than
mitigated. A run can change the real world and then stop. The bias remains the
IR's: stopping is visible and recoverable, acting on a bad resolution is silent.

## Validation gate

**This spec is not finalized until a real cross-app recording is driven through
it.** Both of this repo's worst bugs were invisible to `npm test` and obvious
within minutes of a real session, and every number in the executor spec came
from a recording rather than an argument.

The graph already on disk spans Electron → TextEdit → Google Chrome, so the
offline half needed no new recording. Its findings are recorded above as
corrections; the live half is outstanding.

**Answered — offline, `--offline`:**

| Measurement | Result | What it decided |
| --- | --- | --- |
| The repaired edge's actual actions, and its AX rate with and without the recorded switch | 0%→100%, 50%→100%, 0%→100%, 50%→100%; below-floor 2/4 → 0/4 | Supersession is load-bearing, not tidiness. |
| Whether the recorded switch is accompanied by a `wait { until: app(X) }` | **2 of 4 edges have no wait at all**; where present the waits precede the switch | Falsified the wait-anchored rule; replaced with "final action". |
| Where the switch sits in the edge | Final action, **4 of 4**, always point-only | The revised rule, and the repair's corrected position. |
| Descriptor availability across spatial actions | identifier 25%, label 13%, path 50%, visual 25%, **none 50%** | Every point-only anchor in the graph is an app switch. |

**Answered — live:**

| Measurement | Result | What it decided |
| --- | --- | --- |
| Segments per cross-app plan | **2**, cut at `e3`, resume at `n3` | The cut lands exactly on the app boundary, measured not predicted. Two approvals, not six — the chosen shape survives. |
| Whether any anchor **falsely** resolves in the wrong state | **0 in 9 foreign trials** across three frontmost apps (4 vs WebStorm, 2 vs TextEdit, 3 vs Chrome) | Greedy resolution's central risk did not materialise, including for `label` and `identifier` descriptors — not just the depth-17 path the single path-walk happened to test. |
| Whether a node locates at all | **0 of 5 nodes verified** before the filter fix; `n2` missed by 3 of 19 while 16 held. **After re-lifting: located, `candidates: 1`, not ambiguous** | Location was gated on document identity. Fixed in the filter — see the correction below. |
| How many recorded nodes verify per observation, and whether they nest | **Exactly 1** | The tie-break was never reached, so predicate-count versus superset-nesting stays **untested rather than validated**. Count is retained as the simpler rule; the decision is unchanged but also unexercised. |

The locator was confirmed end to end after re-lifting: `n2` located against a
TextEdit document titled **`Untitled`**, not the recorded `Untitled.rtf`, which is
precisely the generalization the filter correction existed to buy. The live
observation carried 17 predicates against the node's 16 — the extra one is not a
violation, which is the subset rule behaving as verification requires.

The run also reproduced the segmentation result **without** the `--from`
override — 1 of 2 edges, cut at `e3`, resume at `n3` — so the earlier figures
were not an artefact of forcing the start node.

One result is worth separating out because it inverts an assumption this design
inherited: **resolution proved markedly more robust than location.** The same run
resolved a TextEdit anchor at `identifier@1.00` in a document with a *different
name* at a *different screen origin*, while location refused the node outright.
The spec worried about resolution timing; the binding constraint was the locator.

The live half has begun. It confirmed the sidecar path end to end — 384 elements,
35 predicates, `windowOrigin` resolved, and **0 candidates against WebStorm**, a
correct decline for an app absent from the graph — and then immediately found the
frozen-frontmost defect above, which had to be fixed before any of the remaining
rows could be measured at all.

### Implemented, and driven against a real desktop (2026-08-01)

`executeRun` was driven end to end against the live desktop with `arm` always
refusing, through the probe's read-only proxy — so the whole loop ran and nothing
was posted. Every prediction in this spec held:

```
=== SEGMENT 1 — 7 steps ===
  click  -> identifier@1.00
  SUPERSEDED wait   — activating Google Chrome replaces this
  chord   cmd+a
  type    slot=textarea "this is a new line"
  SUPERSEDED wait   — activating Google Chrome replaces this
  SUPERSEDED click  — activating Google Chrome replaces this
  activate  Google Chrome
  cut       : e3 (resume n3)
  remainder : e3
  brittle   : e2@100%, e3@100% (upper)
stopped: declined
```

- The **repair is the last step**, after the source app's click, chord and
  typing — the correction that had been reasoned about now observed.
- **Both mid-edge app waits and the Dock click are superseded**, which is the
  `e2`/`e5` shape that falsified the first supersession rule.
- **`e2@100%`** live, against the 50% this edge measured before supersession.
- The cut and remainder match the offline prediction exactly.

**One artifact, recorded because it is a real property of the system.** The first
dry run reported a blocker — `"this is a new line" cannot be typed with layout
probe` — because the probe passed a placeholder keymap. That is `type` has no
fallback layout behaving exactly as specified, and it means a plan cannot arm
without the layout its session was recorded with. The probe now loads the
keymap from the session's own `keymap_change` event.

**With the recorded layout, the plan is ARMABLE:**

```
  type    slot=textarea "this is a new line"
  blockers  : none
  brittle   : e2@100%, e3@100% (upper)
stopped: declined
```

`canArm` would return `ok` — no blockers, every edge far above the 0.5
brittleness floor. It was refused only because this probe's `arm` always
refuses. **A cross-app plan can now arm**, which is precisely what the
app-activation spec said this design was required to make possible:

> Activation removes the **predicate** obstacle. Anchors belonging to steps in
> the not-yet-frontmost app still cannot resolve at plan time, so those edges
> still measure 0% and the brittleness gate still refuses.

Both halves are now closed: supersession takes the edge to 100%, and the cut
stops the plan before the anchors that cannot resolve yet.

### The first live multi-segment run (2026-08-01)

**Segment 1 posted for real.** `stepsRun: 6` of 7 — the TextEdit click at
`identifier@1.00`, ⌘A, the typed text, and the activation, which succeeded
(`runRepair` polls the `app` predicate and would have thrown on timeout).

Four firsts in one run: a **chord**, **typed text**, an **app activation**, and
**node-boundary verification** had never posted or run against a real desktop
before. Until this run the project had posted exactly one live CGEvent, ever.

**Then boundary verification stopped it, on its first live use.** It refused to
continue into segment 2 rather than clicking into a Chrome window that was not in
the expected state, and named every predicate that did not hold. The world was
left partway — the honest cost this spec states — and `RunOutcome` reported
exactly how far it got.

**It immediately found a real defect.** The 24 missing predicates were all
Chrome's **tab bar**: 20 open tabs exposed as `RadioButton`s labelled with page
titles, plus 7 `TabGroup`s for collapsed groups — **27 of that node's 61
predicates**. A Chrome node could only verify with the same pages open. Fixed by
excluding anything under a `TabGroup` ancestor (measured 27/27); Chrome nodes
went 61/62 → 33/34 predicates and stayed distinct.

**That defect was introduced by this spec, and could not have been found
offline.** The cap experiment above compared two snapshots *from the same
session*, so the tab predicates were identical on both sides and cancelled out —
a within-session comparison cannot reveal predicates stable within a session and
volatile across sessions. Raising the cap 32 → 64 to fix the node collision is
precisely what pulled the tab strip into identity.

**A second and third run confirmed the fix**: no tab predicates in either
failure. The remaining 18 were genuine page controls (`Edit title`,
`assign yourself`, `Reviewers`); 15 of 33 held.

**Why they still failed is a separate finding, and not the one first assumed.**
The browser *was* on the recorded pull request — confirmed by window title — but
that window exposed **~128 AX elements live against 363 when it was recorded**.
The 18 missing predicates are page content that simply was not in the live tree.
So verification was correct and the diagnosis was honest; the precondition it
reports is about how much of the page the browser is exposing, not about which
page is open.

**A wrong turn, recorded because the error is the point.** An intermediate
measurement appeared to show the two sidecars disagreeing — `ax-dump` returning
1181 elements where `ax-exec` returned 128 — which would have been a serious
drift defect. It was an artefact: the two figures came from two different Chrome
windows at two different moments. Measured properly, back-to-back with each
binary reporting the window it saw, they agree (1335/1217, 1335/307, 129/126 on
identical windows). **Nothing was changed on the strength of it.**

That is the third instance in this validation of one error: comparing two
measurements taken against a moving target and attributing the difference to the
wrong variable. The first was a page diffed against itself; the second a
within-session comparison in which session state cancelled out. Any future
measurement here should pin *when* and *what* it observed, not only the number.

**Chrome's focused window was also observed moving between queries** (three
different windows across a few minutes), which makes a multi-window browser a
poor verification target regardless. Whether that was user-driven or not was not
established, so no conclusion is drawn from it.

**Still never exercised: a run that completes more than one segment.** Segment 2
has never armed. Drags and `wait` actions have still never posted.

Remaining findings are written back into this spec before implementation is
called done, in the style of the executor spec's "Correction:" sections.

## Testing

Everything below runs against `FakeActuator`. The suite stays structurally
incapable of posting a real event, and the barrel guard now enforces that by
directory rather than by list.

- **`locate.ts`** — exact hit; a node that is a strict subset loses to a more
  specific one; a tie for most-specific declines; no candidate returns
  `nodeId: undefined` with `candidates: 0`; **a zero-predicate node is never a
  candidate**, even when it is the only one that verifies.
- **Segmentation** — a fully-resolvable path produces no cut, an empty remainder
  and a plan byte-identical to today's (this is the regression test for the
  2026-07-31 run); an anchor with an `ax` layer that does not resolve cuts at its
  **edge** boundary, not mid-edge; a point-only anchor does not cut.
- **Remainder** — descriptors reflect the recorded anchor; repairs appear;
  `bound: "upper"` is computed from anchors lacking an `ax` layer.
- **Supersession** — fires on a cross-app edge whose final action is spatial and
  point-only; does **not** fire when the final action carries an AX layer; fires
  on an edge with **no** `wait` at all (the `e1`/`e4` shape, which the first rule
  missed); drops app waits wherever they sit, including mid-edge (the `e2`/`e5`
  shape); the suppressed action appears as a `SupersededStep` and posts nothing.
- **Repair placement** — on a cross-app edge, the `RepairStep` is emitted
  **after** the edge's other actions, so the source app's clicks and keystrokes
  are posted before the switch. This is a regression test for the correction
  above, and it fails against today's `plan.ts`.
- **Arming** — a remainder blocker refuses; a remainder upper-bound below the
  floor refuses and is overridable.
- **The run loop** — reaches a goal across two segments; `declined` stops
  immediately with nothing posted after; `no-progress` terminates rather than
  spinning; `max-segments` terminates; drift re-pathfinds and populates
  `Plan.drift`.
- **Node-boundary verification** — a violated destination predicate aborts the
  segment mid-way and the outcome names the predicate.
- **Existing plan tests** must be re-read: any case where an AX-carrying anchor
  falls to `point` now cuts instead of planning a stale coordinate. That is the
  intended change, and each such test is re-expressed rather than relaxed.

## Derived requirements

- **⌘-Tab and other chord-based app switching.** Not covered by supersession, and
  not designed for until a recording contains one.
- **A checked-in AX fixture captured from the real sidecar.** Still absent, still
  the reason the role-prefix bug survived, and now also the thing that would let
  the locator be tested against real predicate sets.
- **A zero-predicate node in the graph at all.** `n0` is the session's first
  boundary and carries nothing. It is inert here because the locator excludes it,
  but a node that describes no state is a lift-time defect worth its own look.
- **The locator's tie-break remains unexercised.** Exactly one node verified, so
  predicate-count versus strict superset-nesting was never reached. Count stands
  as the simpler rule, but it is untested rather than validated, and a graph
  dense enough to produce two equally-specific candidates would be the first real
  test of it.
- **The app's review UI.** Nothing in `app/` calls `buildPlan` yet. The segment
  and remainder shapes are designed to be rendered, but the surface is out of
  scope here.

## Out of scope

- **Unattended replay.** `arm` is injected precisely so an AI-in-the-loop caller
  can supply it later; that is subsystem #4, and `parseInterventionResponse` is
  already the security boundary such a caller would answer through.
- **Rollback or compensation** for a run that stops after posting events. There
  is no undo on a desktop, and inventing one is a larger problem than this spec.
- **Resolution during a segment.** Anchors within a segment are resolved once, at
  plan time, so the review is exact. Re-resolving them at arrival is the rejected
  design, not a later increment of this one.
