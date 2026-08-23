# The Portrait, the Rhythm and the Quiet — Sub-project C2

**Status:** design, approved in chat 2026-08-23
**Consumes:** sub-project A (`walk-analysis.ts`, PR #71), B (the record's second half, PR #72), C1 (conformance on the ledger, PR #73)
**Followed by:** C3 (the Way A/B fork diff) and D (the agent surface), each with its own spec

## Why

`docs/post.md` gives three lessons. **Consistency Wins** is served thoroughly —
bands ordered by what needs answering, the recurrence ledger, `RECORDED ONCE`
said in words, and since C1 the conformance hues. **Identity and Action** and
**Power to Change** still have no surface.

C2 builds them:

- *Identity and Action* — "your routines are proof of who you are" — becomes a
  **portrait band** under the `<h1>What you do repeatedly</h1>` that today heads
  a file list and answers its own question with nothing.
- *Consistency*, in its measured form — context stability is the driver of
  automaticity, so a habit done every Tuesday at 9am and one done at random must
  not draw identically — becomes a **rhythm strip in phase**, hour-of-day ×
  day-of-week, beside the existing absolute-wall-clock ledger.
- *Power to Change* becomes a **"Not walked lately" band**: a habit that had a
  cadence and has gone quiet.

## The corpus, measured before designing

Read read-only from the real store on 2026-08-23
(`~/Library/Application Support/deskrag-app/DeskRAG/app.db`, app not running):

| fact | value |
| --- | --- |
| recordings | **8**, spanning Aug 17 → Aug 22 — **six days** |
| the Aug 20 cluster | **four recordings inside four minutes** (11:00, 11:01, 11:03, 11:04) |
| kept habits | **1** — *Compute sum in Calculator and paste to TextEdit* |
| its walks | Mon 11:14, Mon 20:45, Thu 11:00 — **3 walks across 2 distinct days** |
| its median inter-walk gap | ~36h; quiet as of 2026-08-23: ~72h |
| trace graph | 25 nodes, 58 edges, 65 edge sources |

**This measurement is the spec's central constraint, and it is why two of the
three surfaces ship with their firing paths unexercised.** Deferring them was
considered and rejected in chat; instead each declares its own insufficiency,
the `StageSpec.skipReason` precedent — *a stage that merely never appears is
indistinguishable from one nobody implemented.* The accepted cost is two more
entries in the fixture-tested-and-unexercised list that `docs/todo.md` already
keeps for B's `droppedEarly` and its idle line, and C1's two.

The rejected alternative worth recording: a fade rule with **no absolute floor**
adapts to any cadence and needs no arbitrary constant, and on this library it
would call a healthy three-day-old habit fading within about two days. The Aug 20
cluster would set a ~1-minute cadence and mark that route fading by lunch. That
is `post.md`'s measured backfire arriving on day one, and it is what the floors
below exist to refuse.

## What this is not

- **Not a score.** No ratio, percentage, streak, grade or fitness float, on any
  of the three surfaces. This is the same constraint C1 shipped under and it is
  not relaxed by the fade verdict: "last walked 6 weeks ago" is a fact,
  "6 weeks behind" would be a scoreboard.
- **Not a change to the record.** No new markdown block, no change to
  `recordedBlocks()`, no new prose, no model call. The portrait, the grid and
  the fade verdict are readings on screen only. `probe:habits`'s byte-identity
  assertion (`get_habit` === clipboard) is the guard that this held.
- **Not the Way A/B fork diff.** That is C3.
- **Not staleness in HABIT.md.** An agent might want to know a habit has gone
  quiet, but putting it in the file is a deliberate decision about what a record
  is, and it belongs to D.
- **Not a fade for proposals or for archived habits.** A proposal has no keeping
  act to fade from; archiving is a deliberate setting-aside, and calling it
  fading would relitigate a decision the person already made.

## Architecture

All three readings are projections over DTOs **already on the wire** — walk
timestamps and route labels. So they live in the renderer as `.ts` modules,
reachable from the root suite, and main changes by exactly one field.

| file | responsibility |
| --- | --- |
| `app/src/renderer/src/habit-portrait.ts` *(new)* | what the head band says: places, weighted; and coverage |
| `app/src/renderer/src/habit-rhythm.ts` *(new)* | what the walk **times** say: the phase grid, the cadence, the fade verdict |
| `app/src/renderer/src/habits-view.ts` | gains a `fading` band in `HabitBands`; asks `habit-rhythm.ts` for the verdict |
| `app/src/renderer/src/screens/HabitsScreen.tsx` | `<Portrait>` in `<Head>`; `<Rhythm>` in `habitedit__evidence`; a fourth `<Band>` |
| `app/src/renderer/src/styles.css` | `.portrait*`, `.rhythm*` |
| `app/src/main/deskrag-service.ts` | one line in `toHabitDTO`: `apps: flowApps(flows, bound.route)` |
| `app/src/shared/types.ts` | `HabitDTO.apps: string[]` |

**One module for the grid, the cadence and the fade**, because all three read
`walks[].at` and separating them would duplicate the "is there enough here to
say anything" judgement in two places — the `ax-dump`/`ax-exec` drift hazard by
name, one layer up.

**`now` is injected.** Same rule as the `wallClock`/`timecode` formatters
threaded into `markReadout`: a root test cannot depend on the wall clock, and a
fade rule read against a live clock is untestable by construction.

`.ts` and never `.tsx`, because the root `tsconfig.json` sets no `jsx`.

## The portrait band

Under the `<h1>`, two readings:

**Where it happens.** Every application named by a *recurring* route — kept
habits, plus proposals with `count > 1` — each weighted by that route's
recording count, ordered by weight, drawn as a bar per app. Ties break on first
appearance, so the order is stable across reloads. Routes walked once are
excluded: the h1 asks what you do *repeatedly*, and a route seen once is an
observation.

**What recurs.** One line:
`N recordings walked a route · M routes · K walked again · J written down`.

Every count on that line is over **recurring routes only**, the same set the
bars are drawn from — a coverage line counting routes the bars exclude would
contradict the picture above it. `K walked again` is therefore `M`, restated for
a reader who has not yet learned that the portrait excludes the once-walked; it
is printed because "5 routes" alone invites the question, and dropping it would
leave the exclusion undisclosed.

`N` is the count of **distinct session ids across all walks**, and it is worded
as *"recordings walked a route"* — never as the library total. Some recordings
walk no route at all, so "8 recordings" would be a number the screen cannot
back. Deriving it from the walks already on the wire also means it can never
disagree with the ledger drawn beside it.

**The coverage line is the portrait's own honesty.** There is no separate
insufficiency state: with a thin library the portrait says something true and
small, and its smallness is the disclosure. It degrades gracefully in a way the
other two surfaces cannot, which is why it is the one that fires today.

## The rhythm strip

A **7 × 24 grid** — day-of-week down, hour-of-day across, 168 cells — in
`habitedit__evidence`, beside the lead `Ledger`. The ledger answers *when in
your life*; this answers *where in the week*. Local time, from `walks[].at`,
which is wall-clock ms and display-only by contract.

The joint grid was chosen over separately-drawn axes and over coarse four-hour
buckets. The joint **is** the thing context stability means; the marginals can
say "Tuesday" and can say "9am" but not that they co-occur, and a four-hour
bucket puts 11:55 and 12:05 in different blocks for no reason a reader can see.

### The floor

> Draw the grid when a habit has **≥ 4 walks across ≥ 3 distinct calendar
> days.** Otherwise draw nothing and say what it has.

Both halves are motivated by an artifact in this store rather than by taste. The
walk count alone is insufficient: **four recordings inside four minutes** passes
any walk-count floor and is one sitting, and a grid drawn from it would read
*"you do this Thursdays at 11am"* from a single afternoon. The distinct-day half
refuses that. The walk-count half keeps a three-point grid — three dots in 168
cells — off the screen.

Below the floor the strip states what it has, in the shape of the numbers it
actually holds: *"Three walks, on two days — too few to place in the week."*
Never "unknown", never absent: an absent strip is indistinguishable from one
nobody implemented.

**Both floors in this spec ship UNSWEPT and are declared so**, in the module's
own comment and in `docs/todo.md`, alongside `mpdecimate`'s `lo=1280` and the
patch-highlight floor. A 6-day library cannot falsify them.

## The "Not walked lately" band

A fourth band in the list, **between Kept and the proposals**. Kept, non-archived
habits only.

```
fading  ⇔  walks ≥ 3
           ∧ quiet > max(3 × median inter-walk gap, 4 weeks)
```

- **`walks ≥ 3`** is what makes a cadence estimable at all: two walks give one
  gap, and one gap is not a cadence.
- **The median**, not the mean: the Aug 20 cluster shows exactly how a handful of
  back-to-back walks drags a mean toward zero and manufactures a tiny cadence.
- **`× 3`** is the multiple of its own rhythm a habit must exceed. A habit one
  cycle late is due, not fading.
- **`quiet`** is `now − max(walks[].at)` — time since the *last* walk, never
  since the habit was kept. A habit written down in March and walked yesterday
  has not gone quiet.
- **`4 weeks` absolute** is the load-bearing parameter, and the only thing
  standing between this band and the day-one backfire. It is what keeps the rule
  silent on the real store today: `max(3 × 36h, 672h) = 672h` against 72h quiet.

Each row states the **fact**, not a verdict:
*"about every day and a half · last walked 6 weeks ago"*. The band head is
**"Not walked lately"** — the flattest available wording, chosen over "Fading"
for the reason `post.md` gives.

Banding order becomes: Needs attention · Kept · Not walked lately · Repeated —
not yet kept · Seen once · Archived. `bandOf` checks archived first, then
attention (a moved binding is the thing that can be silently *wrong*), then
fading, then kept.

## Colour discipline

The place bars and the grid's filled cells both take **`--data-0` (teal) at
varying lightness** — one hue, one ramp, no indexed palette.

`--data-0` specifically because it is the one slot C1 left unclaimed on this
screen. Using a slot at varying lightness is not the thing the validator forbids;
hand-editing a slot's definition is, and nothing here does that.

C1 put conformance on `--data-2` (violet) and `--data-3` (clay). An app bar in
violet a few hundred pixels above a violet *deviated* mark would assert a
relationship that does not exist — and `styles.css` is one global sheet with no
scoping, so a colour's meaning is a repo-wide claim exactly as a class name is.
Nothing in C2 may use `--data-warn`, `--data-alarm` or `--data-ok`: none of these
three readings is a warning.

## Testing

**Root suite** — the projections, which is what `.ts` buys:

- `test/habit-portrait.test.ts` — weighting, the once-walked exclusion, the
  distinct-session count, the coverage wording at one route and at many.
- `test/habit-rhythm.test.ts` — both floor boundaries with the
  four-walks-one-day cluster as a **named fixture**; local-time bucketing
  including a walk either side of midnight; the fade rule at each of its three
  guards, with `now` injected; median-not-mean, using the cluster.
- `test/habits-view.test.ts` — the `fading` band: that archived does not fade,
  that attention outranks fading, that the order is as specified.

**Real app** — what no suite can reach, driven with the `run-app` skill against
the store measured above:

- the portrait band's geometry, that nothing truncates, and that the page does
  not scroll horizontally;
- the rhythm strip showing its **insufficiency sentence** for the real kept
  habit, with the real numbers in it;
- that **no "Not walked lately" band renders** — the rule's silence today is a
  prediction this spec makes, and checking it is how the prediction is tested.

**`npm run probe:habits` stays green.** That is what proves the record did not
move.

## What is recorded in docs/todo.md when this ships

- Both floors, as unswept parameters, with the corpus that would falsify them.
- The two firing paths that ship fixture-tested and unexercised — the grid and
  the fade band — joining B's `droppedEarly` and idle line and C1's two, all of
  which want re-reading the next time the library grows.
