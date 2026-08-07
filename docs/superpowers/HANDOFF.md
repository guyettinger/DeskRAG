# Handoff — the executor's loop closed (2026-08-01)

> **HISTORICAL — superseded. Do not read this as current state.**
>
> This is a point-in-time snapshot from 2026-08-01, kept beside the specs as a
> record of what was known then. Several of its headline claims are now wrong:
> the test count has since gone 684 → 988; **progressive resolution shipped**
> (the "one thing I would do next"); **multi-step arming against a real desktop
> happened on 2026-08-02**; and item 7, "app wiring", was *reversed* — the app
> deliberately does not reach the executor, and its plan-review screen was
> removed on 2026-08-06 in favor of Flows.
>
> For current open work, read **[ROADMAP.md](../../ROADMAP.md)**. For current
> invariants, read **[CLAUDE.md](../../CLAUDE.md)**.

`main` is at `35890c8`. Working tree clean, **684 tests passing**, all three
gates green (`npm run typecheck`, `npm test`, `npm --prefix app run typecheck`).

Read first: `CLAUDE.md` — section **"4. The executor (`src/replay/`)"** carries
every invariant below in condensed form. Then, only if you need the reasoning:
`docs/superpowers/specs/2026-07-31-executor-design.md` and
`docs/superpowers/specs/2026-08-01-app-activation-repair-design.md`.

## Where the four subsystems stand

| # | Subsystem | State |
| --- | --- | --- |
| 1 | Replay-fidelity capture | shipped |
| 2 | Trace IR (`src/trace/`) | shipped, proven on real recordings |
| 3 | The executor (`src/replay/`) | shipped; **loop closed once, narrowly** |
| 4 | AI-in-the-loop | wire contract fixed in the IR spec; runtime unbuilt |

## What "the loop closed" does and does not mean

On 2026-07-31 a recorded node verified against the live desktop, its anchor
resolved at `identifier@1.00` against a window that had moved since recording,
the plan armed with no override, and the posted CGEvent had its intended effect
(a triple-click selected the paragraph, confirmed visually).

**That run was one click, in one app, with the target app already frontmost.**

- `wait`, `type` and `chord` have still only executed against `FakeActuator`.
- **Cross-app plans still cannot arm** — see the next section.
- Every ladder figure in the executor spec is a **capture-time** measurement, and
  the `point`-only shares among them are flagged as an upper bound that cannot be
  recomputed (the graphs they came from were deleted).

## The one thing I would do next

**Progressive anchor resolution.** It is the single obstacle left between the
executor and a multi-step replay, and it is a genuine design decision rather
than a bug.

`buildPlan` resolves every anchor up front against the *current* state. Anchors
belonging to later steps expect states that do not exist yet — most obviously in
an app that is not frontmost — so they cannot resolve, their edges measure 0%,
and the brittleness gate refuses. This is **not** cross-app specific; cross-app
is just where it becomes undeniable.

Resolving each anchor when execution reaches it fixes that, but weakens the
dry-run promise from "the plan shows where every action will land" to "…where
the next action will land" — which is the design's principal safety property.
That trade needs its own spec, and app activation (PR #26) deliberately did not
take it.

## Open work, roughly in order

1. **Progressive resolution** (above).
2. **Multi-step arming against a real desktop.** `wait`/`type`/`chord` have never
   posted a real event.
3. **Deleting recordings orphans the graph.** `deleteSession` does not touch the
   `trace_*` tables, so clearing every recording leaves nodes and edges behind
   referencing dead sessions. Not a missing cascade: merging is lossy, so
   per-session retraction from a graph is not well-defined. Needs a product
   decision (drop the graph with the last session / an explicit reset / mark it
   stale).
4. **A real-sidecar AX fixture in the test corpus.** Every AX fixture is
   hand-written; that is why the role-prefix bug reached production.
5. **Region coverage for the visual rung.** All region rows are `source: "ax"` —
   grid tiles score 0.5 against AX's 2–5 and never survive the 14-region budget
   in `fuse.ts`. How much it matters is app-specific (5–8% of targets in
   TextEdit, 40% in Chrome).
6. **Subsystem #4, AI-in-the-loop.** `parseInterventionResponse` is already a
   tested security boundary.
7. **App wiring.** Nothing surfaces plans or replay in DeskRAGApp.

## Things that cost a day, so they are worth carrying

**Six defects were found in one day, and the test suite caught none of them.**
It grew 565 → 684 tests across the same day. Every defect lived at a seam where
synthetic fixtures agree with whatever the code assumes:

| Defect | Found by |
| --- | --- |
| AX role prefix — no recording ever produced an AX predicate | inspecting a real graph |
| Boundary nodes carried the previous app's tree | reading *which* predicates were unmet, not counting them |
| `app`/`window` unobservable at replay | isolating state-mismatch from a real gap |
| Empty AX attribute not treated as absent | index-by-index tree diff |
| Geometry vetoed moved windows | probing `locate` when every target said `point` |
| `app` predicate had no repair path | inspecting what the graph already encoded |

**Diagnose by looking at values, not counts.** "2 of 19 predicates unmet" said
nothing; `app(app="WebStorm")` sitting beside `label="typeface"` said everything.

**Treat any measurement from one application as provisional.** The anchor ladder
was falsified twice, each time by recording in one more app. It is now
trust-ordered with `pathCeiling(depth)`, whose constants are fitted to **9
anchors**. The *shape* is far better supported than any constant.

**Rebuild the sidecars after any checkout.** `native/ax-dump` and
`native/ax-exec` are gitignored. A stale `ax-dump` silently cost every recording
its typed text for two days; a stale `ax-exec` would silently drop the `app`
predicate and put node identification back to impossible. `npm run build:ax`.

## Current data state

The dev store (`~/Library/Application Support/deskrag-app/DeskRAG/`) holds **one
session** recorded 2026-07-31 with every fix in place: 5 nodes, 7 edges, 1 slot,
7 boundary stamps, 0 incoherent nodes. It is the only graph ever built that is
trustworthy end to end. Earlier graphs were deleted; they cannot be repaired by
re-lifting because boundary stamps were never captured.
