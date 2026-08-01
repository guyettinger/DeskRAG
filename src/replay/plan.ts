/**
 * Planning — turn a graph and two endpoints into a reviewable, inert `Plan`.
 *
 * Producing a plan has no side effects beyond reading the AX tree. Every anchor
 * is resolved up front so the plan can show WHERE each action would land and how
 * much that location agrees with the recording: given that a large share of real
 * targets resolve to coordinates alone, that preview is the difference between a
 * reviewable system and a coin flip.
 *
 * Blockers are `assertable` predicates only. An `achievable` predicate that does
 * not hold is a repair path, not a refusal — which is why setup is not a
 * separate phase and recovery is not a separate subsystem.
 */

import { ulid } from "ulid";
import type { Graph, TraceEdge } from "../trace/types.js";
import { resolveAnchor } from "./resolve.js";
import { strokesFor } from "./typing.js";
import {
  BRITTLENESS_FLOOR,
  type Blocker,
  type EdgeBrittleness,
  type Keymap,
  type Locate,
  type Plan,
  type PlannedAction,
  type PlanStep,
  type Predicate,
  type RepairStep,
  type Vec2,
} from "./types.js";
import { blockersOf, verifyNode } from "./verify.js";

/**
 * Lower is better. A well-observed edge that usually succeeds is cheap; an edge
 * seen once, or one that keeps failing, is expensive. An edge with no attempts
 * yet is treated as even odds rather than as a failure.
 */
export function edgeCost(e: TraceEdge): number {
  const rate = e.outcomes.attempts > 0 ? e.outcomes.successes / e.outcomes.attempts : 0.5;
  return 1 / (1 + e.observations * rate);
}

/** Cheapest path by `edgeCost` (Dijkstra). `[]` when already at the goal. */
export function findPath(graph: Graph, from: string, to: string): TraceEdge[] | null {
  if (from === to) return [];
  const out = new Map<string, TraceEdge[]>();
  for (const e of graph.edges) {
    const list = out.get(e.from) ?? [];
    list.push(e);
    out.set(e.from, list);
  }

  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; edge: TraceEdge }>();
  const seen = new Set<string>();

  for (;;) {
    let current: string | undefined;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (!seen.has(node) && d < best) {
        best = d;
        current = node;
      }
    }
    if (current === undefined) return null;
    if (current === to) break;
    seen.add(current);

    for (const e of out.get(current) ?? []) {
      if (e.to === current) continue; // a self-loop never shortens a path
      const next = best + edgeCost(e);
      if (next < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, next);
        prev.set(e.to, { node: current, edge: e });
      }
    }
  }

  const path: TraceEdge[] = [];
  for (let at = to; at !== from; ) {
    const step = prev.get(at);
    if (step === undefined) return null;
    path.push(step.edge);
    at = step.node;
  }
  return path.reverse();
}

export interface BuildPlanInput {
  graph: Graph;
  fromNodeId: string;
  toNodeId: string;
  /** Predicates observed live, for blocker detection along the path. */
  observed: readonly Predicate[];
  locate: Locate;
  /** Absent makes every `type` action a blocker — never a static-layout guess. */
  keymap?: Keymap;
  slotBindings?: Record<string, string>;
  planId?: string;
  /**
   * Live window origin, so anchor geometry is judged in window space. Without
   * it a window that moved since recording vetoes every AX rung and every
   * target falls back to a stale coordinate.
   */
  windowOrigin?: Vec2;
  /**
   * Applications currently running, by `localizedName` — from the INERT
   * `Actuator.runningApps()`. Absent means app repair is not attempted at all,
   * which keeps `buildPlan` usable without an actuator.
   */
  runningApps?: readonly string[];
  /**
   * Allow a repair step to LAUNCH an app that is not running. Default false: a
   * launch can restore windows, reopen documents and run startup work, which is
   * categorically larger than raising an app that is already there.
   */
  allowLaunch?: boolean;
}

export async function buildPlan(input: BuildPlanInput): Promise<Plan> {
  const path = findPath(input.graph, input.fromNodeId, input.toNodeId);
  if (path === null) {
    throw new Error(`no path from ${input.fromNodeId} to ${input.toNodeId}`);
  }

  const resolveOpts = input.windowOrigin !== undefined ? { windowOrigin: input.windowOrigin } : {};
  const nodesById = new Map(input.graph.nodes.map((n) => [n.id, n]));
  const steps: PlanStep[] = [];
  const blockers: Blocker[] = [];
  const brittleness: EdgeBrittleness[] = [];
  // The app we believe is frontmost as the plan progresses — starts from what
  // is observed and advances as repairs are inserted, so a multi-hop path
  // through one application repairs it once.
  let frontmost = input.observed.find((p) => p.kind === "app")?.args.app;

  for (const edge of path) {
    let targets = 0;
    let axTargets = 0;

    // Assertable predicates on the node this edge arrives at gate the plan.
    const to = nodesById.get(edge.to);
    if (to !== undefined) {
      for (const v of blockersOf(verifyNode(to.predicates, input.observed).violations)) {
        blockers.push({ predicate: v.predicate, reason: "assertable predicate does not hold" });
      }
    }

    // Repair an unmet `app` predicate by raising that application. `app` is
    // tagged achievable, which promises exactly this; replaying the recorded
    // Dock click instead is a coordinate on a surface whose contents move, and
    // it fails silently because a click always "succeeds".
    if (to !== undefined && input.runningApps !== undefined) {
      const wanted = to.predicates.find((p) => p.kind === "app")?.args.app;
      if (typeof wanted === "string" && wanted.length > 0 && wanted !== frontmost) {
        const running = input.runningApps.includes(wanted);
        const mayLaunch = input.allowLaunch === true;
        if (!running && !mayLaunch) {
          blockers.push({ reason: `${wanted} is not running` });
        } else {
          const repair: RepairStep = {
            repair: "activate",
            app: wanted,
            launch: !running && mayLaunch,
            reason: `app(app="${wanted}") does not hold`,
          };
          steps.push(repair);
        }
        // Whatever we decided, the rest of the path is "in" this app now.
        frontmost = wanted;
      }
    }

    for (const action of edge.actions) {
      const step: PlannedAction = { edgeId: edge.id, action };

      if (action.kind === "click" || action.kind === "hover" || action.kind === "scroll") {
        const r = await resolveAnchor(action.anchor, input.locate, resolveOpts);
        step.resolution = r;
        targets++;
        if (r.layer !== "point") axTargets++;
      } else if (action.kind === "drag") {
        // The `from` endpoint is what the plan previews; `to` is resolved at
        // execution time against the same ladder.
        const r = await resolveAnchor(action.from, input.locate, resolveOpts);
        step.resolution = r;
        targets++;
        if (r.layer !== "point") axTargets++;
      } else if (action.kind === "type") {
        const bound = input.slotBindings?.[action.slot];
        const value = bound ?? action.recorded;
        if (bound !== undefined) step.slotBinding = { name: action.slot, value: bound };
        if (input.keymap === undefined) {
          blockers.push({ reason: `no keymap supplied: cannot type "${value}"` });
        } else if (strokesFor(value, input.keymap) === null) {
          blockers.push({
            reason: `"${value}" cannot be typed with layout ${input.keymap.layoutId}`,
          });
        }
      }

      steps.push(step);
    }

    const axRate = targets > 0 ? axTargets / targets : 1;
    brittleness.push({ edgeId: edge.id, axRate, belowFloor: axRate < BRITTLENESS_FLOOR });
  }

  return {
    id: input.planId ?? ulid(),
    graphId: input.graph.id,
    from: input.fromNodeId,
    to: input.toNodeId,
    steps,
    blockers,
    brittleness,
  };
}
