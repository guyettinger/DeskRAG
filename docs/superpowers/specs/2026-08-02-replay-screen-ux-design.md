# The Replay screen, redesigned

**Date:** 2026-08-02
**Status:** Design approved, pending spec review

## Context

`docs/superpowers/specs/2026-08-01-plan-review-ui-design.md` built the Replay
screen as the first surface that could arm a plan. It shipped and it works: on
2026-08-02 a multi-step armed run posted nine steps into a real desktop from it.

What it is not is usable. The screen was designed around the *contract* — every
`Plan` field rendered, nothing summarized away — and the contract is right. The
arrangement is not.

This spec changes only the arrangement, plus three small contract additions that
the arrangement needs. **No behavior in `src/replay/` or `src/trace/` changes.**
No new IPC channels.

### What is wrong, specifically

- **The stage is a fixed split** (`grid-template-columns: minmax(0,1fr) 340px`).
  The review column is always mounted. Most of the time it holds one sentence —
  "Pick a goal on the graph, then run." — while the graph is squeezed into what
  is left.
- **The graph flows rightward**, `x = rank * (CARD_W + GAP_X)`, so it grows along
  the axis the window has least of, and the squeezed column makes that worse.
- **Siblings are ordered by array position.** `placed` stacks each rank in
  `graph.nodes` order, so wires cross for no reason other than insertion order.
- **The canvas opens at `pan {24,24}, zoom 1` and never moves.** "You are here"
  and the goal can both be off-screen with nothing indicating where.
- **A node click sets the goal and does nothing else.** There is no way to see a
  node's predicates — which is the whole of identity, merging, verification and
  locating — so the debugging loop the screen exists for has no surface.
- **The control bar mixes four unrelated things** in one wrapping flex row: a
  live status readout, a permission checkbox, N slot inputs, and Run.
- **The plan is seven stacked sections.** Brittleness, the cut and the remainder
  each print a `shortId(edgeId)` and expect the reader to correlate it against
  the step list by eye. Arm sits at the bottom, past all of it.

### Two defects found while grounding this design

Both are pre-existing and both are fixed here.

**`segment-done.failure.step` is off by one in the rendered message.** The index
comes from `execute.ts:133` and is an offset into the *library's* `plan.steps`.
`PlanDTO.steps` prepends a handoff step (`plan-view.ts:304`), so the DTO array is
one longer whenever a handoff exists — which is the normal case, since nearly
every node carries an `app` predicate. `ReplayScreen.tsx:33` renders
`step ${failure.step + 1}` with no correction. The service already computes
`handoffOffsets` and already applies it to its *other* message
(`replay-service.ts:484`); the event itself is unadjusted.

**`telemetry` carries nothing a plan does not already carry.** `execute.ts:117`
pushes `step.resolution` verbatim — the *planned* layer and confidence, echoed
back. There is no measured-at-execution resolution anywhere in the system. Any UI
presenting it as "what actually happened" would be inventing a distinction. The
run log below therefore reports which steps *ran*, which is real, and does not
report a resolution the executor never measured.

## The shape: two modes, not a split

```
                    ┌─────────────────────────────┐
   no plan  ───────▶│  BROWSE     graph + sheet   │
                    └──────────────┬──────────────┘
                          Run to here │
                    ┌──────────────▼──────────────┐
   plan exists ────▶│  REVIEW   route + run log   │
                    └─────────────────────────────┘
                          ⟵ graph  /  run ends
```

`.replay__stage` becomes a single slot holding one component. `PlanReview`'s
`plan === null` branch is deleted rather than hidden: the empty panel has no
content of its own, and its one real payload — the locating diagnosis — moves to
the bottom sheet where the rest of the graph's detail lives.

The status chip (`● here: …`) persists across both modes. It reports live state,
not mode state, and it is the only element that does.

The base mode is derived, not stored: `plan !== null || runLog.length > 0`. A run
that has stopped keeps its log on screen, so review mode persists past the last
segment rather than snapping back and discarding the outcome.

**`⟵ graph` is a peek, not a cancel.** Looking at the graph while deciding
whether to arm is the exact loop this screen exists for, so the strip's back
affordance is available even while a segment awaits approval — it sets one
explicit `peeking` flag and posts nothing. Browse mode then carries a persistent
bar, `Segment N awaiting approval · return to review`, so an unanswered
authorization can never be lost by navigating away from it. Returning clears the
flag; `Cancel` in the gate bar is still the only thing that declines.

Once a run has stopped, `⟵ graph` clears the log and leaves review mode for real.

## Browse mode

### Layout: rank is the row

The transpose of today's placement — `y = rank * (CARD_H + GAP_Y)`,
`x = order * (CARD_W + GAP_X)` — plus one pass that today's layout lacks.

**Order each rank by the mean x of its already-placed parents.** A single
top-down barycenter sweep, ties broken by graph order so the result is stable
across the location poll's re-renders. This is the difference between a legible
chain and crossings that exist only because of array order. It is ~15 lines and
needs no layout library, for the same reason the original spec gave: a layered
layout for tens of nodes is not `@vidstack/react`.

Determinism matters more than it looks. `LocationDTO` arrives on a poll and
re-renders the canvas; a layout that reorders on equal barycenters would make the
graph twitch continuously.

Back edges bow **sideways into the margin**, not downward through the cards they
pass — the vertical equivalent of today's `bow`. A loop is a real feature of a
merged graph and must stay readable as one.

```
        ┌──────────┐
        │   n1     │  entry
        └────┬─────┘
        ┌────┴─────┐
        │   n2     │  ◀ you are here
        └─┬──────┬─┘
   ┌──────┴─┐  ┌─┴──────┐        ╭─╮  back edge bows
   │  n3    │  │  n4    │────────╯ │  out to the margin
   └────────┘  └───┬────┘          │
              ┌────┴─────┐ ◀───────╯
              │   n7     │  goal
              └──────────┘
```

### The canvas keeps pan and zoom; it stops being the only way to navigate

Free pan/zoom is retained — a merged graph is genuinely graph-shaped, and a
scroll-only page cannot show an overview. What changes is the defaults:

- **Fit to viewport on first load**, replacing `pan {24,24}, zoom 1`.
- A control cluster pinned bottom-right: `⊕ ⊖ · fit · ◎ me`. `◎ me` animates the
  canvas to the located node and is disabled when nothing is located.
- Double-click-to-reset stays, but is no longer the only recovery from being lost.

The existing `DRAG_THRESHOLD` pointer-capture discipline is unchanged and must
stay: capture on pointerdown redirects every later event to the canvas, the node
button never sees its own pointerup, no click is synthesized, and nothing is
selectable. That was paid for once.

### The bottom sheet

One sheet, three possible contents, in strict precedence:

1. **selected node** — always wins
2. **locating diagnosis** — when nothing located and no node is selected
3. **closed**

The diagnosis is re-openable from the status chip, so selecting a node never
destroys it. `Esc`, `╳`, or a click on empty canvas closes — the last of these
works because the existing `DRAG_THRESHOLD` already separates a click from a pan,
so a deselecting click cannot fire at the end of a drag.

Fit-to-viewport runs once per mount, not on every graph change: re-fitting under
the location poll would move the canvas out from under the reader.

The sheet rises from the bottom rather than sitting beside the canvas, because a
downward flow is tall and narrow: horizontal room is what the graph now has to
spare, and taking it back would undo the transpose.

```
├──────────────────────────────────────────────────────────┤
│ n4  TextEdit — Untitled   2 obs  ⚠ verifies but never   ╳│
│                                    locates              │
│ ┌────────────┐  PREDICATES              RUN             │
│ │            │   app(TextEdit)          body [hello   ] │
│ │  keyframe  │   ax_exists(TextArea      ☐ allow        │
│ │            │     #First Text View)       launching    │
│ └────────────┘   ax_focused(TextArea)   [ Run to here ] │
│  3 in · 2 out                                           │
└──────────────────────────────────────────────────────────┘
```

Three things it puts on screen that exist nowhere today:

**The node's predicates.** Identity is what merges, verifies and locates. The
task-derived identity work measured max predicates per node dropping 34 → 4 and
mean to 2.0 — a change entirely about this data, invisible in the app that
consumes it.

**"verifies but never locates"**, from `isLocatable`. A node whose identity is
only `app` is satisfied by every observation in that application, so it can never
answer "which state is this?". Measured: without a URL only 3 of 8 nodes were
locatable. Picking such a node as a goal is not wrong — `run.ts` prefers the
`expected` node and carries a run through them — but choosing one *as a goal*
cannot work, and the screen should say so before the click rather than after the
run stops.

**Slots and allow-launch**, moved out of the top bar. They are run parameters, so
they belong with Run, and they render only when `graph.slots` is non-empty
instead of occupying the bar unconditionally.

### Selection is the goal

There is no separate `goalId`. The selected node is the goal; "Run to here" is
the only place a run starts. One piece of state instead of two that can disagree.

### The locating diagnosis

Same content as today's `review__nearest`, in the sheet:

```
├──────────────────────────────────────────────────────────┤
│ WHY NOTHING MATCHED                                     ╳│
│ Locating is a subset check — every predicate a state     │
│ claims must hold.                                        │
│                                                          │
│ n2  TextEdit                                       4/5   │
│   ✗ ax_exists(label="Stop recording")                    │
│ n4  Google Chrome                                  2/5   │
│   ✗ url(prefix=github.com/…)   ✗ ax_focused(…)           │
└──────────────────────────────────────────────────────────┘
```

Unchanged in substance — it is already computed with `verifyNode`, the same
function `locateNode` calls, so the diagnosis cannot disagree with the decision.
Only its home moves.

## Review mode

### Segment outcomes arrive at the end, and are inferable before then

`report()` (`replay-service.ts:453`) emits `segment-done` for **every** segment
at once, after the whole run returns. `executeRun` has no per-segment callback —
only `arm` — and reporting one segment would discard the telemetry of every
earlier one, which is why it is written that way.

The observable order is therefore:

```
segment-planned(1) → armed → [window hidden, executing] →
segment-planned(2) → armed → [window hidden, executing] →
segment-done(1), segment-done(2), stopped
```

While segment 2 is being reviewed, segment 1's outcome has not been reported.
It is nonetheless **sound to infer**: `executeRun` plans segment N+1 only if
segment N completed. The run log derives:

| state | derived from |
|---|---|
| `awaiting approval` | latest `segment-planned`, no `armed` yet |
| `running` | `armed` received, no successor planned |
| `completed` | a later segment was planned, **or** `segment-done.completed` |
| `failed` | `segment-done.completed === false` |

The final burst confirms the inference and supplies the failure detail. No new
IPC event is added for this.

### No live per-step progress

`arm` calls `app.hide()` — the handoff is what arming means, and it resigns
DeskRAG's active status before any event is posted. The window is hidden for the
entire duration of execution. Per-step progress events would add library and
service surface to render a view that, by construction, nobody is looking at.

What matters is the post-mortem when the window returns, and that is what the run
log is.

### The layout

```
┌────────────────────────────────────────────────────────┐
│ ● here: Google Chrome — github.com/guyettinger          │
├────────────────────────────────────────────────────────┤
│ ⟵ graph   [n1]──[n2]──[n4]══▶[n7]                       │
├────────────────────────────────────────────────────────┤
│ ▸ ✓ SEGMENT 1   TextEdit — Untitled → Chrome   4 steps  │░
│                                                        │█
│ ▾   SEGMENT 2   Chrome → Chrome                        │█
│                                                        │█
│   ↺   hide DeskRAG, return focus to Google Chrome      │█
│   1   click     Button "Sign in"         ident   1.00  │░
│   2   type      ⟨query⟩ "deskrag"                      │░
│   3   click     Dock icon            ⚠ point     0.40  │░
│         mostly coordinates — clicks whatever has       │░
│         moved into that spot                           │░
│                                                        │░
│   ══ resolution stopped · resumes at n7 after ═══════  │░
│      re-observing            ▸ ident — no match        │░
│                                ▸ label — 2 candidates  │░
│                                                        │░
│   ·   click     recorded: Button "Go"      unresolved  │░
│   ·   type      recorded: ⟨body⟩           unresolved  │░
├────────────────────────────────────────────────────────┤
│ ⚠ 1 edge is mostly coordinates                          │
│ ☐ arm anyway            [Cancel]   [ Arm segment 2 ]    │
└────────────────────────────────────────────────────────┘
```

### Four sections become annotations on the list

They are all per-edge facts, and steps carry `edgeId`. Rendering them separately
is what forces the reader to correlate ids by hand.

- **Brittleness** marks the steps of the edge it describes, with the consequence
  in words rather than a bare percentage. The count still summarizes in the gate
  bar, because the override is a decision about the plan as a whole.
- **The cut** is the rule drawn across the list, carrying `resumeAt` and its
  rung-by-rung `attempts` as expandable detail. The attempts are *why* resolution
  stopped, so they belong at the stop.
- **The remainder** continues below the rule, dimmed.
- **Blockers** and the override pin to the gate bar, reachable without scrolling
  past everything else.

### The remainder is bulleted, not numbered

Remainder items get a `·`, not a continuing step number.

`buildPlan` cuts at an edge boundary and the rest is "action kinds, recorded
descriptors, recorded points, explicitly not targets". Numbering them `5, 6`
alongside authorized steps asserts they are what will run. They are not: the run
re-observes at `resumeAt` and re-plans. A number is a claim of authorization, and
this list is the one place in the app where that distinction is the entire point.

### A finished segment's steps

Marked from `completed` + `failure.step` alone:

- steps before the failure index — ran
- the failure index — `✗`, with the reason (a boundary verification names every
  predicate that did not hold, and that string is the whole diagnosis)
- after it — not attempted

It does **not** print a per-step "actual" layer. `telemetry` is the planned
resolution echoed back; presenting it as measured would be a claim the executor
never makes.

### The route strip

The thread between modes: the node chain for the current segment, with the
segment's own edge highlighted, and `⟵ graph` returning to browse with the
canvas where it was left.

The chain is derived in the renderer by walking `graph.edges` from `plan.from`
along the steps' `edgeId`s. `PlanDTO` needs no new field.

## Contract changes

Three, all small.

### 1. `GraphNodeDTO` gains `predicates` and `locatable`

```ts
/** Human-readable, via `describePredicate`. The node's whole identity. */
predicates: string[];
/**
 * False when the node's identity cannot answer "which state is this?" — an
 * identity of only `app` is satisfied by every observation in that
 * application. Such a node VERIFIES perfectly and LOCATES never, so it cannot
 * usefully be chosen as a goal.
 */
locatable: boolean;
```

Both computed in `toGraphDTO`. `describePredicate` already exists and is already
exported from `plan-view.ts`.

### 2. `isLocatable` is added to the barrel

It lives in `src/trace/identity-set.ts` — pure, a leaf, already in the barrel's
module — and is currently reachable only from inside `src/replay/locate.ts`.
Exporting it adds no coupling and no native load.

### 3. `segment-done.failure.step` is converted to DTO space

Applied in `report()` using the `handoffOffsets` the service already keeps, and
documented on the type in `shared/types.ts`:

```ts
/**
 * Index into the rendered `PlanDTO.steps`, NOT into the library's plan. The
 * DTO prepends a handoff step whenever the `from` node carries an `app`
 * predicate, which is nearly always, so the raw index is one short.
 */
failure?: { step: number; reason: string };
```

`telemetry` stays on the event unchanged. It is not rendered as a measurement.

## Files

| file | change |
|---|---|
| `app/src/renderer/src/screens/graph-layout.ts` | **new**, pure — rank→row, barycenter ordering, edge path geometry |
| `app/src/renderer/src/screens/GraphCanvas.tsx` | consumes it; fit-on-load, zoom/fit/`◎ me`, selection |
| `app/src/renderer/src/screens/NodeSheet.tsx` | **new** — inspector · diagnosis · run setup |
| `app/src/renderer/src/screens/RouteStrip.tsx` | **new** |
| `app/src/renderer/src/screens/RunLog.tsx` | **new** — accumulating segments + gate bar; absorbs `PlanReview.tsx` |
| `app/src/renderer/src/screens/PlanSegment.tsx` | **new** — one segment's narrative |
| `app/src/renderer/src/screens/ReplayScreen.tsx` | mode derivation + event→run-log reduction; shrinks |
| `app/src/main/plan-view.ts` | `predicates`, `locatable` in `toGraphDTO` |
| `app/src/main/replay-service.ts` | step-index offset in `report()` |
| `app/src/shared/types.ts` | the two DTO fields + the `failure.step` doc |
| `src/index.ts` | export `isLocatable` |
| `app/src/renderer/src/styles.css` | the replay block, rewritten |

`PlanReview.tsx` is removed; `stopMessage` moves with the run log.

## Testing

### Root suite

`graph-layout.ts` is pure — no React, no DOM — so it is tested in the **root**
suite through the `@shared/types` and `deskrag` path mappings that
`tsconfig.json` and `vitest.config.ts` already carry for `plan-view.ts`. Same
trick, same reason: it is the last thing between recorded data and what a human
reads before authorizing a click.

Cases:

- rank becomes the row, order becomes the column
- barycenter ordering reduces crossings on a known branch-and-merge graph
- **identical input yields identical output across repeated calls** — the
  location poll re-renders continuously, and an unstable layout twitches
- back edges are detected and routed to the margin
- an orphan node (rank 0, unreachable from entry) is placed, not dropped

`plan-view.ts`: `predicates` renders through `describePredicate`; `locatable` is
false for an `app`-only node and true for one carrying more.

`replay-service.ts`: a plan **with** a handoff reports the failing step at the
index the rendered list uses. The current code fails this test, which is the
point of writing it.

### Gates

`npm run typecheck`, `npm test`, `npm --prefix app run typecheck`. The library
changes (`src/index.ts`) mean `npm run build` before launching the app.

### Against a real recording

The rule this repo has paid for twice: synthetic fixtures agree with whatever the
code assumes. The known-hard cases are already on disk in the accreted
`DEFAULT_GRAPH_ID` graph and must be the acceptance check:

- **colliding labels** — two Chrome nodes both labelled "Google Chrome", which is
  what the id chip exists to separate
- **an over-merged bare-`app` node** (`observations = 6`) — must show as not
  locatable
- **back edges from merges** — must route to the margin, not through cards
- **the DeskRAG hub nodes** sessions route through, whose predicates include
  `ax_exists(label="Stop recording")` — the node inspector should make it obvious
  why such a node cannot verify outside recording mode

## Out of scope

- **Any change to `src/replay/` or `src/trace/` behavior.** The only library edit
  is one barrel export.
- **Per-step live execution events.** Rejected above: the window is hidden.
- **Editing the graph from this screen** — deleting a node, splitting a wrong
  merge, re-recording an edge. Real needs, and a separate spec.
- **The AI-in-the-loop intervention surface.** `GraphNodeDTO.intervene` is
  carried and unused; `parseInterventionResponse` is a security boundary with no
  runtime. Subsystem #4 remains unbuilt.
- **A layout library.** The barycenter sweep is ~15 lines.

## Rejected alternatives

**Keeping the split and merely hiding the empty column.** The graph would still
be sized for a column that reappears, and the mode boundary — browse versus
review — would stay implicit. The split is what made both halves cramped.

**A scroll-only page instead of a canvas.** A downward flow is close to a
document, and dropping pan/zoom would remove real fiddliness. But a merged graph
is genuinely graph-shaped, with branches and loops, and there is no overview
without zoom.

**Diagnosing locating failures by badging nodes on the graph.** Attractive —
the near-misses *are* nodes. But `held/total` on a card competes with the
keyframe, and the unheld predicates are long strings that have nowhere to go on a
180px card. The sheet reads them as a block.

**A right-side inspector instead of a bottom sheet.** It would take back exactly
the horizontal room the transpose freed.

**Per-step "planned vs actual" resolution.** There is no actual;
`execute.ts:117` echoes the plan. Rendering it as a measurement would invent a
distinction the system does not make.
