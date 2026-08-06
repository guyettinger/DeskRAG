# Flows — the trace graph as an exploration surface

**Date:** 2026-08-06
**Status:** shipped
**Supersedes (as a UI):** the Replay screen from `2026-07-31-executor-design.md` and
`2026-08-01-progressive-anchor-resolution-design.md`. Both specs remain accurate about
the **library**, which is unchanged.

## Why

The Replay screen was built to review and arm plans: locate the live desktop, pathfind
to a goal node, review the steps, arm, execute. It closed the loop against a real
desktop three times, and never became reliable — the last armed run stopped at a
boundary verification, and continuation past a cut has still never run against a real
desktop.

Meanwhile the graph itself is the valuable artifact. It is the only place a pile of
recordings becomes a picture of what the user actually does. That picture had no
surface: the screen drew the graph in order to pick a goal from it.

So the screen becomes **Flows**, a read-only exploration surface, and the executor is
kept but unwired.

## What this is not

`src/replay/`, `native/ax-exec`, and every `test/replay.*` case are untouched. The
executor still resolves a graph against a live accessibility tree, still cuts a plan
where resolution stops working, still refuses to post from a plan nobody reviewed.
What changed is that **nothing in the app can reach it**: there is no plan DTO, no arm
channel, no location poller. The consequence worth stating plainly is that DeskRAGApp
no longer spawns `ax-exec` at all — previously a binary capable of clicking was alive
for as long as the Replay screen was open.

## The one new piece of data: provenance

**A node could not name the recording it came from.** `TraceNode` carried
`observations: number`; `mergeTrace` incremented that counter and discarded which
session produced it. So the graph could say a state had been seen nine times and could
not show you one of them — the artifact summarizing the recordings had no way back to
them.

`lift.ts` holds both facts at the moment it throws them away: a node **is** a boundary
and a boundary carries a `t_mono`; an edge spans `[start, end)`, the same span its
gestures were filtered from. Carrying them costs nothing at lift and is unrecoverable
afterwards.

```ts
export interface NodeSource { sessionId: string; tMono: number }
export interface EdgeSource { sessionId: string; tMonoStart: number; tMonoEnd: number }
```

Optional fields on `TraceNode` / `TraceEdge`, concatenated by `mergeTrace` beside each
`observations += 1` — that merge is the only place a second recording's evidence for a
shared state could be kept at all.

### `observations` is never derived from `sources`

They disagree in two legitimate directions, and both must stay visible:

- a graph lifted before this change has observations and **no sources at all**;
- deleting a recording removes its sources and **leaves the count it contributed**.

A reader that computes one from the other is wrong in both cases. The drawer states the
difference ("2 of 3 observations — 1 recording has been deleted"); the screen carries a
banner for the first.

### Persistence: two new tables, not two new columns

`trace_node_source` and `trace_edge_source`. The schema is `CREATE TABLE IF NOT EXISTS`
with no migration step, so an existing table's shape can never change — a new column
would never reach an existing install, while a new table is simply created empty. Same
precedent as `ax_snapshot_boundary`.

`session_id` is a foreign key that **cascades on purpose**: provenance exists to be
navigated back to, so evidence pointing at a deleted recording is a dead link rather
than a record.

That cascade forces one non-obvious rule in `putGraph`. An FK violation aborts the
whole transaction regardless of any `ON CONFLICT` clause, so a single source naming a
session deleted between lift and write would cost the entire graph. Sources are
therefore filtered against the live session set before insert — not silent loss, but
exactly the rule the cascade would have applied a moment later. The window is real: a
rebuild lifts every session in a loop and a delete can land inside it.

## Flows: what a route is, and the two definitions that failed

A route is keyed by **the sequence of states it passes through, named** — the
`labelNode` labels, with consecutive repeats and stateless nodes dropped.

That is not the first thing tried. Both stricter keys were implemented and **measured
against a real graph of 9 recordings, 17 nodes and 44 edges**:

| Key | Result |
|---|---|
| Ordered **edge-id** sequence | 9 routes, every one ×1 |
| Ordered **node-id** sequence, deduped | 9 routes, every one ×1 |
| **Label** sequence, deduped | **5 routes, one of them ×5** |

Five of those recordings were the same task — open Calculator, use it, come back. The
edge sequence split all five apart because they differed only in *how many* buttons were
pressed (4, 5, 6 and 8 steps).

The node-id failure is the more interesting one, and it is a consequence of the IR's own
design rather than a bug: **equivalent states across recordings do not merge into one
node.** Identity is task-derived, so a Calculator state whose outgoing edge targets a
different button is a genuinely different node and `matchNode` correctly declines to
merge it. Node identity therefore cannot express "the same place" across recordings at
all, and nothing keyed on it can group them.

The label is the right granularity because of what a label *is*: the application plus
its distinguishing hint — a sheet's name, a URL prefix, the focused element. That is
precisely the level at which a person says "I do this a lot".

A predicate-less node is dropped from the key: it is vacuously true of every desktop —
the UI says exactly that about such nodes — so it cannot help say which flow this is.
Leaving it in put a meaningless `n0 — no state` at the head of all nine measured routes.

### What loosening the key costs, and what it does not

It costs precision of highlight. Several distinct paths can share a route, so
`nodeIds`/`edgeIds` are the **union** of what its recordings walked: *"these five
recordings all did this, and here is everywhere they went."*

It does not cost honesty. Every route is still grouped from recordings that actually
happened and `count` counts real sessions. **A route is never a graph traversal** — a
merged graph composes paths no single recording ever walked, and enumerating those
would present routes the user has never performed as their common flows. A graph with
no provenance therefore yields **no routes**, and the screen says why.

## The screen

Three panes, one selection. The routes column asks *what do I do repeatedly*, the
canvas answers *where does that go*, the drawer answers *show me*. All three end at the
same place: a recording, at the moment the thing happened.

- **Wire weight** is `log2(observations)`, clamped. Sub-linear because the question is
  "is this path worn", not "by exactly how much" — linear width made one repeated task
  a black bar over everything crossing it.
- **Edges are selectable**, via a transparent 16px hit path under each wire with
  `pointer-events: stroke`. Never `fill`: a filled hit area makes the region *enclosed*
  by a back edge's bow clickable, which is most of the canvas.
- **The app filter dims, never hides.** Layout is computed from the whole graph, so a
  hidden node's space stays reserved and its wires end in mid-air.
- **Selecting a route frames it** — zoom and all. Centring on its first node keeps the
  fitted zoom, which on the real graph (nine nodes in one rank) pushed all but two
  cards out of the viewport: the route lit up correctly and could not be seen.
- **The canvas re-fits on resize**, which the screen it replaced could not do. Fitting
  once was forced by the 2s location poll re-rendering everything; with the poller gone
  the only things that change the viewport are the drawer opening (~40% of the height)
  and the window resizing, and holding the old framing through either is wrong. A
  `touched` flag stops it fighting a reader who has panned or zoomed.

## The deep link

`Flows → Library`, at a moment. `atSec` travels as **lane seconds** (a `t_mono`
offset) all the way down to `TrackRail`, which performs the seek through its existing
`seek()`. That function is the one place lane seconds are converted to media seconds —
the encoded video runs ~1% short of the span it covers — and there must go on being
only one. The seek waits on `mediaSec > 0` rather than sleeping, because a fragmented
MP4 reports `Infinity` until the provider adopts a real duration.

`App.tsx` gained the app's first cross-screen navigation payload; the Library clears it
once consumed, or picking a different recording would re-seek.

## Verified against real data

Rebuilt from the 9 real recordings in the dev data dir, through the app's own Library
button:

- **17 nodes / 44 edges; node sources 67 = observations 67; edge sources 58 = 58.**
  Every node and edge links back to real recordings.
- Merging preserves provenance across sessions: one node carries `observations = 10`
  from **9 distinct** sessions (one recording visited it twice).
- **58 of 58 node sources land on a moment where the focused app matches the app the
  node claims**, checked against each session's own `focus_change` stream. Zero edge
  spans fall outside their recording.
- Wire observation counts on the real graph are `[1, 2, 6, 9]` — the weighting has
  something to show.
- Driven end to end in the running app: clicking `00:00:03.673` on a TextEdit state
  landed in the Library at **0:03 / 0:38**, with the playhead exactly where the
  `TextEdit` span begins in the APPS lane.
- `pgrep -fl ax-exec` returns nothing at any point while the app runs.

## Removed

`main/replay-service.ts`, `RouteStrip.tsx`, `RunLog.tsx`, `PlanSegment.tsx`,
`run-log.ts`, `test/replay.run-log.test.ts`, the plan half of `plan-view.ts` (renamed
`graph-view.ts`), the seven `replay:*` IPC channels, and the plan/run/location DTOs.
All recoverable from git; none of it reachable from the app since the screen it served
no longer exists.
