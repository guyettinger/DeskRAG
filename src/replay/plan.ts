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
import type { Action, Anchor, Graph, TraceEdge } from "../trace/types.js";
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
  type RemainderAction,
  type RemainderEdge,
  type RepairStep,
  type SegmentCut,
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

/** Actions with a spatial target; the only kinds an anchor belongs to. */
const isSpatial = (
  a: Action,
): a is Extract<Action, { kind: "click" | "hover" | "scroll" | "drag" }> =>
  a.kind === "click" || a.kind === "hover" || a.kind === "scroll" || a.kind === "drag";

/** The anchor an action aims at — `from` for a drag, `anchor` for the rest. */
const anchorOf = (a: Action): Anchor | undefined =>
  a.kind === "drag" ? a.from : isSpatial(a) ? a.anchor : undefined;

/**
 * Indices of the actions a repair for `app` REPLACES.
 *
 * The final action when it is spatial and carries no `ax` layer — both
 * conditions required. `computeBoundaries` cuts a boundary at the focus change,
 * so the action causing the switch is by construction the last one before it
 * (4 of 4 cross-app edges measured), and the switch target sits outside the
 * focused window's AX tree by definition, which is exactly why the recorded Dock
 * click is point-only. An action aimed at an element in the app's own tree
 * cannot have been the switch, so it is posted as recorded.
 *
 * Plus every `wait { until: app(X) }`, wherever it sits: `runRepair` already
 * polls that predicate before returning, so dropping one is a no-op rather than
 * a skipped check. Measurement put them mid-edge, not beside the switch — an
 * earlier rule anchored on the wait fired on only half the real cross-app edges.
 */
function supersededBy(actions: readonly Action[], app: string): Set<number> {
  const out = new Set<number>();
  const lastIndex = actions.length - 1;
  const last = actions[lastIndex];
  if (last !== undefined && isSpatial(last) && anchorOf(last)?.ax === undefined) {
    out.add(lastIndex);
  }
  actions.forEach((a, i) => {
    if (a.kind === "wait" && a.until.kind === "app" && a.until.args.app === app) out.add(i);
  });
  return out;
}

/**
 * The descriptors the RECORDING carries. A fact about the anchor, never a
 * forecast of what it will resolve to — the remainder does not claim to know
 * where an unresolved action would land.
 */
function descriptorsOf(anchor: Anchor | undefined): RemainderAction["descriptors"] {
  if (anchor === undefined) return undefined;
  const d: NonNullable<RemainderAction["descriptors"]> = [];
  if (anchor.ax?.identifier !== undefined && anchor.ax.identifier.length > 0) d.push("identifier");
  if (anchor.ax?.label !== undefined && anchor.ax.label.length > 0) d.push("label");
  if (anchor.ax?.path !== undefined && anchor.ax.path.length > 0) d.push("path");
  if (anchor.visual !== undefined) d.push("visual");
  return d.length > 0 ? d : undefined;
}

/**
 * The deductive CEILING on an edge's AX rate. An anchor with no `ax` layer can
 * never resolve to an AX rung — at any time, by any mechanism — so this is
 * arithmetic over what the recording contains, not a prediction. It is what
 * stops a reviewer arming segment 1, changing the world, and only then finding
 * that a later edge could never arm at all.
 */
function axCeiling(actions: readonly Action[]): number {
  const spatial = actions.filter(isSpatial);
  if (spatial.length === 0) return 1; // matches the measured branch: no targets, no doubt
  return spatial.filter((a) => anchorOf(a)?.ax !== undefined).length / spatial.length;
}

function remainderActionOf(action: Action): RemainderAction {
  const anchor = anchorOf(action);
  const descriptors = descriptorsOf(anchor);
  return {
    kind: action.kind,
    ...(descriptors !== undefined ? { descriptors } : {}),
    ...(anchor !== undefined ? { recordedPoint: { x: anchor.point.x, y: anchor.point.y } } : {}),
    ...(action.kind === "type" ? { slot: action.slot } : {}),
  };
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
  const remainder: RemainderEdge[] = [];
  /** Set once resolution stops working; every later edge is disclosed, not planned. */
  let cut: SegmentCut | undefined;
  // The app we believe is frontmost as the plan progresses — starts from what
  // is observed and advances as repairs are inserted, so a multi-hop path
  // through one application repairs it once.
  let frontmost = input.observed.find((p) => p.kind === "app")?.args.app;

  for (const edge of path) {
    let targets = 0;
    let axTargets = 0;

    // Assertable predicates gate the WHOLE run, segment or remainder alike: no
    // UI action can produce them, so the present observation is decisive even
    // for a node several edges away. Collected first and scoped below, once it
    // is known whether this edge survived the cut.
    const edgeBlockers: Blocker[] = [];
    const to = nodesById.get(edge.to);
    if (to !== undefined) {
      for (const v of blockersOf(verifyNode(to.predicates, input.observed).violations)) {
        edgeBlockers.push({
          predicate: v.predicate,
          reason: "assertable predicate does not hold",
          scope: "segment",
        });
      }
    }

    // Repair an unmet `app` predicate by raising that application. `app` is
    // tagged achievable, which promises exactly this; replaying the recorded
    // Dock click instead is a coordinate on a surface whose contents move, and
    // it fails silently because a click always "succeeds".
    // Built, NOT pushed: it belongs at the edge's END. The `app` predicate is on
    // the DESTINATION node, so it must hold when the edge finishes; the edge's
    // own actions run in the SOURCE app, and activating first posts them into
    // the wrong application.
    let repair: RepairStep | undefined;
    if (to !== undefined && input.runningApps !== undefined) {
      const wanted = to.predicates.find((p) => p.kind === "app")?.args.app;
      if (typeof wanted === "string" && wanted.length > 0 && wanted !== frontmost) {
        const running = input.runningApps.includes(wanted);
        const mayLaunch = input.allowLaunch === true;
        if (!running && !mayLaunch) {
          edgeBlockers.push({ reason: `${wanted} is not running`, scope: "segment" });
        } else {
          repair = {
            repair: "activate",
            edgeId: edge.id,
            app: wanted,
            launch: !running && mayLaunch,
            reason: `app(app="${wanted}") does not hold`,
          };
        }
        // Whatever we decided, the rest of the path is "in" this app now.
        frontmost = wanted;
      }
    }

    const superseded =
      repair === undefined ? new Set<number>() : supersededBy(edge.actions, repair.app);
    /** What would actually be posted, once the repair's replacements are removed. */
    const kept = edge.actions.filter((_, i) => !superseded.has(i));

    /** Disclose an edge instead of planning it, and bound its brittleness. */
    const disclose = (): void => {
      remainder.push({
        edgeId: edge.id,
        toNodeId: edge.to,
        actions: kept.map(remainderActionOf),
        repairs: repair === undefined ? [] : [repair],
      });
      const ceiling = axCeiling(kept);
      brittleness.push({
        edgeId: edge.id,
        axRate: ceiling,
        belowFloor: ceiling < BRITTLENESS_FLOOR,
        bound: "upper",
      });
    };

    if (cut !== undefined) {
      disclose();
      for (const b of edgeBlockers) blockers.push({ ...b, scope: "remainder" });
      continue;
    }

    // Planned into a BUFFER: if any anchor cuts, the whole edge is discarded and
    // disclosed instead. The cut is at an edge boundary because a node boundary
    // is the only place the world can be re-observed.
    const buffer: PlanStep[] = [];
    let edgeCut: SegmentCut | undefined;

    for (const [i, action] of edge.actions.entries()) {
      if (superseded.has(i)) {
        // Visible, never silent: the review has to be able to say what will NOT
        // be posted and why. Skipping here also keeps it out of the AX rate,
        // which is what makes a cross-app edge armable at all.
        buffer.push({
          superseded: "activate",
          edgeId: edge.id,
          action,
          reason: `activating ${repair!.app} replaces this`,
        });
        continue;
      }

      const step: PlannedAction = { edgeId: edge.id, action };

      const anchor = anchorOf(action);
      if (anchor !== undefined) {
        // For a drag this is the `from` endpoint; `to` resolves at execution
        // time against the same ladder.
        const r = await resolveAnchor(anchor, input.locate, resolveOpts);
        // THE CUT: the anchor carries AX descriptors and still reached no AX
        // rung. That is the executor measuring that it is describing a state
        // which does not exist yet — as opposed to a point-only anchor, which is
        // already at its permanent best and cannot be improved by waiting.
        if (r.layer === "point" && anchor.ax !== undefined) {
          edgeCut = { resumeAt: edge.from, edgeId: edge.id, attempts: r.attempts };
          break;
        }
        step.resolution = r;
        targets++;
        if (r.layer !== "point") axTargets++;
      } else if (action.kind === "type") {
        const bound = input.slotBindings?.[action.slot];
        const value = bound ?? action.recorded;
        if (bound !== undefined) step.slotBinding = { name: action.slot, value: bound };
        if (input.keymap === undefined) {
          edgeBlockers.push({
            reason: `no keymap supplied: cannot type "${value}"`,
            scope: "segment",
          });
        } else if (strokesFor(value, input.keymap) === null) {
          edgeBlockers.push({
            reason: `"${value}" cannot be typed with layout ${input.keymap.layoutId}`,
            scope: "segment",
          });
        }
      }

      buffer.push(step);
    }

    if (edgeCut !== undefined) {
      cut = edgeCut;
      disclose();
      for (const b of edgeBlockers) blockers.push({ ...b, scope: "remainder" });
      continue;
    }

    steps.push(...buffer, ...(repair === undefined ? [] : [repair]));
    for (const b of edgeBlockers) blockers.push(b);

    const axRate = targets > 0 ? axTargets / targets : 1;
    brittleness.push({
      edgeId: edge.id,
      axRate,
      belowFloor: axRate < BRITTLENESS_FLOOR,
      bound: "measured",
    });
  }

  return {
    id: input.planId ?? ulid(),
    graphId: input.graph.id,
    from: input.fromNodeId,
    to: input.toNodeId,
    steps,
    blockers,
    brittleness,
    ...(cut !== undefined ? { cut } : {}),
    remainder,
  };
}
