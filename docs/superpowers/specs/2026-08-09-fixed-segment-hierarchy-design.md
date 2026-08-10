# Fixed segment hierarchy — Action / Task / Process / Session purpose

Date: 2026-08-09
Status: design, approved for planning

**Amends** `2026-08-09-compositional-segment-hierarchy-design.md`, which chose
"recursive until one root". That decision is reversed here, on evidence.

## Why the recursion is being replaced

The compositional hierarchy shipped and works: actions compose upward, meaning
survives a fallback, and the Library shows a session's purpose. But the levels
it produces differ in SIZE, not in KIND.

Measured across five real recordings of one task, re-composed on current code —
60 composed parents:

| | |
| --- | --- |
| single-child parents | **21 of 60 (35%)** |
| …whose name duplicates the child's | **11** |
| mean fan-out, `level:1` | 5.1 |
| mean fan-out, `level:2` | 2.1 |
| **mean fan-out, `level:3`** | **1.6** |
| depth per recording | 4, 3, 4, 4, 4 |

**Fan-out collapses to 1.6 by level 3.** A level that groups 1.6 things is not
composing anything — it is a chain. And a third of all parents hold exactly one
child, half of those repeating that child's name verbatim, which reads on the
rail as `Start recording session` stacked over `Start recording session`.

The cause is structural: **every level asks the same question.**
`COMPOSE_SYSTEM` says "group these into larger ones" whether the children are
actions or level-3 nodes. So the recursion produces one question at N sizes —
which is uncomfortably close to the defect the original design set out to fix,
where `action`, `task` and `caption` were one signal at three time windows.

The arithmetic makes it inevitable. Around 30 actions compose 30 → 6 → 3 → 2 → 1.
Above level 1 there is not enough left to group, so levels 2 and 3 exist to walk
the count down to one root, not because they mean anything.

**Level 1 is NOT the problem and is not being changed.** It is consistently good
across all five recordings — six or seven tasks each, semantically parallel, with
the calculator work as one 14–19 action task every time:

```
7M7C86  navigate → record screen → Calculate simple addition (15a) → Copy text → Edit document → Start recording
SA78MQ  navigate → record screen → Performing basic calculator arithmetic (18a) → Copying the result → Edit document → Begin recording
AK37HB  Navigate to Electron → Start recording → Start calculator → Document arithmetic sequence (16a) → Document typing → Initiate recording
```

## Decisions taken

| Decision | Choice |
| --- | --- |
| Depth | **Exactly three composed levels**: Task, Process, Session purpose. Never a fourth. |
| What Process IS | **A phase of work** — tasks serving one outcome (setting up / doing it / recording it). Semantic, model-judged. |
| Level admission | A level exists only if **≥1 node holds ≥2 children AND the level has fewer nodes than the one below**. Otherwise it is never created and the level above adopts its children. |
| Single-child nodes | **Elided** — the grandparent adopts the child directly, so a `segment_tree` edge may span two levels. |
| Process fallback | **Model-only.** No structural Process. |
| Implementation | One bounded loop over a fixed LEVELS table, keeping the measured machinery. |

## 1. The level table

One table in `src/represent/compose/levels.ts` replaces the
`while (children.length > 1)` condition:

| granularity | asks | admission |
| --- | --- | --- |
| `level:1` **Task** | "Group consecutive actions into the smallest run you could name as a verb and an object." | ≥1 node with ≥2 children, and fewer nodes than below |
| `level:2` **Process** | "Group tasks into PHASES — stretches serving one outcome, such as setting up, doing the work, recording the result." | same, **and** a model produced it |
| `session` **Session purpose** | "Name what this whole recording was for." (`NAME_SYSTEM`, one call) | always, given ≥1 child |

**A level that fails admission is SKIPPED, and the level above adopts its
children.** Never created-and-hidden. If six tasks form one phase there is no
`level:2` row at all and `session` points straight at the tasks. On 25–31s
recordings this is expected to be COMMON, so it is the normal path, not an error
branch.

**A node that would hold exactly one child is ELIDED** — its grandparent adopts
the child. The tree therefore stops being level-uniform. `getDescendantLeaves`
already walks to leaves, so Tier-2 scoping is unaffected; `collapseAncestors`
walks children, so it is unaffected too.

**The ROOT is exempt from elision.** A recording whose whole span is one phase
still gets a `session` row over that single child — the root is the session's
purpose and must exist for every recording, or the Library has nothing to show
and `nameRoute` has no top to walk to. It is the one place a single-child node
is correct, because it answers a different question from its child rather than
restating it (`NAME_SYSTEM`, not a grouping call).

**`level:1` can itself fail admission**, and the rule is the same: no Task rows,
and `session` adopts the ACTIONS directly. Unlike Process, `task` is not
model-only — a declined or malformed reply falls back to `structuralRanges`,
which always halves and so always qualifies once there are ≥2 children. The
reachable case is a BOOKMARK barring every pair, so every block holds exactly
one child and the level composes nothing (plus the trivial case of a frontier
smaller than 2) — not a model that quietly declined to group.

**The root keeps its own call.** Unchanged: asking a model to SPLIT a two-item
list returns two groups every time (3 of 3 trials), which cannot shrink and is
correctly rejected, so naming is a separate question.

**Deleted:** `MAX_DEPTH`, the strict-shrinkage guard, and the
wrap-everything-into-one-root escape. All three existed to make an unbounded
recursion terminate. A table of three cannot run away.

## 2. Inside the composer

`composeLevels` becomes `composeLadder`: the same helpers, a bounded loop.

**`ComposeContext` carries one semantic field instead of two mechanical ones.**
Today it is `{ level: number, single?: boolean }` and the adapter picks a prompt
from `single`, which does not extend to three distinct prompts:

```ts
export interface ComposeContext {
  /** WHICH question this call asks — the adapter maps it to a system prompt. */
  kind: "task" | "process" | "session";
}
```

Prompt text stays in `compose/prompt.ts` (`TASK_SYSTEM`, `PROCESS_SYSTEM`,
`NAME_SYSTEM`), so the provider interface carries meaning rather than wording and
a future adapter can phrase each kind however its model prefers.

**Unchanged, deliberately — each cost a measurement:** `splitIntoBlocks` at cap
24, `validatePartition`, wholesale rejection, the CUT-POINT contract, the
compositional rollup above level 1, `think: false`, and reading
`message.thinking` as well as `message.content`.

**Process is model-only.** The structural fallback halves, which is sensible for
Task — adjacent same-app actions do belong together — and meaningless for
Process, where it yields pairs-by-position labelled as phases. Without a model
the hierarchy is Action → Task → Session, which is still complete. This narrows
the earlier "the tree always exists" rule to the levels where structure is a real
signal; the tree is never absent, only flatter.

## 3. Downstream

**Storage: no change.** Still `segment` rows keyed `action` | `level:1` |
`level:2` | `session`, with `segment_tree` and `segment_summary` as they are. An
elided node means an edge spans two levels, which no schema can notice.

**The rail.** `levelTitle` loses its generic branch — only `level:1` → *task* and
`level:2` → *process* exist, so `` `level ${n}` `` becomes unreachable and is
removed. `ComposeRepresenter` already deletes every non-action segment before
composing, so a re-index clears stale `level:3`/`level:4` rows.

A recording with no Process renders the lane **empty with an `emptyReason`** —
"no distinct phases in this recording" — rather than omitting it. That follows
the rail's existing rule that absence is the payload: a MISSING lane says "this
build does not know about processes", an EMPTY one says "this recording did not
have any". The rail distinguishes those everywhere else (`emptyReason`, and
`null` in a density lane meaning no coverage).

**`nameRoute` needs no change and gets more deterministic.** It walks up from
level 1 taking the lowest level covering the majority of a walk; with two
composed levels rather than four, the level it lands on varies less. The
50%-threshold sensitivity remains — measured level-1 coverage was 40/63/44/63% —
but it is now a choice between two levels.

**Retrieval: unchanged, with slightly fewer segments.** Composed nodes drop from
12–15 to roughly 8–10 per recording. The one-dense-lane asymmetry documented in
`rrf.ts` is untouched: it is a property of what a composed node IS, not of how
many levels exist.

## 4. Testing

**Root suite, pure and deterministic**, with a fake provider:

- a level with no node holding ≥2 children is SKIPPED, and the level above
  adopts its children;
- a level that does not shrink is skipped;
- a single-child node is ELIDED — the grandparent adopts it, and the resulting
  edge spans two levels;
- never more than three composed levels, whatever the input size;
- Process skipped → `session`'s children are `level:1` rows;
- **no summarizer → Action / Task / Session, and no `level:2` row at all**;
- translation invariance survives.

## 5. Validation against the real recordings

Measured by re-composing the same five recordings on the very database the
before-numbers came from:

| | before | after |
| --- | --- | --- |
| composed parents | 60 | 37 |
| single-child parents | 21 of 60 (35%) | **0 of 37** |
| single-child ROOTS (exempt by design) | — | 0 of 5 |
| …duplicating the child's name | 11 | **0** |
| mean fan-out, `level:1` | 5.1 | 5.92 |
| mean fan-out, `level:2` | 2.1 | 3.0 |
| mean fan-out, `level:3` | 1.6 | *level:3 no longer exists* |
| mean fan-out, `session` | — | 4.4 |
| depth per recording | 4,3,4,4,4 | 3,3,2,2,3 |
| recordings where Process qualifies | n/a | **3 of 5** |
| `segment_summary.source` | — | 32 llm / 5 template |

Process qualifies on AK37HB (25.0s), SA78MQ (31.3s) and 7M7C86 (29.2s); not on
VAGCKQ (26.1s) or 60Q8BS (30.0s). This document had predicted Process would
often fail admission on ~30s recordings and treated that as a finding about the
data; **3 of 5 is better than predicted**, and the reading stands for the
other two — a recording this short may genuinely have one phase.

**The zero-duplication figure needs one qualification.** A broader query — any
parent SHARING a summary string with a child, not only a parent whose ONLY
child shares it — finds exactly one: a `level:2` "record screen" holding TWO
children, one of them a `level:1` also named "record screen". That parent
genuinely composes two things and merely reuses one child's name; it is not
the single-child-chain defect this table measures, and the count above is
correctly zero for what it measures. Driving the app confirmed the rail
renders `SESSION · PROCESS · TASK · ACTION` top to bottom, a recording with no
Process shows that lane empty with its `emptyReason` rather than vanishing,
and nothing truncates.

Re-checked afterwards but NOT gated on:

- **Root-name convergence.** Still blocked by `nameRoute` voting on exact string
  equality, so four semantically-identical names count as four votes. No movement
  expected.
- **The RRF sweep.** The corpus shrinks by roughly 30 composed segments, which is
  unlikely to move a k that has won four sweeps running.

## Build order

1. `compose/prompt.ts` — `TASK_SYSTEM`, `PROCESS_SYSTEM`, and `composePrompt(children, kind)` replacing `composePrompt(children, level, single)`.
2. `embed/summary.ts` — `ComposeContext.kind`; update the fake.
3. `embed/ollama-summary.ts` — map kind → system prompt.
4. `compose/levels.ts` — the LEVELS table, `composeLadder`, admission, elision.
5. `compose/compose-representer.ts` — drive the ladder; keep the root call.
6. `app/src/main/session-tracks.ts` — `levelTitle`, the empty PROCESS lane.
7. Re-compose all five recordings and fill in the validation table.
