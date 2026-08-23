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
 * All three ship, and `npm run probe:baseline` picks the default — exactly as
 * `route-cluster.ts` ships four cluster rules so `probe:routes` can measure the
 * choice on a real library instead of asserting it. Each is wrong in a way the
 * others are not: `majority` calls a recently adopted better path the
 * deviation, `recent` lets one fumbled session become the standard, and `none`
 * cannot say when the variation happened.
 */
export type BaselineRule = "majority" | "recent" | "none";

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

export function chooseBaseline(
  ways: readonly FlowWalk[],
  rule: BaselineRule,
  startedAt: ReadonlyMap<string, number>,
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

  const total = ways.reduce((n, w) => n + w.sessionIds.length, 0);
  const top = Math.max(...ways.map((w) => w.sessionIds.length));
  const tied = ways
    .map((w, i) => ({ way: w, i }))
    .filter(({ way }) => way.sessionIds.length === top);

  if (tied.length === 1) {
    const only = tied[0]!;
    return {
      rule,
      wayIndex: only.i,
      reason: `The Way ${top} of the ${total} recordings took.`,
    };
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
    rule,
    wayIndex: winner.i,
    reason:
      `${tied.length} Ways tie at ${top} recording${top === 1 ? "" : "s"} each; ` +
      `the standard is the one holding the newest walk.`,
  };
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

export function walkAnalysis(
  input: WalkAnalysisInput,
  _hooks?: WalkAnalysisHooks,
): WalkAnalysis {
  const { flows, route } = input;
  const rule = input.rule ?? DEFAULT_RULE;
  const ways = flowWalks(flows, route);
  const startedAt = sessionStartedAt(flows);
  const baseline = chooseBaseline(ways, rule, startedAt);

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

  return {
    baseline,
    walks,
    steps: [],
    antecedents: [],
    rhythm: { intervalsMs: [], hours: [], days: [] },
    droppedEarly: [],
  };
}
