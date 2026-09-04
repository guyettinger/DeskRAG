/**
 * How settled a node or an edge is — the Knowledge layer's stability tier,
 * computed rather than stored.
 *
 * ## What this is
 *
 * `docs/research/persistence-layers.md` audits DeskRAG against Roynard's
 * four-layer decomposition and finds one layer genuinely absent: Knowledge,
 * "what is true", superseded rather than forgotten. Its §1.3 gives Knowledge
 * and Wisdom a stability tier, and gates promotion on STRUCTURED EVIDENCE
 * rather than on approval — the anti-sycophancy argument, and the one part of
 * the paper this repo had already taken further than the paper asks.
 *
 * This is that tier, and it is deliberately the SMALLEST possible version of
 * it: a pure function over the sources a graph already carries. No table, no
 * new `schema.ts` bucket, nothing persisted. See "Why nothing is stored"
 * below — the omission is the design, not a stage left unfinished.
 *
 * ## The count is distinct SESSIONS, never observations
 *
 * The paper's tier boundary is independent sessions, and DeskRAG has the real
 * thing rather than a proxy: `trace_node_source` / `trace_edge_source` carry
 * `session_id`. `observations` is the wrong number — one recording that walks
 * a loop twice contributes two observations and one session, and a tier is a
 * claim about corroboration, which a single recording cannot supply to itself.
 *
 * ## Why `anchor` is not minted
 *
 * The paper has three tiers; this has two. Its third, *anchor*, is
 * "uncontradicted across ten or more consolidation cycles" — and nothing in
 * DeskRAG counts consolidation cycles. `npm run probe:stability` runs three
 * re-index-and-re-mine cycles and persists no counter, so the input does not
 * exist. A tier that can never be reached is the `StageSpec.skipReason`
 * failure one screen over: a thing that never appears is indistinguishable
 * from a thing nobody implemented. It is named here, in prose, and absent from
 * the type.
 *
 * ## Why nothing is stored
 *
 * A separate Knowledge STORE is the shape the paper's own pilot argues
 * against: typed stores beat a flat store by +0.128 with an ORACLE router and
 * lost by 0.125 with a keyword one, and DeskRAG's retrieval is a tiered funnel
 * with RRF fusion and no router at all. Introducing a store means introducing
 * the routing decision the pilot shows is load-bearing and unsolved.
 *
 * There is a second reason, local to this repo. Persisted Knowledge in the
 * paper's sense — append-only, superseded, NOT recomputed — would be the first
 * state in the store that is neither rebuildable nor authored, a new answer to
 * the question `schema.ts` forces every table to answer. That call should be
 * made deliberately and not as a side effect of the first table, so this
 * derives instead: a re-index rebuilds the graph, the tier is recomputed from
 * it, and the re-index invariant is untouched.
 *
 * ## It is not a score
 *
 * A tier is a WORD and a count of recordings, which is why it may be printed
 * where `FrameResult.score` may not. `walk-analysis.ts` refuses a conformance
 * ratio on exactly that ground. Nothing here returns a fraction, and a consumer
 * that renders one has reintroduced the number this repo spent effort removing.
 */

/** The tiers whose input DeskRAG actually has. See the header on `anchor`. */
export type StabilityTier = "prediction" | "core";

export interface Stability {
  /** Null when the graph predates provenance: withheld, never guessed. */
  tier: StabilityTier | null;
  /** Distinct recordings this was observed in. 0 when none survive. */
  sessions: number;
  /** Why this tier, as a sentence. Required, for `Baseline.reason`'s reason. */
  reason: string;
}

/**
 * Recordings a state or a transition must be seen in before it stops being a
 * guess about one session.
 *
 * UNSWEPT — the same disclosure `RANKING_MIN_HABITS = 5` carries. Three is the
 * paper's own *core* threshold, stated there as configurable and motivated by
 * BaseLayer's 20%-fidelity finding rather than measured on anything like this
 * corpus. It agrees with a rule this repo reached independently, which is the
 * only corroboration it has: `probe:transfer` counts a route walked once as an
 * observation and not a habit.
 */
export const CORE_SESSIONS = 3;

/**
 * The tier for one node's or edge's sources.
 *
 * `undefined` is a graph lifted before provenance existed and is NOT the same
 * as `[]`, which is a graph whose recordings were all deleted. The first
 * cannot be counted; the second counts zero. Collapsing them would report a
 * missing feature as an absence of evidence.
 */
export function stabilityOf(sources: readonly { sessionId: string }[] | undefined): Stability {
  if (sources === undefined) {
    return {
      tier: null,
      sessions: 0,
      reason: "This graph was lifted before provenance was recorded, so its recordings are unknown.",
    };
  }
  const sessions = new Set(sources.map((s) => s.sessionId)).size;
  if (sessions >= CORE_SESSIONS) {
    return {
      tier: "core",
      sessions,
      reason: `Seen in ${sessions} separate recordings, so it is corroborated rather than observed once.`,
    };
  }
  return {
    tier: "prediction",
    sessions,
    reason:
      sessions === 0
        ? `Every recording this came from has been deleted, so nothing corroborates it now.`
        : `Seen in ${sessions} recording${sessions === 1 ? "" : "s"}; ${CORE_SESSIONS} is where a pattern stops being one session's habit.`,
  };
}
