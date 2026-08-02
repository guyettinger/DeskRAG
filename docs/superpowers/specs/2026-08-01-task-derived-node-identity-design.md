# Task-derived node identity

**Date:** 2026-08-01
**Status:** Design approved, pending spec review

## Context

A live armed replay failed on 2026-08-01 at boundary verification:

```
node …:n3 did not verify after edge …:e2:
  ax_exists(label="Create new…",role="PopUpButton")
  ax_exists(label="Copy head branch name to clipboard",role="Button")
  ax_exists(label="assign yourself",role="Button")
  ax_exists(label="Reviewers",role="PopUpButton")          … 18 in total
```

Those are the contents of one GitHub pull-request page. The node's identity had
absorbed the whole document, so it could only be re-entered with that exact PR
open. The executor was not at fault — it posted every action, brought Chrome
forward, then honestly reported it had not arrived where the plan claimed.

The obvious fix is a better stability filter. That is the wrong fix, because the
problem is not which predicates are filtered but **what the set is for**.

### The diagnosis: one set, two opposed jobs

`DEFAULT_MAX_AX_PREDICATES` was raised **32 → 64** for a recorded reason: at 32,
a GitHub pull request and a repository home truncated to identical sets and
**merged wrongly**. The codebase has therefore been pushed hard in both
directions by two failure modes that pull against each other:

- **Merging** asks *"is this a new state?"* → wants **more** predicates.
- **Locating and verifying** ask *"am I here again?"* → want **fewer**.

Raising the cap fixed merging and broke replay. Lowering it would do the reverse.
No cap value satisfies both, because a set sized for discrimination is being
reused for recognition.

### The second finding: the best descriptor is invisible to identity

`extractPredicates` keeps only elements with a **non-empty label** and emits
`ax_exists(role, label)`. So identity is built from labels alone — while
`AXIdentifier`, which `LAYER_CEILING` ranks as the **most** reliable descriptor
(1.0, against a label's 0.8), never reaches it.

Measured on the failing run: the TextEdit target is `TextArea #First Text View` —
an identifier and **no label**. The element the task actually operates on
contributes *nothing* to identity, while eighteen GitHub page labels contribute
everything. That is the defect stated exactly.

## Principle

> **A state is identified by what the task does next, described by the best
> descriptor available.**

Everything else that happens to be on screen is not identity. This needs no
heuristic to separate page content from application chrome — the distinction the
symptom seemed to demand — because content the recording never touched is
excluded by construction.

## The identity set

For each node:

| Source | Rule |
|---|---|
| `app` | always |
| **Outgoing** edges' anchors | each targeted element as `ax_exists`, keyed by `identifier` where the anchor has one, else `label`. Emitted only if the element was present in the observed tree. |
| `ax_focused` | when an outgoing edge contains `type` — typing depends on focus |
| **Incoming** edge's `wait until <p>` | `p`, when it holds in the observed tree |
| URL prefix | one predicate, when the focused window is a web view (below) |

Three details that decide implementations, so they are fixed here rather than
left to the reader:

- **Outgoing is a union.** A branching node contributes the anchors of *every*
  outgoing edge. Each is something the task can do from this state, so each
  element must exist here. A `drag` contributes both its `from` and `to` anchors.
- **Waits come from the INCOMING edge, not the outgoing one.** A
  `wait until app(Chrome)` asserts something about where the edge *arrives*, so
  it describes the destination node. Reading waits from the outgoing edge would
  attach the next state's assertion to this one — the same off-by-one that made
  boundary snapshots describe the previous application.
- **Both are filtered by the observation.** An anchor element or a waited-for
  predicate enters identity only if it actually held in the tree captured at that
  boundary. This is what drops a wait describing a transient mid-edge condition
  rather than the arrival, and it needs no separate rule.

Nothing else. `STABLE_ROLES`, `isVolatileLabel` and `DEFAULT_MAX_AX_PREDICATES`
remain in force for the *observation* side — they still decide what a live tree
yields — but they stop being the thing that defines a node.

**Effect on the failing graph.** `n3` sheds all 18 GitHub predicates. `n2` *gains*
`ax_exists(role=TextArea, identifier="First Text View")`, which it does not have
today.

### `ax_exists` gains identifier keying

Both sides must agree, so `extractPredicates` must also emit identifier-keyed
predicates for elements carrying an `AXIdentifier`, and `predicateKey` must
distinguish the two keyings. An element with both an identifier and a label
yields the identifier-keyed form only — one element must not become two
predicates, or every count and cap shifts.

An element with **neither** contributes nothing. That is honest: a path-only
anchor identifies a position, not a thing.

## One set for both jobs

Merging and locating use the same set. Two recordings of a task on different
documents become one node — the document-independence the `Window` exclusion
already reaches for.

**Rejected: splitting them** (merge on the full observed set, locate on the
touched subset). It manufactures a new failure: near-duplicate nodes that merging
kept apart both satisfy the small key, so `locateNode` finds two candidates and
declines. That trades a hard failure for an ambiguous one, and ambiguity also
refuses to act.

## Web scope: a URL-prefix predicate

Under the touched-set rule, two recordings collide only when the **same action**
is taken on **different pages** — clicking "Search or jump to…" on a PR page and
on a repository home. Different actions already yield different nodes. But that
collision is dangerous rather than benign: replay would proceed on the wrong page
because the control exists there too.

**The grain is the site, not the tab and not the page.** For a browser the real
application is the site: `app=Google Chrome` is too coarse, and full page content
is too specific. The repo already decided a task should work on **any document**;
the web analogue is that it should work on **any pull request**, so a full URL is
too strict for the same reason a filename was.

**Source.** `AXURL` on the focused window's `WebArea`, read by `ax-dump` and
carried through `PredicateContext`.

> **`AXURL` availability is UNVERIFIED in this repo.** It is believed present in
> Chromium and WebKit. Measuring it against real browsers is the first task, and
> if it is absent this option collapses and the question reopens — it does not
> silently fall back to a window title.

**Truncation** — two composable parts, both measured rather than assumed:

1. Drop path segments that look like identifiers (all-numeric, long hex, UUID).
2. Cap the remainder at a small number of segments.

`github.com/guyettinger/DeskRAG/pull/27` → `github.com/guyettinger/DeskRAG/pull`,
so different repositories are different states while different pull requests in
one repository merge. **The cap and the id-patterns take their defaults from
measuring several real sites**, not from a guess written here; a value chosen
against one site would be the anchor ladder's mistake repeated.

**Tagged `assertable`, with no override.** `app` is `achievable` because
activation is a real repair; there is no navigation mechanism, so a URL predicate
can only gate. Being on the wrong site therefore produces a clean, unoverridable
blocker — which is exactly the wrong-page replay this exists to prevent.
Non-browser applications emit no such predicate and are unaffected.

## Weak nodes verify but never locate

A node whose outgoing anchor is path-only contributes nothing, so its identity
collapses to `{app}` — measured: that is exactly `n3`, whose `e3` is
`click · recorded: path`.

`locateNode` already excludes zero-predicate nodes because an empty set is
vacuously satisfied by every observation. A one-predicate `{app}` node is nearly
as weak *for locating* and perfectly adequate *for verifying* — "did I reach
Chrome?" is a real question with a real answer. So:

- **Verification** accepts any node, however thin. It asks whether the claims
  made still hold.
- **Location** requires **at least one predicate that is not `app`**. It asks
  which of many states this is, and "you are in Chrome" cannot answer that.

That floor is stated as a rule rather than a tunable count. `app` is the one
predicate every node in an application shares, so it has zero discriminating
power *within* that application — which is precisely the question locating asks.
A count would invite tuning; this does not.

## Continuation: prefer the expected node

Verify-only alone converts one failure into another. `executeRun` **re-locates**
at the top of every turn, so a weak `n3` that now verifies would still fail the
next turn with `not-located`, and continuation past a cut stays broken.

`run.ts` already tracks `expected` (from `cut.resumeAt`) but uses it **only to
report drift**. The fix uses information the loop already has:

```
if expected is set and verifyNode(expected, observed).satisfied:
    use expected
else:
    locateNode(observed, nodes)      // cold start, or the world moved
```

From a cold start there is no prior and locating is the only option; mid-run
there is one. Drift reporting is unaffected — it already compares against
whatever was actually adopted.

This is a `src/replay/` change in a `src/trace/` spec deliberately: the weak-node
rule and the continuation fix are one decision, and shipping the first without
the second makes replay worse.

## Migration

**None.** `TraceNode.predicates` keeps its shape (`Predicate[]`), so no schema
change is needed — which matters, because the repo has no migration mechanism
(`CREATE TABLE IF NOT EXISTS` on every open). Existing graphs are corrected by
the `rebuildGraph` path that already exists and is already exposed in the app.

**Re-recording is required for the URL predicate only**, since `AXURL` was never
captured. Re-lifting an old session yields correct task-derived identity without
it; those nodes simply carry no web scope.

## Testing

- **`predicates.identity.test.ts`** — identifier-keyed `ax_exists`; an element
  with both keys yields one predicate; an element with neither yields none;
  roles in the unprefixed shape real data has.
- **`lift.identity.test.ts`** — identity is exactly `app` + touched anchors +
  focus-on-type + recorded waits; page content present in the observed tree but
  untouched by the task does **not** appear; a path-only anchor yields `{app}`.
- **`url-prefix.test.ts`** — the truncation rule, table-driven over the real URLs
  gathered in the measurement task, including the PR-merges/repo-differs case.
- **`locate.weak.test.ts`** — a `{app}` node verifies and is not a locate
  candidate.
- **`run.expected.test.ts`** — a satisfied `expected` is adopted without
  locating; an unsatisfied one falls back to locating; drift still reported.
- **Real-data validation, twice.** Re-lift the existing sessions and measure the
  before/after predicate counts and whether `n3` would now verify. Then record a
  fresh cross-app session and drive the full armed run, which is the only thing
  that can show continuation past a cut working.

## Out of scope

- **Navigation as a repair.** A URL predicate gates and never repairs; giving it
  a repair path means driving a browser's address bar, which is its own design.
- **Retuning `STABLE_ROLES`, `isVolatileLabel`, or the 64 cap.** They govern
  observation and stay as they are. This spec changes what identity is, not what
  a tree yields.
- **Visual identity.** `matchNode`'s phash layer is untouched; it corroborates
  and covers AX-blind applications, and neither role changes here.
- **The zero-predicate entry node.** `n0` still describes no state. It remains a
  lift-time defect worth its own look.
