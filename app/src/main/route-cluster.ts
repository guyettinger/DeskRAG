/**
 * Grouping routes that are the SAME WORK walked slightly differently.
 *
 * `frequentRoutes` keys a route on `places.join(" → ")` and groups by exact
 * string equality. That is right about what a route IS and wrong about when two
 * of them are one: record the same task once more in a way that touches one
 * extra application and the key changes, so identical work lands as two routes
 * of ×1 and neither ever looks like a habit.
 *
 * ## The partition is the constraint, not a nicety
 *
 * `bindHabit`'s majority rule is a PROOF, not a threshold: `frequentRoutes`
 * gives each recording exactly one route key, so the session ids partition
 * across routes and more than half of a set can lie in at most one part — a
 * strict majority has at most one winner mathematically. Everything here
 * therefore merges WHOLE ROUTES into whole clusters. A session cannot be split
 * across two clusters because it was never in two routes, so the partition
 * survives by construction rather than by care. `test/route-cluster.test.ts`
 * asserts it anyway, because nothing else would notice if that stopped being
 * true.
 *
 * ## Complete linkage, and declining rather than chaining
 *
 * Single-linkage clustering CHAINS: A merges with B, B merges with C, and A and
 * C — which nothing ever compared — end up in one route. Every member here must
 * be compatible with every other member, so a cluster is a claim that holds
 * pairwise for all of it. And a route compatible with two clusters that are not
 * compatible with each other stays ON ITS OWN. That is `trace/identity.ts`
 * declining to merge when a match is ambiguous, applied one layer up: the cost
 * of declining is a route that reads as walked once, and the cost of guessing is
 * a habit that claims recordings it does not describe.
 *
 * Pure, DTO-free and dependency-free — it speaks in place sequences and keys, so
 * both `graph-view.ts` and `scripts/probes/routes.ts` can read the ONE
 * implementation. Two readers of one tree is the `ax-dump`/`ax-exec` drift
 * hazard by name.
 */

/** One route as this module sees it: its key, its places, how many walked it. */
export interface RouteShape {
  /** The route's own key — `places.join(" → ")`. Opaque here. */
  key: string;
  /** The de-duplicated place labels, in walked order. */
  places: readonly string[];
  /** Recordings that walked it. Decides which member names the cluster. */
  count: number;
}

/**
 * When two routes are the same work.
 *
 * `insertions` is the rule this repo ships, and it is deliberately a COUNT
 * rather than a similarity float: one sequence must contain the other as a
 * subsequence — same places, same order, nothing reordered and nothing dropped —
 * with at most `budget` extra hops. That is a sentence a person can check
 * against a screen ("these two are the same walk, but one of them also passed
 * through Finder"), where "cosine 0.83" is not.
 *
 * The other two exist so `npm run probe:routes` can MEASURE the choice on a real
 * library instead of asserting it. They are not wrong; they are less legible,
 * and `docs/internals/trace-and-replay.md` carries what they measured.
 */
export type ClusterRule =
  | { kind: "exact" }
  | { kind: "insertions"; budget: number }
  | { kind: "lcs"; min: number }
  | { kind: "jaccard"; min: number };

/**
 * The shipped rule, and the budget is 2 because A DETOUR COSTS TWO INSERTIONS.
 *
 * Measured on a real six-recording corpus (`npm run probe:routes`). The same
 * task was recorded three times, once with a deliberate side trip through
 * Finder, and it landed as:
 *
 *     ×2   4 hops   … → Calculator → TextEdit → Electron
 *     ×1   6 hops   … → Calculator → TextEdit → Finder → TextEdit → Electron
 *
 * Leaving and coming back inserts BOTH the place you went to and a second copy
 * of the place you returned to, so the gap is +2. A budget of 1 — which is what
 * this shipped with before the corpus existed — merged nothing at all, and would
 * have read as "the rule does not fire" rather than "the rule is off by one".
 * Only a one-way hop that permanently changes the tail costs 1, and that is the
 * rarer shape: people come back.
 *
 * The budget is not the whole rule: the insertions must also be INTERIOR, so a
 * walk that merely stopped early is never folded into a longer one. See
 * `compatible`.
 *
 * `lcs ≥0.80` and `jaccard ≥0.80` merged exactly the same pair on that corpus,
 * so this is not the only rule that works. It is the one that cannot fail
 * QUIETLY. Loosening the float to `lcs ≥0.60` fused two unrelated browsing
 * sessions — LinkedIn-then-news with news-then-Fox-then-Business-Insider — and
 * containment refuses that BY CONSTRUCTION, not by threshold: it only ever
 * merges walks where one is a subsequence of the other, so it can never claim a
 * merge between two paths that genuinely diverge. A float can, and the amount by
 * which it can is invisible until someone reads the output.
 */
export const DEFAULT_CLUSTER_RULE: ClusterRule = { kind: "insertions", budget: 2 };

/** Length of the longest common subsequence of two place sequences. */
export function lcsLength(a: readonly string[], b: readonly string[]): number {
  // Row-at-a-time: place sequences are short, but this is called O(n²) times.
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = 0;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] =
        a[i - 1] === b[j - 1]
          ? (prev[j - 1] ?? 0) + 1
          : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length] ?? 0;
}

/**
 * Extra hops between two sequences when one CONTAINS the other, else null.
 *
 * Null is not "far apart" — it is "not the same walk at all", which is a
 * different fact and must not be smoothed into a large number.
 */
export function insertionGap(a: readonly string[], b: readonly string[]): number | null {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (lcsLength(shorter, longer) !== shorter.length) return null;
  return longer.length - shorter.length;
}

/** Order-insensitive overlap of the places visited, ignoring how often. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let shared = 0;
  for (const v of sa) if (sb.has(v)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

/** LCS as a fraction of the two lengths — order-sensitive, 1 when identical. */
export function lcsRatio(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  return (2 * lcsLength(a, b)) / (a.length + b.length);
}

/** Does this rule call these two routes the same work? */
export function compatible(
  a: readonly string[],
  b: readonly string[],
  rule: ClusterRule,
): boolean {
  switch (rule.kind) {
    case "exact":
      return a.length === b.length && a.every((p, i) => p === b[i]);
    case "insertions": {
      const gap = insertionGap(a, b);
      if (gap === null || gap > rule.budget) return false;
      // THE INSERTIONS MUST BE INTERIOR: same first place, same last place.
      //
      // Containment alone cannot tell a DETOUR from a TRUNCATION. "A → B" is
      // contained in "A → B → C" at a gap of 1, but that walk did not take a
      // side trip — it STOPPED, one state short, and folding it in would
      // publish a route as walked three times when one of the three never
      // reached the end. A route is work with an outcome; two walks that finish
      // somewhere different did not do the same work, however much of the
      // middle they share.
      //
      // A real detour keeps both ends: you leave from where you were and you
      // come back to it. That is exactly the corpus case — `… → Calculator →
      // TextEdit → Electron` and `… → Calculator → TextEdit → Finder →
      // TextEdit → Electron` start and end identically.
      return a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
    }
    case "lcs":
      return lcsRatio(a, b) >= rule.min;
    case "jaccard":
      return jaccard(a, b) >= rule.min;
  }
}

/** One merged route: who names it, who is in it, and who differed. */
export interface RouteCluster {
  /** The member that names the cluster — its key becomes the route's key. */
  canonical: RouteShape;
  /** Every member, canonical first. One entry means nothing was merged. */
  members: RouteShape[];
  /**
   * Members that are NOT the canonical walk, with how many hops they added.
   *
   * The disclosure the UI and the file read from. A merge that hid this would be
   * asserting that five recordings agree when two of them did something else.
   */
  variants: { key: string; count: number; extraHops: number }[];
  /**
   * Keys this cluster was ALSO compatible with but declined to absorb, because
   * they were compatible with another cluster too.
   *
   * Kept rather than dropped: an ambiguity nobody can see is indistinguishable
   * from an ambiguity that never happened.
   */
  declined: string[];
}

/**
 * Group routes into clusters under `rule`.
 *
 * Input order decides which member names a cluster, so callers pass routes in
 * the order they already rank them — `frequentRoutes` sorts most-walked first,
 * and the most-walked walk is the one a habit should describe. Stable: equal
 * inputs in equal order give an equal answer, with no `Map` iteration deciding
 * anything.
 */
export function clusterRoutes(
  routes: readonly RouteShape[],
  rule: ClusterRule = DEFAULT_CLUSTER_RULE,
): RouteCluster[] {
  const clusters: RouteCluster[] = [];

  for (const route of routes) {
    // COMPLETE linkage: compatible with every member, not just with one.
    const fits = clusters.filter((c) =>
      c.members.every((m) => compatible(m.places, route.places, rule)),
    );

    if (fits.length === 1) {
      const target = fits[0]!;
      target.members.push(route);
      const gap = insertionGap(target.canonical.places, route.places);
      target.variants.push({
        key: route.key,
        count: route.count,
        // A rule looser than containment can pair sequences that contain
        // neither, and there is then no honest hop count. -1 says so rather
        // than inventing one.
        extraHops: gap ?? -1,
      });
      continue;
    }

    // Ambiguous, or nothing fits: its own cluster either way. When ambiguous we
    // record WHICH clusters wanted it, on each of them.
    for (const c of fits) c.declined.push(route.key);
    clusters.push({ canonical: route, members: [route], variants: [], declined: [] });
  }

  return clusters;
}
