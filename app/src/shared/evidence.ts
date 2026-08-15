/**
 * How a search hit's evidence is NAMED, shared by every surface that reports it.
 *
 * There are two readers — the Search screen's rows and the MCP `search_experience`
 * tool — and they must agree, because they are describing the same retrieval to
 * two audiences. Two copies of this table is the drift hazard the repo keeps
 * paying for elsewhere (`ax-dump`/`ax-exec` reading one tree, `encodeWav`/`wavPeaks`
 * reading one header), so it lives in `shared/` where both sides already depend.
 *
 * Runtime values, unlike the rest of `shared/`, which is types only. `@shared/`
 * is aliased in main, preload and renderer alike, so the import resolves in all
 * three; the ROOT tsconfig needs its own exact-path entry, because it is
 * NodeNext and cannot follow the app's bundler-style wildcard.
 */

/**
 * What a ranked list is CALLED, for someone who did not build the index.
 *
 * The keys are the retriever's own vocabulary — `digest` is a templated event
 * rollup, `app_caption` is a crop of the focused window — and none of that is
 * the reader's problem. They asked a question and want to know which part of
 * the recording answered it.
 */
const LANE_LABELS: Record<string, string> = {
  digest: "what happened",
  summary: "task summary",
  caption: "screen description",
  app_caption: "window description",
  transcript: "what was said",
  behavior: "activity pattern",
  lexical: "exact words",
  region_label: "on-screen label",
};

/**
 * An unknown key falls through to ITSELF rather than to a catch-all: a lane
 * added later should look unfinished here, not be silently absorbed into a
 * plausible-sounding "other" that nobody ever notices is wrong.
 */
export function laneLabel(key: string): string {
  return LANE_LABELS[key] ?? key;
}

/** One lane as a surface prints it: `on-screen label ×7`, or just its name. */
export function laneText(lane: { key: string; count?: number }): string {
  const label = laneLabel(lane.key);
  return lane.count !== undefined && lane.count > 1 ? `${label} ×${lane.count}` : label;
}

/**
 * Every hit scored identically, so the ordering between them is arbitrary.
 *
 * A real state, not a degenerate one: frames sharing a segment with no region
 * match are equal on every signal the retriever has, and eleven of them tying
 * to six decimal places is documented behaviour. Both surfaces have to say so
 * rather than presenting an arbitrary order as a ranking — the UI dims its bars
 * and the MCP tool drops "best first".
 *
 * A single hit is not a tie: there is nothing for it to tie with.
 */
export function scoresAreTied(hits: readonly { score: number }[]): boolean {
  if (hits.length < 2) return false;
  return hits.every((h) => h.score === hits[0]!.score);
}
