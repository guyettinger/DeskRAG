# Where the Ways Fork — Sub-project C3

**Date:** 2026-08-23
**Status:** approved, not yet planned
**Series:** habit insight, sub-project C — the Habits screen becomes a mirror. C1 shipped conformance on the ledger, C2 shipped the portrait, the rhythm strip and the fading band. C3 is the last of C.

---

## Why

`post.md`'s third lesson is *power to change*, and a habit's Ways are the only
place in DeskRAG where a person's own alternatives sit side by side. Today the
record prints them as independent numbered lists — Way A, then Way B, then Way C
— and a reader has to diff four procedures by eye to find out where they
actually differ. Nothing says where they share a spine, where they fork, or
whether one of them is shorter.

That is worse for an agent than for a person. Sub-project D will hand a habit to
a model, and four independent lists with the instruction "follow one of them,
not all of them in sequence" gives it no basis for choosing.

---

## The corpus, measured before designing

Read from the real store on 2026-08-23 (`~/Library/Application
Support/deskrag-app/DeskRAG/app.db`, 8 recordings, 5 routes). Exactly **one
route has more than one Way**:

**Calculator → TextEdit**, 4 recordings, **4 Ways, one recording each**, baseline
chosen by tiebreak.

| Way | steps | total | place sequence |
| --- | --- | --- | --- |
| A | 5 | 39.3s | `Calc›Calc`, `Calc›Calc`, `Calc›TextEdit`, `TE›TE`, `TE›TE` |
| B | 4 | 24.0s | `Calc›Calc`, `Calc›Calc`, `Calc›TextEdit`, `TE›TE` |
| C | 4 | 28.1s | **`n0 — no state›Calc`**, `Calc›Calc`, `Calc›TextEdit`, `TE›TE` |
| D | 13 | 62.3s | …the spine…, `TE›Finder`, `Finder›Finder`, `Finder›Finder`, `Finder›TextEdit`, `TE›TE` |

Three findings, each of which changed the design:

**1. An edge-level fork diff is degenerate, and it is structural rather than a
matter of corpus size.** The four Ways share **exactly one edge** between them
(A and D share `01M084MJ…:e1`). `alignWalk(A, B)` would report 5 skipped and 4
inserted with zero matches — two disjoint lists, not a fork. A node's identity is
*what the task does next*, so two recordings of Calculator button-mashing lift to
different nodes and therefore different edges. This is the same fact that made
`route.id` a **place-label** sequence in the first place: edge-id and node-id
keys were measured on a real 9-recording graph and both split five identical
walks into nine routes of ×1.

**2. At place-step granularity the Ways align cleanly.** Their shared spine is
`Calculator›Calculator · Calculator›TextEdit · TextEdit›TextEdit` — "work in
Calculator, hand off, work in TextEdit" — and the three real differences fall out
as forks: C started from no state, C did one fewer Calculator step, and D took a
nine-step excursion through Finder before coming back. D is in this group only
because the cluster rule folded it as a near-miss variant, so the fork also
explains why it is here at all.

**3. "Is B better" has honest material at whole-walk granularity only.** Each
baseline step carries exactly one duration — its own session's — because the
steps are not shared. Whole-walk totals *are* comparable (B 24.0s, C 28.1s,
A 39.3s, D 62.3s), but every Way is n=1, so that is one afternoon against
another.

### A measurement error worth recording

The first reading of this corpus said the per-step durations were **empty**, and
that was wrong. `scripts/baseline-probe.ts` calls `toGraphDTO(graph)` with no
`sessionStart` resolver, and `toEdgeSources` drops every source whose session
cannot be dated — so every edge comes back with `sources: []`, every `firstAt` is
null, and the probe's "Other readings" section is measuring an empty graph. Its
deviation table does not read sources and is unaffected, so the shipped baseline
rule stands. **C3 fixes the resolver** (one line) because a probe that silently
measures nothing is the exact failure this repo keeps paying for.

### A finding outside this scope

Way C still begins at **`n0 — no state`**, despite `liftTrace` taking
`startTMono` to stop minting a zero-predicate head. That is a trace-lift
question, not a rendering one. Recorded in `docs/todo.md`; not addressed here.

---

## What this is not

- **Not a score.** No ratio, percentage, edit-distance, grade or fitness float
  reaches any surface. `FrameResult.score` established that this repo prints
  rank and evidence rather than a number, and `walk-align.ts` says in its own
  header that an edit-distance ratio "would be exactly the figure this repo
  refuses to print".
- **Not a merge and not a recommendation to change.** The fork *shows* the
  alternatives. It never suggests adopting one, never marks a Way wrong, and
  never hides one.
- **Not model-touchable.** `recordedBlocks()` takes the route and nothing else.
  The fork is computed from `flows` and `route` inside it, the way `walkAnalysis`
  already is, so there remains no path by which model output reaches the record.
- **Not a change to route mining, clustering, or node identity.** The alignment
  reads the Ways that `flowWalks` already produces.

---

## Architecture

A new pure module, `app/src/main/way-fork.ts`, holding the same contract as
`walk-analysis.ts` and `flow-steps.ts`: `FlowsDTO` in, plain objects out, no
store, no Electron, no model. That is what keeps it reachable from the **root**
suite, and what lets the rendered file and the screen read one implementation
instead of two — the `ax-dump`/`ax-exec` drift hazard by name.

```
flowWalks(flows, route)  ->  FlowWalk[]
                                |
                          way-fork.ts
                                |
                +---------------+---------------+
                |                               |
        habit-doc.ts                     toHabitDTO -> HabitForkDTO
   "## Where the ways fork"                      |
                                          HabitsScreen.tsx
                                        the fork instrument
```

### The spine

```ts
const placeKey = (s: FlowStep): string => `${s.from}\0${s.to}`;

/** The place-step sequence every Way contains, in order. Folded pairwise. */
export function spineOf(ways: readonly FlowWalk[]): string[];
```

`spineOf` folds a two-sequence LCS across the Ways in order: `spine = ways[0]`,
then `spine = lcs(spine, ways[i])` for each subsequent Way. Deterministic, linear
in the number of Ways, and **not guaranteed optimal** — an N-way LCS is
NP-hard, and progressive folding is the standard, honest approximation. The
result is stated as "a sequence every Way contains", which is true of any fold
result; it is never claimed to be the longest such sequence.

`\0` is the delimiter because a place label cannot contain one — the same
reasoning as the composite map keys in `src/store/store.ts`, and written as an
escape rather than a literal byte so `grep` still reads the file.

### The rows

```ts
export type ForkRow =
  | { kind: "spine"; from: string; to: string; at: { wayIndex: number; step: FlowStep }[] }
  | { kind: "fork"; runs: { wayIndex: number; steps: FlowStep[] }[] };
```

Each Way is scanned forward once against the spine, greedily matching the next
spine key. That yields, per spine position, the step in that Way which realised
it, and the run of steps between it and the previous spine position.

- A `spine` row carries **every Way's own step** at that position, so both
  surfaces can still show that Way C pasted where Way A retyped, and the screen
  keeps a per-Way "Open this moment".
- A `fork` row is emitted **only** when at least one Way filled that gap. Gaps
  before the first spine position and after the last are ordinary fork rows.
- A Way with an empty run at a fork is drawn as present-and-empty, never
  omitted: "B did nothing here" and "B is not in this picture" are different
  facts.

### The verdict

```ts
export type Verdict =
  | { kind: "named"; text: string }
  | { kind: "withheld"; reason: string };   // required — the StageSpec.skipReason rule
```

`reason` is required, never optional and never an enum. A surface that merely
goes quiet is indistinguishable from one nobody implemented.

Two gates, and neither is a statistic:

1. **A floor.** Every Way in the comparison needs at least
   `FORK_VERDICT_MIN_WALKS = 2` recordings.
   Withheld: *"Way A and Way B have one recording each, so nothing here says one
   is better."*
2. **Non-overlapping ranges.** The verdict fires only when the **slowest**
   recording of one Way beat the **fastest** recording of another. No mean, no
   median, no ratio, no significance test — a rule a person can check against
   the printed numbers.
   Fires: *"Every recording of Way B (22.1–25.9s) was faster than every
   recording of Way D (60.2–62.3s)."*
   Withheld: *"Their times overlap (A 24.0–39.3s, B 22.1–39.9s), so these
   recordings do not say one is faster."*

The per-Way times are printed beside every Way **regardless of the gates** —
facts always, verdict behind a floor. On the store as it stands today the floor
is what speaks, on all four Ways, and that is the correct output.

The floor is **unswept**, like C2's two. It needs a route walked several times
along at least two Ways, which this library does not have. It is recorded as
unswept when it ships.

### Phrasing lives in `way-fork.ts`

The words for a run ("9 more steps, via Finder") and for the verdict are
produced by `way-fork.ts`, not by the renderer and not by `habit-doc.ts`. This is
the `differBlock` precedent: it prints `Baseline.reason` **verbatim** so that the
file and `probe:baseline` cannot disagree about how the standard was picked.

---

## The record

`## How the recordings differ` is **replaced** by `## Where the ways fork`.

Nothing is lost. `differBlock` reports per-*recording* deviation counts against a
baseline that, on this store, is chosen by tiebreak and moves between runs; the
fork names which recordings took each Way directly and needs no standard. Keeping
both would print one fact twice, which `cautionsFor` already paid for once —
a per-step bullet fired on nearly every step of every variant and printed one
fact **twelve times** in an eighteen-bullet section.

**The agreement case is preserved verbatim.** One Way still prints *"All N
recordings took the same path."* `differBlock`'s comment is right that going
silent there would make "they all did the same thing" indistinguishable from
"nothing was measured".

Block shape with several Ways:

1. The existing lead sentence — the recordings did not take the same path, follow
   one of them.
2. The Ways, one line each: letter, step count, recording count, each recording's
   own total.
3. The spine as a numbered procedure, with fork rows inline as indented per-Way
   runs.
4. The verdict, or its reason.

### One adjacent fix

`## Where the time goes` prints one number per step and reads like a comparison.
On this store every row has exactly **one** duration, because the Ways share no
steps. One clause: when every row carries a single duration, the block says so.

---

## The screen

`RecordedSteps` in `HabitsScreen.tsx` keeps its current per-Way lists when there
is **one** Way — the healthy case is unchanged. With several Ways it draws the
fork instrument instead:

- a header of Way chips (`A · 5 steps · 39.3s`), one per Way;
- the spine as a numbered column;
- fork rows as a band with one lane per Way, each lane naming its run;
- the verdict line, or its reason, beneath.

A step keeps its actions and its "Open this moment" button wherever it is drawn,
spine or fork — C1's rule that the record is verifiable rather than merely
trusted does not weaken inside a fork.

### The seam

`HabitDTO` gains `fork: HabitForkDTO | null`, built in `toHabitDTO` beside
`ways`. Null when there are fewer than two Ways. Rows reference steps **by index
into `ways`**, never by embedding them:

```ts
export type HabitForkRowDTO =
  | { kind: "spine"; from: string; to: string; at: { way: number; step: number }[] }
  | { kind: "fork"; runs: { way: number; steps: number[] }[] };
```

`way` indexes `HabitDTO.ways`; `step` indexes `ways[way].steps`. This keeps the
payload small and makes the two structures provably consistent — the fork cannot
name a step the Ways do not have.

`HabitProposalDTO` is **not** widened. A proposal's preview is rendered through
`recordedBlocks`, so it gets the fork in its file for free, and the proposal row
does not draw `RecordedSteps`.

---

## Colour discipline

The fork band takes **`--data-6` (periwinkle)**, the only unclaimed indexed slot:
`--data-0` is C2's portrait, `--data-1` is `--data-warn`, `--data-2` and
`--data-3` are C1's deviated and short, `--data-4` is `--data-signal`,
`--data-5` is `--data-ok`, `--data-7` is `--data-alarm`. The palette's own
comment at `styles.css:30` calls `--data-6` "an instrument colour and a lane
colour".

**Colour carries spine-versus-fork, never Way identity.** Spine rows are
neutral; fork rows use `--data-6` at varying lightness via
`color-mix(in oklab, var(--data-6) N%, transparent)`, the same technique C2 used
for the portrait. Ways are told apart by their printed letter and their lane
position, so hue is never the only channel and the palette never has to stretch
to N Ways.

New class names are prefixed `wayfork__`. `styles.css` is one global sheet with
no scoping, so a class name is a repo-wide identifier — grep before minting.
Sizes come from the `--s*` / `--t-*` scales; a raw `font-size: <n>px` is the
regression.

---

## Testing

**`test/way-fork.test.ts`** — the projection, including the two shapes the real
store handed us:

- **empty common prefix**: Way C's `n0 — no state` head, which falsified the
  prefix/suffix approach outright;
- **repeated place labels**: Way D's five consecutive `TextEdit › TextEdit`;
- the fold over three and four Ways; one Way; zero Ways;
- a Way that contributes nothing to a fork is present with an empty run;
- the verdict floor withholding with its reason;
- the verdict withheld on overlapping ranges, with both ranges in the reason;
- the verdict firing on disjoint ranges.

**`test/habit-doc.*.test.ts`** — the replaced block; the one-Way agreement
sentence preserved; the `## Where the time goes` single-duration clause; and the
standing assertion that an adversarial body cannot reach the record.

**Renderer** — row phrasing is exercised through `way-fork.ts` in the root suite.
Any renderer-side helper is a `.ts` module, never `.tsx`, so the root suite
reaches it.

**`npm run probe:fork`** — read-only and **headless**, for `probe:baseline`'s
stated reason: DeskRAGApp takes no single-instance lock and writes on startup, so
a second instance is a second owner of SQLite. It opens `app.db` readonly, prints
the corpus **before** any reading, then for every multi-Way route prints the
spine, the fork rows, each Way's totals, and what the verdict said **and why**.
It exits non-zero when no route has more than one Way, because then it is not a
measurement. This is the check that would have caught the empty-prefix
falsification before it reached a spec, and it keeps working as the library
grows rather than starting to fail.

**`scripts/baseline-probe.ts`** — pass a `sessionStart` resolver so its edge
sources stop being dropped, and re-run it to confirm the "Other readings" numbers
change.

The gate is three unpiped commands, each run whole: `npm test`;
`npm run typecheck`; `npm run build && npm --prefix app run typecheck`. Piping
through `tail` returns `tail`'s exit code and hides failures.

---

## What is recorded in docs/todo.md when this ships

- The C3 entry: what the fork draws, the two verdict gates, and the real reading
  it produced on this store.
- **`FORK_VERDICT_MIN_WALKS` is unswept**, joining C2's two floors and the four
  fixture-tested-but-unexercised paths from B and C1. It needs a route walked
  several times along at least two Ways.
- The **`n0 — no state`** head still appearing on Way C, as a trace-lift finding.
- That `probe:baseline`'s edge sources were blind until C3, and the reminder to
  check every probe's resolvers — the numbers it printed before this were about
  an empty graph.
