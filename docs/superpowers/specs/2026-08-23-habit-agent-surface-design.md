# The agent surface — habits an agent can find, look at, and parse

**Date:** 2026-08-23
**Status:** designed
**Sub-project:** HABIT INSIGHT, D. Follows A (the record), B (the record's second
half), C1 (the ledger), C2 (the portrait and the rhythm strip) and C3 (the Way fork).

## Why

Everything the habit work has built so far is a surface for a **person**: a
screen with bands and a ledger, and a `HABIT.md` a human reads. The MCP endpoint
carries two habit tools, and both were written before the record had a second
half:

- `list_habits` prints the whole catalogue. An agent that wants one habit reads
  every habit — and a habit's composite (name, description, body) runs to
  roughly 1,500 tokens, so a library of thirty is a 45k-token read to answer
  "have they done this before?"
- `get_habit` returns one file verbatim, which is right, and is the end of the
  road. An agent that is *following* that file and is stuck at step 4 has
  nowhere to look: the file says `Calculator — no state → TextEdit — Untitled`
  and nothing shows what that looked like.

Meanwhile the record is prose. Prose is the correct format for the thing a human
keeps, and the wrong one for a thing an agent has to execute against: the steps,
their targets, the slots that varied and the state each step arrives in are all
in there, as markdown, to be re-parsed by every reader.

So: **find one habit by situation, look at one step, and get the steps as data.**

## What this is not

It is not a way for an agent to act, and it does not widen the read-only
guarantee by a byte. `test/mcp.readonly.test.ts` keeps its full force: every new
file lands under `app/src/main/mcp/`, where the guard `readdirSync`s and covers
it the day it appears.

**It is also not outcome reporting**, and that exclusion is deliberate rather
than deferred. `habit-doc.ts` says outright that `TraceEdge.outcomes` is
`{attempts: 0, successes: 0}` on every graph on disk, because passive recording
cannot observe a failure — the user did the thing. The only entity that could
ever fill it is an agent that followed a habit and reported back, and a tool
that accepts a report is a **write**. That is the one change this endpoint's
structure forbids, so it is not in scope here and must not arrive as a
convenience later.

## The naming constraint, which is load-bearing

`docs/todo.md` calls the retrieval tool `find_habit`. **It cannot ship under
that name.** `test/mcp.readonly.test.ts` asserts:

```ts
it("every advertised tool is a read", () => {
  for (const t of TOOLS) expect(t.name, t.name).toMatch(/^(search|get|list)_/);
});
```

That prefix rule is a cheap, blunt guarantee that an acting tool cannot be added
by accident. Widening it to admit `find_` would trade a real structural property
for a nicer word. The tool is **`search_habits`**, beside `search_experience`.

Two further naming traps in the same test, both of which would fail *after* the
code was written and read as mysterious:

```ts
expect(iface!).not.toMatch(/record\(|delete|remove|start|stop|arm|execute|write|put|set/i);
```

That regex runs over the whole `ExperienceReader` interface **body**, with no
word boundaries. So:

- `EmbeddingProvider.embed(inputs: string[])` cannot be mirrored verbatim —
  `in`**`put`**`s` matches. The reader's parameter is `texts`.
- No return shape may be written inline if it contains `startedAt` —
  `start`edAt matches. Every new return type is a **named interface declared
  outside the body**.

## The three tools

The endpoint goes from eight tools to eleven. Every one of them is a read, and
every one is named `search_` / `get_` / `list_`.

### 1. `search_habits(situation, limit?)`

**Two lanes, fused by rank.** This is Tier 1's own architecture at a smaller
scale, and it is chosen for the reason Tier 1 has already measured: on a default
install the lexical lane is the only route from a query to an exact term.

**The dense lane** embeds `title + description + prose body + apps` — the
**authored half** of the habit — through `providers.textEmbedder`, documents
with `role: "document"` and the query with `role: "query"` so nomic's asymmetric
prefixes apply.

It is the authored half and not the whole file, for two measured reasons:

- **Both pinned text models truncate hard at 2,048 tokens**
  (`NOMIC_PROFILE.maxTokens`, `EMBEDDINGGEMMA_PROFILE.maxTokens`), and D's own
  note puts the median composite at ~1,583. Embedding the whole file is one long
  habit away from silent truncation, and truncation here is not a clamp on a
  score — it is a document whose tail was never seen.
- **A duplicate pair's record blocks are byte-identical by construction.**
  `habit-text.ts` states it: both are re-rendered from the same live route,
  which is what made them duplicates, "so the only thing that CAN differ is the
  prose." A dense lane over the record cannot separate two habits that the app
  already knows are two descriptions of one procedure.

`apps` joins the document text because an application name is the most concrete
situational anchor a habit has, and it is one short line.

**The lexical lane** is BM25 over the **whole markdown**, computed in memory.
That keeps exact terms from the recorded steps — a button label, a URL, an app
— retrievable, which is the half the dense lane deliberately dropped. It is in
memory and not an FTS table because habits are `AUTHORED_TABLES`: adding a
derived table beside them would make "can a purge remake it?" a question with
two answers, for a corpus of tens of documents.

**Fusion** is `reciprocalRankFusion` from the barrel at `DEFAULT_RRF_K`.
`graph-view.ts` already imports a runtime value from `deskrag`, and vitest
aliases `deskrag` to `src/index.ts`, so the root suite reaches it without a
build.

`k = 5` is carried over rather than re-derived, and the reasoning that produced
it holds at this shape: the count term spans the number of lanes (2×), and the
rank term over a ten-long list spans `(5 + 10) / (5 + 1)` = 2.5×, so the rank
term stays wider and an exact match is not outranked by mediocre ubiquity.
**That is an argument, not a measurement**, and it is recorded here as such.

**NO SCORE.** The output is a rank and **which lanes matched** — the
`FrameEvidence` precedent, and the same rule `search_experience` already
follows. A fused RRF value is not a confidence and is not comparable between
queries; "matched: prose + exact terms" is something an agent can reason about,
and `0.83` is something it will report to a user as a percentage.

**The corpus is disclosed before the ranking, never after.** This is the whole
reason this tool can ship against a store with one kept habit. Below
`RANKING_MIN_HABITS = 5` the tool leads with the count and what it means:

- **0 kept:** the three distinct empty states `renderHabitList` already
  separates (no graph / a graph with no routes / routes nobody kept), reused
  verbatim rather than restated.
- **1 kept:** *"There is 1 kept habit, so it is the only candidate. Nothing was
  ranked against it."*
- **2–4 kept:** *"Ranked among N kept habits. A corpus this small ranks nearly
  everything — read the disclosures below before relying on the order."*
- **5 or more:** the ranking, with no preamble about size.

`RANKING_MIN_HABITS = 5` **ships unswept**, and joins the three floors C2 and C3
already shipped unswept (`RHYTHM_MIN_WALKS` / `RHYTHM_MIN_DAYS`, `FADE_MULTIPLE`
/ `FADE_FLOOR_MS`, `FORK_VERDICT_MIN_WALKS`). C2's own spec prediction was
falsified within six days when the library grew; treat this one with the same
suspicion.

**Degradation is stated, never silent.** The text model is a download. If
`embed` throws — the model is absent or the ONNX host is not up — the tool falls
back to the lexical lane alone and **says the dense lane was skipped and why**
(the `StageSpec.skipReason` rule). A quietly lexical-only ranking is
indistinguishable from a working one, which is precisely how the frame↔segment
gating bug survived.

**Unkept routes are counted, not ranked.** A proposal has no prose at all, so
there is nothing to embed and nothing to match; ranking one beside a kept habit
would compare a document with a shape. The tool names how many recurring routes
are unkept and points at `list_habits`, because silence there reads as "none".

### 2. `get_habit_step(habitId, step, way?)`

**Addressed the way the file prints it.** `recordedBlocks` numbers steps `1.`,
`2.`, … with no letter when the recordings agreed, and restarts numbering under
`### Way A` / `### Way B` when they did not. So `step` is **1-based**, and `way`
is a letter.

**`way` is required when the habit has more than one Way**, and refused when it
has one. Defaulting to A would answer about a different path than the agent just
read — and the file it read prints the letters, so the agent always has one when
one exists.

Returns, in a single call:

- **Text**: `from → to`, each action with its target, slot **names**, the step's
  `observations` and `everyRecording`, when it was first walked, and which
  recording that was.
- **The keyframe, as an image content block.** Resolved from
  `sessionDetail(sessionId).keyframes`: the **last keyframe at or before**
  `firstAt.atSec`. At-or-before because a step is an **edge** — its actions want
  the screen as it was when they began, which is the same rule `regionsAt`
  follows. When `atSec` precedes the recording's first keyframe the earliest is
  returned and the direction is disclosed.
- **The frame's regions**, from `store.getRegionsByFrame(frameId)`: role, label
  and bbox for each. Every one draws solid — there is no query here, so there is
  no `strength`, exactly as `ExperienceReader.moment` already documents for
  highlights.

**Every refusal states its reason**, and they are distinct situations:

| situation | what it says |
| --- | --- |
| unknown habit | `findHabit`'s existing message |
| `way` given, habit has one Way | the habit has one recorded way; omit `way` |
| `way` omitted, habit has several | the letters available, and that one must be chosen |
| `step` out of range | how many steps that Way has |
| `firstAt` is null | the edge carries no sources, so there is no moment to open |
| no keyframe in that recording | the step is real; the recording has no video |

### 3. `get_habit_steps(habitId)` — the `steps.json` sibling

JSON as text, so an agent can write it beside a pasted `HABIT.md`. Progressive
disclosure, the `SKILL.md` convention: metadata (`list_habits`), then body
(`get_habit`), then bundled files (this).

Per step: `index`, `edgeId`, the from/to node **id and label**, `actions`
(`action`, `target`, slot name), `observations`, `everyRecording`, `firstAt`,
`missing`, `liftWarnings` — plus the **destination node's `predicates` and
`locatable`**.

The predicates are what "anchors" means at this seam. There is no anchor on the
DTO layer; `GraphNodeDTO.predicates` is a node's whole identity, and it is the
field that answers *how do I know I have arrived*. `locatable: false` is the
matching disclosure: such a node "is satisfied by every observation in that
application, so it cannot answer which state this is". An agent handed a step
with an unlocatable destination should know it cannot verify arrival.

Resolution: `HabitStepDTO.from`/`to` are **labels**, not ids, so predicates come
from `flows().graph` — find the edge by `edgeId`, take its `to` node, read that
node's predicates. When the edge is `missing`, or the habit is orphaned and has
no live route, **the predicates are absent and their absence is stated in the
document**, never faked from the label.

Top level: habit id, slug, version, `routeKey`, and the Ways.

**Slot NAMES only. No recorded value ever appears in `steps.json`, and
`showSamples` is not consulted.**

This is stricter than "honour the toggle", and the reason is a rule already in
force one level down. `habit-marks.ts` drops the samples when it builds
`HabitStepDTO` and says why: *"Whether the rendered FILE prints values is a
per-habit toggle, and the DTO that feeds a pixel has no toggle — so it carries
no values at all."* The record is a file a person deliberately turned values on
for; a JSON payload handed to a background process over a socket is not. Gating
this on the toggle would be the weaker of the two available guarantees, and it
would put the leak one boolean away instead of zero.

So `HabitStepDTO.actions` gains `slot?: { name: string }` — the **name**, which
the record already prints unconditionally, and never the samples. The test is
therefore the stronger one: with `showSamples` **on**, no recorded value appears
anywhere in the JSON.

## The catalogue picks up B's and C's disclosures

`list_habits` was written when a habit was a title, a description and a step
list. It now has more to say, and an agent choosing between habits should not
have to fetch each file to learn it. Per habit, `habit-text.ts` gains:

- the applications the route passes through (`HabitDTO.apps`)
- the Way count, when it exceeds one — the recordings did not take the same path
- the fork verdict when one is named, and **its withheld reason verbatim** when
  it is not (`Verdict.withheld.reason` is required precisely so it can be
  printed)
- whether any recordings started this work and dropped it early
  (`droppedEarly`), as a count
- whether the prose was hand-edited (`HabitDTO.edited`) — it changes who is
  speaking in the file

Nothing here computes anything new; every field already crosses the seam.

## Files

| file | change |
| --- | --- |
| `app/src/main/mcp/habit-search.ts` | **new** — tokenizer, BM25, fusion, the corpus disclosure, the skipped-lane sentence |
| `app/src/main/mcp/habit-step.ts` | **new** — step address resolution, keyframe pick, the rendered step |
| `app/src/main/mcp/habit-steps-json.ts` | **new** — the JSON projection, values-free by construction |
| `app/src/shared/types.ts` | `HabitStepDTO.actions[].slot?: {name}` and `liftWarnings` |
| `app/src/main/habit-marks.ts` | `toStep` carries the slot NAME and the lift warnings |
| `app/src/main/mcp/habit-text.ts` | the catalogue's new disclosure lines |
| `app/src/main/mcp/tools.ts` | three `ToolDef`s; `TOOLS` and `SERVER_INSTRUCTIONS` |
| `app/src/main/mcp/reader.ts` | two reader methods, two named return types, three `ServiceReads` members |
| `app/src/main/deskrag-service.ts` | `embedTexts`, `frameRegions`; `sessionDetail` joins `ServiceReads` |
| `test/mcp.habit-search.test.ts` | **new** |
| `test/mcp.habit-step.test.ts` | **new** |
| `test/mcp.habit-steps-json.test.ts` | **new** |
| `test/mcp.tools.test.ts` | eleven tools |
| `scripts/mcp-probe.mjs` | eleven tools against the real store |

## The reader's new surface

Two methods and two named return types, written to clear the guard's regex:

```ts
/** A keyframe chosen for a step, with what was on it. */
export interface StepMoment {
  frameId: string;
  offsetSec: number;
  /** True when atSec preceded the first keyframe and the earliest was taken. */
  after: boolean;
  regions: RegionView[];
}

export interface RegionView {
  role: string | null;
  label: string | null;
  bbox: { x: number; y: number; w: number; h: number };
}
```

on `ExperienceReader`:

```ts
/** Null when no text model is ready — the caller degrades and says so. */
embed(texts: string[], role: "document" | "query"): Promise<Float32Array[] | null>;
/** The keyframe at or before a lane second, with its regions. */
momentAt(sessionId: string, atSec: number): StepMoment | null;
```

`ServiceExperienceReader` catches the embedder's throw and returns `null`, so
the pure half branches on a value rather than on an exception.

`ServiceReads` gains `embedTexts`, `sessionDetail` and `frameRegions`. None of
those names matches its guard
(`/\bclose\b|\bdelete|\bremove|startRecording|stopRecording|reindex|\bopen\(/i`),
and all three are reads.

## Error handling

`callTool` already converts anything thrown into a tool error, and that stays
the backstop. Everything foreseeable is a **message**, not a throw: an absent
model, an orphaned habit with no live graph, a step with no sources, a recording
with no video. The `search_experience` rule governs all of them — an empty or
degraded result must say which emptiness it is, because an agent handed a bare
one reports the wrong remedy to the user.

## Testing

The pure modules are the whole of the logic, so the root suite reaches all of
it with no Electron and no store:

- **`test/mcp.habit-search.test.ts`** — the tokenizer; BM25 ordering; fusion
  over two lanes; each of the four corpus-disclosure branches; that no output
  contains a score-shaped number; that a null embedder yields a lexical-only
  ranking **with** the skipped-lane sentence; that unkept recurring routes are
  counted.
- **`test/mcp.habit-step.test.ts`** — every address and every refusal in the
  table above; that the keyframe pick is at-or-before; that the before-first
  case is disclosed; that regions carry role, label and bbox.
- **`test/mcp.habit-steps-json.test.ts`** — the shape; predicates present for a
  live edge and **absent and stated** for a missing one; that an orphaned habit
  is refused with its reason rather than answered from a stale snapshot; and
  the leak test, in its strong form: with `showSamples` **on**, no recorded
  value appears anywhere in the JSON.
- **`test/mcp.tools.test.ts`** — eleven tools, each still a read.
- **`test/mcp.readonly.test.ts`** — unchanged, and must stay green untouched.
  If it needs an edit, the design is wrong.
- **`npm run probe:mcp`** — the only place these meet a real store. Extended to
  call all eleven tools over a real socket, including `search_habits` against a
  one-habit corpus, which is the case whose disclosure this spec turns on.

## What ships unfalsifiable, and is said so out loud

Three things here cannot be exercised by the library that exists, and each joins
a list this project already keeps:

1. **`RANKING_MIN_HABITS = 5`** — the store has one kept habit, so only the
   `1 kept` branch will ever run. The other three are fixture-tested.
2. **The `2–4 kept` and `5 or more` branches of the disclosure** — same reason.
3. **A multi-Way `get_habit_step` refusal** on real data — MEASURED REACHABLE,
   not assumed. `probe:fork` reads five routes over eight recordings, one of
   which (`Calculator → TextEdit`) has four Ways, and the single kept habit
   `compute-sum-in-calculator-and-paste-to-textedit` binds to exactly that
   route. So `probe:mcp` must exercise the missing-`way` refusal rather than
   leave it to a fixture.

Item 3 is the interesting one: it was written into this list on the assumption
it was unreachable, and checking `probe:fork` falsified that within a paragraph.
That is C2's lesson arriving again, and it is why every claim of
"unexercised" in this document should be re-read rather than trusted.
