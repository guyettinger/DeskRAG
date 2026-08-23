/**
 * The walks of a recorded route, as data rather than as text.
 *
 * `renderFlow` walked a route and formatted it in the same pass. A HABIT.md
 * needs the same walk in markdown, and two readers of one structure is the
 * `ax-dump`/`ax-exec` drift hazard by name — two binaries reading one tree
 * disagreed on exactly one of 48 elements, and that single label was enough to
 * stop any node from verifying. So the walk happens once, here, and the
 * formatters differ only in how they print it.
 *
 * Pure: `FlowsDTO` in, plain objects out. No store, no Electron, no model.
 *
 * It reads the projection the Flows screen already has — `EdgeActionDTO.action`
 * is already "3× click" and `target` is already `Button "Send"`, because
 * `graph-view.ts` put them in a reader's words.
 *
 * **It reads `route.walks`, never `route.edgeIds`.** `edgeIds` is the UNION of
 * what every recording in the group walked and exists for the canvas highlight.
 * Numbering it asserts an order no recording walked: measured on the real store,
 * two recordings walked 8 edges each, shared 2, and rendered as a numbered
 * 14-step procedure — 75% longer than either walk, with the step numbers falling
 * out of `Map` iteration over `graph.edges`. The prose model then described the
 * artifact accurately ("a second variant repeats the entry and copy steps"),
 * which is worse than a hallucination: the model was right about a defect one
 * layer down.
 *
 * So a route yields VARIANTS, not one list. Identical walks collapse — a route
 * walked five times the same way is still one numbered procedure, byte for byte
 * what it was before — and distinct walks are shown as distinct, because two
 * recordings that key to one route can genuinely have done two different things.
 * Nothing here picks a winner between them; `bindHabit` declines on a tie for the
 * same reason.
 */

import type { EdgeActionDTO, EdgeSourceDTO, FlowRouteDTO, FlowsDTO } from "@shared/types";

const MS_PER_SEC = 1000;

/** One action on a step, with the slot that varied there if any. */
export interface FlowStepAction {
  /** "3× click", "type", "press cmd+a", "wait until app(TextEdit)". */
  action: string;
  /** The RECORDED descriptor: `Button "Send"`, `#save-btn`, or a point. */
  target: string;
  /**
   * TWO OR MORE samples is a discovered variable — the thing recording a task
   * twice produces. One sample is a value that happened to be typed, and calling
   * it a variable would overstate the evidence. Both formatters make that
   * distinction; neither decides it.
   */
  slot?: { name: string; samples: string[] };
}

export interface FlowStep {
  /** Zero-based. Both formatters print `index + 1`. */
  index: number;
  /** The edge this step is, or the id that was missing. */
  edgeId: string;
  from: string;
  to: string;
  actions: FlowStepAction[];
  observations: number;
  /**
   * False when fewer recordings walked this edge than walked the route — a step
   * not every recording took.
   *
   * This is the honest replacement for a success rate. `TraceEdge.outcomes` is
   * `{attempts: 0, successes: 0}` on every graph on disk (`lift.ts` writes the
   * zeroes, nothing increments them, and passive recording cannot observe a
   * failure because the user did the thing), so "this step sometimes failed" has
   * no data behind it. "Four of the five recordings did this" has.
   */
  everyRecording: boolean;
  /**
   * The earliest recording that walked it, and where inside it. Null when the
   * edge carries no sources.
   *
   * `sources` can be SHORTER than `observations` — a graph lifted before
   * provenance has none at all, and deleting a recording removes its sources
   * while leaving the count it contributed. Never derive one from the other.
   *
   * SORTED, not `sources[0]`. Sources accumulate in the order sessions were
   * merged into the graph, which is not time order once anything is re-indexed;
   * the field's name promised otherwise and the Habits step instrument turns
   * that promise into a link. `atSec` is LANE seconds already — `toEdgeSources`
   * converts through `laneSec`, so nothing downstream may divide `tMono` again.
   */
  firstAt: { sessionId: string; startedAt: number; atSec: number } | null;
  /** True when evidence has been deleted since: see `firstAt`. */
  sourcesBelowObservations: boolean;
  /** What lifting could not do here, e.g. a dropped wait. */
  liftWarnings: string[];
  /**
   * The edge id is not in the graph — an index defect. Carried rather than
   * dropped: a step that vanished would make the flow read as shorter than it
   * actually was, so both formatters print it.
   */
  missing: boolean;
}

const toAction = (a: EdgeActionDTO): FlowStepAction => ({
  action: a.action,
  target: a.target,
  ...(a.slot !== undefined ? { slot: { name: a.slot.name, samples: [...a.slot.samples] } } : {}),
});

/**
 * One recording's distinct path through a route, with the recordings that took it.
 *
 * `index` exists so a formatter can label variants without knowing how they were
 * ordered. A route walked one way has exactly one of these, and that is the case
 * every healthy route is in.
 */
export interface FlowWalk {
  index: number;
  /** Recordings that walked this exact edge sequence. Most-walked variant first. */
  sessionIds: string[];
  steps: FlowStep[];
}

/**
 * The route's DISTINCT walks, most-walked first.
 *
 * Grouping happens here rather than in `graph-view.ts` so both formatters group
 * once and identically — the `ax-dump`/`ax-exec` drift hazard by name. Ties break
 * on first appearance, so the order is stable across reloads.
 *
 * A route with NO walks — which `frequentRoutes` cannot produce, since a route
 * exists because a session walked it, but a hand-built fixture can — falls back
 * to the union as a single walk. That is the old behaviour exactly, for the one
 * input that cannot distinguish the two: degrading, not guessing.
 */
export function flowWalks(flows: FlowsDTO, route: FlowRouteDTO): FlowWalk[] {
  const raw =
    route.walks.length > 0
      ? route.walks
      : [{ sessionId: route.sessionIds[0] ?? "", edgeIds: route.edgeIds }];

  // A NUL delimiter, for the reason `store.ts` uses one: an edge id cannot
  // contain it, so the joined key cannot collide across different sequences.
  const byPath = new Map<string, { sessionIds: string[]; edgeIds: string[] }>();
  for (const walk of raw) {
    const key = walk.edgeIds.join("\0");
    const seen = byPath.get(key);
    if (seen === undefined) byPath.set(key, { sessionIds: [walk.sessionId], edgeIds: walk.edgeIds });
    else seen.sessionIds.push(walk.sessionId);
  }

  return [...byPath.values()]
    .sort((a, b) => b.sessionIds.length - a.sessionIds.length)
    .map((g, index) => ({
      index,
      sessionIds: g.sessionIds,
      steps: stepsFor(flows, g.edgeIds, route.count),
    }));
}

/** Every step of every variant, flattened — for slot gathering, never for display. */
export function allSteps(walks: readonly FlowWalk[]): FlowStep[] {
  return walks.flatMap((w) => w.steps);
}

/**
 * A variant's label: A, B, C…
 *
 * A LETTER, never a number, because the steps inside a variant are numbered and
 * "2.3" would read as a sub-step of a single procedure — which is the exact
 * misreading the variant machinery exists to stop. Past Z it falls back to the
 * index, which no real route reaches and which is still unambiguous.
 *
 * It lives HERE rather than in `habit-doc.ts` because this file owns
 * `FlowWalk.index`, whose comment already says that index exists so a formatter
 * can label variants without knowing how they were ordered — and because
 * `way-fork.ts` needs it while `habit-doc.ts` imports `way-fork.ts`, so leaving
 * it there is an import cycle.
 */
export function variantLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `#${index + 1}`;
}

/**
 * An explicit edge list, in order, resolved against the graph.
 *
 * `recordings` is the ROUTE's count, not the variant's, and decides
 * `everyRecording`: the interesting fact about a step is whether every recording
 * of the route took it, which stays true across variants. A route with no count
 * (zero) leaves every step marked as walked by all of them, the only reading that
 * does not invent a shortfall.
 */
export function stepsFor(
  flows: FlowsDTO,
  edgeIds: readonly string[],
  recordings: number,
): FlowStep[] {
  const nodeById = new Map(flows.graph.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(flows.graph.edges.map((e) => [e.id, e]));
  const labelOf = (id: string): string => nodeById.get(id)?.label ?? `${id} (unknown state)`;

  return edgeIds.map((edgeId, index) => {
    const edge = edgeById.get(edgeId);
    if (edge === undefined) {
      return {
        index,
        edgeId,
        from: "",
        to: "",
        actions: [],
        observations: 0,
        everyRecording: true,
        firstAt: null,
        sourcesBelowObservations: false,
        liftWarnings: [],
        missing: true,
      };
    }
    // The MOMENT, not the recording's start: a session that began later can
    // reach this edge first, and a route walked twice in one afternoon is the
    // ordinary case rather than the exotic one.
    const moment = (s: EdgeSourceDTO): number => s.startedAt + s.atSec * MS_PER_SEC;
    const first = [...edge.sources].sort((a, b) => moment(a) - moment(b))[0];
    return {
      index,
      edgeId,
      from: labelOf(edge.from),
      to: labelOf(edge.to),
      actions: edge.actions.map(toAction),
      observations: edge.observations,
      everyRecording: recordings <= 0 || edge.observations >= recordings,
      firstAt:
        first === undefined
          ? null
          : { sessionId: first.sessionId, startedAt: first.startedAt, atSec: first.atSec },
      sourcesBelowObservations: edge.sources.length < edge.observations,
      liftWarnings: [...(edge.liftWarnings ?? [])],
      missing: false,
    };
  });
}

/** Every distinct application named by the route's states, in order reached. */
export function flowApps(flows: FlowsDTO, route: FlowRouteDTO): string[] {
  const nodeById = new Map(flows.graph.nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (const id of route.nodeIds) {
    const app = nodeById.get(id)?.app;
    if (app !== undefined && !out.includes(app)) out.push(app);
  }
  return out;
}

/**
 * The route's discovered variables, from the actions actually on its steps.
 *
 * NOT `graph.slots`, which is the whole graph's — a route is one path through
 * it, and listing another route's variables as this one's inputs would be the
 * same category error as synthesising a route from a traversal.
 */
export function flowVariables(steps: readonly FlowStep[]): { name: string; samples: string[] }[] {
  const bySlot = new Map<string, string[]>();
  for (const step of steps) {
    for (const a of step.actions) {
      if (a.slot === undefined) continue;
      const seen = bySlot.get(a.slot.name);
      if (seen === undefined) {
        bySlot.set(a.slot.name, [...a.slot.samples]);
        continue;
      }
      for (const s of a.slot.samples) if (!seen.includes(s)) seen.push(s);
    }
  }
  return [...bySlot].map(([name, samples]) => ({ name, samples }));
}
