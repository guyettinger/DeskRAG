/**
 * What a habit's own recordings say about how it is going.
 *
 * `habit-doc.ts` renders what the recordings DID and is structurally silent
 * about how it went — and rightly so for outcomes: `TraceEdge.outcomes` is
 * `{attempts: 0, successes: 0}` on every graph on disk, because passive
 * recording cannot observe a failure. The user did the thing, so it succeeded.
 *
 * That is true about outcomes and false about CONSISTENCY. The store already
 * holds, per walk, the exact edge sequence taken and when each edge was walked;
 * process mining calls comparing a model against its own log conformance
 * checking, and DeskRAG does discovery and stops. This module is that
 * comparison, plus the three other facts sitting unread beside it: what a step
 * costs, what preceded the work, and how the walks are spaced in a life.
 *
 * Pure: `FlowsDTO` in, plain objects out. No store, no Electron, no model — the
 * same contract `flow-steps.ts` holds, and what keeps this file in the ROOT
 * suite.
 *
 * THREE RULES IT DOES NOT BREAK:
 *
 * - **No score.** Counts and named facts only. A conformance ratio would be
 *   exactly the number `FrameResult.score` established this repo does not print.
 * - **No merge.** `droppedEarly` is a disclosure in the shape of `duplicates`.
 *   Merging a prefix route into its parent would inflate `route.count`, and that
 *   count is what the entire recurrence argument rests on.
 * - **No DTO widening.** What is not on `FlowsDTO` arrives through a hook.
 */

import type { FlowRouteDTO, FlowsDTO } from "@shared/types";
import { flowWalks, type FlowWalk } from "./flow-steps.js";
import { alignWalk, type EdgeDeviation } from "./walk-align.js";

/**
 * Which Way is the standard.
 *
 * All four ship, and `npm run probe:baseline` picks the default — exactly as
 * `route-cluster.ts` ships four cluster rules so `probe:routes` can measure the
 * choice on a real library instead of asserting it. Each is wrong in a way the
 * others are not: `majority` calls a recently adopted better path the
 * deviation, `recent` lets one fumbled session become the standard, `none`
 * cannot say when the variation happened, and `weighted` — the two ends of that
 * spectrum joined by a half-life — demotes a Way that is still the right one
 * whenever the gap since the last walk exceeds the half-life.
 *
 * `weighted` IS THE QUERY-TIME HALF OF A LITMUS, and the distinction is the
 * whole reason it is shaped this way (docs/internals/persistence.md). The
 * intuitive version of this rule decays the stored walk counts; that is a
 * storage-level operation standing in for a query-time preference, and it is
 * the documented category error. Nothing here mutates a count. The weight is
 * computed per call, from a reference time the CALLER supplies, over rows that
 * keep meaning exactly what they meant before.
 */
export type BaselineRule = "majority" | "recent" | "none" | "weighted";

/**
 * The half-life `weighted` scores with, and the moment it counts back from.
 *
 * `now` is REQUIRED rather than defaulted, and `chooseBaseline` reads no clock
 * of its own: a rule that calls `Date.now()` internally cannot be tested
 * against a fixture, and every other injected seam in this layer
 * (`WalkAnalysisHooks.antecedentAt`, `LiftInput.visualAt`) is shaped the same
 * way for the same reason. The single wall-clock read lives at `walkAnalysis`,
 * which is the consumer boundary.
 */
export interface RecencyOptions {
  /** Reference time to measure staleness against. */
  now: number;
  /** Milliseconds after which a walk counts half. */
  halfLifeMs?: number;
}

/**
 * UNSWEPT, and it is `probe:baseline`'s job to sweep it — the same disclosure
 * `RANKING_MIN_HABITS = 5` carries. Fourteen days is a starting point, not a
 * finding: it is roughly the span over which a desktop workflow is still the
 * one you are doing, and nothing has measured that.
 */
export const DEFAULT_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

export interface Baseline {
  rule: BaselineRule;
  /** Index into `flowWalks(...)`. Null when no Way qualifies. */
  wayIndex: number | null;
  /**
   * WHY this Way, as a sentence.
   *
   * Required, and never an enum. A rule that merely applied without saying
   * which Way won and why is the `StageSpec.skipReason` failure one screen
   * over: a thing that never appears is indistinguishable from a thing nobody
   * implemented.
   */
  reason: string;
}

/** An `EdgeDeviation` with the step label resolved from the graph. */
export interface Deviation extends EdgeDeviation {
  /** "Place 1 → Place 2", from the same node labels the record prints. */
  label: string;
}

export interface WalkFit {
  sessionId: string;
  /**
   * Wall clock of the recording's start, or null.
   *
   * NOT on `RouteWalkDTO`, which carries lane seconds only. Resolved from an
   * `EdgeSourceDTO.startedAt`, the way `FlowStep.firstAt` already is. Null when
   * no source resolves — the `sourcesBelowObservations` case, where a recording
   * this walk came from has been deleted. Null is carried, never invented.
   */
  at: number | null;
  /** Vacuously true under the `none` rule, which names no end to reach. */
  reachedEnd: boolean;
  deviations: Deviation[];
}

export interface StepCost {
  stepIndex: number;
  edgeId: string;
  /** The step's OWN extent per recording — `throughSec - atSec`, never a difference between edges. */
  durations: { sessionId: string; ms: number }[];
  /** Idle between this step ending and the next beginning. Empty on the last step. */
  gapsAfter: { sessionId: string; ms: number }[];
}

export interface Antecedent {
  /** "Slack", "github.com/…", "Tue 09:00" — one observed fact. */
  what: string;
  kind: "app" | "place" | "phase";
}

export interface AntecedentFact extends Antecedent {
  observations: number;
  of: number;
}

export interface RhythmFacts {
  /** Milliseconds between consecutive walks, oldest first. Empty below 2 dated walks. */
  intervalsMs: number[];
  /** Local hour (0–23) and day (0–6) of each dated walk, oldest first. */
  hours: number[];
  days: number[];
}

export interface PrefixFact {
  routeKey: string;
  places: readonly string[];
  count: number;
  sessionIds: string[];
}

export interface WalkAnalysis {
  baseline: Baseline;
  walks: WalkFit[];
  steps: StepCost[];
  antecedents: AntecedentFact[];
  rhythm: RhythmFacts;
  droppedEarly: PrefixFact[];
}

export interface WalkAnalysisHooks {
  /**
   * What was in front just before this walk started, or null.
   *
   * Injected because it needs the focus/event stream and `FlowsDTO` does not
   * carry it — `briefFor` takes `reflections` for the same stated reason, and
   * `LiftInput.visualAt` is the same shape one layer down. No hook means no
   * antecedents, and the consumer renders nothing. Never a guess.
   */
  antecedentAt?(sessionId: string, atSec: number): Antecedent | null;
}

export interface WalkAnalysisInput {
  flows: FlowsDTO;
  route: FlowRouteDTO;
  /**
   * Provisional default until `npm run probe:baseline` reports on the real
   * library. `majority` is the conservative pick: it is frequency-honest, and
   * being wrong about a recently improved path is a milder failure than letting
   * one bad session become the standard.
   */
  rule?: BaselineRule;
  /** Read only by `weighted`. Defaults to `DEFAULT_HALF_LIFE_MS`. */
  halfLifeMs?: number;
  /**
   * Reference time for `weighted`. THE ONE WALL-CLOCK READ in this module
   * defaults it, below; supply it from a test or a probe to keep the answer
   * reproducible.
   */
  now?: number;
}

const DEFAULT_RULE: BaselineRule = "majority";

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Session -> the wall clock its recording started at.
 *
 * FIRST source wins, and the walk order does not matter: every source for one
 * session carries the same `startedAt`, because it is the recording's own start
 * rather than the moment of the edge.
 */
export function sessionStartedAt(flows: FlowsDTO): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of flows.graph.edges) {
    for (const s of e.sources) {
      if (!out.has(s.sessionId)) out.set(s.sessionId, s.startedAt);
    }
  }
  return out;
}

/** The newest wall clock among a Way's recordings, or null when none is dated. */
function newestAt(way: FlowWalk, startedAt: ReadonlyMap<string, number>): number | null {
  let best: number | null = null;
  for (const id of way.sessionIds) {
    const at = startedAt.get(id);
    if (at !== undefined && (best === null || at > best)) best = at;
  }
  return best;
}

/**
 * A Way's recency-weighted evidence: one walk decays to half its vote per
 * half-life elapsed.
 *
 * An UNDATED session contributes 0 and is still counted by the caller for
 * disclosure. Dropping it from the denominator instead would report unanimity
 * nobody observed — `antecedentsOf`'s `of` rule, one rule over. A walk dated
 * in the FUTURE clamps to weight 1 rather than exceeding it: a clock skew is
 * not extra evidence.
 */
function wayWeight(
  way: FlowWalk,
  startedAt: ReadonlyMap<string, number>,
  now: number,
  halfLifeMs: number,
): { weight: number; dated: number } {
  let weight = 0;
  let dated = 0;
  for (const id of way.sessionIds) {
    const at = startedAt.get(id);
    if (at === undefined) continue;
    dated += 1;
    weight += 0.5 ** (Math.max(0, now - at) / halfLifeMs);
  }
  return { weight, dated };
}

/** The `majority` answer, extracted so the weighted fallback can name it. */
function chooseMajority(
  ways: readonly FlowWalk[],
  startedAt: ReadonlyMap<string, number>,
): { wayIndex: number; reason: string } {
  const total = ways.reduce((n, w) => n + w.sessionIds.length, 0);
  const top = Math.max(...ways.map((w) => w.sessionIds.length));
  const tied = ways
    .map((w, i) => ({ way: w, i }))
    .filter(({ way }) => way.sessionIds.length === top);

  if (tied.length === 1) {
    const only = tied[0]!;
    return { wayIndex: only.i, reason: `The Way ${top} of the ${total} recordings took.` };
  }

  // A TIE means the tiebreak is carrying the whole decision, and a standard
  // chosen that way is one more recording away from moving. It is said out
  // loud for the same reason `nameObservations < count` is.
  let winner = tied[0]!;
  let winnerAt = newestAt(winner.way, startedAt);
  for (const cand of tied.slice(1)) {
    const at = newestAt(cand.way, startedAt);
    if (at !== null && (winnerAt === null || at > winnerAt)) {
      winner = cand;
      winnerAt = at;
    }
  }
  return {
    wayIndex: winner.i,
    reason:
      `${tied.length} Ways tie at ${top} recording${top === 1 ? "" : "s"} each; ` +
      `the standard is the one holding the newest walk.`,
  };
}

const DAYS_MS = 24 * 60 * 60 * 1000;

export function chooseBaseline(
  ways: readonly FlowWalk[],
  rule: BaselineRule,
  startedAt: ReadonlyMap<string, number>,
  recency?: RecencyOptions,
): Baseline {
  if (rule === "none") {
    return { rule, wayIndex: null, reason: "No Way is the standard, so no walk is called deviant." };
  }
  if (ways.length === 0) {
    return { rule, wayIndex: null, reason: "This route has no recorded walks." };
  }

  if (rule === "recent") {
    // A `for` loop, NOT `ways.forEach`. TypeScript does not widen a `let`
    // narrowed at its declaration just because a callback assigns to it, so
    // `let bestAt: number | null = null` stays narrowed to `null` after a
    // `forEach` and the date branch below becomes unreachable-looking. The loop
    // keeps the narrowing honest instead of needing an annotation to undo it.
    let bestIndex = 0;
    let bestAt: number | null = null;
    for (let i = 0; i < ways.length; i += 1) {
      const at = newestAt(ways[i]!, startedAt);
      if (at !== null && (bestAt === null || at > bestAt)) {
        bestAt = at;
        bestIndex = i;
      }
    }
    return {
      rule,
      wayIndex: bestIndex,
      reason:
        bestAt === null
          ? "The Way the newest recording took; none of them carries a date."
          : `The Way the newest recording took, on ${iso(bestAt)}.`,
    };
  }

  if (rule === "weighted") {
    // No reference time, no rule. It DECLINES rather than reaching for the
    // clock: a silent fallback is the failure `scripts/lib/flows.ts` documents,
    // where a probe measuring nothing looks exactly like one that found
    // nothing.
    if (recency === undefined) {
      return {
        rule,
        wayIndex: null,
        reason: "The weighted rule needs a reference time and none was supplied.",
      };
    }
    const halfLifeMs = recency.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
    const scored = ways.map((way, i) => ({ i, ...wayWeight(way, startedAt, recency.now, halfLifeMs) }));
    const totalWalks = ways.reduce((n, w) => n + w.sessionIds.length, 0);
    const totalDated = scored.reduce((n, s) => n + s.dated, 0);

    // NOTHING IS DATED, so every weight is 0 and the rule has no signal at all.
    // It falls back to `majority` and says which answer the reader is looking
    // at — the deviation table would otherwise silently be a majority table
    // wearing a different rule's name.
    if (totalDated === 0) {
      const fallback = chooseMajority(ways, startedAt);
      return {
        rule,
        wayIndex: fallback.wayIndex,
        reason: `No recording carries a date, so recency has no signal here; falling back to majority. ${fallback.reason}`,
      };
    }

    let best = scored[0]!;
    for (const cand of scored.slice(1)) {
      if (cand.weight > best.weight) best = cand;
    }
    const days = Math.round(halfLifeMs / DAYS_MS);
    const newest = newestAt(ways[best.i]!, startedAt);
    const undated = totalWalks - totalDated;
    return {
      rule,
      wayIndex: best.i,
      reason:
        `The Way carrying the most recent-weighted evidence at a ${days}-day half-life: ` +
        `${ways[best.i]!.sessionIds.length} of ${totalWalks} recordings` +
        `${newest === null ? "" : `, the newest on ${iso(newest)}`}` +
        `${undated > 0 ? `; ${undated} undated walk${undated === 1 ? "" : "s"} counted for nothing` : ""}.`,
    };
  }

  return { rule, ...chooseMajority(ways, startedAt) };
}

/**
 * "Place 1 → Place 2" for an edge, or a named absence.
 *
 * The absence is spelled out rather than skipped, for `FlowStep.missing`'s
 * reason: a step that vanished makes a flow read as shorter than it was, and a
 * deviation that vanished makes a walk read as closer to the standard than it
 * was — which is the one direction this module must never err in.
 */
function edgeLabel(flows: FlowsDTO, edgeId: string): string {
  const edge = flows.graph.edges.find((e) => e.id === edgeId);
  if (edge === undefined) return `edge ${edgeId} is not in the graph`;
  const label = (id: string): string => flows.graph.nodes.find((n) => n.id === id)?.label ?? id;
  return `${label(edge.from)} → ${label(edge.to)}`;
}

/** Every recording's own edge sequence, in the order `frequentRoutes` recorded it. */
function walkedEdges(route: FlowRouteDTO): { sessionId: string; edgeIds: readonly string[] }[] {
  if (route.walks.length > 0) {
    return route.walks.map((w) => ({ sessionId: w.sessionId, edgeIds: w.edgeIds }));
  }
  // `flowWalks` degrades the same way for the one input that cannot distinguish
  // a route with no walks from a route walked once — a hand-built fixture.
  return [{ sessionId: route.sessionIds[0] ?? "", edgeIds: route.edgeIds }];
}

const MS_PER_SEC = 1000;

/**
 * Every recording's source on one edge, keyed by session.
 *
 * `EdgeSourceDTO` is where BOTH the wall clock and the extent live; `atSec` on
 * `RouteWalkDTO` is the whole walk's span and cannot answer for a single step.
 *
 * EXPORTED so `habitRuns` reads edge sources through this function rather than
 * walking `edge.sources` a second time. Two readers of one shape is the
 * `ax-dump`/`ax-exec` drift hazard, and the first-source-wins rule below is
 * exactly the kind of tie-break that would be reimplemented differently.
 */
export function sourcesOf(
  flows: FlowsDTO,
  edgeId: string,
): Map<string, { atSec: number; throughSec: number }> {
  const out = new Map<string, { atSec: number; throughSec: number }>();
  const edge = flows.graph.edges.find((e) => e.id === edgeId);
  if (edge === undefined) return out;
  for (const s of edge.sources) {
    if (!out.has(s.sessionId)) out.set(s.sessionId, { atSec: s.atSec, throughSec: s.throughSec });
  }
  return out;
}

/**
 * The baseline's steps, costed per recording.
 *
 * `order` is the session order `walks` already settled on, so a reader
 * comparing a step's durations against the ledger sees the same recordings in
 * the same sequence. Two orders for one set is the drift `shared/evidence.ts`
 * exists to stop.
 */
function stepCosts(
  flows: FlowsDTO,
  baseEdges: readonly string[],
  order: readonly string[],
): StepCost[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const bySession = baseEdges.map((edgeId) => sourcesOf(flows, edgeId));
  const byRank = <T extends { sessionId: string }>(list: T[]): T[] =>
    list.sort(
      (a, b) =>
        (rank.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER) ||
        a.sessionId.localeCompare(b.sessionId),
    );

  return baseEdges.map((edgeId, i) => {
    const here = bySession[i]!;
    const next = i + 1 < baseEdges.length ? bySession[i + 1] : undefined;

    const durations = byRank(
      [...here.entries()].map(([sessionId, s]) => ({
        sessionId,
        ms: Math.max(0, Math.round((s.throughSec - s.atSec) * MS_PER_SEC)),
      })),
    );

    const gapsAfter =
      next === undefined
        ? []
        : byRank(
            [...here.entries()].flatMap(([sessionId, s]) => {
              const after = next.get(sessionId);
              if (after === undefined) return [];
              // Clamped at zero rather than dropped: overlapping spans mean the
              // recording did the next thing before this one finished, which is
              // a real shape and not a negative pause.
              return [
                {
                  sessionId,
                  ms: Math.max(0, Math.round((after.atSec - s.throughSec) * MS_PER_SEC)),
                },
              ];
            }),
          );

    return { stepIndex: i, edgeId, durations, gapsAfter };
  });
}

/**
 * When the walks happened, as raw facts.
 *
 * NO automaticity score and no regularity coefficient. The habit literature's
 * numbers — a median around 66 days to automaticity, over a range of 18 to 254 —
 * are population statistics and say nothing about one person's one route.
 * Turning them into a per-habit figure would be the invented confidence this
 * module refuses everywhere else.
 *
 * LOCAL time on purpose: the question a rhythm answers is when in a person's
 * day and week this happened. Nothing in the store records the zone the
 * recording was made in, so a route walked at 09:00 in two zones reports two
 * phases — named in the spec's open requirements, not solved here.
 */
function rhythmOf(walks: readonly WalkFit[]): RhythmFacts {
  const dated = walks
    .map((w) => w.at)
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b);

  const intervalsMs: number[] = [];
  for (let i = 1; i < dated.length; i += 1) intervalsMs.push(dated[i]! - dated[i - 1]!);

  return {
    intervalsMs,
    hours: dated.map((at) => new Date(at).getHours()),
    days: dated.map((at) => new Date(at).getDay()),
  };
}

/**
 * What preceded the work, with the agreement it was observed at.
 *
 * `of` is EVERY walk asked, including the ones the hook could not answer for.
 * Two of three walks showing Slack is a different claim from two of two, and
 * shrinking the denominator to the walks that answered would report unanimity
 * nobody observed — the `nameObservations` versus `count` rule, one level down.
 *
 * The hook is asked at the moment THIS recording walked the route, which is
 * `RouteWalkDTO.atSec` — lane seconds, the axis the rail is drawn in. Never
 * `tMono / 1000`: that was the measured Flows bug that landed every jump ~1.9s
 * early.
 */
function antecedentsOf(
  route: FlowRouteDTO,
  order: readonly string[],
  hooks: WalkAnalysisHooks | undefined,
): AntecedentFact[] {
  const ask = hooks?.antecedentAt;
  if (ask === undefined) return [];

  const atSecOf = new Map(route.walks.map((w) => [w.sessionId, w.atSec]));
  const counts = new Map<string, AntecedentFact>();
  let of = 0;

  for (const sessionId of order) {
    of += 1;
    const found = ask(sessionId, atSecOf.get(sessionId) ?? 0);
    if (found === null) continue;
    // A space is an unambiguous delimiter here: `kind` is a closed set of
    // three tokens and none contains one, so no two distinct pairs collide.
    const key = `${found.kind} ${found.what}`;
    const seen = counts.get(key);
    if (seen === undefined) {
      counts.set(key, { what: found.what, kind: found.kind, observations: 1, of: 0 });
    } else {
      seen.observations += 1;
    }
  }

  const out = [...counts.values()].map((f) => ({ ...f, of }));
  out.sort(
    (a, b) =>
      b.observations - a.observations || a.what.localeCompare(b.what) || a.kind.localeCompare(b.kind),
  );
  return out;
}

/**
 * The separator `frequentRoutes` joins a route's places with. Named once.
 *
 * `FlowRouteDTO` exposes no `places` array, but its `id` IS
 * `places.join(" → ")` and the labels are de-duplicated before the join — so
 * splitting the key recovers the sequence exactly. Safe by definition rather
 * than by convenience: if the key ever stops being the joined label sequence,
 * `route-cluster.ts`, `bindHabit` and every stored `routeKey` break with it.
 */
const PLACE_SEP = " → ";

/**
 * Routes whose places are a STRICT prefix of this one's — work begun and
 * dropped early.
 *
 * A DISCLOSURE, in the shape of `duplicates`, and never a merge. Every
 * recording gets exactly one route key, and that partition is what makes
 * `bindHabit`'s strict-majority rule a proof rather than a threshold: a session
 * cannot lie in two routes, so more than half of a set can lie in at most one
 * part. Folding a prefix into its parent would inflate `route.count` — the one
 * number the whole recurrence argument rests on — with recordings that did not
 * do the work.
 *
 * Longest first: the nearest miss is the one worth reading.
 */
function prefixRoutes(flows: FlowsDTO, route: FlowRouteDTO): PrefixFact[] {
  const places = route.id.split(PLACE_SEP);
  const out: PrefixFact[] = [];
  for (const other of flows.routes) {
    if (other.id === route.id) continue;
    const theirs = other.id.split(PLACE_SEP);
    if (theirs.length >= places.length) continue;
    if (!theirs.every((p, i) => p === places[i])) continue;
    out.push({
      routeKey: other.id,
      places: theirs,
      count: other.count,
      sessionIds: [...other.sessionIds],
    });
  }
  out.sort((a, b) => b.places.length - a.places.length || a.routeKey.localeCompare(b.routeKey));
  return out;
}

export function walkAnalysis(
  input: WalkAnalysisInput,
  hooks?: WalkAnalysisHooks,
): WalkAnalysis {
  const { flows, route } = input;
  const rule = input.rule ?? DEFAULT_RULE;
  const ways = flowWalks(flows, route);
  const startedAt = sessionStartedAt(flows);
  // The single impure edge. `chooseBaseline` reads no clock, so a fixture can
  // pin the whole rule; a caller that wants "as of now" gets it here and
  // nowhere else.
  const baseline = chooseBaseline(ways, rule, startedAt, {
    now: input.now ?? Date.now(),
    ...(input.halfLifeMs !== undefined ? { halfLifeMs: input.halfLifeMs } : {}),
  });

  const baseWay = baseline.wayIndex === null ? null : (ways[baseline.wayIndex] ?? null);
  const baseEdges = baseWay === null ? null : baseWay.steps.map((s) => s.edgeId);

  const walks: WalkFit[] = walkedEdges(route).map(({ sessionId, edgeIds }) => {
    const at = startedAt.get(sessionId) ?? null;
    if (baseEdges === null) {
      // `none` names no end, so `reachedEnd` is vacuous rather than false —
      // false would assert the walk fell short of a standard that does not
      // exist.
      return { sessionId, at, reachedEnd: true, deviations: [] };
    }
    const aligned = alignWalk(baseEdges, edgeIds);
    return {
      sessionId,
      at,
      reachedEnd: aligned.reachedEnd,
      deviations: aligned.deviations.map((d) => ({ ...d, label: edgeLabel(flows, d.edgeId) })),
    };
  });

  // Oldest first, and an UNDATED walk sorts last rather than first: a missing
  // date is not a very old one, and letting null sort to the front would put
  // deleted evidence at the head of a ledger that reads left-to-right in time.
  walks.sort((a, b) => {
    if (a.at === null && b.at === null) return a.sessionId.localeCompare(b.sessionId);
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at - b.at || a.sessionId.localeCompare(b.sessionId);
  });

  const order = walks.map((w) => w.sessionId);
  const steps = baseEdges === null ? [] : stepCosts(flows, baseEdges, order);

  return {
    baseline,
    walks,
    steps,
    antecedents: antecedentsOf(route, order, hooks),
    rhythm: rhythmOf(walks),
    droppedEarly: prefixRoutes(flows, route),
  };
}
