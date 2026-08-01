# App activation as a predicate repair

**Date:** 2026-08-01
**Status:** Design approved, pending spec review

## Context

The executor's replay loop closed on 2026-07-31: a recorded node verified against
the live desktop, its anchor resolved at `identifier@1.00`, the plan armed, and
the posted CGEvent had its intended effect. That run was deliberately narrow —
one click, one app, with the target app already frontmost.

A plan that crosses applications cannot arm. The `app` predicate on the
destination node does not hold, and nothing in the executor can make it hold.

`REACH_BY_KIND` tags `app` as **`achievable`**, and the IR spec says an
achievable predicate that does not hold "has a repair path". That repair path has
never existed. This spec builds it.

### What the graph already contains

Inspecting a real recorded graph first changed the shape of this work, so it is
recorded here rather than assumed:

1. **App switching is already in the graph** — as **point-only Dock clicks**.
   The recorded switches are clicks at y≈1017, 1035 and 1006 on a 1080-tall
   screen. The Dock is not in the focused window's AX tree, so those clicks
   carry no AX layer and resolve at `point@0.30`.
2. **The IR already models the app change as state.** Lifted edges contain
   `wait { until: app("Google Chrome") }`. That machinery works now that
   `observe()` reports the frontmost app.
3. **So the missing piece is not a switching mechanism.** Two separate things
   block a cross-app plan:
   - the Dock clicks are point-only, dragging the edge's AX rate to 0% so the
     brittleness gate refuses;
   - **`buildPlan` resolves every anchor up front against the *current* state.**
     An anchor in Chrome cannot resolve while TextEdit is frontmost, however the
     switch happens.

### Explicit decision: replaying the Dock click is not the answer

The recorded Dock click is a coordinate with no AX layer, on a surface whose
contents and position change as apps are pinned, opened and closed. Replaying it
is a coin flip that lands on whatever now occupies that pixel — and the failure
is silent, because a click always "succeeds".

Activating a named application is deterministic, survives Dock changes, and is
what `achievable` promises: not "repeat what was recorded", but "reach this
state". The recorded Dock click remains in the graph; the executor simply has a
better way to satisfy the predicate it was serving.

### Explicit decision: this does not make cross-app plans armable

Stated so it is not mistaken for a fix it is not. Activation removes the
**predicate** obstacle. Anchors belonging to steps in the not-yet-frontmost app
still cannot resolve at plan time, so those edges still measure 0% and the
brittleness gate still refuses. That is the **resolution-timing** obstacle, and
it is not cross-app specific: no multi-step plan can be fully resolved in
advance, because later steps expect states that do not exist yet.

Fixing it means resolving each anchor when execution reaches it, which weakens
the dry-run promise from "every action" to "the next action" — the design's
principal safety property. That is a separate decision with its own spec, and it
is deliberately not taken here.

## Decisions taken during design

- **Activation is a visible step in the plan, never implicit.** Arming's promise
  is that the plan shows everything that will happen; an app switch performed
  silently during execution would be a real side effect absent from the review.
- **It is not an `Action`.** `Action` is the IR — recorded behaviour — and
  nothing recorded this. It is a separate `RepairStep`, which also keeps
  `trace/` untouched.
- **Activation raises an already-running app. Launching is opt-in.** A launch can
  restore windows, reopen documents and run startup work; it is a categorically
  larger action than bringing an app forward. Not running is a **blocker** by
  default, overridable by the caller in the same shape as the brittleness
  override.
- **Match on `localizedName`.** It is the string `active-win` records as
  `owner.name` and the string `dump` already returns, so an `app` predicate
  matches verbatim with no normalization. Normalizing app names across two
  sources is exactly the class of divergence that has already cost this project
  a full day (window titles, AX roles, empty attributes).
- **After activating, wait on the predicate.** Never sleep. Activation that does
  not take effect must time out naming the app, not continue silently.

## Architecture

No new module. Three files change, plus the Swift sidecar.

| File | Change |
| --- | --- |
| `src/replay/types.ts` | `RepairStep`, `PlanStep`, `Actuator.activate` |
| `src/replay/plan.ts` | insert a repair step for an unmet `app` predicate |
| `src/replay/execute.ts` | perform activation, then wait on the predicate |
| `native/ax-exec.swift` | the `activate` command |

### The repair step

```ts
export interface RepairStep {
  repair: "activate";
  app: string;
  /**
   * Whether execution may LAUNCH the app rather than only raise it. Decided at
   * plan time and recorded on the step, so the review shows exactly what will
   * happen — an override that only lived in the executor's options would be a
   * launch the plan never disclosed.
   */
  launch: boolean;
  /** The unmet predicate this repairs, so the plan can explain itself. */
  reason: string;
}

/** A plan step is either a recorded action or a synthesized repair. */
export type PlanStep = PlannedAction | RepairStep;
```

`Plan.steps` becomes `PlanStep[]`. The two are discriminated by
`"repair" in step`, so every existing `PlannedAction` path is untouched — no
field is added to `PlannedAction` and no existing test changes shape.

### The actuator methods

Two, and the split is load-bearing:

```ts
/** Inert: which applications are currently running, by localizedName. */
runningApps(): Promise<string[]>;

activate(app: string, launch: boolean): Promise<"activated" | "launched" | "not-running">;
```

**Planning may only call `runningApps`.** Producing a plan has no side effects
beyond reading the AX tree, and calling `activate` to discover whether an app is
running would activate it — the plan would change the world it is describing.
`runningApps` is the read that lets planning decide between a repair step and a
blocker while staying inert.

`activate` returns three outcomes rather than a boolean because the caller must
distinguish "it is now frontmost" from "it does not exist to activate"; a boolean
would collapse them. With `launch: false` and no match it returns `not-running`
without side effects.

Both are implemented over `NSWorkspace.shared.runningApplications`, matching
`localizedName`.

### Options and their homes

| Option | Lives on | Default |
| --- | --- | --- |
| `allowLaunch` | `BuildPlanInput` | `false` — recorded onto each `RepairStep.launch` |
| `activateTimeoutMs` | `ExecuteOptions` | `5000` |

`allowLaunch` is a **planning** input because whether a launch may happen must be
visible in the plan under review, not decided later at arming.

## Semantics

### Planning

For each node on the path, if it carries an `app` predicate that the observed
predicate set does not satisfy, insert a `RepairStep` immediately before that
node's edge. Consecutive steps for the same app collapse to one — a path that
stays in an app does not re-activate it at every hop.

Whether the app is running is determined at plan time via `runningApps` — never
by attempting to activate it — so the plan can carry the blocker rather than
failing halfway through execution:

| Condition | Plan outcome |
| --- | --- |
| App frontmost already | No repair step inserted |
| App running, not frontmost | `RepairStep` inserted |
| App not running, no override | **Blocker**: `"<app> is not running"` |
| App not running, override set | `RepairStep` inserted; execution launches |

### Execution

A repair step activates, then **polls the `app` predicate through `observe`**
until it holds or `activateTimeoutMs` elapses — the same mechanism `wait` uses,
for the same reason: a cold app takes an unpredictable time to come forward, and
sleeping a fixed duration is the difference between a replay that works once and
one that works repeatedly.

A timeout aborts the plan naming the app. `not-running` at execution time (the
app quit between planning and arming) aborts likewise.

### Arming

Unchanged. A repair step is not a target, so it does not enter `axRate` — a plan
does not become less brittle by containing more repairs. Blockers remain
non-overridable; the launch override governs only whether "not running" becomes
a blocker in the first place.

## Failure handling

| Condition | Behaviour |
| --- | --- |
| App not running, no override | Blocker at plan time; cannot arm |
| App not running at execution | Abort, naming the app |
| Activation does not take effect | Abort on `activateTimeoutMs`, naming the app |
| Two apps share a `localizedName` | Activate the first match; recorded in the step's `reason` |
| Sidecar error during activate | Abort the plan, like any other actuator failure |

## Testing

`FakeActuator` records `activate` calls and returns a scripted outcome, so **no
test can activate or launch a real application** — the same property that keeps
the suite unable to post events.

- **`plan.activate.test.ts`** — a repair step is inserted when the `app`
  predicate is unmet; **not** inserted when it already holds; consecutive steps
  for one app collapse; not-running becomes a blocker; the override turns that
  blocker into a repair step.
- **`execute.activate.test.ts`** — activation is performed before the following
  action; the executor polls rather than sleeping and proceeds once the predicate
  holds; a predicate that never holds aborts naming the app; `not-running` at
  execution aborts.
- **`replay.sidecar.test.ts`** — `runningApps` returns a non-empty list against
  the real sidecar, and `activate` answers with a valid outcome. `activate` is
  exercised only against a **name that cannot match a running app** and with
  `launch: false`, so the real-sidecar test activates and launches nothing.
- The inertness guard in `replay.barrel.test.ts` continues to assert that only
  `sidecar.ts` may spawn.

## Out of scope

- **Progressive anchor resolution** — the resolution-timing obstacle above.
  Cross-app plans remain unarmable until it is addressed.
- **Launching as a default.** Reachable only via the caller's override.
- **Window selection within an app.** Activation brings the application forward;
  which of its windows receives focus is the OS's decision. A `window` predicate
  that then fails is a normal unmet predicate, not a second repair.
- **Anything for `file` or `permission` predicates.** They are `assertable` and
  have no repair path by definition.
