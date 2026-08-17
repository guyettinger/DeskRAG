/**
 * One walk of a recorded route, as data rather than as text.
 *
 * `renderFlow` walked a route and formatted it in the same pass. A SKILL.md
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
 */

import type { EdgeActionDTO, FlowRouteDTO, FlowsDTO } from "@shared/types";

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
   * The first recording that walked it. Null when the edge carries no sources.
   *
   * `sources` can be SHORTER than `observations` — a graph lifted before
   * provenance has none at all, and deleting a recording removes its sources
   * while leaving the count it contributed. Never derive one from the other.
   */
  firstAt: { startedAt: number; atSec: number } | null;
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
 * The route's edges in order, resolved against the graph.
 *
 * `route.count` is passed through to decide `everyRecording`; a route with no
 * count (zero) leaves every step marked as walked by all of them, which is the
 * only reading that does not invent a shortfall.
 */
export function flowSteps(flows: FlowsDTO, route: FlowRouteDTO): FlowStep[] {
  const nodeById = new Map(flows.graph.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(flows.graph.edges.map((e) => [e.id, e]));
  const labelOf = (id: string): string => nodeById.get(id)?.label ?? `${id} (unknown state)`;

  return route.edgeIds.map((edgeId, index) => {
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
    const first = edge.sources[0];
    return {
      index,
      edgeId,
      from: labelOf(edge.from),
      to: labelOf(edge.to),
      actions: edge.actions.map(toAction),
      observations: edge.observations,
      everyRecording: route.count <= 0 || edge.observations >= route.count,
      firstAt: first === undefined ? null : { startedAt: first.startedAt, atSec: first.atSec },
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
