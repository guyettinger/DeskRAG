# The record grows a second half — what a habit says about how it is going

Sub-project **B** of four. A built the projection (`walk-analysis.ts`); B is its first consumer
and the first one a person can read. Nothing here computes a new measurement — every fact in
this spec already exists in `WalkAnalysis` and is currently rendered nowhere.

**Consumes:** `docs/superpowers/specs/2026-08-22-walk-projection-design.md` (merged, PR #71).
**Siblings:** C (the Habits screen as a mirror), D (the agent surface). Both are recorded as
starting prompts in `docs/todo.md` and neither is in scope here.

## Why

`HABIT.md` has one half. The prose says what the work is; the record says what the steps were,
what varied, what the evidence does not say, and where it came from. Between them there is no
answer to the question a person actually asks about a habit — **how is it going** — and no
answer to the one an agent asks: *is this reliable, and where does it usually go wrong.*

`docs/post.md` names three lessons and the file serves one. Consistency Wins is drawn (the
record counts recordings). **Identity and Action** — your routines are the proof of who you
are — and **Power to Change** have no surface in the file at all.

A closed that gap in data. B closes it in the artefact, and it closes it in the RECORD half,
which matters more than it sounds: the record is template-rendered from the graph and nothing
else, so every sentence B adds is a sentence no model can rewrite and every reader can check
against the block above it.

## What this is not

- **Not a score.** No fitness float, no reliability percentage, no streak, no grade. Counts and
  named facts. `FrameResult.score` is an ordering rather than a confidence and this repo's UI
  and MCP tool show rank and evidence instead of the number; a "78% consistent" habit is
  exactly the figure it refuses to print.
- **Not a renderer.** No file under `app/src/renderer/` is touched. C draws.
- **Not an MCP change.** `habit-text.ts` gains one differentiator (below) and no new tool. D
  builds tools.
- **Not a DTO change.** `app/src/shared/types.ts` is not modified. Every fact renders from
  `FlowsDTO` + `FlowRouteDTO`, which `recordedBlocks` already holds.
- **Not `probe:describe`.** Deferred, with a measured reason — see *Deferred, and why*.
- **Not a new caller.** See *The signature does not change*.

## The signature does not change

`walkAnalysis(input, hooks?)` takes `{ flows, route, rule? }`. `recordedBlocks(input)` takes
`{ flows, route, showSamples }`. The projection therefore needs nothing the record does not
already have, and B adds **no parameter to `recordedBlocks`**.

This is load-bearing rather than tidy. `recordedBlocks` does not take a body, a prose object or
a provider, and the header says outright that this is what makes *"a model cannot rewrite the
record"* a property of the code rather than a promise in a prompt. A new parameter is the
obvious way to hand it a projection and it would put the first widening crack in that
property. Computing the projection inside keeps the guarantee exactly as strong as it is today,
and `test/habit.doc.test.ts` continues to assert it against an adversarial body unchanged.

No hook is wired. The phase cue reads `RhythmFacts`, which needs no store access at all, so
`antecedentAt` stays declared and unimplemented — see *The cue is not observable*.

## The three blocks

They render after `## What varies` and before `## What this evidence does not say`, so the
cautions stay last and keep their job of qualifying everything above them.

Each block appears **only when it has something to say**, following `## What this evidence does
not say`, which is already conditional on `cautions.length > 0`. A habit recorded once has no
differences to report, no second recording to compare a duration against, and one timestamp is
not a rhythm — so a single-recording habit renders none of the three and is unchanged byte for
byte. That is the same rule the variant machinery follows: a route walked five times the same
way still renders exactly as it always did.

### `## How the recordings differ`

Lead with what the standard IS and how it was chosen, because under `majority` with no repeated
Way the choice is a tiebreak and a reader must know that before reading a single deviation.
Then one line per recording, named by date.

```markdown
## How the recordings differ

Measured against one of the 3 recorded ways. 3 Ways tie at 1 recording each; the standard
is the one holding the newest walk. A different recording could become the standard as
soon as one more is made.

- 2026-08-14 — followed the standard.
- 2026-08-17 — 4 steps not in the standard, 3 of the standard's steps not taken.
- 2026-08-20 — 12 steps not in the standard, 6 of the standard's steps not taken. Reached the end.
```

The second sentence is `Baseline.reason` **verbatim**, and the third renders only on a tie.

**Counts per recording, never a bullet per deviation.** Measured on the real store: the one
recurring route yields 9 skipped and 16 inserted across two deviant walks, which is 25 bullets
for three recordings. `cautionsFor` already paid for that exact mistake — a per-step bullet
fired on nearly every step of every variant and printed *"Step N was in 1 of the 2 recordings"*
**twelve times in an eighteen-bullet section**, one fact printed twelve times — and the fix
was to state it once about the route. This block is built the same way from the start.

**`reachedEnd` is stated only when it is false, or when it is true after deviations.** On a walk
that followed the standard it is not news.

**A tiebroken baseline says so.** `Baseline.reason` already carries the sentence — the real
string is `"3 Ways tie at 1 recording each; the standard is the one holding the newest walk."`
— and B prints it rather than composing a second one, so the file and the probe cannot
disagree about how the standard was picked. It was written for a probe and is now user-facing;
see *Open derived requirements*.

### `## Where the time goes`

Per-step, every recording's own number, in the order `walks` is sorted (oldest first) so a
reader can align the column with the recordings named in the block above.

```markdown
## Where the time goes

Each recording's own time on each step, from the recorded spans. These are durations, not
targets.

1. Calculator → Calculator — 17.5s, 15.5s, 15.5s
2. Calculator → TextEdit — 8.5s, 0.5s, 11.5s
   *idle before the next step: 0s, 0s, 4.0s*
```

- **A step's duration is its own span** (`throughSec - atSec` from that recording's own
  `EdgeSourceDTO`), never the gap to the next step. A's spec was corrected on exactly this
  point: differencing consecutive `atSec` folds the idle before the next step into this one's
  cost and hides the hesitation.
- **The idle line renders only when some gap is non-zero.** A tight sequence should not carry a
  row of zeroes.
- **A recording that did not walk the step is omitted from that step's list, not given a zero.**
  Zero is a real duration.
- **"durations, not targets"** is in the block, not only in this spec. The file is the thing
  that gets pasted somewhere else — the same reason the `showSamples` warning travels in the
  file.

### `## When it happens`

```markdown
## When it happens

All 3 recordings on a weekday, between 09:00 and 11:00 local time.
Gaps between them: 3 days, 3 days.

The application in front beforehand cannot be recovered: recording starts when you press
record, so a recording contains no evidence of what preceded it.
```

Built from `RhythmFacts.hours`, `.days` and `.intervalsMs`. Weekday/weekend and an hour range
are the two statements the data supports; anything sharper ("every Tuesday at 9") needs a
corpus this library does not have and is C's rhythm strip to draw, not B's to assert.

**The second paragraph is the point of the block, not a footnote.** Without it an absent cue
reads as *there was no cue*.

## The cue is not observable, and this was measured

A's `AntecedentFact` anticipated an app-or-place cue reached through an injected hook. Against
the real store the naive implementation is wrong in a way no corpus growth fixes.

For **all three** recordings of the only recurring route, the focus timeline has the same shape:

```
t_mono   524  Electron     <- the Recorder
t_mono  7388  Calculator   <- the walk starts here, exactly
   ...
t_mono 46924  Electron     <- the Recorder again
```

The only application ever in front before the work begins is **DeskRAG's own Recorder, 3 of 3
times**. So `antecedentAt` reading raw `focus_change` events would report *"you do this after
DeskRAG"* — false, and a direct violation of **the recorder is not part of the work it
records**, the invariant `excludeFocusedApps` exists to enforce. Applying that exclusion, as the
invariant requires, makes the answer **null in 3 of 3 walks**.

The cause is structural: **a recording begins when you press record, so the cue happens before
the evidence exists.** An in-session antecedent is unobservable by construction.

Therefore B renders the phase, states the impossibility, and leaves `antecedentAt` declared and
unimplemented. It is not dead code — it is the seam a cross-session or calendar cue would enter
through — and A already specifies that no hook means no antecedents and the consumer renders
nothing. Nothing in A changes.

## The `duplicates` differentiator

Today the list says:

```
ALSO DESCRIBED BY — compute-sum-paste. These habits answer to the same recorded route;
nobody has merged them.
```

Two habits on one route have **byte-identical records** — `mergedBody`'s header already states
why: the record below `## Recorded steps` is re-rendered from the live route either way, and
both answer to the same route, which is what made them duplicates. So an agent that fetches
both and diffs them finds nothing, and the disclosure hands it no way to choose. That is the
resolution-ambiguity failure the skill-retrieval literature names: two entries with the same
capability and nothing to separate them.

The only thing that CAN differ is prose, so the disclosure says so and quotes it:

```
ALSO DESCRIBED BY — compute-sum-paste (01M0F8Z...). The recorded steps are identical;
these two differ only in how they are described. That one says: "Use when you need to
total a column and drop it into a note."
```

The id is kept as well as the slug, because the id is what `get_habit` takes.

**`HabitDTO.duplicates` holds ULIDs, not slugs** — `duplicateHabits` groups by
`liveRouteKey` and emits `s.id`. So today the line reads `ALSO DESCRIBED BY —
01M0F8Z...`, which strengthens the case rather than weakening it: an agent is handed an
opaque key and no way to weigh it. The differentiator prints the other habit's **slug** and
its description instead.

**No DTO change, one internal signature change.** `lines(s: HabitDTO)` renders one habit and
`renderHabitList` maps it over `kept`, so `lines` gains a second parameter — a
`ReadonlyMap<string, HabitDTO>` over that same rendered set. Both members are present in it by
construction: `duplicateHabits` is resolved over the whole set in `listHabits`, and it emits a
pair only when both are `active`. A miss is still handled — it degrades to the current
sentence — because a lookup that cannot fail is a lookup that will.

## `HabitBrief` and the prompt

`HabitBrief` gains one field:

```ts
/**
 * Neutral counts about how consistently this route was walked.
 *
 * Facts, in the shape `cautions` already uses. The prose may STATE them and may
 * not assess them: the record prints the same counts a few lines below, so a
 * sentence here can only agree with something the reader can check.
 */
consistency: string[];
```

Populated by `briefFor` from the projection: how many recordings took the standard way, how
many deviated, and the weekday/hour statement. Still four string fields back, still no step,
still names and counts and never a sample.

`HABIT_SYSTEM` gains one rule: **state variation as fact, never as assessment.** No
"unreliable", no "inconsistent", no advice about improving. `parseHabitResponse`'s wholesale
rejection remains the enforcement — it already rejects any reply carrying `steps`, `recorded`
or `recordedSteps`, and nothing about that changes.

The alternative — passing the facts with no new rule — was rejected because this repo has
measured **twice** that prompt tweaks against composition quality read as noise across fewer
than three runs, so a model drifting into evaluative prose would be very hard to detect after
the fact. The alternative of withholding the facts entirely was rejected because the prose
would then describe a habit as though it always went smoothly while the block directly below it
says it went three different ways — the contradiction the reflection stage exists to avoid.

## A's committed carry-over

A committed one consumer to B, and it ships here:

> The strict-prefix relation is disclosed in the record as a caution-style line — "this work
> was started and dropped early N further times" — so the fact reaches `get_habit` before any
> pixel exists.

It renders as a caution, from `WalkAnalysis.droppedEarly`, and it is a **disclosure and never a
merge**: `route.count`, `frequentRoutes`, `route-cluster.ts` and every stored `routeKey` are
untouched, exactly as A specified.

On the real store today this line does not fire — `probe:baseline` reported 0 routes with a
prefix route and 0 recordings that dropped early. It ships tested against fixtures and
unexercised by real data, which is stated rather than hidden.

## Testing

Every block is deterministic template output from fixture graphs, so the root suite covers all
of it — `habit-doc.ts` is already `.ts` under `app/src/main/` and `test/habit.doc.test.ts`
already builds `FlowsDTO` fixtures.

- **The seam holds.** The existing adversarial-body assertion must still pass unchanged: it is
  the proof that no model output reaches the record, and B adds three blocks to that record.
- **A single-recording habit renders none of the three blocks**, and its file is byte-identical
  to what it renders today. This is the regression test for the whole change.
- **Counts, not bullets:** a fixture with many deviations renders one line per recording. Assert
  the line count against the recording count, not against the deviation count.
- **The tiebreak sentence appears** when no Way repeats, and does not when one does.
- **A step not walked by a recording is absent from its duration list**, and the list length is
  therefore below the recording count without a zero appearing.
- **The unobservable-cue paragraph is present whenever the block is**, so an empty cue can never
  read as an absent cue.
- **`consistency` reaches the brief and no sample does** — the existing "names and counts, never
  a sample" assertion extended to the new field.
- **The differentiator quotes the other habit's description**, and degrades to the current
  sentence when that description is empty.

`npm run probe:habits` is the end-to-end check and already asserts the clipboard string and
`get_habit`'s are byte-identical; it exercises the new blocks for free against the real store,
including the one real habit with three recordings and three distinct Ways.

## Deferred, and why

`probe:describe` was in B's recorded prompt and is deferred to its own entry, on a measurement
rather than on taste. The real store holds **one kept habit**. Its proposed ground truth is
"a held-out session belongs to a route, the route belongs to a habit", so with one habit top-1
is trivially 100% and MRR is 1.0 regardless of what any description says.

That is the degenerate-corpus error `probe:embed`'s first version made — 750 digests, 144
distinct, one appearing 85 times, top-1 capped at 1/85, reporting a 28.6% "lift" that was pure
noise — one order of magnitude worse. Its todo entry names the floor: **the probe should refuse
to score below roughly 8-10 kept habits**, and should print the corpus first, as
`probe:baseline` does.

## Honest states

- **A single-recording habit gains nothing from B.** Three blocks that all require a second
  recording render nothing, which is correct and is the most common habit on a young library.
- **Two of the three blocks are thin on the real store today** because it holds 3 recordings of
  one route. The blocks are built to be right, not to look full.
- **The baseline is one recording from moving.** `probe:baseline` found the only real baseline
  was chosen by tiebreak, 1 of 1. The block leads with that sentence for exactly this reason.
- **`droppedEarly` is unexercised by real data** (0 prefix routes on the real store).
- **`RhythmFacts` uses local time with no zone recorded** — carried forward from A unsolved, and
  now user-visible for the first time, since `## When it happens` prints an hour range. A
  library carried across time zones reports the reader's current zone, not the one the work
  happened in.

## Open derived requirements

- **A cross-session or calendar cue** is the only route to a genuine "after X, you do Y" claim,
  and `antecedentAt` is the seam it would enter through. Not scoped.
- **`Baseline.reason` is now user-visible prose**, having been written for a probe. If C or D
  reword it, the record's lead sentence changes with it — one string, two readers.
