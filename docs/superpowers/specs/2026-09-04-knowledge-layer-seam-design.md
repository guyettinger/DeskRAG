# The Knowledge layer seam: typed semantics, nothing stored

**Status:** design approved 2026-09-04. Settles
`docs/research/persistence-layers.md` §6.2, which was recorded as
deliberately open on 2026-09-03.

**Scope:** this is cycle 0 of four. It settles the invariant and ships the
contract. It creates **no table** and stores **no fact**. The three candidate
fact types the research doc names — cross-recording entity identity, environment
facts promoted library-wide, an application's AX shape per version — are each
their own later cycle and are explicitly out of scope here.

---

## 1 · The question being settled

The research doc's §6.2 left one thing open, and required that it be decided
deliberately rather than as a side effect of the first table:

> Persisted Knowledge in the paper's sense — append-only, superseded, **not
> recomputed** — would be the first state in this store that is neither
> rebuildable nor authored: a new answer to the question `schema.ts` forces
> every table to answer.

Two decisions close it. Both were made against real data rather than against the
paper, which is the point.

## 2 · The measurement that decided it

Read off the author's real library on 2026-09-04 — 12 recordings,
2026-08-17 → 2026-08-29, SQLite opened read-only.

| | occurrences | distinct payloads | actual configurations |
| --- | --- | --- | --- |
| `keymap_change` | 12 | **1** | 1 |
| `display_change` | 12 | **8** | **2** |

Every recording carries exactly one of each, so **nothing supersedes anything
within a session** and the chains a naive design would build are length 1.

The display row is the finding. Seven of its eight distinct payloads are the
same 1920×1080@2 primary display with a **different `id` every session** (180,
185, 206, 219, 247, 296, 297); the eighth is a genuine two-display setup
(1728×1117 primary plus a 3840×2160 external). macOS re-mints the identifier per
session, so `id` is a decoy and geometry is the discriminator.

Three things follow, and they are the whole basis of the design:

- **Keying supersession on the observed identifier would mint eight facts where
  there are two.** The Knowledge layer's first table would have been wrong on
  the first data it ever saw.
- **The two real configurations do not supersede one another.** They coexist —
  a laptop is docked some days and not others. "Newer wins" would delete a
  configuration that is still true, which is the paper's update mechanism
  producing a false claim.
- **Deciding whether display `180` and display `185` are the same display is
  entity identity**, the candidate this doc had ranked second. It is not a
  separate feature that happens to be nearby; it is a prerequisite of every
  other candidate. "Is this the same display", "is this the same document",
  "is this the same app version" are one question asked three times.

## 3 · Decision one — Knowledge is `DERIVED_LIBRARY_TABLES`, when it has a table

Knowledge does **not** get a sixth `schema.ts` bucket. When cycle 1 or later
adds a table, it is classified `DERIVED_LIBRARY_TABLES`, alongside the trace
graph, and inherits that bucket's contract: a rebuild discards the whole thing
and replays every session in order, and a per-session purge does not touch it.

**The argument is that the paper's reason for append-only does not transfer.**
Roynard's Knowledge is append-only because his system does not retain the
evidence — an agent learns a fact from a conversation, and the conversation is
gone. DeskRAG's `CAPTURED_TABLES` is exactly that retained evidence, and its
defining property is that a re-index must never touch it. So re-derivability is
available here for free, and buying it costs nothing the paper was protecting.
Taking the expensive side would have bought a property this store does not need,
at the price of the re-index invariant.

Two consequences, both already precedented rather than new:

- **A fact outlives the deletion of its evidence, and the gap is disclosed.**
  `removeSession` does not rebuild the trace graph today: `observations` survives
  while `sources` thins, and `GraphNodeDTO.sources` documents the discrepancy
  rather than repairing it. `stabilityOf` already separates `undefined`
  (pre-provenance) from `[]` (every recording deleted). Knowledge behaves the
  same way, so it introduces no new answer to what deletion means.
- **A rebuild re-derives under the providers configured now**, which is the
  re-index invariant holding rather than an exception to it.

## 4 · Decision two — exclusivity is per fact type, and supersession is computed

The paper updates Knowledge by supersession: a newer claim wins and the older is
preserved and marked superseded. §7 of the research doc declines contradiction
*resolution* in favour of disclosure. On the display data those collide and the
paper's rule loses, per §2.

**The resolution: every distinct observed value is kept with its sources. Each
fact TYPE declares whether its values can coexist. "Current" is computed at
query time and stored nowhere.**

This is the storage/query litmus applied to itself. A stored `superseded_by`
edge is a storage-level commitment to a ranking; which value is current is a
question asked per query, and it is answered per query. It also needs the
exclusivity judgement anyway to be correct on the display data — and once that
judgement is made, storing the edge buys nothing the computed form does not
already give.

## 5 · The contract — `src/knowledge/`

A leaf module: no store dependency, no model, no clock of its own. Exported from
the `deskrag` barrel, the shape `src/trace/stability.ts` already has.

```ts
/** A recording that observed a value. t_mono only — the wall clock is joined at query time. */
export interface KnowledgeSource { sessionId: string; tMono: number; }

/** One distinct value, and every recording that observed it. */
export interface ObservedValue<V> { value: V; sources: readonly KnowledgeSource[]; }

/** A fact: a kind, and the distinct values observed for it. Nothing is stored. */
export interface KnowledgeFact<V> { kind: string; values: readonly ObservedValue<V>[]; }

/** Declared per fact TYPE, never per value. */
export type Exclusivity = "exclusive" | "coexisting";
```

`exclusive` means at most one value is true at a time — a keyboard layout.
`coexisting` means several are — docked and undocked are both real.

**Ordering across recordings is injected.** `tMono` restarts at zero every
session, so ordering needs `session.started_at`, which is joined at query time
and is deliberately absent from this layer. The resolver takes a
`(sessionId) => number | undefined` exactly as `EdgeRecency` and
`RecencyOptions` do. Nothing in `knowledge/` reads a clock.

### What the resolver returns, and what it refuses

```ts
/** Orders a value's sources across recordings. Undefined = that recording cannot be dated. */
export type SessionStartedAt = (sessionId: string) => number | undefined;

export interface Current<V> {
  /** The current value, or null on every refusal below. */
  value: V | null;
  /** Why this answer. Required — the `Stability.reason` precedent. */
  reason: string;
  /** Distinct OTHER values still standing. A count of values, never a ratio. */
  alternatives: number;
  /** Sources that could not be dated, so could not be ordered. Disclosed, never guessed. */
  undated: number;
}

export function currentValue<V>(
  fact: KnowledgeFact<V>,
  exclusivity: Exclusivity,
  startedAt: SessionStartedAt,
): Current<V>;
```

`reason` follows the `Stability.reason` and `StageSpec.skipReason` precedent — a
thing that does not appear must say why.

| Case | Behaviour |
| --- | --- |
| `exclusive`, sources datable | The most recently observed value. Alternatives are **disclosed, never dropped**. |
| `coexisting` | **Refuses.** There is no current display configuration; the answer is the set. This is `get_habit_step` refusing a multi-way habit with no `way`. |
| A tie on the ordering | **Declines**, on `bindHabit`'s strict-majority-declines-on-a-tie precedent. |
| Sources that cannot be dated | **Disclosed, never guessed** — `stabilityOf`'s `undefined` vs `[]` rule. |
| No values at all | Null with a reason. Distinct from a value whose recordings were all deleted. |

**Counts only.** No ratio, no confidence, no percentage. A stability percentage
would be `FrameResult.score` under a new name, and so would this.

## 6 · What this deliberately does not do

**It does not decide whether two values are the same value.** Fed the real
display data, `currentValue` reports eight coexisting configurations, not two.

That is the seam, not a defect being hidden. Deduplication is cycle 1's whole
subject, and leaving it out here makes the display case legible *as* an identity
problem rather than silently mis-keying it — which is exactly what a stored
`superseded_by` edge would have done, and it would have looked correct.

Also out of scope: any table, any bucket-list edit, any `index-plan.ts` stage,
any UI surface, any MCP tool. §6.3 reserves `search_knowledge` and `get_fact` as
names that satisfy the read-only guard's `^(search|get|list)_` rule; neither is
built here.

## 7 · Testing

Unit-level, no fixtures and no real data required: latest-wins for `exclusive`;
`coexisting` refuses; a tie declines; undatable sources are disclosed; empty and
single-value facts. `npm run typecheck` and `npm test` are the gates.

The design's correctness against real data is established by §2 and is a claim
about cycle 1, not about this code. The documented expectation — not a suite
assertion, since it would need the real library — is that `currentValue` fed the
eight display payloads reports eight coexisting configurations. That is the
honest answer for a layer that does not do identity, and cycle 1 is what should
turn it into two.

## 8 · What would reopen this

Recorded so a later session does not relitigate it by accident:

- **A fact type whose evidence is genuinely not retained.** The whole argument
  in §3 is that `CAPTURED_TABLES` keeps the evidence. A fact learned from
  something DeskRAG does not store would break that and would deserve the
  sixth bucket the paper wants.
- **A rebuild that cannot reproduce a fact in session order.** The
  `DERIVED_LIBRARY_TABLES` contract assumes replay-in-order is sufficient, as it
  is for the trace graph.
- **A measured need for a stored supersession edge** — for instance a chain long
  enough that recomputing it per query is too slow. Nothing on a 12-recording
  library suggests this; `DEFAULT_RRF_K` is the precedent that the number comes
  before the adoption.

## 9 · Sources

- `docs/research/persistence-layers.md` §6, §6.1, §6.2, §6.3, §7 — the argument.
- `docs/internals/persistence.md` — the durable rules, to be updated by this cycle.
- Michaël Roynard, *The Missing Knowledge Layer in Cognitive Architectures for AI
  Agents*, arXiv:2604.11364, v2 revised 2026-06-12. Re-verified 2026-09-04: the
  keyword-router reversal (Δ = −0.125) and the three-session *core* threshold
  are unchanged from the v1 this repo cited.
- In-repo precedents relied on: `src/trace/stability.ts`, `src/replay/types.ts`
  (`EdgeRecency`), `app/src/main/walk-analysis.ts` (`RecencyOptions`),
  `app/src/main/habit-bind.ts` (declines on a tie),
  `src/store/sqlite/schema.ts` (the buckets), `test/store.purge-derived.test.ts`
  (the classification guard).
