# The executor — driving macOS from a trace graph

**Date:** 2026-07-31
**Status:** Design approved, pending spec review

## Context

`src/trace/` lifts a recorded session into a manipulable graph, and
`app/src/main/trace-index.ts` merges each session into one accreting graph. The
graph can be read, printed, parsed, and merged. Nothing can *act* on it.

This spec covers subsystem #3 of the four-way decomposition (capture → IR →
**executor** → AI-in-the-loop). The executor is the first component in DeskRAG
that does something rather than records something, and its failure mode is
clicking real things on a real desktop.

### What validation established first

The IR spec's end-to-end proof was `SyntheticInputProducer` in tests — no real
recording had been driven through the full chain. Doing that before designing
the executor changed the design, because three of the graph's inputs turned out
to be degenerate, and the fixes moved numbers this spec depends on.

Three recordings produced a graph of **2 nodes, 3 edges, 0 slots** — one state
with two self-loops. The causes, in order of severity:

1. **The AX role prefix mismatch.** `native/ax-dump.swift` strips the `AX`
   prefix (`rawRole.dropFirst(2)`), so real data carries `Button`, `Window`,
   `TextField`. `trace/predicates.ts` matched a set of *prefixed* literals with an
   exact `Set.has()`. `extractPredicates` therefore emitted **zero `ax_exists`
   and zero `ax_focused` predicates from real capture data, ever**. Every node
   held only `app` + `window`, so every boundary inside one app was the same
   state, and every idle gap was dropped with *"produced no newly-true
   predicate"* — a predicate set that never changes has nothing that can become
   newly true. `represent/regions/ax.ts` had already learned this and normalizes
   (`r.replace(/^AX/i, "").toLowerCase()`); `predicates.ts` regressed it. The
   tests missed it because they hand-write prefixed roles — the IR spec called
   for a fixture captured from the real sidecar, and that part was not done.
2. **A stale sidecar binary**, predating `--keymap` and `--displays`. Both modes
   returned an AX tree instead. No keymap meant every key event was dropped and
   no slot could ever be filled; no display topology meant every anchor fell back
   to a synthetic `D0`. The validation guard in `trace-index.ts` correctly
   rejected the malformed payloads rather than storing them, which is why this
   degraded silently instead of corrupting.
3. **Region rows were never written.** `imageEmbedder` and `patchEmbedder` are
   mutually exclusive in `DeskRagService`, and the Regions stage was gated on
   `imageEmbedder`. Selecting ColSmol — the better retrieval path — skipped the
   stage entirely, so `Anchor.visual` could never be populated. Region *proposal*
   is pure geometry plus the AX tree; only the crop needs a model. They are now
   decoupled, and a region row without a vector is a state the store already
   modelled (it is what a crash between the SQLite commit and the Lance add
   leaves behind, and what `reconcile()` exists to find).

A fourth defect surfaced only after those were fixed: the visual anchor layer
took its `framePhash` from the **AX snapshot** while taking its regions from the
nearest **frame**. Two thirds of real AX snapshots are boundary-triggered
(`focus_change`, `dwell_resume`) and carry no frame at all, so the layer was
dropped on 31 of 32 actions despite regions being available. The regions and the
pHash now travel as one value (`RegionsAtFrame`), which makes the mismatch
unrepresentable rather than merely fixed.

### The numbers this spec is designed against

After the fixes, two recordings of one task in TextEdit (differing only in typed
text) produce:

| Metric | Before | After |
| --- | --- | --- |
| Nodes / edges / slots | 2 / 3 / 0 | 18 / 21 / **2** |
| `ax_exists` predicates | 0 | 245 |
| `wait` actions | 0 | 13 |
| `type` actions | 0 | 4 |
| Nodes with a visual signature | ~1 | 16 / 18 |
| displayId | `D0` fallback | real (`5`) |

Slots merged as `textfield=["Test 1","Test 2"]` and
`textarea=["This is test 1","This is test 2"]` — two recordings differing only in
typed content collapsed into shared edges with two samples each. **The graph
model's central claim holds on real data.**

The anchor ladder, per resolved target (33 total):

| Layer | Share |
| --- | --- |
| `ax` | 18 (55%) |
| `visual` | 2 (6%) |
| point only | 15 (45%) |

Descriptor availability *within* the anchors carrying an AX layer, measured
across three sessions in two applications:

| Descriptor | TextEdit (2 sessions) | Chrome (1 session) |
| --- | --- | --- |
| `identifier` (AXIdentifier) | 50%, 80% | **9%** (1 of 11) |
| `label` | 25%, 30% | **36%** |
| `path` | 100% | 100% |

**Availability is app-specific, and it is the wrong thing to rank by.** An
earlier reading of the TextEdit sessions alone put AXIdentifier at 71% against
29% for labels, and concluded the ladder should be ordered by what appears most.
Chrome inverts that: a label is four times more common than an identifier there.
Ranking by observed frequency would have encoded one app's AX implementation as a
general rule.

Path depth is the finding that actually orders the ladder:

| Role | Mean depth | Max | Source |
| --- | --- | --- | --- |
| `Window` | 1.0 | 1 | native |
| `TextArea` | 3.0 | 3 | native |
| `PopUpButton` | 4.0 | 4 | native |
| `Group` | 8.0 | 10 | web |
| `Button` | 8.8 | 11 | mixed |
| `StaticText` | 11.0 | 13 | web |
| `TextField` | **13.0** | **17** | web |

A depth-17 positional path is an ordinal chain through seventeen levels, and a
sibling inserted at any one of them shifts it. That is what puts `label` above
`path`, at an accepted cost in native apps where a depth-3 path is likely
steadier than a content-dependent label.

These tables are from two applications, so they remain indicative rather than
authoritative — but they already falsified one ladder ordering, which is the
argument for measuring a third AX implementation (SwiftUI, Electron) before
treating the current order as settled.

### The known coverage constraint

All 154 region rows have `source: "ax"`. `fuse.ts` budgets `maxRegions = 14` and
sorts by priority; AX regions score 2–5, hotspots ~1–2, grid **0.5**. A real app
offers dozens of labeled controls, so the top 14 are always AX and grid coverage
never survives the budget cut.

The consequence is that the visual layer's coverage is inherited from the AX
tree's, so it is thinnest where AX is thin — the opposite of what a fallback rung
is for. **How badly that bites is app-specific**, and the second application
changed the picture materially:

| | TextEdit | Chrome |
| --- | --- | --- |
| targets with a `visual` layer | 5%, 8% | **40%** |

In TextEdit, AX regions span y 36–1416 while clicks span y 5–2113: the menu bar,
unlabeled chrome, and lower-screen clicks fall outside every region. In Chrome
the web content itself produces AX regions over exactly the area people click, so
the rung is genuinely useful there.

So the earlier framing — that the visual layer is empty precisely where it is
needed — holds for *native* applications specifically, not as a general rule. The
grid-coverage question is still recorded as a **derived requirement on
`represent/`** (final section) rather than fixed opportunistically: whether a grid
tile is a useful visual anchor is a resolution-strategy question, and the executor
is the component that gets to answer it.

## Decisions taken during design

- **Dry-run is the default and arming is a single gate.** Every replay produces a
  complete, reviewable plan with per-action targets, resolution layer, and
  confidence, and posts nothing until armed. Arming then runs end-to-end,
  aborting on predicate mismatch. Chosen over per-edge confirmation, which asks a
  human to approve under time pressure rather than review a plan.
- **Actuation is a new Swift sidecar, `ax-exec`, not a Node native module.** The
  repo's line is *native module, not subprocess*: a subprocess stays in the
  barrel, needs no `electron-rebuild`, and adds no ABI fragility. `nut-js`/
  `robotjs` would violate all three and still could not see the AX tree.
- **`ax-exec` is a separate binary from `ax-dump`.** `ax-dump` is read-only and
  two of its modes are deliberately permission-free. Folding actuation into it
  would mean every AX read is performed by a binary that can also click.
  Capability separation is worth a second build target.
- **The sidecar is long-lived, with a JSON line protocol.** Anchor resolution
  must run against the AX tree *at that moment*; a round trip back through Node
  between reading the tree and clicking is a staleness window in which the UI
  moves. One process per replay also means one permission prompt and correctly
  timed drag samples.
- **The Swift/TS boundary is element lookup vs. policy.** The sidecar answers
  "does this descriptor still resolve, and where?", returning bounds plus an
  opaque handle that stays valid in-process. TypeScript decides which layer to
  try, what counts as confident, and when to give up. The ladder stays
  exhaustively testable where the anchor types already live.
- **Resolution order is `identifier → label → path → visual → point`**, ranked by
  reliability. Availability was tried as the criterion and abandoned: it is a
  property of the application's AX implementation, not of the descriptor.
- **Verification is subset, not set equality** — see Semantics. This deliberately
  differs from node identity.
- **Brittleness gates.** The executor records the winning layer per action and
  the AX rate per edge, surfaces both in the plan, and refuses to arm an edge
  whose anchors are majority point-only without an explicit override.

### Explicit decision: clicks use CGEvent, never AXPress

`AXUIElementPerformAction(kAXPressAction)` is more reliable than a synthetic
click and is available on many resolved elements. It is nevertheless the wrong
default, because **it is a different action**: it skips hover and mouse-down
states, produces a different event stream, and bypasses any handler that reads
the click position. A trace records what the user did; replaying it as something
more reliable but different is a silent divergence, and silent divergence in a
system whose whole premise is fidelity is the failure worth avoiding.

Consequence, stated so it can be revisited: a point-only anchor is replayed as a
raw coordinate click with no verification that the thing under the cursor is the
thing that was recorded. That is 45% of targets today. It is why dry-run is the
default rather than a feature.

## Architecture

`src/replay/` is pure TypeScript that spawns a subprocess, so — like the ffmpeg
producers and the Swift AX sources — it **is** re-exported from `src/index.ts`.
Importing it loads nothing until it runs.

```
capture/ → segment/ → represent/ → retrieve/
                 ↘ trace/ ──────────────→ replay/
```

`replay/` imports `trace/` (types, `extractPredicates`, identity) and nothing
from `store/`, `represent/`, or `retrieve/`. Like `trace/`, its world arrives
through injected callbacks.

### Module layout

| File | Responsibility |
| --- | --- |
| `types.ts` | `Plan`, `PlannedAction`, `Resolution`, `ResolvedLayer`, `ExecOutcome`, `Actuator` |
| `resolve.ts` | Anchor + live AX → `Resolution` (layer, bounds, confidence). Pure. |
| `plan.ts` | Graph + start + goal → ordered `Plan`; pathfinding over `achievable` predicates |
| `verify.ts` | Predicate set vs. live AX → satisfied / violated, classified by `reach` |
| `sidecar.ts` | `ax-exec` lifecycle: spawn, line protocol, timeout, crash handling |
| `execute.ts` | Drives an armed plan; records outcomes and telemetry |

`resolve.ts`, `plan.ts`, and `verify.ts` are pure functions over plain data — no
subprocess, no clock, no I/O — which is what makes them exhaustively testable.

### The `Actuator` seam

`execute.ts` never touches a process. It depends on an `Actuator` interface that
`sidecar.ts` implements over `ax-exec` and that tests implement as
`FakeActuator`. This is the same discipline every provider in the repo follows,
and here it carries a hard safety property: **no test can post a real event.**

```ts
/** One rung's worth of AX descriptor — a projection of `Anchor["ax"]`. */
interface AxDescriptor {
  identifier?: string;
  path?: string;
  role: string;
  label?: string;
}

interface Actuator {
  /** Live AX tree of the frontmost app, for verification and resolution. */
  dump(): Promise<UIElement[]>;
  /** Does this descriptor still resolve? Returns current bounds + a handle. */
  locate(d: AxDescriptor): Promise<{ handle: number; bounds: Rect } | null>;
  moveTo(p: Vec2): Promise<void>;
  click(p: Vec2, button: number, count: number): Promise<void>;
  dragPath(samples: readonly { p: Vec2; atMs: number }[], button: number): Promise<void>;
  scroll(p: Vec2, delta: Vec2, steps: number): Promise<void>;
  key(keycode: number, modifiers: readonly string[], down: boolean): Promise<void>;
}
```

### Injected seams

`replay/` stays a leaf the way `trace/` does: everything external arrives through
the caller. Besides the `Actuator`, planning and execution need two things the
module must not go looking for itself.

```ts
interface ReplayInput {
  graph: Graph;
  actuator: Actuator;
  /**
   * The keyboard layout to type through, in reverse (char -> keycode).
   *
   * NOT optional, and not defaulted. Capture records a `keymap_change` event
   * precisely because the layout changes mid-session and fails silently when it
   * does; the lift resolves keycode -> char against it, and the executor must
   * resolve char -> keycode against the SAME table or typed text is replayed
   * through the wrong layout. A US-QWERTY fallback would be silently wrong for
   * every non-US layout and for Dvorak/Colemak on US hardware, which is the
   * failure mode the capture spec rejected a static table to avoid.
   *
   * A `type` action with no keymap is a blocker, never a guess.
   */
  keymap: Keymap;
  /** Optional visual corroboration for the `visual` rung, injected like trace/'s. */
  visualMatcher?: VisualMatcher;
}
```

The keymap is the graph's, not the session's: a graph accreted from sessions
recorded under different layouts has no single answer, and the caller — which
knows which recording it is replaying — is the only place that can choose. Where
the samples disagree, that is a blocker to surface, not an average to take.

### The sidecar protocol

One JSON object per line on stdin, one per line on stdout, correlated by `id`.
The sidecar holds `AXUIElement` references in a handle table for the life of the
process, which is what "keeping references warm" means concretely: a `locate`
followed by a `click` does not re-walk the tree.

`ax-exec` gates on `AXIsProcessTrusted()` like `ax-dump`, and additionally
refuses to start unless it is given the replay's plan id — a small guard that
makes an accidental bare invocation inert.

## The data model

### Resolution

```ts
type ResolvedLayer = "identifier" | "path" | "label" | "visual" | "point";

interface Resolution {
  layer: ResolvedLayer;
  point: Vec2;              // where the action will actually go
  bounds?: Rect;            // the resolved element's current box, when known
  /**
   * [0,1], and it means one thing only: how much the resolved target agrees with
   * the recorded one. It starts at the layer's ceiling (identifier 1.0, path
   * 0.8, label 0.6, visual 0.5, point 0.3) and is reduced by geometric
   * disagreement — centre displacement and area ratio against the recorded box.
   * It is NOT a probability that the action will succeed; nothing here can know
   * that.
   */
  confidence: number;
  /** Layers tried and why each was rejected — the brittleness record. */
  attempts: { layer: ResolvedLayer; rejected: string }[];
}
```

`attempts` is not diagnostics padding. It is the empirical answer to "where is
this trace brittle", and it is the reason the anchor layers are recorded
independently rather than derived from one another.

### Plan

```ts
interface PlannedAction {
  edgeId: string;
  action: Action;                    // from trace/types.ts
  resolution?: Resolution;           // absent for chord/type/wait
  slotBinding?: { name: string; value: string };
}

interface Plan {
  id: string;
  graphId: string;
  from: string;                      // node id observed at plan time
  to: string;                        // goal node id
  steps: PlannedAction[];
  /** Assertable predicates that do not hold. Non-empty => cannot be armed. */
  blockers: { predicate: Predicate; reason: string }[];
  /** Per-edge AX resolution rate, and whether it is below the floor. */
  brittleness: { edgeId: string; axRate: number; belowFloor: boolean }[];
}
```

A `Plan` is inert data. It can be printed, diffed, stored, and reviewed, and
producing one has no side effects beyond reading the AX tree.

## Semantics

### Planning

1. Dump live AX, extract predicates with `trace/predicates.ts` — **the same
   function used at lift time**, never a parallel implementation.
2. Locate the current node with the same identity resolver `merge.ts` uses.
   Ambiguity declines to match, exactly as merging declines to merge.
3. Pathfind to the goal. Edge cost prefers higher `observations` and a better
   `outcomes` ratio, so a well-trodden path wins over a once-seen branch.
4. Resolve every anchor along the path up front, recording layer and confidence.
5. Classify unmet predicates by `reach`: `achievable` becomes a repair sub-path,
   `assertable` becomes a blocker.

Setup is therefore not a phase and recovery is not a subsystem — both are
pathfinding, which is the whole point of the `achievable`/`assertable` tag.

### Arming and execution

Arming requires: no `blockers`, and either no edge below the brittleness floor or
an explicit override. Execution then walks `steps` in order, verifying at each
node boundary.

**The floor is `axRate < 0.5` — a majority of the edge's targets resolving below
the `visual` rung.** The number is a starting point, not a finding: today's
measured whole-graph rate is 55%, so a floor of 0.5 gates roughly half of real
edges. That is the intended aggressiveness for a system whose first act is
clicking a real desktop, and it is expected to move once there is data on how
often a point-only replay actually lands correctly.

Per action kind:

- **`click`** — warp, then post down/up at the resolved point (see the CGEvent
  decision above).
- **`drag`** — project the unit-space `Path` onto the resolved endpoints and post
  the samples against the recorded velocity profile. Verbatim and retargeted
  replay are the *same* projection, as the IR requires; there is no second path.
- **`hover`** — warp and dwell `dwellMs`.
- **`scroll`** — post `steps` wheel events totalling `delta`.
- **`type`** — char → keycode through the **same keymap** the lift used in
  reverse. This is the payoff of the capture spec's "the mapping is needed in
  both directions" decision; a second mechanism here would drift. Uses the slot
  binding when bound, otherwise `recorded`.
- **`chord`** — modifiers down, key, modifiers up, in order.
- **`wait`** — poll the predicate until true or `timeoutMs`. **Never sleep a
  recorded duration.** A dialog that took 400ms while recording takes seconds on
  a cold start.

### Verification is subset, not set equality

At each node, extract predicates from the live tree and require that **every
predicate the node claims still holds**. Extra observed predicates are not a
violation.

This deliberately differs from `samePredicateSet`, which is exact because
*merging* needs it — a differing set is a different state. Verification asking
for exact equality would fail on any screen that gained anything since recording
(a new row, a changed count that survived the stability filter, a restored
window), and given how aggressive the filter already is, that would be the
common case rather than the exception. Merging is asking "is this the same
state?"; verifying is asking "is this state still true?" Those are different
questions and need different comparisons.

## Failure handling

| Condition | Behavior |
| --- | --- |
| A layer resolves to a box wildly unlike the recorded one | Treat as non-resolution, fall to the next layer |
| Every layer fails | Abort the action. Never guess a coordinate. |
| Resolution reaches `point` only | Allowed, recorded as low confidence, surfaced in the plan |
| Edge majority point-only | Below the brittleness floor: refuse to arm without override |
| `wait` times out | Abort, naming the predicate that never became true |
| `assertable` predicate false | Blocker at plan time; cannot be armed |
| `achievable` predicate false | Repair sub-path; abort only if no path exists |
| `type` action with no usable keymap | Blocker at plan time. Never fall back to a static layout. |
| Sidecar crash or timeout | Abort the plan. Never resume a half-posted drag. |
| Node not identifiable at plan time | Abort with the observed predicate set attached |

The bias mirrors the IR's: refusing to act is visible and recoverable, while
acting on a bad resolution is silent and lands on a real desktop.

## Telemetry

Per action: winning layer, confidence, and rejected attempts. Per edge:
`outcomes.attempts` / `outcomes.successes` — fields the IR already defines — plus
an AX resolution rate. The rate is what gates arming, and it is the first
consumer of the `reason` column on `ax_snapshot` and of the anchor provenance,
both of which were added to make brittleness measurable before anything could
measure it.

## Testing

All pure TypeScript except the sidecar tests, which skip without `swiftc` — the
established pattern.

- **`resolve.test.ts`** — ladder order over fixtures; a stale `path` with a valid
  `identifier` resolves by identifier; a geometry mismatch falls down rather than
  being trusted; a point-only anchor reports low confidence. Highest-value file.
- **`plan.test.ts`** — pathfinding; `assertable` violations become blockers;
  `achievable` violations become repair sub-paths; a well-trodden edge is
  preferred over a once-seen branch.
- **`verify.test.ts`** — the subset semantics, asserted directly: a node with an
  extra observed predicate verifies, a node missing one does not.
- **`brittleness.test.ts`** — an edge below the floor cannot be armed without an
  override.
- **`typing.test.ts`** — char → keycode round-trips against the *same* keymap
  fixture `trace.lift.test.ts` uses for keycode → char, asserted both directions
  on one table; a `type` action planned without a keymap is a blocker, not a
  US-QWERTY guess.
- **`sidecar.test.ts`** — the line protocol against a real `ax-exec`; skips
  without `swiftc`.
- **Executor inertness** — a test asserting `execute.ts` performs no actuation
  through anything but the injected `Actuator`. The suite must be incapable of
  moving the mouse.

## Derived requirements

Output of this design; input to whoever picks them up.

1. **Region coverage for the visual rung.** Grid tiles never survive
   `fuse.ts`'s 14-region budget against AX priorities, so the visual layer is
   empty exactly where AX is blind. The executor wants coverage that is
   *independent* of AX, which means either reserving budget for grid or
   proposing densely on the proposal-only path — where there are no crops and
   therefore almost no cost. Deferred deliberately: the tradeoff belongs to
   whoever measures whether a grid tile actually resolves usefully at replay.
2. **A real-sidecar AX fixture in the test corpus.** The role-prefix bug survived
   because every fixture is hand-written with prefixed roles. The IR spec asked
   for a fixture captured from the real sidecar; until one exists, the same class
   of bug can recur in any consumer of `UIElement`.
3. **`ax-exec` build integration** — an `npm run build:ax` sibling, gitignored
   binary, and the same "skips cleanly when absent" discipline the AX tests use.

## Out of scope

- **The AI intervention runtime** (subsystem #4): model selection, prompting,
  latency budget. Only the wire contract is fixed, in the IR spec.
- **Promoting a synthesized edge** to `provenance: "recorded"` after a successful
  run. The IR describes it; it needs the executor to exist first.
- **Any replay UI in the app.** This spec defines the library seam; how a plan is
  reviewed and armed in DeskRAGApp is a later question.
- **Multi-display replay.** Topology is recorded and `assertable`, so a mismatch
  gates. Reprojecting a trace onto a different monitor arrangement is not
  attempted.
