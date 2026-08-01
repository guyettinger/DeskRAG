# The plan review UI

**Date:** 2026-08-01
**Status:** Design approved, pending spec review

## Context

`src/replay/` is complete and merged. `buildPlan` resolves a graph against the
live AX tree and cuts at the resolution frontier; `executeRun` drives the segment
loop with an **injected** `arm` gate; `Plan` carries blockers, per-edge
brittleness, the cut with its rung-by-rung attempts, and the disclosed remainder.
Every one of those shapes was designed to be rendered.

Nothing renders them. Both executor specs close with the same deferral:

> **Any replay UI in the app.** This spec defines the library seam; how a plan is
> reviewed and armed in DeskRAGApp is a later question.

> **The app's review UI.** Nothing in `app/` calls `buildPlan` yet. The segment
> and remainder shapes are designed to be rendered, but the surface is out of
> scope here.

This spec is that surface. It adds no capability to the library — it is the first
consumer of one that already exists.

### What already exists to build on

- `app/src/main/trace-index.ts` merges every session into one accreting graph
  under `DEFAULT_GRAPH_ID`, and `store.getGraph(id)` reads it back.
- `TraceNode.visual` carries a `frameBlobId`, and `main/protocol.ts` already
  serves `deskrag://frame/<blobId>`. Recorded states can be shown as the
  screenshots they are, rather than as `n7`.
- `AxExecSidecar` is exported from the barrel and implements `Actuator` whole.
- `SwiftKeymapSource` (`ax-dump --keymap`, permission-free) supplies the layout.

### The state of validation this UI inherits

One live CGEvent has ever been posted from a plan (2026-07-31): a single click,
one app, target already frontmost. Waits, typing, chords, drags and the segment
loop have only ever run against a fake actuator, and **no multi-segment run has
ever posted an event** — the measured 2-segment cross-app plan was exercised with
arming refused.

This UI is therefore the first surface that can post a multi-segment run. That is
the reason for the focus-handoff section below, and the reason the review renders
every `Plan` field rather than a summary of them.

## The problem this UI creates, which no prior spec has

**The reviewer is itself an application.**

`executeRun` dumps at the top of each turn, which is correct: the previous
segment's execution ended in the target app, so the target is frontmost and the
observation describes it. But the user approves by **clicking in DeskRAGApp**,
which raises DeskRAGApp and puts its window over the target. Execution then posts
the first click at a screen coordinate that may now be covered by the reviewer's
own window — and because `app` was met at plan time, no repair step was planned
to correct it.

That is how a plan reviewed for TextEdit posts a click into DeskRAG.

`scripts/replay-probe.mjs` already has `--wait-for <app>` because running the
probe necessarily focuses a terminal. The probe never posts, so it never had to
solve this; it only had to avoid observing at the wrong moment.

### The fix: the handoff is what arming means

The handoff belongs **inside the injected `arm` callback**, not beside it:

```
arm(plan) = emit segment-planned(PlanDTO)          → the renderer renders
          → await the renderer's decision
          → if declined: return false                (executeRun stops "declined")
          → win.hide()
          → actuator.activate(expectedApp, false)
          → poll the `app` predicate until it holds
          → return true                              (executePlan may now post)
```

`arm` is `async` and returns a boolean, so everything before the `return true`
completes before `executePlan` posts anything. `replay/` needs no change and
learns nothing new — the seam it already has is exactly the right shape.

This is not a mechanism that happens to run near arming. Approving a plan and
then leaving your window over the target is not an approval that means anything;
returning the world to the state the plan was reviewed against is part of the
approval itself.

`expectedApp` is read from the `app` predicate on `plan.from`. **If the poll
never satisfies, `arm` returns `false`.** A failed handoff stops the run; it must
never become a click posted into the reviewer.

`executeRun` reports any false return as `stopped: "declined"`, which would put a
failed handoff and a user's Cancel under one word. The service therefore records
*why* it returned false and the panel reads that, not the enum alone — see the
failure table.

A plan whose `from` node carries no `app` predicate has no handoff step and no
activation: there is nothing to name. The window is still hidden, because
occlusion does not require knowing which app is underneath.

## Explicit decision: the poller runs through `ax-exec`

`locateNode` needs an `app` predicate — a node carrying `app` cannot verify
without one, and nearly every node carries one. `ax-dump` reports no app or
window title. `ax-exec`'s `dump` does, in one call.

**Rejected:** `ax-dump` for the tree plus `active-win` for the app name. It would
keep the read-only binary in the read-only role, and it is the pattern the IR
spec already rejected by name — sourcing two halves of one observation
separately is what made boundary snapshots describe the previous application, and
an app name fetched a moment after a tree has the identical hazard. `AxObservation`
bundles them for that reason.

**Consequence, stated rather than buried:** a binary capable of clicking is alive
whenever the Replay screen is mounted, not only during an armed run. This is a
widening of the probe's posture and is recorded here as a decision.

Mitigations, all structural:
- The sidecar's lifetime is exactly `replay:watch` — `watch(true)` on screen
  mount spawns it and starts the poller, `watch(false)` on unmount stops the
  poller and kills it. Quit kills it too. There is no other way to start it, so
  the screen being open is the whole of its liveness condition.
- `ax-exec` still gates on `AXIsProcessTrusted()` and still refuses to start
  without `--plan <id>`.
- Nothing posts outside `executePlan`, which runs only after `arm` resolves true.
- `test/replay.barrel.test.ts` continues to assert that only `sidecar.ts` may
  reach for a process.

### The rule the poller needs

**When DeskRAGApp is frontmost, the observation describes the reviewer, not the
desktop.** Poll every 2s; when `observation.app` is DeskRAG's own name, discard
the reading and keep the last *foreign* one, marked with its age:

> last seen: TextEdit — Untitled, 4s ago

Without this the you-are-here indicator reads "no match" permanently, because
looking at it is what breaks it. With it, the workflow works the way a user
expects: switch to TextEdit, get it into the state you want, switch back to
DeskRAG, and the canvas still shows where you were.

## Architecture

Three new modules, following the process boundary the app already enforces:
`main` is the only process that touches the library, the renderer sees only
plain serializable DTOs.

### `app/src/main/replay-service.ts`

The single owner, mirroring `DeskRagService`'s role for capture. It owns:

- the `AxExecSidecar` lifecycle (mount → spawn, unmount → kill);
- the location poller and its frontmost-is-self rule;
- the run: `executeRun` is called from here and nowhere else;
- the arm bridge — a pending promise resolved by the renderer's `replay:arm`.

The `ax-exec` binary is located the way `ax-dump` already is in `main/index.ts`:
an `ERAG_AX_EXEC_BIN` env var wins, otherwise `<repo>/native/ax-exec` when it
exists.

### `app/src/main/plan-view.ts`

Pure projection: `Graph → GraphDTO`, `Plan → PlanDTO`, predicates → human labels.
No Electron, no Node, no I/O.

This module is what the reviewer actually reads before authorizing a click, so it
is tested rather than eyeballed. The root `vitest.config.ts` gains a `@shared`
alias so `test/replay.plan-view.test.ts` can import it. That is the only
build-config change in this spec.

Labelling rules. **There is no `window` predicate to label from** — checked
against `extractPredicates` rather than assumed from `PredicateKind`, which lists
one. Window titles are deliberately never emitted (a title is document identity,
not state; keeping it meant a node recorded in one document could never be
located in another), and `Window` is deliberately absent from `STABLE_ROLES` for
the same reason. So a node label is built from what nodes actually carry:

1. the `app` predicate's `app` arg;
2. one distinguishing hint after it — a `Sheet` or `Dialog` `ax_exists` label
   first, because those name a state ("Open", "Save") rather than a document and
   are kept in `STABLE_ROLES` for exactly that reason; failing that, the
   `ax_focused` label;
3. nothing else. Two nodes in one app with no sheet and no focused element are
   labelled identically, and the id chip on the card is what tells them apart.
   Inventing a difference would be worse than showing there isn't one.

A node with no predicates at all — the entry node, `n0` — is labelled by its id
and says it describes no state.

The live location is different and may show a window title: `AxObservation`
carries `windowTitle`, so "last seen: TextEdit — Untitled" is sourced from the
observation, never from a predicate.
- An action's target is described from the anchor's **recorded** descriptors —
  identifier, then label, then role plus path depth. Never from the resolution,
  which is where it landed, not what was asked for.

### `app/src/renderer/src/screens/ReplayScreen.tsx`

A fifth rail route, `Replay`. Splits into `GraphCanvas.tsx` and `PlanReview.tsx`.

The Replay screen does not fit inside Library: Library is per-recording, and the
graph is the merge of all recordings. A recording is not a task.

## The DTO contract

`shared/types.ts` imports nothing from Node or `deskrag`, so `Plan` cannot cross
as-is. The DTOs mirror it, already labelled, so the renderer never re-derives a
target description from raw predicates.

```ts
interface GraphNodeDTO {
  id: string;
  label: string;          // "TextEdit — Save", or the id when unlabellable
  app?: string;
  /** A Sheet/Dialog or focused-element label. NOT a window title — see above. */
  hint?: string;
  frameBlobId?: string;   // from TraceNode.visual
  observations: number;
  intervene: "none" | "select" | "synthesize";
  rank: number;           // BFS distance from entry; the canvas's column
}

interface GraphEdgeDTO {
  id: string;
  from: string;
  to: string;
  actions: number;
  back: boolean;          // to an equal or lower rank — a merged loop
  provenance: "recorded" | "synthesized";
}

interface GraphDTO {
  id: string;
  entry: string;
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
  slots: { name: string; samples: string[] }[];
}

interface LocationDTO {
  nodeId?: string;
  candidates: number;
  ambiguous: boolean;
  app?: string;
  /** From AxObservation.windowTitle — the one place a title is legitimate. */
  window?: string;
  /** Age of the last FOREIGN observation. Set while DeskRAG is frontmost. */
  staleMs?: number;
}

type PlanStepDTO =
  | { kind: "handoff"; app: string }
  | { kind: "action"; edgeId: string; action: string; target: string;
      layer?: string; confidence?: number; slot?: { name: string; value: string } }
  | { kind: "repair"; edgeId: string; app: string; launch: boolean; reason: string }
  | { kind: "superseded"; edgeId: string; action: string; reason: string };

interface PlanDTO {
  id: string;
  segment: number;         // 1-based
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  steps: PlanStepDTO[];
  blockers: { reason: string; scope: "segment" | "remainder" }[];
  brittleness: { edgeId: string; axRate: number; belowFloor: boolean;
                 bound: "measured" | "upper" }[];
  cut?: { resumeAt: string; edgeId: string;
          attempts: { layer: string; rejected: string }[] };
  remainder: { edgeId: string; toNodeId: string;
               actions: { kind: string; descriptors?: string[];
                          recordedPoint?: { x: number; y: number };
                          slot?: string }[];
               repairs: { app: string; launch: boolean }[] }[];
  drift?: { expected: string; observed: string };
}

type RunEventDTO =
  | { type: "segment-planned"; plan: PlanDTO }
  | { type: "armed"; segment: number }
  | { type: "segment-done"; segment: number; completed: boolean;
      failure?: { step: number; reason: string };
      telemetry: { edgeId: string; layer: string; confidence: number }[] }
  | { type: "stopped"; reached: boolean; stopped?: string };
```

New `IPC` channels: `replayGraph`, `replayWatch`, `replayStart`, `replayArm`,
`replayCancel`, `replayEvent`, `replayLocationEvent`.

```ts
replay: {
  graph(): Promise<GraphDTO | null>;
  watch(on: boolean): Promise<void>;
  start(input: { goalNodeId: string; slotBindings?: Record<string, string>;
                 allowLaunch?: boolean }): Promise<void>;
  arm(input: { segment: number; approve: boolean; override?: boolean }): Promise<void>;
  cancel(): Promise<void>;
  onEvent(cb: (e: RunEventDTO) => void): () => void;
  onLocation(cb: (l: LocationDTO) => void): () => void;
}
```

## The graph canvas

Fixed split, graph left and review right, both always present — the review column
is an empty state before planning. Nothing moves when a plan arrives, and the
canvas stays visible while the plan is read, so "where am I / where is this
going" and "what will it do" are legible at once.

Layout, with **no new dependency**:

- `rank` is BFS distance from `graph.entry`, first-seen winning, so a merged loop
  does not re-rank its target. Computed in `plan-view.ts`, shipped on the DTO.
- Same-rank nodes stack vertically; `x = rank * (cardWidth + gap)`.
- Edges are SVG cubics. A `back` edge — to an equal or lower rank — is drawn
  distinctly, because a loop is a real feature of a merged graph and should not
  read as a mistake.
- Wheel zoom and drag pan over a CSS transform. No minimap, no auto-layout
  refinement.

`@vidstack/react` was worth a dependency because a media player is not 60 lines.
A layered layout for a graph of tens of nodes is, and the renderer's dependency
surface stays where it is.

A card shows its keyframe through `deskrag://frame/<frameBlobId>` when
`TraceNode.visual` exists, and degrades to a text card when it does not — which
is exactly the entry node's case. Badges: **you are here**, **goal**, entry, and
the observation count.

## The review panel

Every `Plan` field is rendered. A field the reviewer cannot see is a field the
plan did not disclose.

| Field | Rendering |
|---|---|
| `drift` | leading banner: *"last segment expected n7, landed on n5"* |
| handoff | synthesized first step: *"hide DeskRAG, return focus to TextEdit"* |
| `PlannedAction` | kind, recorded target, `layer` + `confidence`, slot binding |
| `RepairStep` | *"activate Notes"*, its `reason`, and **`launch`** explicitly |
| `SupersededStep` | struck through, with `reason` — visible, never omitted |
| `blockers` | listed with `scope`; **Arm is disabled and there is no override** |
| `brittleness` | per-edge `axRate`; `belowFloor` needs an explicit override tick |
| `cut` | *"resolution stopped at edge e12"* plus the `attempts` ladder, rung by rung |
| `remainder` | action kinds and which descriptors were **recorded**; `recordedPoint` labelled provenance, never a target; `axRate` marked *upper bound* |

The two gates keep the library's asymmetry exactly: **blockers can never be
overridden** — no UI action produces an `assertable` predicate, so there is
nothing for an override to mean — while brittleness can be, by an explicit tick
that names what is being accepted.

Segment count is rendered as *"Segment 3"*, never *"3 of N"*. The loop does not
know how many segments remain, and inventing a denominator would be a claim the
executor never makes. The remainder's edge count is the honest lower bound and is
shown as such.

### Run setup

Before the first plan: the goal node (clicked on the canvas), values for any
slots (a dropdown of `Slot.samples` plus free text), and an `allowLaunch` toggle
whose effect appears on every `RepairStep.launch`.

The keymap comes from `SwiftKeymapSource` at run start. If it is unavailable,
typing is a **blocker** — never a US-QWERTY guess. Same rule, opposite direction,
as `resolveKeys` at lift time.

## Failure surfacing

Each `RunStop` gets a plain-English panel rather than its enum name:

| `stopped` | Panel |
|---|---|
| `not-located` | "The desktop matches no recorded state" + the last location |
| `no-path` | "No recorded path from here to that state" |
| `no-progress` | "The first action's target is gone from this screen" |
| `declined`, cancelled | "Cancelled" — no event was posted |
| `declined`, handoff failed | "TextEdit did not come forward; nothing was posted" — the two share an enum, so the service records which one it was |
| `failed` | the failing step, highlighted, with `ExecOutcome.failure.reason` |
| `max-segments` | "Stopped after 8 segments" |

`ExecOutcome.telemetry` becomes a post-run per-edge layer/confidence summary —
the first place the executor's own measurements are visible without a script.

## Testing

- **`test/replay.plan-view.test.ts`** — the projection. Node labelling from
  predicates, including the unlabellable entry node and two same-app nodes that
  are *allowed* to collide; BFS ranks with a loop present; back-edge
  classification; and that blockers, superseded steps and the remainder all
  survive into the DTO. A plan whose blockers vanish in projection is the failure
  mode that matters, so it is asserted directly.

  The labelling tests use predicates in the shape real data has: roles with **no
  `AX` prefix**, since the sidecar strips it and matching the prefixed spelling
  is the bug that has already shipped once in this repo.
- **`npm --prefix app run typecheck`** — the app's gate, renderer and node.
- **`npm test`** — unchanged and still offline; the alias addition is the only
  config change.
- **A real run.** This is the first surface that can post a multi-segment run, so
  the validation gate is the repo's standing rule: record a real session, open
  Replay, and drive it. Read what actually lands, and treat any figure from one
  application as provisional.

The suite cannot cover the thing this spec is most about. Nothing in `test/` can
observe that the reviewer's window was over the target when a click was posted;
`replay.barrel.test.ts` guarantees the suite cannot post at all, which is the
point. The handoff is verified by running it.

## Out of scope

- **AI-in-the-loop.** `arm` stays human. `parseInterventionResponse` is the
  security boundary a model would answer through, and that is subsystem #4.
- **Graph editing.** No renaming nodes, deleting edges, or authoring slots. The
  graph is what was recorded; changing it is a different spec.
- **Undo.** There is no undo on a desktop, and inventing one is a larger problem
  than this surface.
- **Naming tasks.** A goal is a node, picked visually. A task-name layer over the
  graph is worth having and is not this.
- **Replaying a specific recording.** Edges carry no session provenance, so
  "do that session again" is not expressible today. The goal is a state, not a
  history.
