/**
 * How many steps a route is — which is NOT `edgeIds.length`.
 *
 * `FlowRouteDTO.edgeIds` is the UNION of what every recording walked, kept so
 * the canvas highlight can light up everywhere they went. As a step count it is
 * wrong whenever the recordings disagreed: measured on the real store, two
 * recordings walked 8 edges each, shared 2, and the union said 14 — a path
 * neither of them took.
 *
 * It lives in `shared/` because BOTH sides need it and they must agree. The
 * route list is a renderer module and the Habits proposal row is built in main;
 * when this was two copies, the list was fixed and the proposal row was not, so
 * one screen said "8 steps" while the other said "14" about the same route.
 * Two readers of one tree, again.
 */

import type { FlowRouteDTO } from "./types.js";

/** The distinct walk lengths, longest first. One entry means one way. */
export function routeWayLengths(route: FlowRouteDTO): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (const walk of route.walks) {
    const key = walk.edgeIds.join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(walk.edgeIds.length);
  }
  // No walks at all is a hand-built or pre-`walks` route; the union is then the
  // only thing there is to count, which is what the list showed before.
  if (out.length === 0) return [route.edgeIds.length];
  return out.sort((a, b) => b - a);
}

/**
 * "12 steps", or "2 ways · 8/8 steps" when the recordings took different paths.
 *
 * NOTHING TRUNCATES and nothing is smoothed over: a route whose recordings
 * disagree says so, because that is the fact that decides whether it is one
 * procedure at all.
 */
export function routeStepSummary(route: FlowRouteDTO): string {
  const ways = routeWayLengths(route);
  const only = ways[0] ?? 0;
  if (ways.length === 1) return `${only} step${only === 1 ? "" : "s"}`;
  return `${ways.length} ways · ${ways.join("/")} steps`;
}
