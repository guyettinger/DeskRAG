/**
 * Finding a saved habit's route again after the graph moved under it.
 *
 * A route's id IS the de-duplicated sequence of place labels it passes through
 * (`places.join(" → ")`, `graph-view.ts`). That key is the only one that finds
 * repetition — edge-id and node-id sequences were both measured on a real
 * 9-recording graph and both split five identical walks into nine routes of ×1 —
 * and it is NOT stable: record the same task once more in a way that touches one
 * extra application and the key changes. `rebuildGraph` discards and replays the
 * whole graph on every re-index.
 *
 * So a habit cannot BE a route. It owns a ULID, and stores what it was bound to
 * as a record of a past act. This module reads that record against the routes
 * that exist now.
 *
 * **Nothing here writes.** A re-bind is DISCLOSED and stays disclosed until the
 * user confirms it; the stored key changes only by an explicit act. Silently
 * adopting a new key would make the habit's own record of where it came from
 * unfalsifiable — the `observations` vs `sources` ethic, one level up.
 *
 * Pure: plain objects in, plain objects out. Root-tested.
 */

import type { FlowRouteDTO, RouteWalkDTO, WalkFitDTO, WalkMarkDTO } from "@shared/types";

/** What was true at the moment the user kept this habit. Never rewritten here. */
export interface HabitBindingDoc {
  /** `FlowRouteDTO.id` at accept time — the place sequence, not an edge list. */
  routeKey: string;
  /** The route's `label` then, already elided at MAX_ROUTE_HOPS. */
  routeLabel: string;
  /**
   * The route's `sessionIds` then.
   *
   * NEVER a foreign key: a deleted recording must CHANGE this habit's evidence
   * count, not delete the habit. That is also why it is the re-bind evidence —
   * labels can change wholesale, but the recordings a route was made of do not.
   */
  sessionIds: string[];
  /** Wall clock of the last act that set the three fields above. */
  boundAt: number;
}

export type HabitBindState = "exact" | "rebound" | "ambiguous" | "orphaned";

export interface HabitBinding {
  state: HabitBindState;
  /** The route this habit reads from NOW. Null when orphaned or ambiguous. */
  route: FlowRouteDTO | null;
  /** Bind-time recordings the live route still has. */
  overlap: number;
  /** Bind-time recordings the live route no longer has: deleted, or re-keyed. */
  lostSessionIds: string[];
  /** Recordings the live route has that this habit was never bound to. */
  gainedSessionIds: string[];
  /** Every route that tied. Empty unless `state === "ambiguous"`. */
  candidates: string[];
  /** One sentence for the row and for the file. Null when nothing moved. */
  note: string | null;
}

const quoted = (s: string): string => `“${s}”`;

/**
 * Resolve one habit against the routes the graph has now.
 *
 * The majority rule is not a tuned threshold, and that is the point.
 * `frequentRoutes` builds its groups keyed by `sessionId` and each recording
 * produces exactly one key, so **the sessionIds partition across routes** — more
 * than half of a set can lie in at most one part. A strict majority therefore
 * has at most one winner mathematically, with no heuristic tiebreak to get
 * wrong.
 *
 * The only case that ties is an even split — two recordings landing on two
 * routes — and there it DECLINES rather than picking, for the reason
 * `trace/identity.ts` declines to merge on ambiguity: a redundant state is
 * visible and fixable, a wrong one is silent corruption.
 */
export function bindHabit(
  doc: HabitBindingDoc,
  routes: readonly FlowRouteDTO[],
): HabitBinding {
  const bound = new Set(doc.sessionIds);

  const against = (route: FlowRouteDTO): { lost: string[]; gained: string[]; overlap: number } => {
    const live = new Set(route.sessionIds);
    const lost = doc.sessionIds.filter((id) => !live.has(id));
    const gained = route.sessionIds.filter((id) => !bound.has(id));
    return { lost, gained, overlap: doc.sessionIds.length - lost.length };
  };

  // 1. The key still exists. Still compute lost/gained: a route can keep its key
  //    and lose a recording, and that has to show rather than reading as intact.
  const exact = routes.find((r) => r.id === doc.routeKey);
  if (exact !== undefined) {
    const { lost, gained, overlap } = against(exact);
    return {
      state: "exact",
      route: exact,
      overlap,
      lostSessionIds: lost,
      gainedSessionIds: gained,
      candidates: [],
      note:
        lost.length === 0
          ? null
          : `${lost.length} of the ${doc.sessionIds.length} recordings this habit was written from ` +
            `${lost.length === 1 ? "is" : "are"} no longer in this route.`,
    };
  }

  // 2. Strict majority of the bind-time recordings.
  const scored = routes
    .map((r) => ({ route: r, ...against(r) }))
    .filter((c) => c.overlap * 2 > doc.sessionIds.length);

  if (scored.length === 1) {
    const only = scored[0]!;
    return {
      state: "rebound",
      route: only.route,
      overlap: only.overlap,
      lostSessionIds: only.lost,
      gainedSessionIds: only.gained,
      candidates: [],
      note:
        `The states this flow passes through changed. It was ${quoted(doc.routeKey)}; ` +
        `${only.overlap} of its ${doc.sessionIds.length} recordings are now in ` +
        `${quoted(only.route.id)}.`,
    };
  }

  if (scored.length > 1) {
    return {
      state: "ambiguous",
      route: null,
      overlap: 0,
      lostSessionIds: [...doc.sessionIds],
      gainedSessionIds: [],
      candidates: scored.map((c) => c.route.id),
      note:
        `The ${doc.sessionIds.length} recordings this habit was written from now key to ` +
        `${scored.length} different routes: ${scored.map((c) => quoted(c.route.id)).join(", ")}. ` +
        `DeskRAG will not choose between them.`,
    };
  }

  // 3. Nothing. Kept, never deleted — the prose is the user's.
  return {
    state: "orphaned",
    route: null,
    overlap: 0,
    lostSessionIds: [...doc.sessionIds],
    gainedSessionIds: [],
    candidates: [],
    note:
      `None of the ${doc.sessionIds.length} recordings this habit was written from are in any ` +
      `current route. It was ${quoted(doc.routeKey)}.`,
  };
}

/**
 * Routes with no habit and no dismissal yet — computed, never stored.
 *
 * Keyed on the ROUTE KEY rather than on a habit id, because that is what a
 * proposal is: a route nobody has answered about. A dismissal is a real stored
 * row for exactly this reason — a rejected proposal that is not persisted comes
 * back on every load.
 */
/**
 * Active habits that now answer to the SAME live route.
 *
 * Two habits can arrive at one route without anybody doing anything wrong: a
 * re-index re-keys every route, near-miss clustering merges two of them, and a
 * disclosed re-bind is confirmed. The result is two files describing one
 * procedure, which is the duplicate explosion that makes a habit library stop
 * being worth reading.
 *
 * It DISCLOSES and never merges. Each habit holds prose a person may have
 * written and edited, and prose is the one thing in this repo that nothing can
 * remake — `AUTHORED_TABLES` exists to say so. Choosing which of two to keep is
 * therefore a judgement, and the same ethic as `bindHabit` declining on a tie:
 * the app says what it found and stops.
 *
 * Keyed on the LIVE route, not on the stored `routeKey`: two habits bound at
 * different times to keys that have since merged are the interesting case, and
 * comparing what they were bound to would miss exactly that one.
 *
 * Returns, for each habit id, the OTHER ids sharing its route. Absent from the
 * map means it is alone, which is the common case.
 */
export function duplicateHabits(
  habits: readonly { id: string; liveRouteKey: string | null }[],
): Map<string, string[]> {
  const byRoute = new Map<string, string[]>();
  for (const s of habits) {
    // An orphan answers to no route, so it cannot duplicate one. Grouping the
    // orphans together would report every unbindable habit as a duplicate of
    // every other, which is the opposite of informative.
    if (s.liveRouteKey === null) continue;
    const list = byRoute.get(s.liveRouteKey);
    if (list === undefined) byRoute.set(s.liveRouteKey, [s.id]);
    else list.push(s.id);
  }

  const out = new Map<string, string[]>();
  for (const ids of byRoute.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) out.set(id, ids.filter((other) => other !== id));
  }
  return out;
}

export function unclaimedRoutes(
  routes: readonly FlowRouteDTO[],
  claimed: readonly string[],
): FlowRouteDTO[] {
  const taken = new Set(claimed);
  return routes.filter((r) => !taken.has(r.id));
}

/**
 * Recordings placed on the wall clock, oldest first.
 *
 * The screen draws one mark per walk instead of printing `×3`, so this is the
 * function that turns a count back into the thing it counted. A count can only
 * say how often; the marks say how often AND when, and "when" is the half that
 * answers whether a habit is still being practised.
 *
 * A recording with no row in the session table is DROPPED, never placed at the
 * epoch: a mark at 1970 would rescale the whole screen's shared domain to a
 * half-century and flatten every real walk into one pixel. That is not
 * hypothetical — a route's `sessionIds` outlive the recordings they name, which
 * is exactly why `HabitBindingDoc.sessionIds` is not a foreign key.
 *
 * `walks` is the LIVE route's own walks, which is what makes a mark followable:
 * it carries the lane seconds this recording walked the route at. It is
 * deliberately allowed to be missing an id — an orphaned or ambiguous habit has
 * no live route at all, and there the mark is drawn from the bind-time ids with
 * no moment to open. Absent, never invented.
 */
export function walkMarks(
  sessionIds: readonly string[],
  startedAt: ReadonlyMap<string, number>,
  gained: ReadonlySet<string>,
  walks: readonly RouteWalkDTO[] = [],
  /**
   * How each recording compared to the standard, keyed by session.
   *
   * Absent for a proposal and for an orphaned habit, and a session missing from
   * it gets `fit: null` — which means NO STANDARD EXISTED, not "it conformed".
   */
  fits: ReadonlyMap<string, WalkFitDTO> = new Map(),
): WalkMarkDTO[] {
  const walked = new Map(walks.map((w) => [w.sessionId, w]));
  const out: WalkMarkDTO[] = [];
  for (const sessionId of sessionIds) {
    const at = startedAt.get(sessionId);
    if (at === undefined) continue;
    const w = walked.get(sessionId);
    out.push({
      sessionId,
      at,
      gained: gained.has(sessionId),
      fit: fits.get(sessionId) ?? null,
      walk:
        w === undefined
          ? null
          : { atSec: w.atSec, throughSec: w.throughSec, steps: w.edgeIds.length },
    });
  }
  return out.sort((a, b) => a.at - b.at);
}
