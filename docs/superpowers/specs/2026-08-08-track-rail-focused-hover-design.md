# The track rail's hover card — focus the lane the cursor is on

**Date:** 2026-08-08
**Status:** designed
**Amends:** `2026-08-02-library-timeline-tracks-design.md` and
`2026-08-06-visual-state-keyframes-and-track-rail-design.md`. The rail, its four
shapes, its bands and its axis are all unchanged. Only what the hover card
*contains* changes.

## Why

The rail carries sixteen lanes and the hover card resolves every one of them at
the cursor. That was the right answer to "what was happening here" and it is the
wrong answer to "what does this bar say".

Measured on a real 29s recording: hovering the `apps` lane produced a card of ten
rows, ~550px tall, in which the answer — `Calculator` — was the second row and
the shortest string on it. Four of the rows were VLM captions (`keyframes`,
`action`, `task`, `caption`), each clamped to three lines and each describing the
same instant in nearly the same words. The card is legible; the *answer* is not
findable in it.

The cause is that the card is lane-blind by construction. `onMouseMove` on
`.tracks__body` derives only `sec` from `clientX`, so the pointer's vertical
position — the entire content of the gesture "this bar, here" — is discarded
before `readoutAt` is ever called.

## What supersedes what

CLAUDE.md currently records:

> **The hover card reports EVERY lane, including collapsed ones.** Collapsing
> chooses how much of the plot to show; it must not quietly drop evidence.

That rule stands for its own case and is not weakened here: a collapsed band's
lanes still appear in the card, because collapsing is a persistent choice about
the plot and must not silently cost evidence. What changes is that **the card now
distinguishes the lane you pointed at from the lanes you did not**. Both are
still reported. A hover is a pointing gesture and carries an argument; band
collapse does not.

## The three states

One component, one pure resolver, three renderings.

### 1. Over a lane

```
┌──────────────────────────────────┐
│ 0:08                             │   head — timecode, unchanged
├──────────────────────────────────┤
│ APPS                             │   FOCUS — the lane pointed at. Title on
│ ■ Calculator                     │   its own line; value at the existing
│                                  │   3-line clamp.
├──────────────────────────────────┤   divider
│ keyframes   DeskRAG Recorder w…  │   CONTEXT — every OTHER lane carrying a
│ action      Recorder captures …  │   value, one dimmed line each, in rail
│ caption     Recorder captures …  │   order.
│ clicks    ■ click                │
│ mouse x/y   0.15 screen          │
└──────────────────────────────────┘
```

### 2. Over a lane with nothing at that instant

The focus block still renders, carrying the lane's `emptyReason` (`no scrolling
recorded`) or, for a lane that has data elsewhere but none here, `nothing here`.
Context is unchanged.

**Pointing at a lane always gets an answer about that lane.** Today such a lane
is simply omitted from the rows, which is correct for a list and wrong for an
argument: a card that answered about five other lanes and not the one under the
cursor reads as broken rather than as informative.

### 3. Over no lane

A band header, or the empty space below the last lane. There is no pointing
gesture, so the card answers everything: head plus all rows in the full style, no
focus block and no divider. This is today's card exactly — not a third rendering
but the *default* one, which is what keeps the change additive.

It also leaves the all-lanes correlation view reachable, which matters because
that view is the reason the rail exists.

## The keyframes carve-out needs no code

Hovering `keyframes` puts the frame's caption in the focus block at full clamp
and every other lane beneath it — which is the "show all the other tracks" case,
arrived at by the general rule. Special-casing one lane id would have been a
policy in the renderer with nothing enforcing it; there is none.

## Where the lane id comes from

`.tracks__lane` gains `data-lane={lane.id}`. `onMouseMove` reads:

```ts
(e.target as HTMLElement).closest(".tracks__lane")?.dataset.lane ?? null
```

This is sound because `.tracks__axis` — the box holding the playhead and
crosshair, which spans every lane — is already `pointer-events: none`
(`styles.css:2125`). The real event target is therefore always a lane descendant,
a band header, or `.tracks__inner`. `Hover` gains `laneId: string | null`.

No new listener and no per-lane handler: sixteen lanes × four shapes would be
sixteen more places for the rule to drift, and the rail already has exactly one
mousemove.

## The pure function

`readoutAt` gains an optional `focusLaneId` in `ReadoutOptions` and returns:

```ts
export interface Readout {
  timecode: string;
  /** The lane the cursor is on, resolved. Null when the cursor is on no lane. */
  focus: ReadoutRow | null;
  /** Every OTHER lane with a value, in rail order. Never contains `focus`. */
  rows: ReadoutRow[];
}
```

Two properties are load-bearing:

- **The focused lane is removed from `rows`.** A lane appearing twice in one card
  is the card contradicting itself about what it is emphasising.
- **Omitting `focusLaneId` yields `focus: null` and today's full `rows`.** State 3
  is the function's default rather than a branch, and every existing
  `readoutAt` case in `test/track-view.test.ts` passes untouched.

All resolution stays in `track-view.ts`, which is pure and root-tested.
`TrackRail` supplies the id and renders; it decides nothing about what a lane
says. Same division as `keyframeLabel` being injected rather than imported.

## The rail says which lane the card is about

`.tracks__lane[data-hovered]` gets a faint surface tint and a 2px `--accent` bar
at the gutter edge.

Without it the card names a lane and nothing on screen connects the name to a
row — the reader has to read the card's title to discover what they are pointing
at, which inverts the gesture. It also makes the focus visible during the
vertical travel between lanes, where the card's contents are changing fastest.

`--accent` is correct here and not a data colour: this is the INSTRUMENT
register (selection and focus), which the rail's two-register rule puts above
OKLCH L 0.67, distinct from the `--data-*` band a lane tone is drawn from.

## Truncation

Context values clamp to **one** line; the focus value keeps the existing three.

This is not a new exception to "nothing in the rail truncates". That rule governs
the plot — `labelFits` withholds a bar's label rather than clipping it — and the
card is already a stated exception: `.tracks__tip-value` clamps to three lines on
the reasoning that the card is a glance and `DetailView` plus the chapters menu
carry the record. Context rows tighten that same exception; the row the reader
asked for is the one that does not tighten.

## CSS

New: `.tracks__tip-focus` (title block plus value at 3 lines), a divider before
`.tracks__tip-context`, and a `data-compact` modifier on the rows grid that drops
the clamp to one line and the colour to `--muted`. `.tracks__tip`'s
`max-width: 320px` and viewport clamping are unchanged — the measured
`useLayoutEffect` positioning already handles a card of any height, and this one
is shorter than what it was built for.

## Testing

`test/track-view.test.ts` (root suite, since `track-view.ts` is `.ts` precisely so
the root tsconfig can reach it):

- a `focusLaneId` naming a lane with a value extracts it into `focus` and it does
  not appear in `rows`
- omitting `focusLaneId` reproduces today's output exactly — `focus` null, all
  rows present
- a `focusLaneId` naming a lane with no value at `sec` still yields a `focus` row,
  carrying `emptyReason` where the lane has one
- a `focusLaneId` naming a lane that does not exist behaves as if omitted

Then `run-app` against a real recording. A card's height and legibility is
exactly the class of fact the suite cannot see — the rail's per-bucket rate bug
and its 1px playhead were both found by driving the app and neither by an
assertion.

## Out of scope

- Click-to-pin the card. The card is `pointer-events: none` and stays that way;
  pinning means a focus trap and a dismissal rule for a glance surface.
- Any change to which lanes exist, their shapes, their order, or their bands.
- Any change to `session-tracks.ts` or the DTO. `TrackLaneDTO.id` already carries
  everything this needs.
