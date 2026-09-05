/**
 * The Knowledge layer's semantics — what is true, computed rather than stored.
 *
 * ## What this is
 *
 * `docs/research/persistence-layers.md` finds one of the paper's four layers
 * genuinely absent from DeskRAG: Knowledge, "what is true", superseded rather
 * than forgotten. Its §6.2 left one question open on purpose — whether such a
 * layer is PERSISTED append-only, which would be the first state in this store
 * that is neither rebuildable nor authored. This module is the answer, and the
 * answer is that nothing is stored. See
 * `docs/superpowers/specs/2026-09-04-knowledge-layer-seam-design.md`.
 *
 * ## Why a fact is not stored
 *
 * The paper's Knowledge is append-only because its system does not RETAIN the
 * evidence: an agent learns a fact from a conversation and the conversation is
 * gone. `CAPTURED_TABLES` is exactly that retained evidence, and a re-index must
 * never touch it — so re-derivability is free here and the paper's reason does
 * not transfer. When a later cycle adds a table it is classified
 * `DERIVED_LIBRARY_TABLES`, beside the trace graph, and inherits its contract: a
 * rebuild discards everything and replays every session in order.
 *
 * ## Why supersession is COMPUTED, and exclusivity is per TYPE
 *
 * The paper updates Knowledge by supersession — newer claim wins, older marked
 * superseded. Measured on the real library, that rule produces a FALSE CLAIM:
 * `display_change` carries 12 occurrences and 8 distinct payloads but only TWO
 * configurations, and the two do not supersede one another — a laptop is docked
 * some days and not others. "Newer wins" would delete a configuration that is
 * still true.
 *
 * So every distinct value is kept with its sources, and the TYPE declares
 * whether its values can coexist. A keyboard layout is `exclusive`; a display
 * topology is `coexisting`. "Current" is then a question asked per query and
 * answered per query — a stored `superseded_by` edge would be a storage-level
 * commitment to a ranking, which is the litmus this repo already holds.
 *
 * ## What this deliberately does NOT do
 *
 * It does not decide whether two values are the SAME value. Fed those 8 display
 * payloads it reports 8, not 2 — seven of them are the same physical display
 * with an `id` macOS re-mints every session. Collapsing them is cross-recording
 * entity identity, a later cycle, and leaving it out here makes that case
 * legible AS an identity problem rather than silently mis-keying it.
 *
 * ## It is not a score
 *
 * `alternatives` and `undated` are COUNTS. Nothing here returns a fraction, and
 * a consumer that renders one has reintroduced the number `FrameResult.score`
 * established this repo does not print.
 */

/**
 * A recording that observed a value, and how far into it.
 *
 * `tMono` only — the wall clock is not in this layer to be read. `EdgeSource`
 * carries the same pair for the same reason.
 */
export interface KnowledgeSource {
  sessionId: string;
  tMono: number;
}

/**
 * One distinct value, and every recording that observed it.
 *
 * DISTINCT is the caller's guarantee. Nothing here merges two values that mean
 * the same thing — see the header.
 */
export interface ObservedValue<V> {
  value: V;
  sources: readonly KnowledgeSource[];
}

/** A fact: a kind, and the distinct values observed for it. Stored nowhere. */
export interface KnowledgeFact<V> {
  kind: string;
  values: readonly ObservedValue<V>[];
}

/**
 * Whether a fact's values can be true at the same time. Declared per TYPE,
 * never per value: a keyboard layout is `exclusive`, a display topology is not.
 */
export type Exclusivity = "exclusive" | "coexisting";

/**
 * Orders a recording against the others. `undefined` is an UNDATABLE recording,
 * which is disclosed rather than guessed.
 *
 * Injected, because `tMono` restarts at zero every session and
 * `session.started_at` is joined at query time. `EdgeRecency` and
 * `RecencyOptions` take the same shape.
 */
export type SessionStartedAt = (sessionId: string) => number | undefined;

/** What a fact resolves to right now. Counts only — never a ratio. */
export interface Current<V> {
  /** The current value, or null on every refusal. */
  value: V | null;
  /** Why this answer. Required — a thing that does not appear must say why. */
  reason: string;
  /** Distinct OTHER values still standing. A count of values. */
  alternatives: number;
  /** Sources that could not be dated, so could not be ordered. */
  undated: number;
}

/** The latest moment this value was observed, or null when nothing datable saw it. */
function observedAt(v: ObservedValue<unknown>, startedAt: SessionStartedAt): number | null {
  let latest: number | null = null;
  for (const s of v.sources) {
    const start = startedAt(s.sessionId);
    if (start === undefined) continue;
    const when = start + s.tMono;
    if (latest === null || when > latest) latest = when;
  }
  return latest;
}

/** Sources across the whole fact that no clock could place. */
function undatedSources(fact: KnowledgeFact<unknown>, startedAt: SessionStartedAt): number {
  let n = 0;
  for (const v of fact.values) {
    for (const s of v.sources) if (startedAt(s.sessionId) === undefined) n += 1;
  }
  return n;
}

/**
 * Which value of this fact is current.
 *
 * Refuses three ways, and each refusal is an answer rather than an error: a
 * `coexisting` fact has no current value, a tie declines on `bindHabit`'s
 * precedent, and a fact nothing can date says so.
 */
export function currentValue<V>(
  fact: KnowledgeFact<V>,
  exclusivity: Exclusivity,
  startedAt: SessionStartedAt,
): Current<V> {
  const undated = undatedSources(fact, startedAt);
  const total = fact.values.length;

  let best: { value: V; when: number } | null = null;
  let tied = false;
  for (const v of fact.values) {
    const when = observedAt(v, startedAt);
    if (when === null) continue;
    if (best === null || when > best.when) {
      best = { value: v.value, when };
      tied = false;
    } else if (when === best.when) {
      tied = true;
    }
  }

  if (best === null || tied) {
    // Task 2 fills in the refusals. Until then, an unranked fact is not current.
    return { value: null, reason: `Nothing is current for ${fact.kind}.`, alternatives: total, undated };
  }

  return {
    value: best.value,
    reason:
      total === 1
        ? `The only value observed for ${fact.kind}.`
        : `Most recently observed of ${total} values for ${fact.kind}; ${total - 1} other${total === 2 ? "" : "s"} still stand.`,
    alternatives: total - 1,
    undated,
  };
}
