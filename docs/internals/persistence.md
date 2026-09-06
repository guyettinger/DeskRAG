# Persistence semantics — what may fade, and where a time preference belongs

Read before adding a table, before adding a bucket to `schema.ts`, and before
putting a recency, decay, or freshness term anywhere.

This file is the durable half of `docs/research/persistence-layers.md`, which
audits DeskRAG against Roynard's four-layer persistence decomposition
(arXiv:2604.11364, submitted 2026-04-13, **v2 revised 2026-06-12**). The
research file is the argument and the citations; this one is the rules that
came out of it, plus the measurement that decided the only open question.

The preprint was read here at v1 and **re-verified against v2 on 2026-09-04**,
after the code below had shipped on it: every figure this repo built on is
unchanged, including the two that are load-bearing — the keyword-router
reversal (Δ = −0.125), which is the whole argument for deriving a tier rather
than storing one, and the *core* threshold of three independent sessions, which
is `CORE_SESSIONS`. A preprint can be revised out from under a citation; this
one was not.

---

## The litmus

> **Recency is a query-time property. Decay is a storage-level mechanism.
> Confusing the two is a category error, not a tuning mistake.**

The paper's named anti-pattern is a store that gives episodic memories a 7-day
half-life and semantic memories a 69-day one. The objection is not that the
numbers are wrong; it is that the operation is misplaced. A fact does not become
less true after 69 days. What changes is how much attention it deserves *in this
query* — and that is a property of the query, not of the row.

DeskRAG already had the local form of this argument: a recording is real-time
and unrepeatable, so `CAPTURED_TABLES` is what a re-index must never touch. The
litmus is its general form, and it is what makes that rule non-negotiable rather
than a preference to be traded away when something needs to rank better.

Two corollaries, both load-bearing:

- **Nothing in the store fades.** Not blobs, not events, not counts. A
  `TraceEdge.observations` counts what was seen and must keep meaning that;
  `schema.ts` already defends the adjacent case, that observations and sources
  are never derived from one another.
- **A time preference is a parameter of the call.** It arrives as an injected
  resolver plus a reference time, is applied per query, and leaves no trace.
  `EdgeRecency` (`src/replay/types.ts`) and `RecencyOptions`
  (`app/src/main/walk-analysis.ts`) are both shaped that way, and neither reads
  a clock of its own — the single wall-clock read is at `walkAnalysis`, the
  consumer boundary.

The wall clock is not in `trace/` to be read even if you wanted to: `EdgeSource`
carries `sessionId` and `t_mono` only, and `session.started_at` is joined at
query time. The litmus is already holding at the schema.

## The buckets are the paper's layers, arrived at independently

`src/store/sqlite/schema.ts` exports five lists, and
`test/store.purge-derived.test.ts` unions them against `sqlite_master` so a new
table is *forced* to answer which one it is rather than defaulting into silence.

| Bucket | Paper's layer | The question it answers |
| --- | --- | --- |
| `CAPTURED_TABLES` | Memory (what happened) | Can it be re-recorded? No. |
| `DERIVED_SESSION_TABLES` | Memory | Can it be remade from the blobs? Yes. |
| `DERIVED_LIBRARY_TABLES` | Wisdom, *mined* | Can it be remade by replaying every session? Yes. |
| `AUTHORED_TABLES` (`habit`) | Wisdom, *written* | Can it be remade? Nothing can rewrite a person's prose. |
| `OPERATIONAL_TABLES` (`index_job`) | — | Losing it costs pending work, which is re-enqueueable. |

Wisdom landing in two buckets is not a mismatch; it is the purge boundary
falling exactly where authorship does. `OPERATIONAL_TABLES` has no counterpart
in the paper at all, and its own schema comment makes the paper's kind of
argument for why it is neither captured nor derived.

## Four properties this repo already has — do not regress them

1. **Correct side of the litmus.** `CAPTURED_TABLES` cannot decay by
   construction.
2. **LLM-free core, model at the consumer layer.** Every provider is local and
   injected; `store/` never depends on `represent/`; `trace/` and `replay/` are
   leaves. The paper states this invariant, `test/replay.barrel.test.ts`
   *enforces* it.
3. **Evidence-gating over approval-gating, and stricter than asked.** The
   paper wants a Wisdom layer gated on structured evidence because models are
   sycophantic. DeskRAG removes the model from the record path entirely:
   `recordedBlocks()` takes the route and nothing else, verified against an
   adversarial body in `test/habit.prose.test.ts` and against a real 30B model
   by `npm run probe:habits`. `bindHabit`'s strict-majority rule that *declines
   on a tie* is the paper's revision-gating in miniature.
4. **Intelligence leaves no trace of its own.** `segment_summary.source`,
   `session_reflection.source`, and a reflection reaching a habit only as an
   opinion labelled *not part of the record*.

## Three things to decline

- **Confidence scores and confidence damping.** `FrameResult.score` is an
  ordering, the UI and the MCP tools print rank and evidence lanes instead, and
  `walk-analysis.ts` refuses a conformance ratio on exactly that ground.
  Adopting damping reintroduces the number this repo spent effort removing. A
  stability *tier* is admissible because it is a word and a count of
  recordings; a stability *percentage* is not.
- **Contradiction resolution.** DeskRAG's answer to a contradiction is
  disclosure — `droppedEarly`, the duplicate disclosure, a binding that declines
  on a tie, `way-fork` leaving four real ways as four ways. Every system in the
  paper's own benchmark scores below 0.05 on resolution; for a tool whose output
  a person reads and acts on, showing the contradiction is a different answer,
  not a missing feature.
- **Storage-level decay on captured rows.** See the litmus.

## The Knowledge layer: typed semantics, not a typed store

Knowledge — "what is true", superseded rather than forgotten — is the layer
DeskRAG does not have. It is deliberately not built as a second store.

**The paper's own pilot is the argument.** Typed stores beat one flat store by
+0.128 *with an oracle router*, and **lost by 0.125 with a realistic keyword
router**; the author's stated limitations include no ablation separating routing
from store semantics. DeskRAG's retrieval is a tiered funnel with RRF fusion
across lanes and **no router at all** — every lane sees the query and the fusion
decides. A second store means introducing the routing decision the pilot shows
is load-bearing and unsolved, where getting it wrong is measurably worse than
not splitting.

What exists instead is `src/trace/stability.ts`: `stabilityOf(sources)`, a pure
function over the sources a graph already carries, returning a tier
(`prediction` | `core`), a count of distinct recordings, and a reason. It is
surfaced on `GraphNodeDTO` / `GraphEdgeDTO` and drawn in the Inspect drawer.
Beside it sits `src/knowledge/facts.ts`: `currentValue(fact, exclusivity,
startedAt)`, which answers *which of these values is true now* from the same
kind of evidence and likewise stores nothing. See **The decision, made
2026-09-04** below for why it computes rather than persists.

Three things about it are deliberate:

- **The count is `COUNT(DISTINCT session_id)`, never `observations`.** One
  recording that walks a loop twice contributes two observations and one
  session, and a tier is a claim about corroboration, which one recording
  cannot supply to itself. It is counted off the *trace-layer* sources, not off
  the DTO's `sources` — that list drops every recording the projection could not
  date, and counting off it would report an undatable recording as a deleted
  one.
- **The paper's third tier, `anchor`, is not minted.** Its input is
  "uncontradicted across ten or more consolidation cycles", and nothing counts
  consolidation cycles: `probe:stability` runs three and persists no counter. A
  tier that can never be reached is the `StageSpec.skipReason` failure — a thing
  that never appears is indistinguishable from a thing nobody implemented — so
  it is named in prose and absent from the type.
- **`undefined` sources and `[]` sources are different answers.** The first is a
  graph lifted before provenance existed and the tier is *withheld*; the second
  is a graph whose recordings were all deleted and counts zero.

### The decision, made 2026-09-04

Persisted Knowledge in the paper's sense — append-only, superseded, **not
recomputed** — would be the first state in this store that is neither
rebuildable nor authored. **It is not built, and when Knowledge does get a
table that table is `DERIVED_LIBRARY_TABLES`.**

**The paper's reason for append-only does not transfer.** Roynard's Knowledge
is append-only because his system does not retain the evidence — an agent
learns a fact from a conversation and the conversation is gone.
`CAPTURED_TABLES` is exactly that retained evidence, and its defining property
is that a re-index must never touch it. So re-derivability is free here, and
taking the expensive side would have bought a property this store does not
need at the price of the re-index invariant.

A fact outliving the deletion of its evidence needs no new rule either:
`removeSession` does not rebuild the trace graph today, `observations` survives
while `sources` thins, and the discrepancy is disclosed rather than repaired.

**Supersession is COMPUTED, and exclusivity is declared per fact TYPE.** The
paper updates Knowledge by supersession — newer claim wins, older marked
superseded — and §7's decline of contradiction *resolution* collides with it.
On the real library the paper's rule loses. Measured 2026-09-04 over 12
recordings: `keymap_change` is 12 occurrences and **one** distinct payload, so
nothing supersedes anything; `display_change` is 12 occurrences and **eight**
distinct payloads but only **two** configurations. Seven of the eight are the
same 1920×1080@2 primary with a **different `id` every session** (180, 185,
206, 219, 247, 296, 297), because macOS re-mints the identifier — `id` is a
decoy and geometry discriminates. Keying supersession on it would have minted
eight facts where there are two, and the two real configurations do not
supersede one another: a laptop is docked some days and not others, so "newer
wins" would delete a configuration that is still true.

So every distinct value is kept with its sources, each fact TYPE declares
whether its values can coexist, and "current" is answered per query and stored
nowhere — the storage/query litmus applied to itself, since a stored
`superseded_by` edge is a storage-level commitment to a ranking.

`src/knowledge/facts.ts` is that contract: `currentValue()` returns the latest
value of an `exclusive` fact and **refuses three ways** — a `coexisting` fact
has no current value, a tie declines on `bindHabit`'s precedent, and a fact no
recording can date says so. Counts only; a percentage would be
`FrameResult.score` renamed.

**It does not decide whether two values are the same value.** Fed those eight
display payloads it reports eight. That is the seam, not a defect:
cross-recording entity identity is its own cycle, and it is a **prerequisite of
every Knowledge candidate** rather than one of them — "is this the same
display", "is this the same document", "is this the same app version" are one
question. Leaving it out makes the display case legible *as* an identity
problem instead of silently mis-keying it, which is what a stored edge would
have done while looking correct.

**Cycle 1 answered it, 2026-09-06, and identity is a DECLARED PROJECTION.**
`src/knowledge/identity.ts` folds many observations into values that are
distinct under an identity rather than under equality; a `FoldedFact` **is** a
`KnowledgeFact`, so `currentValue` reads one with `facts.ts` unmodified. Each
fact type declares the form that decides sameness — `DISPLAY_TOPOLOGY` drops the
re-minted `id` and sorts the list, `FOCUSED_APP` keeps `bundleId`, `VISITED_PAGE`
**calls `urlPrefix`**. Sameness could instead have been *measured*, by embedding
the payloads and clustering under a threshold, and that was declined on
evidence: there is no ground truth on a 12-recording library to sweep a
threshold against, and `probe:embed`'s first version is the standing lesson
about what a metric scored without ground truth measures.

Three things it does not do, each deliberate. **It enumerates what it keeps**, so
a new field on `DisplayInfo` does not silently become a discriminator. **It
writes no URL rule**: a hand-written normalizer was measured against `urlPrefix`
and merged the same single pair, so the tie went to the rule that ships and the
two layers cannot drift on what a URL is. And **an observation it cannot place is
counted, never dropped** — `chrome://new-tab-page/` names no site, and 3 of 44
`url_change` observations land in `unidentified` rather than inventing a value.

`npm run probe:identity` re-renders every number above from the live library.
Measured 2026-09-06 over 13 recordings, by fact id because two facts now read
`focus_change`: `display_topology` 13 occurrences / 9 raw / **3**, `focused_app`
102 / 71 / **7**, `focused_window` 102 / 71 / **29** plus 19 unidentified,
`visited_page` 50 / 23 / **21** plus 3, `keyboard_layout` 13 / 1 / **1**. Every
one of those changed when the library gained a single recording, which is why
they are re-rendered rather than quoted. See
`docs/superpowers/specs/2026-09-06-knowledge-entity-identity-design.md`.

### Cycle 2, 2026-09-06: the first consumer, and no table

Cycles 0 and 1 shipped a contract ahead of its first caller, deliberately — the
measurement that decided the contract would have been baked into a wrong table
had the caller come first. The consumer is the **Knowledge screen** and the
`list_facts` / `get_fact` tools, projected by `app/src/main/knowledge-view.ts`.
Three things it settled:

**"Computed per query" survives a consumer, so there is still no table.** The
bar was set in advance: single-digit milliseconds settles it, hundreds make the
table a real question at 100 recordings. Measured over the real library, running
the whole pipeline — every event of every recording read, parsed, excluded,
folded, and `currentValue` resolved on each — **4.63ms**, of which **3.77ms** was
reading and parsing rows rather than folding them. The fold alone against a
synthetic hundredfold corpus: **9200 observations → 7 values in 34.13ms**. The
cost is dominated by the read and is linear, so a hundredfold library still
resolves inside one frame. §6.2 of `docs/research/persistence-layers.md` closes,
and the rule above stands unamended: **no table, no bucket.**

**`keymap_change` got an identity after all, and only a consumer could have
asked for it.** The fold count is unchanged and the old note was right about it —
12 occurrences, one payload, a projection buys zero *values*. What the count
cannot see is that a projection also decides what a consumer SEES, and the raw
payload is `{ layoutId, entries: { …70 keycode mappings… } }`. Seventy entries is
not a value that goes on a screen or into a tool response. `KEYBOARD_LAYOUT` is
also `exclusive` — a layout supersedes where a docked display does not — which
makes it **the one fact that returns a value**: all three earlier declarations
are `coexisting`, so a screen built on them alone could only ever show DeskRAG
declining, three times, teaching that refusing is all the layer does.

**THE RECORDER EXCLUSION IS SCOPED BY FACT TYPE, AND THIS WAS MEASURED.**
Applying `excludeFocusedApps` to every event before folding is the obvious
implementation and it is wrong: display and keymap are sampled at session start,
while the recorder is still frontmost. Measured with the app's real
`flows.excludeApps` — **6 of 12 recordings lose their `display_change`
entirely, and 6 of 12 their `keymap_change`**. The two display configurations
survived that only by luck: the docked one is a *single* observation and was one
coin flip from vanishing, which would have shown one setup where there are two,
confidently and with no disclosure. An environment fact is not about the
application that happened to be frontmost when it was sampled, so
`IdentityDeclaration.attribution` (`focused-app` | `ambient`) declares it beside
exclusivity, as data rather than a branch. The exclusion drops **253 of 5079**
events; `focus_change` folds 7 → 6 and `url_change` 17 → 15, `localhost` leaving
with `com.github.Electron`.

The `(bundleId, title)` question stayed closed for that consumer — the rule
being that a consumer wanting windows wants a second declared identity, not an
edit to `FOCUSED_APP`. See
`docs/superpowers/specs/2026-09-06-knowledge-first-consumer-design.md`.

### Cycle 3, 2026-09-06: what an audit against the paper found

The layer was read back against Roynard and against its own research document.
The seam held — `FoldedFact` **is** a `KnowledgeFact` and cycle 1 shipped without
touching `facts.ts`, exactly as predicted — and five things did not.

**A LABEL IS HALF OF A VALUE, AND IT MUST BE INJECTIVE OVER THE CANONICAL FORM.**
`DISPLAY_TOPOLOGY` folds on all six fields of every panel; `displayLabel`
rendered four. The library holds the pair that breaks it: two docked
configurations differing ONLY in the external panel's `y` (−797 and −706) printed
one identical string. Two values, one label — a duplicate React key, two rows
nobody can tell apart, two identical blocks in `get_fact`, and a `current` field
which is a LABEL and therefore named neither. The label now carries the origin,
`KnowledgeValueDTO.key` carries `stableKey` of the canonical form so nothing is
keyed on prose, and `test/knowledge-view.test.ts` asserts injectivity **per
fact**, so a sixth declaration is covered the day it is added.

**THE VALUE LIST RANKED BY A RAW LIFETIME TALLY — §4'S DEFECT, IN THE LAYER BUILT
FROM §4.** It also contradicted itself on screen: `currentValue` picks the most
recently observed value while the list ranked by lifetime recordings, so a
superseded keyboard layout would sit above the one that replaced it, directly
under a verdict naming the replacement. The order is now recency-weighted with
`0.5 ** (Δ / halfLife)` per distinct recording — the SAME expression as
`edgeCost`'s `evidenceOf` and `wayWeight`, reusing `DEFAULT_HALF_LIFE_MS` so the
app has one half-life and not three — and an undatable recording keeps its whole
vote. **`stabilityOf` is untouched**: a tier is the paper's evidence threshold, a
`COUNT(DISTINCT session_id)`, and a weighted count would be a fraction wearing
the word "recordings". The weight never leaves `knowledge-view.ts`; what ships is
the rank plus `lastObservedAt`, a moment.

Measured 2026-09-06 over 13 recordings, on the streams the app actually renders:

| | 7d | 14d (shipped) | 30d | 90d |
| --- | --- | --- | --- | --- |
| real overrides | 106 | **54** | 35 | 35 |
| tiebreaks | 172 | 172 | 172 | 172 |
| leading value ≠ lifetime rule's | 3 of 5 | **3 of 5** | 3 of 5 | 3 of 5 |

**Unlike the trace seams, this one ships ON.** A *real override* is a value with
strictly less lifetime evidence ranked above one with more — §4's claim; a
*tiebreak* is a pair the lifetime rule could only separate by key, and separating
those is an improvement but not the effect under test. That split was paid for
twice now: `probe:baseline` printed "1 of 1 paths changed" at every half-life on
a tie, and this probe's first version printed "3 of 5 facts reordered" at 90d on
a 20-day span for the same reason. The readable case is Applications: Chrome
leads on 5 recordings over TextEdit's 6, because Chrome was seen today and
TextEdit a fortnight ago.

**A FACT IS ADDRESSED BY ITS `id`, NOT BY THE EVENT IT READS.** Cycle 2's note
said a consumer wanting the window count wants a second identity; cycle 3
declared it, and discovered that the promise was unkeepable as written — two
declarations reading `focus_change` collide on every surface that identified a
fact by its kind. `IdentityDeclaration.id` is that name. `FOCUSED_WINDOW` folds
the same 102 events to **29** windows against `FOCUSED_APP`'s 7, with **19
unidentified**: nearly a fifth of real focus events carry no title, which is why
a missing one is disclosed rather than dropped.

**TWO RULES FOR ONE QUESTION, TWICE.** `Fact.rawVariants` counted distinct raw
payloads with `JSON.stringify` while `foldByIdentity` deduped variants with
`stableKey`, so the probe's `raw` column and the DTO's `variants` answered one
question two ways. And the display reader re-implemented a weaker
`coerceDisplays` as a cast — `compareGeometry` subtracts, so one missing field
makes the comparator return `NaN` and the canonical form implementation-defined,
which is a non-deterministic identity. The coercion moved INTO the identity,
where the rule belongs, and the reader passes the payload through whole so
`variants` stay raw.

**A DISCLOSURE THAT CANNOT FIRE IS THE `skipReason` FAILURE.** `Current.undated`
is structurally zero on the app's path — `KnowledgeSession.startedAt` is required
and the map is built from the same sessions — so it left the DTO and both
renderers while staying in `facts.ts`, which is a real contract for a caller
whose recordings cannot all be dated. `Current.alternatives` went entirely: it
meant "other values" on the one path with an answer and "all of them" on the
three that refuse, and nothing read it.

The benchmark that closed §6.2 also gets a caveat rather than a correction: 9200
observations folding to the same **7** values measured the fold's TIME, not the
output's SIZE. What grows with a library is values — one further recording took
`visited_page` from 17 to 21 — and the surface that fails first is the rendering.
`MAX_FACT_VALUES` answers that for the counted form; `get_fact` stays uncapped,
because checking a fold against a truncation is not checking it.

What would reopen the no-table decision: a fact type whose evidence is genuinely
not retained; a rebuild that cannot reproduce a fact in session order; or a
measured need for a stored edge. See
`docs/superpowers/specs/2026-09-04-knowledge-layer-seam-design.md` §8.

## The measurement: does a recency term move anything?

`edgeCost` and `chooseBaseline`'s `majority` rule both rank by a raw lifetime
tally with no time term, so a workflow walked twelve times last spring and
abandoned outranks one walked four times last week, forever. Both now accept an
optional query-time recency term, and `npm run probe:baseline` sweeps it.

**Measured 2026-09-03 on the real library** — 12 recordings, 7 routes, **1
walked more than once**, dated span 2026-08-17 → 2026-08-29 (11.5 days), at
half-lives of 7/14/30/90 days:

| | 7d | 14d | 30d | 90d |
| --- | --- | --- | --- | --- |
| baselines moved vs `majority` | 0 of 1 | 0 of 1 | 0 of 1 | 0 of 1 |
| paths changed | 1 | 1 | 1 | 1 |
| …of which tiebreaks | 1 | 1 | 1 | 1 |
| …real overrides | **0** | **0** | **0** | **0** |

**So the default did not change.** `DEFAULT_RULE` stays `"majority"` and
`EdgeRecency` is passed by nothing but the probe. The term exists, is tested,
and is off.

Two things about that table are worth more than the zeros:

- **THE PATH COLUMN NEEDED A CONTROL AND THE FIRST VERSION DID NOT HAVE ONE.**
  It printed "1 of 1 paths changed" at every half-life, including 90 days on an
  11.5-day library, which should have been impossible as a recency effect.
  Both candidate first edges had `observations: 1`, so they cost *exactly* the
  same and Dijkstra was choosing by iteration order; recency broke the tie by
  date. Breaking a tie by date is a genuine improvement over insertion order and
  it is not the effect under test, so the two are now counted separately: a
  change is an OVERRIDE only when the path recency chose is strictly more
  expensive under the shipped cost. Without that split the probe would have
  published a 100% hit rate for an effect it was not exercising.
- **One route walked more than once is not a corpus.** The probe says so before
  the tables, and it also withholds the sweep verdict when the library's dated
  span is shorter than the shortest half-life — every weight is then within a
  factor of two of every other and nothing can separate two Ways. Re-run this
  on a larger library before concluding that the term is worthless; what is
  established today is that it is not yet *worth switching on*, not that it
  never will be.

The relevant precedent is `DEFAULT_RRF_K`, which is 5 rather than the published
60 because it was swept four times against known answers. A half-life picked off
a paper would be the 60.

## The leak the research file records, and why it is already closed

`compose-representer.ts` reads `s.caption ?? s.digest` — caption first, which is
model output being read back up the ladder as though it were a record of what
happened. The consequence was measured, not hypothesised: 114 of 367 captions
described the DeskRAG window itself, and three of eight composed roots named the
recording rather than the work. `captionExclusionFor` closed it, and both
composed roots afterwards name the work.

In the paper's vocabulary this is the category error running in the direction it
does not discuss: not decay applied to facts, but **ephemeral inference
persisted and then re-read as experience**. It is the strongest in-repo evidence
for the thesis, and it was invisible to `npm test` — it surfaced only as
summaries that were about the wrong thing.
