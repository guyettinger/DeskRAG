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

## What re-lifting the real recordings measured (2026-08-01)

Read-only, against the two sessions already on disk. Nothing was armed.

| | predicate counts per node |
|---|---|
| **Before** (stored graph) | `0, 12, 16, 33, 34, 13, 2, 17` |
| **After** session `3PH1DM` | `0, 1, 3, 1, 1, 3, 2, 1` |
| **After** session `CXS7JS` | `0, 1, 1, 1, 4, 2, 2, 1` |

**The 18 GitHub predicates are gone.** The two Chrome nodes went from 33 and 34
predicates to **one each** — `app(Google Chrome)` — because the recording's only
action there was a point-only click.

Two things confirmed by inspection rather than by argument:

- **`ax_exists(role=TextArea, identifier="First Text View")` now appears.** That
  predicate could not exist before: identity was built from labels, and this
  element has an identifier and no label. It is the element the failing run was
  actually operating on.
- **`ax_focused` appears exactly on the nodes whose outgoing edge types**, and
  nowhere else.

### The unanticipated consequence: most nodes are now unlocatable

Five of eight nodes in `3PH1DM` carry only `app` (or nothing), so under the
locate floor they can be verified but never located. Only the two TextEdit nodes
with three predicates can start a run.

That is not a defect of the floor — a node whose recorded behaviour is one
point-only click genuinely does not describe a distinguishable state — but it is
a sharper constraint than "identity gets smaller" suggested, and it makes the
`expected` mechanism load-bearing rather than a convenience. Without it these
graphs would be almost entirely unreachable past the first segment.

**The URL predicate is the repair, and this is why it matters beyond
disambiguation.** These sessions predate URL capture, so their Chrome nodes get
nothing. A session recorded now would give them `app(Google Chrome)` **plus**
`url(github.com/…)` — and since `url` is not `app`, those nodes become
**locatable**. Web scope was designed to stop wrong-page merges; it turns out to
also be what makes browser states addressable at all under task-derived identity.

### The rebuilt graph, with URL capture (2026-08-01)

Four fresh recordings, then `rebuildGraph`. **13 nodes, 28 edges.**

| metric | before | after |
|---|---|---|
| max predicates on a node | 34 | **4** |
| mean | ~14.6 | **2.0** |
| nodes carrying >6 predicates | most | **0** |
| locatable nodes | 3/8 | **9/13** |

**Both halves of the merge contract hold on real data.**

- **Merge:** `app(Google Chrome) ∧ url(github.com/guyettinger/DeskRAG/pull)`
  carries **`observations = 2`** — two separate recordings of the pull-request
  page collapsed into one node.
- **Separate:** the issues page is a distinct node carrying
  `url(github.com/guyettinger/DeskRAG/issues)`, and never merged with the pull
  node. This is the case that motivated web scope at all.

**Locatability recovered exactly as predicted.** Before URL capture, browser
nodes were bare `app` and unlocatable; with it they carry a second predicate and
9 of 13 nodes can now start a run, against 3 of 8 before.

**A capture bug this found, and the repo had already paid to learn it once.**
`url_change` was first stamped with the WALK's `t_mono`. The settle delay puts
the walk ~250ms after the boundary it describes, so lift's latest-at-or-before
lookup handed each URL to the NEXT node — measured directly: the Chrome node was
bare `app` and its URL sat one node later. This is the same off-by-one that
`boundaryTMono` already exists to fix for the snapshot itself, where it measured
54% of nodes incoherent. The parameter was already being passed in and simply was
not used.

**Residual noise, explained rather than hidden.** Two recordings made before that
fix still carry walk-stamped events, and re-lifting cannot repair them — the
wrong timestamp is in the events table. They contribute a URL-less
`app(Google Chrome) ∧ ax_exists(Search Issues)` node that did not merge with its
corrected twin. That is stale data, not a design fault.

**Over-merging, measured and inert.** `app(TextEdit)` and `app(Electron)` nodes
show `observations = 6`: states whose recorded action touched nothing collapse
together. They are also the nodes `isLocatable` excludes, so they cannot start a
run or be planned toward. Visible, bounded, and worth revisiting only if a run
ever needs one.

### The armed run against the rebuilt graph (2026-08-02)

Nine steps posted into a real desktop, and confirmed by looking at the screen:
the reviewer hid, TextEdit came forward, `CheckBox "bold"` at `path@0.88` toggled
bold, `TextArea #First Text View` at `identifier@1.00` took focus, `type` put real
characters in the document, and the activation repair brought another app
forward.

**Two firsts.** Typing end to end — keymap captured at record, resolved at lift,
replayed through `strokesFor`, characters visibly on screen — and the focus
handoff under a **multi-step** sequence rather than the single click of
2026-07-31. Every event landed in TextEdit, which is also the evidence that none
landed in the reviewer: a click into DeskRAG's window is a click TextEdit does
not receive.

**It then refused to continue, correctly.** Boundary verification named
`ax_exists(label="Stop recording", role="Button")` — a button that exists only
*while a recording is running*. The state genuinely did not hold, and the run
aborted naming the predicate.

**Three fixes this run forced, in order of how badly each was needed.**

1. **`url` had to become `achievable`** (above). Until then the plan was blocked
   with nothing to override, because `buildPlan` turns an unmet assertable
   predicate on a remainder node into a hard blocker.
2. **A blocker must name its predicate.** `Blocker.predicate` carried it and the
   DTO dropped it, so the panel said "assertable predicate does not hold" with no
   way to tell which. Restoring it diagnosed the above in one run.
3. **`reach` is denormalized into stored predicates**, so changing
   `REACH_BY_KIND` does nothing to a graph on disk. The code, the tests and the
   built `dist/` all agreed on `achievable` while a live plan was still blocked by
   `url/assertable` read straight out of `trace_node`. It needs a rebuild.

### The recorder is not special, and excluding it was the wrong instinct

Every session begins and ends by clicking Record/Stop in DeskRAG, so the app's
own nodes are in the graph and act as **hubs** that paths route through. The run
above stopped on one of them, because `n6`'s identity includes
`ax_exists("Stop recording")` — a button present only while recording.

**Excluding the recorder at lift time was proposed and REJECTED.** It would be an
app-specific heuristic in a design whose central claim is that it needs none:
this whole spec exists because "page content versus application chrome" could not
be answered by a rule about apps, and excluding one app by name is that same
mistake one level up. It would also be wrong for a task legitimately recorded
*inside* DeskRAG.

Read without the special case, the failure is the system telling the truth.
`ax_exists("Stop recording")` is correct identity — that state does have that
button — and it is unverifiable outside recording mode for exactly the reason a
node recorded with a modal open is unverifiable with the modal closed. Note the
contrast with `Edited|Modified` in `VOLATILE_PATTERNS`: that is a label which
changes *within* one state, whereas this is a genuine mode marker, and filtering
it would hide state rather than remove noise.

**So the lesson is about which route a recording takes, not about the recorder.**
A task recorded without detouring through the app produces a graph without those
hubs. Nothing in the code changes.

**Still unvalidated:** continuation past a cut against a real desktop. The run
aborted before segment 2, so the `expected`-node mechanism remains proven only in
the suite (`test/run.expected.test.ts`).

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
