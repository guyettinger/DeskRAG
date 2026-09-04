# Persistence semantics — what may fade, and where a time preference belongs

Read before adding a table, before adding a bucket to `schema.ts`, and before
putting a recency, decay, or freshness term anywhere.

This file is the durable half of `docs/research/persistence-layers.md`, which
audits DeskRAG against Roynard's four-layer persistence decomposition
(arXiv:2604.11364, an April 2026 preprint). The research file is the argument
and the citations; this one is the rules that came out of it, plus the
measurement that decided the only open question.

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

### The decision left open, on purpose

Persisted Knowledge in the paper's sense — append-only, superseded, **not
recomputed** — would be the first state in this store that is neither
rebuildable nor authored: a new answer to the question `schema.ts` forces every
table to answer. The paper itself concedes the cheaper design (collapse
Knowledge and Wisdom, carry a stability tier and a provenance flag) and notes
what it costs: one update mechanism has to handle both supersession and
evidence-gated revision.

**`stabilityOf` takes the cheap side and does not settle the expensive one.** It
derives, so a re-index rebuilds the graph and recomputes the tier, and the
re-index invariant is untouched. The candidates that would need real
supersession chains — an application's AX shape per version, cross-recording
entity identity, environment facts promoted library-wide — are **not built**,
because that call should be made deliberately rather than as a side effect of
the first table.

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
