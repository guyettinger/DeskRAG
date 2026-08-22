/**
 * How a route reads in a list.
 *
 * The counting itself lives in `@shared/route-ways`, because the Habits proposal
 * row is built in MAIN and has to say the same thing about the same route. When
 * this module owned its own copy, the fix that removed the union step count
 * reached the route list and not the proposal row, and the two screens disagreed
 * by 75% about the same walk.
 *
 * Pure, and `.ts` rather than `.tsx` so it stays reachable from the root suite
 * (the `styles.css`/renderer rule in CLAUDE.md).
 */

export { routeStepSummary, routeWayLengths } from "@shared/route-ways";
