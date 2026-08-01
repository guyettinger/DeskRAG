# Progressive anchor resolution — segmenting a plan at the resolution frontier

**Date:** 2026-08-01
**Status:** Design approved, pending spec review and the validation gate below

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
every recording measured so far contains (Dock clicks at y≈1017, 1035, 1006 on a
1080-tall screen). A ⌘-Tab switch is a `chord` with no anchor and would not be
suppressed, so it would be posted after activation and switch to a third app.

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
| `src/replay/plan.ts` | Greedy cut, remainder disclosure, supersession. |
| `src/replay/execute.ts` | Node-boundary verification; drag `to` resolution. |
| `src/replay/types.ts` | `SegmentCut`, `RemainderEdge`, run types, field additions. |
| `src/index.ts` | Export `locateNode`, `executeRun` and the new types. |
| `test/replay.barrel.test.ts` | Glob `src/replay/*.ts` instead of listing files. |

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

> On an edge where a `RepairStep` for app X was inserted, suppress the contiguous
> **tail** of actions ending at that edge's `wait { until: app(X) }` — the wait
> itself, plus immediately-preceding spatial actions whose anchors carry **no
> `ax` layer**. Everything else is posted as recorded.

Each clause is load-bearing:

- **The `wait` anchors it.** Without one there is no evidence in the IR that the
  click caused the app change, so nothing is suppressed and the click posts as
  recorded. The conservative default is today's behaviour, so absence of
  evidence never produces a silent change.
- **The wait is independently safe to drop** — `runRepair` already polls that
  exact predicate before returning, so removing it is a no-op rather than a
  skipped check.
- **No `ax` layer is structural, not heuristic.** The switch target sits outside
  the focused window's AX tree by definition — that is *why* the Dock click is
  point-only. An action targeting an element in the app's own tree therefore
  cannot have been the switch.
- **Tail-contiguity** stops the rule reaching backwards past a real in-app
  action.

A suppressed action becomes a `SupersededStep`, visible in the review: *"the
recorded Dock click will not be posted; activating Google Chrome replaces it."*

### Locating

```ts
export function locateNode(
  observed: readonly Predicate[],
  nodes: readonly TraceNode[],
): { nodeId?: string; candidates: number; ambiguous: boolean };
```

Candidates are nodes with no `verifyNode` violations against `observed`. The
candidate with the most predicates wins; a tie for the most declines with
`ambiguous: true`. `candidates` is reported whatever the outcome, so a failure to
locate is debuggable rather than opaque.

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

Record a real TextEdit → Chrome session, lift it, and drive greedy resolution
against the live desktop. The recording must answer:

| Measurement | The decision it feeds |
| --- | --- |
| Segments per cross-app plan | Whether the approval cost is tolerable. Six approvals for one task invalidates the chosen shape. |
| Anchors in the not-yet-frontmost app that carry any `ax` layer | Whether cutting helps at all, or those edges are point-only regardless of timing. |
| Whether any anchor **falsely** resolves in the wrong state | The real risk in greedy resolution. A `Save` identifier present in both apps would be swallowed into segment 1 and clicked wrongly. Nothing but a recording settles this. |
| How many recorded nodes verify against one live observation, and whether they nest | Whether the locator's tie-break stays predicate-count or becomes strict superset-nesting. |
| The repaired edge's actual actions, and its AX rate with and without the recorded switch action | Confirms the supersession rule fires on real data and measures what it buys. |
| Whether the recorded switch is accompanied by a `wait { until: app(X) }` | If it is not, supersession never fires and the rule needs its anchor reconsidered. |

Findings are written back into this spec before implementation is called done,
in the style of the executor spec's "Correction:" sections.

## Testing

Everything below runs against `FakeActuator`. The suite stays structurally
incapable of posting a real event, and the barrel guard now enforces that by
directory rather than by list.

- **`locate.ts`** — exact hit; a node that is a strict subset loses to a more
  specific one; a tie for most-specific declines; no candidate returns
  `nodeId: undefined` with `candidates: 0`.
- **Segmentation** — a fully-resolvable path produces no cut, an empty remainder
  and a plan byte-identical to today's (this is the regression test for the
  2026-07-31 run); an anchor with an `ax` layer that does not resolve cuts at its
  **edge** boundary, not mid-edge; a point-only anchor does not cut.
- **Remainder** — descriptors reflect the recorded anchor; repairs appear;
  `bound: "upper"` is computed from anchors lacking an `ax` layer.
- **Supersession** — fires with a `wait { until: app(X) }` present; does **not**
  fire without one; does not reach past an AX-anchored action; the suppressed
  action appears as a `SupersededStep` and posts nothing.
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
- **A committed driver script.** The 2026-07-31 run was ad hoc; `executeRun`
  plus `locateNode` make a small `scripts/` driver possible, and the validation
  gate needs one anyway.
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
