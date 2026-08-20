/**
 * How a route reads in a list — the step count, which is not `edgeIds.length`.
 *
 * `FlowRouteDTO.edgeIds` is the UNION of what every recording walked, kept for
 * the canvas highlight. As a step count it is wrong whenever the recordings
 * disagreed: on the real store two recordings walked 8 edges each, shared 2,
 * and the list said "14 steps" for a path neither of them took.
 *
 * Pure, and `.ts` rather than `.tsx` so it stays reachable from the root suite
 * (the `styles.css`/renderer rule in CLAUDE.md).
 */

import type { FlowRouteDTO } from "@shared/types";

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
 * disagree says so in the list, because that is the fact that decides whether it
 * is one procedure at all.
 */
export function routeStepSummary(route: FlowRouteDTO): string {
  const ways = routeWayLengths(route);
  const only = ways[0] ?? 0;
  if (ways.length === 1) return `${only} step${only === 1 ? "" : "s"}`;
  return `${ways.length} ways · ${ways.join("/")} steps`;
}
