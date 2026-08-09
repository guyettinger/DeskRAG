# Compositional segment hierarchy — Action → Task → Process → Session purpose

Date: 2026-08-09
Status: design, approved for planning

## The problem, stated structurally

On the Library rail, the `ACTION`, `TASK` and `CAPTION` lanes read as three
drawings of one signal. They are.

- `src/segment/types.ts` — `action` and `task` are both boundary-aware windows
  over the **same** event timeline. They differ only in which boundary reasons
  cut them (`action`: `scene_change`/`focus_change`/`bookmark`; `task`:
  `focus_change`/`bookmark`) and in duration (`task.targetMs` is the session
  length ÷ 2, clamped to 30–180s). A task is not a bigger *idea*; it is a
  longer *box*.
- `app/src/main/session-tracks.ts` — `segmentLabel` is
  `caption ?? digest ?? boundaryReason`, so both lanes are labelled by a VLM
  caption.
- `captionLane` is `presenceLane(…, finestGranularity)`, and the finest
  granularity is `action`. **The CAPTION lane is the ACTION lane filtered to
  segments that got a caption** — identical spans, identical text.
- `src/represent/caption/prompt.ts` instructs the VLM to *"Describe what is on
  screen concisely and factually… One or two sentences"* over three sampled
  keyframes. Run that over a 30-second window and the output is still a
  screenshot description. **A task caption cannot sit at a higher altitude than
  an action caption**: same model, same prompt, same kind of input, bigger box.

So the hierarchy today is **temporal, not compositional**. Nothing in the
pipeline ever takes N actions and asks *what did these accomplish together?*

That is the layer this design adds. The levels above `action` need a different
kind of input — the children's *text*, not more pixels — and a different
question — *purpose*, not appearance.

## Decisions taken

| Decision | Choice |
| --- | --- |
| Level count | **Recursive until one root.** Level 0 is always Action, the root is always Session purpose; depth falls out of the recording. |
| Where structure comes from | **Bottom-up contiguous agglomeration**, never top-down decomposition. |
| Who judges coherence | **A local LLM partitions *and* names in one call**, with structural coherence as the fallback. |
| Default install | The tree **always exists**; a configured model upgrades the prose. |
| Rail vocabulary | Level 1 = `TASK`, level 2 = `PROCESS`, 3+ = `LEVEL N`, root = `SESSION`. |
| Scope | All three pieces in one spec: the hierarchy, retrieval at altitude, and the Flows/Library readers. |

### Why not top-down decomposition

Handing the whole session's action summaries to an LLM and asking for a plan
tree reads the most like a person's account of their own work, and it is ruled
out twice. It does not scale — a 3h session has thousands of actions and they
do not fit one context, so it fails exactly where hierarchy matters most. And it
makes the *structure*, not only the prose, depend on a model the default install
does not have. Bottom-up also keeps every node **grounded**: a parent's span is
exactly the union of its children's, so no node can claim time nothing was
recorded in.

### Why the LLM judges the grouping and not only the naming

Two reasons; the second is a defect in the purely structural version.

1. **Naming is the test of a group.** If the model cannot name a run, it was not
   one. Split the jobs — cosine picks the group, the model writes prose about it
   — and the namer is stuck justifying a grouping it would not have chosen.
   That is precisely how `"Recorder app capturing screen…"` ends up sitting at
   task level today: the bug being fixed, reproduced one layer up.
2. **Cosine coherence is biased against what a task is.** Embedding similarity
   merges things that *look alike*. A task is usually goal-directed
   *heterogeneity* — open terminal, run build, read error, edit file, run build
   again. Those five actions are maximally dissimilar and span three apps with
   several focus changes, so both the cosine term and the app/focus term shred
   them; meanwhile a cosine grouper confidently fuses ten minutes of repetitive
   scrolling into one "task". The structural signals are *correlates* of intent,
   and this is the case where they are anti-correlated.

**Point 2 is a hypothesis, not a finding.** It is measurable and the spec
requires it to be measured (see Validation).

### Scope note, recorded deliberately

The recommendation was to spec the hierarchy alone and brainstorm retrieval and
the readers afterwards, against a real recording — because what a good task
summary actually looks like is the input to both, and neither is known yet. The
full arc was chosen instead. Sections 5 and 6 therefore rest on one stated
assumption: **that level-1 summaries are short goal phrases rather than
screenshot descriptions.** If the first real recording falsifies that, sections
5 and 6 need revisiting; section 3's prompt and fallback do not.

## 1. Data model

Levels are **`segment` rows**. `segment`'s shape is frozen — there is no
migration mechanism, only `CREATE TABLE IF NOT EXISTS` on every open — so
levels reuse the existing free-form `granularity TEXT`, and everything new is a
table.

- Level 0 keeps `granularity = "action"`. Those are today's rows, unchanged.
- Composed levels are `"level:1"`, `"level:2"`, …
- The root is `"session"`. Recursion stops when one node covers the recording,
  so the top level always holds exactly one row.
- **`task` is removed** — the granularity is deleted from `BASE_GRANULARITIES`
  and no longer produced or read.

### Existing data is discarded

This change ships with a **data-dir reset**: no existing recording is migrated,
re-indexed, or read. That is a deliberate authorization, and it removes work
that would otherwise be required — no `task`-compatibility path on the rail, no
rebuild banner, no re-index affordance, and no "does an old `app.db` gain the
table" verification.

It does **not** license changing `segment`'s shape. The absence of a migration
mechanism is a permanent property of the store (`CREATE TABLE IF NOT EXISTS` on
every open), so a column added now would still be unreachable on the next
person's database without another reset. Levels stay `segment` rows keyed by the
existing `granularity` column, and everything new stays a table — the sanctioned
move, which costs almost nothing here.

Two new tables:

```sql
CREATE TABLE IF NOT EXISTS segment_tree (
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  parent_id  TEXT NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
  child_id   TEXT NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX IF NOT EXISTS idx_segtree_child   ON segment_tree(child_id);
CREATE INDEX IF NOT EXISTS idx_segtree_session ON segment_tree(session_id);

CREATE TABLE IF NOT EXISTS segment_summary (
  segment_id TEXT PRIMARY KEY REFERENCES segment(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL   -- 'llm' | 'template'
);
```

**Edges are stored, not derived from spans.** A parent's span is exactly its
children's union, so interval containment *looks* sufficient — until a parent
with a single child has an identical span and containment cannot say which is
which. Explicit edges are unambiguous and cost nothing.

**The summary is not the `digest` column.** `digest` means templated text over a
segment's *own events* and owns a Tier-1 vector namespace. A parent's summary is
composed from *children*. Writing it into `digest` would put two different kinds
of text in one similarity space — the exact thing `namespaceFor` exists to
prevent.

**`source` is disclosure, not bookkeeping.** It records which parents got a real
sentence and which got a structural rollup, the same refusal to smooth over a
real difference that `clockCalibrated` and `observations`/`sources` make.

**Invariant:** a `segment_summary` row exists **iff** the segment is a composed
level (≥ 1). Level 0 is labelled `caption ?? digest` as today — a summary of one
action would only restate it.

**`finestGranularity` is unaffected and must stay that way.** It picks the
granularity with the most rows, which is `action` both before and after this
change — composed levels are strictly fewer by construction. The transcript and
caption presence lanes therefore keep keying on level 0, which is what they
want: the finest granularity is the one that shows where a view actually starts
and stops.

**Deletion.** Both tables cascade from `session`/`segment`, so `deleteSession`
needs no new explicit clear (unlike `region_fts`/`segment_fts`, which have no
foreign key). This must be verified, not assumed.

## 2. The composer

New always-on stage `src/represent/compose/`, running **after** Digest, Caption
and Transcript (it needs their text) and **before** the always-on `segment_fts`
stage (so summaries reach the lexical lane).

The judgment core is `compose/agglomerate.ts` — **pure TS**: children in, groups
out, no store, no provider, root-testable like `track-buckets.ts` and
`graph-view.ts`. The stage does the I/O.

### Provider contract

```ts
export interface SummaryProvider {
  readonly id: string;
  readonly model: string;
  compose(children: ChildSummary[], ctx: ComposeContext): Promise<ComposeGroup[]>;
}

export interface ChildSummary {
  index: number;
  text: string;
  app: string | null;
  url: string | null;
  startSec: number;
  endSec: number;
}

export interface ComposeGroup {
  start: number;   // inclusive child index
  end: number;     // exclusive child index — DERIVED, see below
  summary: string;
}

export interface ComposeContext {
  /** 1 for the first composed level, 2 above it, and so on. */
  level: number;
  /** Name the whole list as ONE activity rather than splitting it. */
  single?: boolean;
}
```

The model works in **indices, never times**, so it can only choose cut points
among children that exist and cannot invent a moment nothing was recorded in.

**It is asked for CUT POINTS, not ranges — amended 2026-08-09 after measuring.**
Asked for `{start, end}`, `qwen3-vl:4b` returned a genuinely good three-task
grouping of 24 real steps that ended at index **23**: it dropped the last step,
so the covering check discarded all of it. Naming where a run ENDS is the only
thing it got wrong, and it is the one thing it never needs to say. The model now
states only where each run BEGINS; `parseComposeResponse` closes each cut
against the next and the last against the block's end, so a gap, an overlap and
a short cover are **impossible to express** rather than rejected after the fact.

This does not soften the reject-wholesale rule — it changes what is ASKED for,
never what is accepted. Cut points are still validated (ascending, first is 0,
in range, integer) and a violation still discards the whole reply. Measured on
one real recording, model-named nodes went **3 of 31 → 8 of 9**.

**The ROOT gets its own call** (`single: true`, `NAME_SYSTEM`). The final
collapse asks the model to split a two-item list, which it answers with two
groups every time (3 of 3 trials) — two does not shrink, so it is correctly
rejected and the session's purpose was a rollup on every run. Naming is a
different question from splitting. Failure leaves the rollup standing with
`source: "template"`, so composing still cannot fail the run.

**One prompt serves every level.** At level 1 the input is action captions; at
level 2 it is level-1 goals, and composing goals into bigger goals is the same
instruction with `level` passed as context. Recursion needs exactly one prompt.
It asks for contiguous runs, each one thing the user was trying to accomplish,
named in one short phrase stating the **goal, not the appearance**.

The provider is local, over Ollama, with model discovery through `/api/tags` —
never a hardcoded name, for the reason `listModels` already exists: Ollama's
library now includes cloud-hosted models, and offering one in a local picker
would route a user's activity off the machine. A `FakeSummaryProvider` keeps the
suite deterministic and offline.

**Two adapter facts, both measured on `qwen3-vl:4b` and both silent failures.**
A THINKING model routes its structured answer into `message.thinking` and leaves
`content` empty — even with `think: false`, because Ollama applies the JSON
format constraint to whichever channel the model writes. Reading only `content`
made the adapter silently incompatible with every thinking model: the composer
would take the structural path forever with nothing saying why. Both channels
are read, content first, and the partition is validated either way. And thinking
ON never returned at all on a 30-step prompt, where `think: false` answered in
1.4s — so the request asks for a partition, not a monologue.

### Validation is code, never a request to the model

A returned partition must be contiguous, non-overlapping, covering, and must not
cross a barrier. Any violation **rejects the whole response** and that block
falls back to structural composition. It is **not repaired** — repairing a
malformed partition means guessing intent, which is the rule
`parseInterventionResponse` already sets in `trace/`: a malformed reply is
refused, not widened.

### Scale, without a seam trick

Barriers (`bookmark`, session bounds) pre-split each level into blocks. A block
longer than the batch cap is split further at its largest **structural**
discontinuity — biggest gap, then focus change — deterministically, until every
block fits one call. Groups never span a block, so there is no cross-batch
stitching to get wrong.

The batch cap starts at **24 children** and is a calibration target, not a
tuned value: it trades context length against how often a real run is forced
apart, and the first real recording is what sets it.

Disclosed cost: on a very long level, a parent cannot span a forced cut.

### Termination is enforced, not hoped for

Each level must be **strictly smaller** than the one below. If the model returns
a partition that does not shrink a block, that block takes the structural
grouping, which always shrinks. Recursion stops when one node covers the
recording; that node is the root, `granularity = "session"`, and its summary is
the session's purpose.

### Structural fallback — the always-on path

Adjacent-sibling coherence from what is already on disk: same app, same `url`
prefix, gap at the seam, boundary strength at the seam. Greedy-merge the
best-scoring adjacent pair until the level's node count is **at most half** the
level below it — which is what guarantees the strict shrinkage the recursion
depends on.

The parent's text is a rollup in `buildDigest`'s own vocabulary — apps spanned,
typed text, click targets, child count — which is a concatenation discipline
over text that already exists, not new extraction.

This path is also the **control** the LLM is measured against.

### Compose cannot fail the run

A provider error, a timeout, an unparseable reply, or no Ollama at all each
degrade that block to structural and stamp `source = 'template'`. Unlike
Transcribing this needs no special dispensation, because there is no path where
it throws.

## 3. The rail

**Lanes are ordered coarse → fine, top-down**, reversing today's arrangement.
`SESSION` above `PROCESS` above `TASK` above `ACTION`, so each bar visibly
contains the bars beneath it and the rail reads as an outline. `segmentLanes`
stops sorting alphabetically and orders by level; `bandedLanes` keeps them all
in the `segments` band.

**Titles** index from the bottom: level 1 = `TASK`, level 2 = `PROCESS`, 3+ =
`LEVEL 3`, `LEVEL 4`, root always `SESSION`. A five-deep recording reads
`SESSION · LEVEL 4 · LEVEL 3 · PROCESS · TASK · ACTION` — the named levels stay
at the bottom where they are familiar, the generic ones sit where nobody has a
word anyway.

**`TrackLaneDTO` gains a required `level: number | null`** (null for every
non-hierarchy lane), so the renderer can indent lane titles by depth. Required,
not optional, for the reason `showLabels` and `TrackGroup` are: the compiler
then finds every builder and every fixture.

**Composed levels set `showLabels: true`; `action` keeps `false`.** This is the
direct fix for the reported defect. A level summary is a short goal phrase by
construction, so `labelFits` will usually pass and the TASK bar can be *read*.
An action's label is a whole VLM caption sentence — exactly what `labelFits`
exists to withhold — and that text stays in the hover card.

**The CAPTION lane stops carrying text.** It becomes a thin presence strip
(`showLabels: false`), keeping its one real diagnostic — which actions got a VLM
caption and which did not — and dropping the duplicate prose. Its `emptyReason`
is unchanged.

**`source` surfaces through `warning`, not a lane.** A level whose parents are
all `template` sets a lane warning saying the structure is there but no text
model wrote it. That is `warning`'s exact purpose — a full, healthy-looking lane
whose content was silently degraded — and it stops a structurally-composed
hierarchy from masquerading as a summarized one.

**Ancestry is already free.** The hover card resolves every lane at the cursor
and reports unfocused ones as dimmed context rows, so hovering a TASK bar
already shows its `SESSION` and `PROCESS` above and its `ACTION` below. Pointing
at a level gets the focus block — summary, child count, source — and the rest is
the chain it sits in. No new interaction.

**Noted, not built:** hovering a composed span could highlight its child spans
(cheap now that `segment_tree` exists, but a new interaction on a surface that
has just settled). Depth adds ~32px per level to a rail whose default height is
262px; bands collapse, so it degrades correctly, but a deep recording will want
a drag.

## 4. Retrieval at altitude

**A `summary` view joins Tier 1 as a sixth lane.** Namespace is
`namespaceFor("summary", textEmbedder)` — the same embedder digest already uses,
since `view` is part of the namespace, so it is a distinct physical table at no
extra provider cost. The space exists whenever the digest space does, and
`buildRetriever` gates on `listVectorSpaces()` exactly as it must for caption
and transcript (`searchSegments` throws on an unregistered namespace).

**`DEFAULT_RRF_K` must be re-swept.** It is 10 rather than the published 60
because five lanes over a few-hundred-segment corpus make the lane-count term
span 5×. A sixth lane changes that term, and the constant is documented as
*inverting* the ranking when wrong — a segment ranked 1st in two lanes came 13th
fused. Re-run the known-answer sweep; do not assume 10 still holds.

**`segment_fts` gains the summary text.** That stage is always-on and already
runs last, so on a default install with no dense summary lane, exact-term
lexical search still reaches a task by name. It is the only route from a query
to a task without a model, and it falls straight out of the stage ordering.

**Ancestor/descendant results collapse.** A parent's span contains its
children's, so Tier 1 will return a TASK *and* several of its ACTIONs as
separate results — the reported defect, reproduced in the result list. When an
ancestor and a descendant both survive, keep whichever ranked higher and attach
the other as context, never as a second result. A moment belongs to one place in
the tree.

**Tier-2 scoping expands to leaves — the failure that would be silent.** Tier 2
scopes frames by `array_has_any(segment_ids, [...])` against a field
**denormalized onto the frame vectors in Lance**, written by `FrameRepresenter`
long before compose runs. Composed levels can never appear in it, so a TASK hit
would scope to zero frames and Tier 2 would return empty — no error, no
diagnostic, the same shape as the frame↔segment bug already documented.

Three ways out; the third is chosen:

1. rewrite the denormalized field after composing — a Lance rewrite of every
   frame vector, for data that is derivable;
2. run compose earlier — impossible, it needs captions, which need frames;
3. **expand at query time**: a parent hit resolves through `segment_tree` to its
   descendant leaves, and Tier 2 scopes on those. No storage change, no rewrite,
   nothing to drift.

The same relation gives `frame_segment` rows for parents for free: **a parent's
frames are exactly the union of its children's frames.** Deriving it that way
rather than re-applying `segmentIdsForFrame` leaves the window rule with no
second implementation to drift from — the failure `ax-dump`/`ax-exec` already
paid for.

**Hits carry their altitude.** `FrameHitDTO` and `ResultDetailDTO` gain the
level and the enclosing task's summary, so a frame result reads *"in: renamed
the capture clock"*. That is the payoff even when the thing retrieved is a
single frame.

## 5. Flows and the Library

**A route keeps its key and gains a name.** Route identity stays the deduped
`labelNode` sequence. That key was reached by measuring two stricter ones that
both failed — edge-id and node-id sequences each gave 9 routes all ×1 on a real
9-recording graph, where the label sequence gave 5 with one at ×5. Re-keying on
summaries would be a fourth experiment, and worse: summaries are
**nondeterministic**, so a route's identity would change on every re-index.
Names change; identities must not.

**The name comes from provenance, never from traversal.** A `TraceEdge` source
carries `{sessionId, tMonoStart, tMonoEnd}`, so each edge resolves to the
composed segments covering that span in that recording. Walk up from level 1 and
take the **lowest level at which a single node covers the majority of the
route's recorded time** — naming a route at the altitude it actually occupies
rather than a fixed one. If no level qualifies, the route keeps today's label
sequence, which is the honest answer for a route that is not one task.

Routes are unions across recordings, so recordings will sometimes disagree. Show
the dominant summary **with its count**, never a merged sentence — the
`observations`/`sources` rule: both are shown, neither is smoothed.

**The Library gets the session's purpose from the root segment.**
`granularity = "session"` has exactly one row per recording and its summary *is*
the purpose. The session DTO gains required `purpose: string | null` and
`purposeSource: 'llm' | 'template' | null`. The same string makes a good stage
header on the player, which currently carries only the total.

`null` remains a real state even with a reset — a recording that has been
captured but not yet indexed has no root segment — so the list falls back to
what it shows today and asserts nothing false. No rebuild banner is needed,
because there is no pre-change data to rebuild.

## 6. Testing

**Root suite, deterministic.** `compose/agglomerate.ts` is pure, so the
partition rules test directly:

- contiguity, non-overlap, covering;
- barrier inviolability (no group crosses a `bookmark`);
- a malformed partition is **rejected wholesale**, not repaired — proven with a
  fake provider that deliberately returns one;
- strict shrinkage per level, and termination at exactly one root;
- **translation invariance**: a uniform time shift must not change the grouping,
  the trap that `thumbPlacement` and `Path.curve` span-splitting both hit.

**Default configuration first.** Every compose test runs with **no provider** as
well as with the fake. The zero-results bug survived because every retrieval
test built a `Retriever` with an image embedder the shipped default does not
have; the equivalent mistake here is testing composition only where a summarizer
exists.

**Store tests.** Round-trip both tables, and verify cascade-on-delete by
deleting a session and checking that its tree and summary rows go with it. The
"does an old `app.db` gain the table" check that `transcript_clip` needed is
**not** required here — existing data is discarded (see §1).

## 7. Validation against a real recording

Three things the suite structurally cannot see. Each is a required measurement,
not an assumption. **1 and 2 were run on 2026-08-09** against one real 29.2s
recording (30 actions, Calculator → TextEdit → Electron), `qwen3-vl:4b`.

**1. Do LLM cuts beat structural cuts? — YES, and not for the predicted reason.**

| | levels | level-1 nodes | model-named | time |
| --- | --- | --- | --- | --- |
| structural (control) | 16/8/4/2/1 | 16 | 0 of 31 | 105ms |
| LLM, range contract | 16/8/4/2/1 | 16 (all rejected) | 3 of 31 | 14.5s |
| LLM, cut points | 6/2/1 | 6 | 8 of 9 | 6.0s |

The anti-correlation claim above predicted structural coherence would SHRED
cross-app workflows. What it actually did was strand **eleven single-action
"tasks"**: greedy pairwise merging chains the best seams into one 10-action
group and leaves the rest alone, and a one-action task is not a task. The LLM
also produced a shallower, better-shaped tree (3 levels against 5) because it
merges at a semantically meaningful rate rather than halving. Sample level-1
names: *"Verify calculator operation during recording"*, *"Document creation"*,
*"Screen recording setup"*.

**2. Do level summaries fit? — YES, and nothing truncates.**

On the rail, with LLM summaries: the `task` lane painted **3 of 5** labels, the
`session` lane 1 of 1 (*"checking electron setup"*), and **0 labels truncated
anywhere**. Templated rollups paint far less — 1 of 7–15 — because they are
longer (27–48 chars against 16–26) and there are more of them. So
`showLabels: true` on composed lanes is correct: a withheld label is the
contract working, not a defect.

**3. Does `DEFAULT_RRF_K` still hold at six lanes? — NO. Changed 10 → 5.**

Re-swept 2026-08-09 on TWO real recordings, 87 segments, 30 known-answer
queries (20 composed summaries, 10 leaf captions). The corpus now exceeds Tier
1's `topN` of 50, so ranks are meaningful where the first attempt's 42-segment
library returned everything:

| k | mean rank | recall@1 | recall@5 | mean (composed) | mean (leaf) |
| --- | --- | --- | --- | --- | --- |
| **5** | **25.43** | **27%** | **47%** | 37.45 | 1.40 |
| 10 (was) | 29.17 | 20% | 33% | 42.80 | 1.90 |
| 20 | 32.47 | 13% | 30% | 47.55 | 2.30 |
| 60 | 35.77 | 7% | 23% | 50.60 | 6.10 |

Monotonic on every metric, and it is the documented theory doing what it
predicts: one more lane widens the count term, so k must shrink to keep the
rank term wider.

**THE ASYMMETRY THIS EXPOSED, WHICH NO k CAN FIX — a real limitation of §4.**

A composed level has ONLY a summary: no digest, no caption, no app_caption, no
transcript. It therefore participates in ONE dense lane where a leaf
participates in three or four, and RRF is a SUM, so four mediocre ranks
outscore one perfect rank. Measured over 20 composed queries whose own summary
lane ranked them **#1 every single time**: NONE came first fused, and the ranks
split bimodally — 3,4,4,4,4,5,5,9,11 then 26,29,29,30,32,33,34,34,35,36.

    query "Start calculator"
      correct (level:1): summary#1
      winner  (action):  digest#25 caption#32 app_caption#1 transcript#13

This is the failure `rrf.ts` already documents, now STRUCTURAL rather than a
tuning artefact: the lane count differs by what a node IS. "Retrieval at
altitude" therefore works far less well than §4 claims — a task is findable but
rarely first.

Fixing it means changing the fusion (a participation-normalized score, which
discards the cross-lane agreement signal RRF was chosen for) or ranking
altitudes separately and interleaving. Both are design changes and neither is
made here. Leaf retrieval is unaffected and excellent (mean rank 1.40).

**Found while running the first attempt:** `rrfK` belongs to `Tier1Options` and
reaches the fusion only as `RetrieverOptions.tier1.rrfK`. Passing it at the top
level is silently ignored — which looks exactly like an inert sweep, since every
k then returns an identical ranking.
returns an identical ranking.

Record with the Recorder window closed to the tray. Its elapsed timer displays
milliseconds, which changes every sampled frame and defeats decimation entirely
— any keyframe-derived measurement taken with it visible is meaningless, and
level 0 is built from keyframes.

## Build order

Following the dependency direction the repo already uses:

1. `store/` — the two tables, their reads, cascade verification.
2. `embed/` — the `SummaryProvider` interface, the Ollama adapter, the fake.
3. `represent/compose/` — `agglomerate.ts` pure core, then the stage; structural
   fallback first, so the always-on path exists before the model path.
4. Stage ordering in `DeskRagService` — after Caption/Transcript, before FTS.
5. Rail — `session-tracks.ts` projection, `TrackLaneDTO.level`, `TrackRail`
   ordering and indent. **Stop here and run Validation 1 and 2.**
6. Retrieval — `summary` view + space, Tier-1 lane, leaf expansion in Tier 2,
   ancestor/descendant collapse, DTO altitude. **Run Validation 3.**
7. Flows route naming, Library purpose, rebuild affordance.

Steps 1–5 are the piece that produces evidence; 6 and 7 rest on the assumption
recorded in the scope note above.
