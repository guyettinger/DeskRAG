/**
 * The Flows projection, read from the store, with THE RESOLVERS IN ONE PLACE.
 *
 * Four probes — baseline, fork, routes, transfer — each opened the graph and
 * called `frequentRoutes` / `toGraphDTO` themselves, in FOUR DIFFERENT SHAPES.
 * Two passed both resolvers, two passed neither, and nothing anywhere made that
 * decision visible. This is the failure mode CLAUDE.md names: a probe measuring
 * nothing looks exactly like one that found nothing.
 *
 * ## Why neither resolver is optional
 *
 * WITHOUT `sessionStart`, `toEdgeSources` flatMaps away every source whose
 * session it cannot date, so every edge arrives with `sources: []` and every
 * `firstAt` is null. `probe:baseline` read that way until 2026-08-23, and it
 * was not only the "Other readings" section: on the real store, adding the
 * resolver moved the deviation table itself from 14/20 to 12/22, because a walk
 * with no date cannot be ordered and the baseline lands somewhere else. Every
 * count printed before that date was against an empty graph.
 *
 * WITHOUT `laneOrigin`, a probe reads the raw t_mono span where the app reads
 * the LANE span. Measured the same day: `probe:fork` read Way C at 28.1s where
 * the SCREEN read 26.6s. `laneSec` clamps at zero, so a walk beginning before
 * its video's first frame has its `atSec` pulled to 0 while its `throughSec` is
 * not. Two readers of one store disagreeing by 1.5s is the `ax-dump`/`ax-exec`
 * drift hazard, in the instrument rather than in the code.
 *
 * The origin is what `laneOriginOf` returns: the earliest `screen` blob's
 * start, or 0 for a recording with no video.
 *
 * ## What is deliberately NOT decided here
 *
 * `rule` and `covering` are parameters with the APP'S OWN defaults, not values
 * this module picks. `probe:routes` exists to compare clustering rules by
 * calling the shipped function with each of them; baking one in would make it
 * measure a second implementation.
 */

import type Database from "better-sqlite3";
import {
  frequentRoutes,
  toGraphDTO,
  type CoveringSummary,
  type RouteSpan,
} from "../../app/src/main/graph-view.js";
import { DEFAULT_CLUSTER_RULE, type ClusterRule } from "../../app/src/main/route-cluster.js";
import type { FlowRouteDTO, FlowsDTO } from "@shared/types";
import type { Graph } from "../../src/trace/types.js";
import { readGraph } from "./read-store.js";

export interface OpenFlowsOptions {
  /** Which clustering rule counts two routes as one. Defaults to what ships. */
  rule?: ClusterRule;
  /**
   * The composed levels covering a stretch of one recording — what NAMES a
   * route. Defaults to none, which is what the app's own pure projection does
   * without a store behind it.
   */
  covering?: (span: RouteSpan) => CoveringSummary[];
}

export interface OpenedFlows {
  graph: Graph;
  routes: FlowRouteDTO[];
  flows: FlowsDTO;
  /** Every recording in the store, not only those that reached the graph. */
  sessionCount: number;
  /** Recording id -> lane offset zero. Exposed because probes report on it. */
  laneOrigin: (sessionId: string) => number;
}

/**
 * Read the trace graph and project it exactly as `DeskRagService.flows()` does.
 *
 * Returns null when there is no graph — the caller decides whether that is an
 * empty state or a failure, because it is one or the other depending on what
 * the probe claims to measure.
 */
export function openFlows(db: Database.Database, opts: OpenFlowsOptions = {}): OpenedFlows | null {
  const graphIds = (db.prepare("SELECT id FROM trace_graph").all() as { id: string }[]).map(
    (r) => r.id,
  );
  const graph = readGraph(db, graphIds[0] ?? "default");
  if (graph === undefined) return null;

  const startedAt = new Map(
    (
      db.prepare("SELECT id, started_at FROM session").all() as {
        id: string;
        started_at: number;
      }[]
    ).map((r) => [r.id, r.started_at]),
  );
  const originById = new Map(
    (
      db
        .prepare(
          `SELECT s.id AS id,
                  (SELECT b.t_mono_start FROM blob b
                    WHERE b.session_id = s.id AND b.media = 'screen'
                    ORDER BY b.t_mono_start ASC LIMIT 1) AS t
             FROM session s`,
        )
        .all() as { id: string; t: number | null }[]
    ).map((r) => [r.id, r.t ?? 0]),
  );
  const laneOrigin = (sessionId: string): number => originById.get(sessionId) ?? 0;

  const { rule = DEFAULT_CLUSTER_RULE, covering = (): CoveringSummary[] => [] } = opts;
  const routes = frequentRoutes(graph, covering, rule, laneOrigin);
  const flows: FlowsDTO = {
    graph: toGraphDTO(graph, {
      sessionStart: (id) => startedAt.get(id),
      laneOrigin,
    }),
    routes,
    excludedApps: [],
  };

  return {
    graph,
    routes,
    flows,
    sessionCount: (db.prepare("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n,
    laneOrigin,
  };
}
