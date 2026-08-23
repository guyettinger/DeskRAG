# The Ledger Tells the Truth — Sub-project C1

**Status:** design, approved in chat 2026-08-23
**Consumes:** sub-project A (`walk-analysis.ts`, PR #71) and B (the record's second half, PR #72)
**Followed by:** C2 (the portrait band and rhythm strip) and C3 (the Way A/B fork diff), each with its own spec

## Why

`docs/post.md` gives three lessons and the Habits screen serves one of them thoroughly.

**Consistency Wins** is everywhere: bands ordered by what needs answering, the
recurrence ledger with one mark per recording on a shared axis, `RECORDED ONCE`
said in words at every count. **Identity and Action** and **Power to Change**
have no surface at all.

C1 does not build those two surfaces — that is C2 and C3. It builds the seam
they both need, and spends it on the one thing the screen can already almost
say and doesn't: **which recordings actually followed the standard.**

Sub-project B computed all of it. `WalkAnalysis` carries per-walk deviations, a
baseline with its reason, rhythm facts and the strict-prefix relation, and B
rendered every one of them into `HABIT.md`. B also held a global constraint of
**no DTO widening**, so none of it can reach a pixel. The Habits screen is
currently a mirror of the recordings and not of the record.

The gap is not decorative. Process mining calls this conformance checking:
discovery (what routes exist) is what DeskRAG has had since Flows shipped, and
conformance (did this instance follow the model) is what it has never had on
screen. The ledger draws four identical dots for four recordings that went four
different ways.

## What this is not

- **Not the portrait band, and not the rhythm strip.** Those serve *Identity and
  Action* and are C2. They are the hazard-heavy, inventive half and they deserve
  a design that is not a rider on this one.
- **Not the fading band** ("was weekly, not walked in six weeks"). It serves
  *Power to Change* and rides C2's rhythm data.
- **Not the Way A/B aligned fork diff.** That is C3, and it is a distinct
  interaction that also has to answer whether B is *better* — a question this
  spec deliberately refuses to let the colour of a dot imply.
- **Not `probe:describe`.** Deferred on a measured corpus floor; see
  `docs/todo.md`.
- **No new MCP tool.** The agent surface is D.
- **No change to `walk-analysis.ts` or `walk-align.ts`.** A is merged; C1 is a
  consumer, exactly as B was.

## The two findings that shaped this

Both came out of reading the code rather than from taste, and each one removed
a decision rather than adding one.

### A dropped-early recording cannot be a mark

`docs/todo.md` asks for the ledger to distinguish *canonical / deviated /
dropped*. The third one cannot exist there.

A recording that started this work and abandoned it partway **walked a different
route**. DeskRAG's route partition gives every recording exactly one route key —
that is what makes `bindHabit`'s strict-majority rule a proof rather than a
threshold — so a prefix walk has its own key, is absent from `route.walks` and
from `binding.boundSessionIds`, and has no `WalkMarkDTO` at all.

Minting one and placing it on this habit's shared axis would assert that it
belongs to this route. B's own caution refuses to do exactly that: *"Those are
not counted among the N above."* The screen must not contradict the file it
mirrors.

So the ledger carries **canonical / deviated / stopped-short**, all three read
from `WalkFit` on this route's own walks, and the prefix relation is disclosed
in words. See *The dropped-early disclosure*.

### `is-lone` and conformance are mutually exclusive by construction

The hollow ring means *exactly one recording* — the single visual difference
between an observation and a habit. Conformance requires a standard, and B's
guard is `count < 2 || baseline.wayIndex === null || walks.length < 2`.

So a mark can never be both lone and conformance-coloured. That is what makes a
third channel affordable on a 7px dot at all: the ring is free wherever
conformance exists, which is the only reason `gained` has somewhere to move to.

## The seam

Main already computes `walkAnalysis` per habit — `briefFor` calls it. C1 lets
its output cross into the renderer.

### Three DTO additions, all facts

| Field | Shape | Note |
| --- | --- | --- |
| `WalkMarkDTO.fit` | `{ inserted: number; skipped: number; reordered: number; reachedEnd: boolean } \| null` | Counts, never a verdict and never a ratio. |
| `HabitDTO.droppedEarly` | `{ places: string[]; count: number }[]` | Straight from `PrefixFact`. |
| `HabitDTO.ways` | `{ letter: string; sessionIds: string[]; steps: HabitStepDTO[] }[]` | The record's Ways, structured, so steps can be drawn as an instrument. |

```ts
export interface HabitStepDTO {
  index: number;
  edgeId: string;
  from: string;
  to: string;
  actions: { action: string; target: string }[];
  observations: number;
  everyRecording: boolean;
  missing: boolean;
  /** Lane seconds, plus the recording to open. Null when the edge has no sources. */
  firstAt: { sessionId: string; startedAt: number; atSec: number } | null;
}
```

**`fit: null` MEANS NO STANDARD EXISTS, NOT "CONFORMANT".** A habit recorded once
has nothing to be consistent with, and drawing it in the canonical hue would
claim it passed a check that was never run. Null draws as it does today.

**The DTO carries facts; the renderer derives the display state.** `markState`
lives in `habits-view.ts`, which is `.ts` precisely so the root suite can reach
it. A `kind: "deviated"` field on the DTO would put a display decision in main,
where no root test can see it change.

### The mapping is a pure function, in main, outside the service

`deskrag-service.ts` imports electron, so the root suite structurally cannot
construct it — the same constraint that produced `habit-doc.ts` and is why
`probe:merge` and `probe:reflect` exist at all. The `WalkAnalysis → WalkMarkDTO.fit`
mapping and the `FlowWalk[] → HabitDTO.ways` mapping therefore go in a pure,
importable main module (`habit-doc.ts` or a new sibling), and the service only
calls them.

### `firstAt` needs a `sessionId`, and its lane seconds are already correct

`onOpenRecording(sessionId, atSec)` needs both halves. `FlowStep.firstAt` carries
only `{ startedAt, atSec }`, so the field grows a `sessionId`.

**The lane-seconds hazard is already closed and must not be "fixed" again.**
`firstAt` reads `edge.sources[0]`, an `EdgeSourceDTO`, and `toEdgeSources`
already converts through `laneSec(s.tMonoStart, origin)`. The step instrument
inherits that for free. `tMono / 1000` is the axis only when capture began at
t_mono zero, which it never does — measured at 1.9s of pre-roll on a real
session — and that bug was already paid for on this screen's sibling.

## The ledger

### The state

```ts
export type MarkState = "lone" | "canonical" | "deviated" | "short" | null;
export function markStates(marks: readonly LedgerMark[]): MarkState[];
```

**It takes the ROW, not one mark.** `lone` is a property of the row — exactly one
mark on it — and a per-mark signature could not see that, which is the same
positional-coupling trap `LedgerMark.walk` was carried to avoid. One call per
row returns one state per mark, in order.

`lone` when the row has exactly one mark. Otherwise, from `fit`: `null` when
absent, `"short"` when `!reachedEnd`, `"deviated"` when any of the three counts
is non-zero, `"canonical"` when none is.

**`short` outranks `deviated`** when a walk did both. Stopping before the end is
the larger fact about what happened, and a walk that stopped will almost always
also show skipped steps — reporting it as merely deviated would bury the reason.
The hover card says both.

### The hues

| State | Colour | |
| --- | --- | --- |
| canonical | `--data-signal` #00a0dd azure | unchanged from today |
| deviated | `--data-2` #b674d2 violet | |
| stopped short | `--data-3` #c65931 clay | |
| gained | ring in `--data-ok` | moved from fill to ring |
| lone | hollow ring in `--muted` | unchanged from today |

**Neutral indexed slots, never `--data-warn` / `--data-alarm`.** This is the
whole hazard of the sub-project in one decision. `Baseline.reason` says the
standard is *"chosen from the recordings themselves"* and is frequently
tiebroken — B prints *"a different recording could become the standard as soon
as one more is made"* — so a deviation may well be the better path. Painting it
amber makes the screen assert what the file it mirrors deliberately declines to
assert, and it is the streak-shaped-UI backfire `docs/todo.md` names. The
indexed slots distinguish without ranking; that is the only thing the evidence
supports.

**Canonical keeps `--data-signal`, so a fully conforming library is
pixel-identical to today.** The diff *is* the finding. Re-derive nothing: the
data register is computed and `--data-0..7` are never hand-edited.

**`gained` changes channel, not meaning.** It keeps `--data-ok`, moving from
fill to a ring, because fill is now spoken for. It is also the channel that
loses least: a recording made after the habit was kept is necessarily rightward
on the axis, so position already half-tells it, where conformance is redundant
with nothing.

### The words

`MarkReadout` gains one field and `markLabel` joins it, so the hover card, the
tooltip and the mark's accessible name all carry it — position is a metaphor and
the words are the fact. The clause states counts, never a grade:

> 18 Aug 2026 · 00:00:05.671 – 00:00:45.004 · 5 steps · 4 steps not in the
> standard, 13 of the standard's steps not taken · Stopped before the end ·
> Open this recording

Worded from `differBlock`'s own sentences so the file and the screen cannot
describe one recording differently — the same rule that made `differBlock` carry
`Baseline.reason` verbatim.

### One legend, in one place

Three hues need one. It sits beside the **lead ledger in the editor masthead**
and is never repeated per row: four legends down a list is chrome, and the row
ledger is `aria-hidden` decoration beside words that already state the fact.

**The legend must say that a deviation is not a failure.** A colour key that
reads `canonical / deviated / stopped short` and stops has smuggled the grade
back in through the ordering. One clause, in the screen's own voice: the
standard is whichever way the recordings themselves most agreed on, and it moves.

## The record well splits

`## Recorded steps` is drawn from `HabitDTO.ways` as an instrument. Each step
shows its number, `from → to`, its actions, its observation line, and **opens
its own moment** at `firstAt`. The `<pre>` holds the record from the next
heading down.

This is the want that matters most for the screen's own argument: ledger marks
can open a recording (`c205413`, "a mark is a recording, so it can be opened"),
and the steps — the part a person is actually asked to trust — could not. The record was trusted rather
than verifiable.

**Not by parsing the markdown.** Two renderers of one file is the
`ax-dump`/`ax-exec` drift hazard, and `probe:habits` exists because nothing in
the suite can diff them. `habit-doc.ts` and the renderer both render steps, but
from the same `FlowStep[]` — neither one reads the other's output.

**A step with no `firstAt` is drawn and states its reason** — the
`StageSpec.skipReason` rule, and the same rule that already makes a mark with no
walk draw and say *"Not in a current route, so there is no moment to open"*. A
disabled control with no reason is indistinguishable from one nobody
implemented.

**The cut is two `indexOf` calls, in `habits-view.ts`.** `## How the recordings
differ` only exists at `count ≥ 2`, so the tail cannot be found by name. It is
"the first `\n## ` after `## Recorded steps`" — the same class of operation as
the `lastIndexOf` already in the `.tsx`, moved into the `.ts` where the root
suite can test it against a single-recording habit, a multi-Way habit and a
habit whose record ends at the steps.

## The dropped-early disclosure

On the **row**, not in the editor.

B already prints it through `cautionsFor`, so the `<pre>` says it — but that is
behind a selection, and the row is where the decision to open is made. The same
argument put `RECORDED ONCE` into `list_habits` rather than only into the file.

Drawing it in both the row and the editor masthead would be one fact stated
three times on one screen. This repo deleted the `×N` glyph for exactly that,
keeping the marks and the words and removing the third.

Wording follows `cautionsFor`'s, shortened for a row:

> also started and dropped early 2 further times

**It never changes the recording count.** `route.count` is the number of
recordings that walked *this* route. A disclosure, in the shape of `duplicates`,
and never a merge.

## What must never happen

- **No score, no ratio, no percentage, no streak, no grade.** Not "3 of 4
  conformant", not "75%", not a conformance bar. Counts and named states only.
  `FrameResult.score` is an ordering not a confidence, the UI shows rank and
  evidence, and a habit-strength number would be the same sin one layer up.
- **No `--data-warn` or `--data-alarm` on a conformance state.**
- **`fit: null` never draws as canonical.**
- **No prompt, no nudge, no "keep it up".** Readings, never prompts.
- **Nothing truncates.** A label fits or is withheld.
- **No `.tsx` for anything pure** — the root suite cannot reach it.

## Testing

Everything decidable is decided in `.ts` modules the root suite can import:

| Function | Where | Cases |
| --- | --- | --- |
| `markState` | `habits-view.ts` | lone; null fit; canonical; deviated; short; short-outranks-deviated |
| `markLabel` / `markReadout` | `habits-view.ts` | the clause at each state; absent when `fit` is null; no percentage |
| `recordTail` | `habits-view.ts` | single-recording habit; multi-Way; record ending at the steps; missing heading |
| `droppedEarlyLine` | `habits-view.ts` | none; one; several; count untouched |
| the DTO mapping | pure main module | `fit` null under B's guard; counts match `WalkFit`; `ways` letters match the record's |

The `.tsx` is verified by driving the running app, as every pixel rule on this
screen was: `npm run probe:habits` already asserts the page does not scroll and
no title is truncated, and the record well changing height will move both.

**Read the rendered screen, not the CSS.** Nearly every rule in
`docs/internals/app-ui.md` — the notched seam, the covered Inspect button, the
one-pixel playhead — was found with `getBoundingClientRect()` in the running
app and was invisible in the source.

## Honest states

- A habit recorded once: no conformance, no legend, hollow mark. Unchanged.
- A habit where every recording conformed: **pixel-identical to today.**
- An orphaned or ambiguous habit: no live route, so `walk` is null, so `fit` is
  null. The mark draws, says why, and offers nothing to open.
- A step whose edge carries no sources: drawn, disabled, reason stated.
- No prefix routes: no line. Measured — `probe:baseline` found 0 on this store,
  so this ships tested by fixtures and unexercised by real data, exactly as B's
  own caution did.

## Open derived requirements

- **`FlowStep.firstAt` claims to be "the first recording that walked it" and
  nothing guarantees it.** It reads `edge.sources[0]`, and sources accumulate in
  merge order as the graph is rebuilt, not in wall-clock order. Before a step
  opens a moment, verify the claim against the real store or sort explicitly —
  a step that opens the wrong recording is a dead link wearing a working one,
  and this is precisely the shape of bug the repo's three worst were.
- **The legend's wording needs to be read on screen, not in a diff.** It is the
  one place the no-grade rule is carried by prose rather than by structure.
- **`probe:habits`' geometry assertions will move** when the record well splits.
  Re-run and re-read; do not adjust the assertion to fit the new number without
  looking at the screen.
