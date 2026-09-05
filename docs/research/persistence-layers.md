# Persistence Semantics as an Architectural Seam
### Roynard's four-layer decomposition (arXiv:2604.11364), read against DeskRAG

> Research document. Not a behavior spec. This is the argument and the
> citations; it is an outside check on a decision this repo already made.
>
> **Source re-verified 2026-09-04, and the caveat this line used to carry is
> discharged.** The preprint was cited here from its v1; arXiv now serves a
> **v2, revised 2026-06-12**, and code has shipped on its numbers since. Every
> figure this repo built on is unchanged in v2 — the pilot table (0.500/0.394,
> 0.425/0.275, 0.463/0.334, Δ +0.128), the CI and McNemar p ([0.04, 0.22],
> p = 0.035), the keyword-router reversal (Δ = −0.125), the three tier
> thresholds (three independent sessions, ten consolidation cycles), and the
> storage/query litmus verbatim. So `CORE_SESSIONS = 3` still cites what it
> says it cites, and §6.1's argument against a typed store still rests on a
> number the author still publishes. A revision that had moved the reversal is
> the one that would have mattered: it is the whole reason `stabilityOf`
> derives instead of storing.
>
> **Acted on 2026-09-03.** The durable half now lives in
> [`docs/internals/persistence.md`](../internals/persistence.md), which carries
> the rules and the measurement rather than the reasoning. What shipped: an
> optional query-time recency term on both ranking seams (§4), a half-life
> sweep in `npm run probe:baseline`, and `stabilityOf` as typed semantics
> rather than a typed store (§6). **The sweep's answer was null** — 0 baselines
> moved and 0 real path overrides at 7/14/30/90-day half-lives on a
> 12-recording library — so the term ships OFF and `DEFAULT_RULE` stays
> `majority`. §6.2 is recorded as still open, deliberately.

---

## 0 · TL;DR

Roynard argues that agent memory systems commit a **category error**: they apply
one persistence contract to every kind of state, so "systems apply cognitive decay
to factual claims, or treat facts and experiences with identical update mechanics."
His fix is to bucket state by *persistence semantics* — four layers, each with a
different update mechanism.

DeskRAG made the same move independently. `src/store/sqlite/schema.ts` exports
bucket lists — `CAPTURED_TABLES`, `DERIVED_SESSION_TABLES`,
`DERIVED_LIBRARY_TABLES`, `OPERATIONAL_TABLES`, `AUTHORED_TABLES` — and
`test/store.purge-derived.test.ts:316` ("classifies every table in the schema into
exactly one bucket") unions them against `sqlite_master` so a new table is *forced*
to answer the question rather than defaulting. The bucket comments already argue
the paper's distinction in the paper's spirit: `AUTHORED_TABLES` says the question
a purge actually asks is **can it be remade**.

So this is not a proposal to adopt an architecture. It is a **vocabulary** and an
outside audit. Applying it yields:

- **Four confirmations** — DeskRAG is on the correct side of the paper's central
  litmus, and satisfies three of its stated invariants already, one of them
  (evidence-gating over approval-gating) more strictly than the paper asks.
- **One defect** — `edgeCost` has no query-time recency term at all (§4).
- **One leak** — persisted model prose is re-read as observation (§5).
- **One genuinely absent layer** — Knowledge, with a good reason from the paper's
  own pilot *not* to build it as a separate store (§6).

---

## 1 · What the paper actually says

### 1.1 The four layers

Table 1 of the paper, reproduced:

| Layer | Definition | Persistence | Update | Scope |
| --- | --- | --- | --- | --- |
| Knowledge | What is true | Indefinite; supersession | Append-only + provenance | Shared |
| Memory | What happened | Ebbinghaus decay | Bi-temporal event sourcing | Per-agent |
| Wisdom | What works | Durable; revision-gated | Evidence-threshold review | Multi-source |
| Intelligence | Capacity to reason | Ephemeral (inference-time) | N/A | Per-invocation |

Three qualifications that are easy to lose, and that a summary of this paper will
usually get backwards:

**It is not a hierarchy.** The paper's own figure caption: the layers are
"co-equal substrates with distinct persistence semantics, **not a strict
hierarchy**." There is no promotion/demotion stack. The dashed arrows are offline
consolidation pipelines, not a ladder.

**Wisdom is distinguished from Knowledge by the update mechanism, not the content
type.** Verbatim: "The primary criterion that distinguishes Wisdom from Knowledge
is *the update mechanism*, not the content type." Knowledge updates by
supersession — both claims preserved and linked, the old one marked superseded.
Wisdom updates by evidence-gated revision — a directive is promoted or modified
only when structured evidence (corroboration count, session span, contradiction
absence) crosses a threshold. Content type is explicitly a *secondary* heuristic.

**Wisdom does not decay.** "'Never store secrets in git' does not become less wise
over time." It is retired by explicit revision with provenance, never by fading.

### 1.2 The organizing principle — the actual load-bearing idea

The four layers are the paper's title, but this is its sharpest paragraph:

> "The key design litmus that emerges from this decomposition is the distinction
> between **storage-level and query-time properties**. Recency is a query-time
> heuristic (the Intelligence layer can boost recent results when recency matters).
> Decay is a storage-level mechanism (the Memory layer applies Ebbinghaus
> forgetting to experiential facts). Confusing the two produces systems like
> NornicDB where knowledge is subjected to storage-level decay when recency should
> be a query-time filter."

The named anti-pattern is concrete: NornicDB gives episodic memories a 7-day
half-life, semantic 69-day, procedural 693-day. Roynard's objection is not that the
numbers are wrong — it is that the operation is misplaced. "A paper's findings do
not become less true after 69 days. What decays is the *agent's attentional
relevance* to the information."

**This litmus, not the four-layer table, is the part of the paper that has
purchase on DeskRAG.** See §3.1 and §4.

### 1.3 Revision-gating, and why it is gated on evidence rather than approval

Each Wisdom entry carries a stability tier:

| Tier | Threshold | Behavior |
| --- | --- | --- |
| *prediction* | derived from a single episode | free to churn |
| *core* | corroborated across **three or more independent sessions** | stabilizes |
| *anchor* | persists uncontradicted across **ten or more consolidation cycles** | resists modification |

Thresholds are stated as configurable and empirically motivated by BaseLayer's
finding that 20% of facts produces behavioral fidelity equivalent to 100%.

The motivation for gating on *structured evidence* rather than on user approval is
anti-sycophancy, and it is the paper's most transferable argument:

> "RLHF-trained models affirm user behavior 50% more than humans, and users rate
> sycophantic AI 9–15% higher **even after disclosure**. Gating on approval alone
> would let sycophantic models promote agreeable-but-incorrect patterns. Gating on
> structured evidence prevents this."

### 1.4 The LLM-free core invariant

Roynard's two reference implementations (`knowledge-base` in Python,
`memory-engine` in Rust) share an invariant he flags as distinguishing them from
every system he surveys:

> "All core operations (decay computation, graph traversal, retrieval fusion,
> supersession bookkeeping, consolidation scheduling) use deterministic algorithms
> with zero LLM calls and zero network dependencies. LLM operations (entity
> extraction, fact validation, wisdom promotion) happen exclusively at the consumer
> layer, invoked by the calling agent with its own provider."

`memory-engine` expresses this as five consumer traits — `EmbeddingProvider`,
`SummaryGenerator`, `ConflictArbiter`, `PersistenceClassifier`, `Reranker` — that
"carry zero network or LLM dependencies."

### 1.5 The pilot, and the finding that constrains everything

BEAM 100K-token split, N = 80 per condition, Gemma 4 26B for both generation and
scoring. *Typed routing* (an oracle classifier sends each query to the
supersession-aware store or the bi-temporal store) against a *flat baseline* (one
undifferentiated FTS5 store):

| Category | Typed | Flat | Δ |
| --- | --- | --- | --- |
| Contradiction resolution | 0.500 | 0.394 | +0.106 |
| Temporal reasoning | 0.425 | 0.275 | +0.150 |
| Overall | 0.463 | 0.334 | +0.128 |

Bootstrap 95% CI on Δ: [0.04, 0.22]; McNemar p = 0.035.

**And then the sentence that matters more than the table:**

> "A two-conversation comparison with a heuristic keyword-based router (instead of
> the oracle) **reverses the typed advantage (Δ = −0.125)**, confirming that
> routing accuracy is load-bearing: architectural separation helps only when
> queries reach the correct store."

The author's own stated limitations: small sample, two categories only, **no
ablation separating routing from store semantics**, FTS-only retrieval with no
vector search, and one local 26B model doing both generation and scoring.

Read plainly: the measured benefit of typed *stores* is contingent on a router
that does not exist, and with a realistic router the result went negative. This is
§6's whole argument.

---

## 2 · The mapping

| Paper layer | DeskRAG |
| --- | --- |
| **Knowledge** | **absent** |
| **Memory** | `CAPTURED_TABLES` + `DERIVED_SESSION_TABLES` — the event firehose, blobs, segments, AX walks |
| **Wisdom** | `DERIVED_LIBRARY_TABLES` (the trace graph, which accretes across recordings) + `AUTHORED_TABLES` (`habit`) |
| **Intelligence** | the injected providers and `Retriever` |

`OPERATIONAL_TABLES` (`index_job`) has no counterpart in the paper. It is a work
queue, not cognitive state — and its own schema comment makes precisely the
paper's kind of argument for why it is neither captured nor derived: "losing it
costs pending work, which is re-enqueueable, never a recording, which is not."

The split of Wisdom across two DeskRAG buckets is not a mismatch. It is the
paper's Wisdom/authorship distinction showing up as a purge boundary: the trace
graph is *mined* wisdom (rebuildable by replaying every session in order), the
habit is *written* wisdom (reproducible by nothing).

---

## 3 · Where DeskRAG already satisfies the paper

### 3.1 It is on the correct side of the storage/query litmus

The NornicDB failure is applying storage-level decay where recency was wanted.
DeskRAG cannot commit it: `CAPTURED_TABLES` is defined as "what a re-index must
NOT touch… Losing one is unrecoverable — a video, an event stream and an AX walk
cannot be re-recorded." Nothing in the store fades.

This has always been justified locally — a recording is real-time and
unrepeatable. The paper supplies the general form of the same argument, which
means the rule is not a DeskRAG quirk to be traded away under pressure; it is the
correct side of a documented category error. The corollary in §4 is that the
*query-time* half of the litmus is where DeskRAG has a real gap.

### 3.2 The LLM-free core (§1.4) is DeskRAG's architecture verbatim

Point for point:

- **Deterministic core, model at the consumer layer.** Every provider in DeskRAG
  is local and injected. `store/` never depends on `represent/` — reconciliation
  returns *missing* rows for a caller-supplied re-embed callback rather than
  embedding anything itself. `trace/` and `replay/` are leaves, guarded by
  `test/replay.barrel.test.ts`.
- **Consolidation cannot fail on the model.** `composeOneLevel` catches everything
  a provider throws and rolls the block up structurally; composing can never fail
  the run.
- **The five consumer traits** map almost one-to-one onto DeskRAG's injected
  provider interfaces, including the ones the repo added for the same reason the
  paper gives — e.g. `ImageDownscaler` is injected because `OllamaCaptionProvider`
  must stay barrel-safe while `sharp` is native.

Where DeskRAG goes further: the paper states the invariant, DeskRAG *enforces* it
with a barrel test that asserts no file in `replay/` except `sidecar.ts` even
mentions `spawn`.

### 3.3 Evidence-gating over approval-gating — already shipped, and stricter

§1.3 is the paper's argument that a Wisdom layer must gate on structured evidence
because models are sycophantic. DeskRAG's habit design is that argument taken to
its conclusion:

> **A model writes the PROSE and never the record.** `recordedBlocks()` takes the
> route and nothing else, so there is no path by which model output reaches the
> steps.

That is not gating on evidence *in preference to* approval — it is removing the
model from the record path entirely, so approval is not an input at all. And it is
verified twice over: against an adversarial body in `test/habit.prose.test.ts`
(distinctive tokens, so "no sample reached the prompt" is a real assertion), and
against a real 30B model by `npm run probe:habits`.

The binding rule is the paper's revision-gating in miniature. A habit's stored
`routeKey` goes stale by design; `bindHabit` re-resolves by strict-majority session
overlap and **declines on a tie**. Threshold-gated promotion, with the failure mode
disclosed rather than guessed.

### 3.4 Intelligence leaves no trace

"It exists only at inference time and leaves no direct trace; its effects persist
only through the other three layers." DeskRAG tracks *which* intelligence acted
without letting it become the record: `segment_summary.source` discloses `llm` vs
`template`, `session_reflection.source` names the model that wrote the note, and a
reflection reaches a habit only as an **opinion** in `habitPrompt`, explicitly
labelled *not part of the record*.

---

## 4 · The defect: `edgeCost` has no query-time recency term

`src/replay/plan.ts:42`:

```ts
export function edgeCost(e: TraceEdge): number {
  const rate = e.outcomes.attempts > 0 ? e.outcomes.successes / e.outcomes.attempts : 0.5;
  return 1 / (1 + e.observations * rate);
}
```

`TraceEdge.outcomes` is `{attempts: 0, successes: 0}` on every graph on disk —
passive recording cannot observe a failure, as `app/src/main/walk-analysis.ts:5-7`
says: "The user did the thing, so it succeeded." So `rate` is the constant 0.5 and
the function reduces to:

```
edgeCost(e) = 1 / (1 + 0.5 · observations)
```

**A raw lifetime tally, with no time term of any kind.** A workflow walked twelve
times last spring and abandoned outranks one walked four times last week, forever,
and `findPath` will keep routing through it.

By the litmus in §1.2, the correction is **recency at query time, not decay at
storage**. This distinction is the whole reason to write it down: the intuitive
patch is "decay the observations," which would be the NornicDB error — mutating
stored counts because a ranking wanted a time preference. `observations` counts
what was seen and must keep meaning that (schema.ts already defends the adjacent
version of this: observations and sources "are never derived from one another").
The time preference belongs in the cost function, which is evaluated per query.

Two things make this unusually cheap to *measure* before changing anything:

- `walk-analysis.ts:44` already ships `BaselineRule = "majority" | "recent" |
  "none"` — `recent` is a crude one-observation recency rule, so the concept is
  already admitted and already has three named alternatives.
- `npm run probe:baseline` already exists to compare those rules on a real
  library, prints the corpus first, exits 1 when no route was walked more than
  once, and reports how many baselines were chosen by tiebreak.

**This is a measurement to run, not a change to make.** A half-life as a fourth
`BaselineRule` is a probe entry; whether it moves anything on a real library is an
open question, and per this repo's standing rule the number comes before the
adoption. The relevant precedent is `DEFAULT_RRF_K`, which is 5 rather than the
published 60 because it was swept four times against known answers.

---

## 5 · The leak: Intelligence → Memory

`src/represent/compose/compose-representer.ts:187`:

```ts
text: s.caption ?? s.digest ?? s.boundaryReason ?? "segment",
```

`caption` is model output. `digest` is observation — window title, URL, typed text,
the label of what was clicked, all recovered by a path that never saw the image.
Reading caption *first* means persisted model prose is fed back up the compose
ladder as though it were a record of what happened.

The consequence was measured, not hypothesised: 114 of 367 captions described the
DeskRAG window itself, that prose climbed the ladder, and **three of eight composed
roots named the recording rather than the calculator, the news and the music they
were about**. The fix was `captionExclusionFor`, and afterwards both composed roots
named the work.

In the paper's vocabulary this is exactly the category error, running in the
direction the paper does not discuss: not decay applied to facts, but **ephemeral
inference persisted and then re-read as experience**. `src/represent/caption/caption-representer.ts:45`
already carries the warning inline.

It is worth recording as the strongest in-repo evidence *for* the thesis. The
layers were conflated at one line, and the failure was invisible to `npm test` —
it surfaced only as summaries that were about the wrong thing.

---

## 6 · The missing layer, and why not to build it as a store

Knowledge — "what is true about the world," indefinite, superseded rather than
forgotten, shared — has no home in DeskRAG. Candidates that are genuinely facts
rather than records:

- **Application UI structure.** Every recording rediscovers the Settings button's
  AX path from scratch. "App *X*, version *v*, has this AX shape at this screen" is
  superseded when the app updates — not forgotten. This aims at the fragility
  CLAUDE.md already flags: the anchor ladder was falsified twice, each time by
  recording in one more app.
- **Cross-recording entity identity.** That `Untitled — Edited` and
  `report.md — Edited` are one document. Nothing currently links across sessions
  except trace node identity.
- **Environment facts promoted library-wide.** Display topology and keyboard layout
  are already events "resolved latest-at-or-before" — which *is* supersession,
  scoped to one session. Promoting them is a small step.

### 6.1 Why a separate Knowledge *store* is the wrong shape here

The paper's own pilot is the argument (§1.5). Typed stores beat a flat store by
+0.128 **with an oracle router**, and lost by 0.125 with a keyword router.
DeskRAG's retrieval is a tiered funnel with RRF fusion across lanes and no
router at all — queries reach every lane and the fusion decides. Introducing a
second store means introducing the routing decision the pilot shows is load-bearing
and unsolved, and getting it wrong is measurably worse than not splitting.

The paper also concedes the cheaper design outright:

> "An alternative design would collapse Knowledge and Wisdom into a single layer
> with a stability-tier field and a source-attribution flag. This is a viable
> simplification, but it forces a single update mechanism to handle both
> supersession and evidence-gated revision."

For DeskRAG that trade reads the right way round. Typed **semantics** on the store
that exists — a stability tier and a provenance flag — is reachable; typed
**stores** buys the pilot's oracle problem.

### 6.2 The unresolved tension, left open

The paper's Knowledge is append-only and *not recomputed*. DeskRAG's re-index
invariant is that everything derived is discardable and rebuilt with the providers
configured now. A Knowledge bucket in the paper's sense would be the first state in
the store that is neither rebuildable nor authored — a new answer to a question
`schema.ts` currently forces into its existing buckets.

There is a cheaper resolution — Knowledge that is derived and rebuildable, but
carries supersession chains *within* a rebuild, so you keep the invariant and gain
the provenance — and it is not obviously the right one, because it gives up the
property the paper cares most about (facts surviving a rebuild). **This should be
decided deliberately if Knowledge is ever built, not settled as a side effect of
the first table.**

### 6.3 If it is built, the tiers have their inputs already

Should §1.3's stability tiers be wanted, DeskRAG has better inputs than the paper
assumes. The tier boundary is *independent sessions*, and `trace_node_source` /
`trace_edge_source` carry `session_id` — so the count is
`COUNT(DISTINCT session_id)`, not a proxy. The *prediction*/*core* boundary is even
already stated informally, in `probe:transfer`'s rule that "a route walked once is
an observation, not a habit." And `npm run probe:stability` already runs three full
re-index-and-re-mine cycles, which is the paper's "consolidation cycle" counter
under another name.

The MCP surface would accommodate it: `search_knowledge` and `get_fact` both
satisfy the read-only guard's `^(search|get|list)_` rule — the rule that already
cost `find_habit` its name.

---

## 7 · What DeskRAG should decline

**Confidence scores and confidence damping.** The paper wants confidence-weighted
fact selection, and damping on contradiction. DeskRAG's settled position is that
`FrameResult.score` is an ordering and not a confidence, that the UI and the MCP
tools show rank and evidence lanes and never the number, and that
`walk-analysis.ts` refuses a conformance ratio for exactly that reason ("a
conformance ratio would be exactly the number `FrameResult.score` established this
repo does not print"). Adopting damping would reintroduce the number the repo spent
effort removing.

**Contradiction *resolution*.** DeskRAG's answer to a contradiction is
**disclosure**: `droppedEarly`, duplicate disclosure, a binding that declines on a
tie, `way-fork` leaving four real ways as four ways. The paper's own BEAM figures
show every surveyed system scores below 0.05 on resolution — the state of the art
is that nobody can do it. For a tool whose output a person reads and acts on,
showing the contradiction is a defensible different answer, not a missing feature.

**Storage-level decay on captured rows.** §3.1. Non-negotiable, and now
non-negotiable on the paper's own terms.

---

## 8 · Summary of findings

| # | Finding | Location |
| --- | --- | --- |
| 1 | DeskRAG's bucket lists are the paper's move, arrived at independently and guard-enforced | `src/store/sqlite/schema.ts`, `test/store.purge-derived.test.ts:316` |
| 2 | Correct side of the storage/query litmus | `CAPTURED_TABLES` |
| 3 | LLM-free core with model at the consumer layer — enforced, not merely stated | `test/replay.barrel.test.ts`, injected providers |
| 4 | Evidence-gating over approval-gating, stricter than the paper asks | `recordedBlocks()`, `probe:habits` |
| 5 | **Defect:** no query-time recency term; a raw lifetime tally | `src/replay/plan.ts:42` |
| 6 | **Leak:** model prose re-read as observation | `src/represent/compose/compose-representer.ts:187` |
| 7 | **Absent:** the Knowledge layer — but typed *semantics*, not typed *stores* | §6 |
| 8 | Decline: confidence scores, contradiction resolution, storage-level decay | §7 |

The one actionable item is #5, and its action is a measurement:
`npm run probe:baseline` with a recency-weighted rule added, on a real library.

---

## Sources

- **Michaël Roynard, *The Missing Knowledge Layer in Cognitive Architectures for
  AI Agents*, arXiv:2604.11364.** Submitted 2026-04-13; **v2 revised
  2026-06-12**. All quotations in §1 are from the PDF text and were checked
  against v2 on 2026-09-04 (see the header) — quote v2 for anything added from
  here on, since the numbers agree but the section numbering may not.
  Companion implementations:
  `github.com/dutiona/knowledge-base` (Python), `github.com/dutiona/memory-engine`
  (Rust); pilot code at `github.com/dutiona/papers-material`.
- Cited *within* the paper and not independently checked here: CoALA, JEPA,
  Graphiti's bi-temporal model, the BEAM benchmark, BaseLayer's 20%-fidelity
  finding, NornicDB's three-tier decay, Mastra Observational Memory.
- In-repo anchors used above: `src/store/sqlite/schema.ts`,
  `src/replay/plan.ts:42`, `src/represent/compose/compose-representer.ts:187`,
  `src/represent/caption/caption-representer.ts:45`,
  `app/src/main/walk-analysis.ts:44`, `test/store.purge-derived.test.ts:316`,
  `test/habit.prose.test.ts`, plus the invariants in `CLAUDE.md` and
  `docs/internals/`.
