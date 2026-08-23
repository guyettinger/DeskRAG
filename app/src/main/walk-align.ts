/**
 * How one recording's walk differed from the standard, as named facts.
 *
 * DTO-free on purpose. `route-cluster.ts` is split from `graph-view.ts` for the
 * same reason and states it: a core that speaks only in sequences is what lets
 * the app and a probe read ONE implementation. Two readers of one tree is the
 * `ax-dump`/`ax-exec` drift hazard by name — two binaries reading one AX tree
 * disagreed on exactly one of 48 elements, and that single label was enough to
 * stop any node from verifying at replay.
 *
 * There is NO score here and there will not be one. `FrameResult.score` is an
 * ordering rather than a confidence, and the UI and the MCP tool show rank and
 * evidence instead of the number; an edit-distance ratio would be exactly the
 * figure this repo refuses to print. What comes out is a list a person can
 * check against a screen, which is the same standard `route-cluster.ts` holds
 * when it ships `insertions` as a COUNT: "the same walk, but one of them also
 * passed through Finder" is checkable and "cosine 0.83" is not.
 */

export type DeviationKind = "skipped" | "inserted" | "reordered";

/** A difference, located at an index into the BASELINE. No label: see below. */
export interface EdgeDeviation {
  kind: DeviationKind;
  stepIndex: number;
  edgeId: string;
}

export interface Alignment {
  deviations: EdgeDeviation[];
  /** Whether the walk consumed the baseline's final edge. Vacuously true when the baseline is empty. */
  reachedEnd: boolean;
}

/**
 * A monotone forward scan, then a post-pass.
 *
 * The scan is the shape `scripts/transfer-probe.ts` already uses to verify a
 * route's states against a held-out recording's own AX moments. It is
 * order-preserving by construction, which is exactly why `reordered` cannot
 * fall out of it: a swapped pair emerges as one `skipped` plus one `inserted`,
 * and that the same edge merely MOVED is only visible once both lists exist.
 *
 * Lookahead breaks the tie when neither cursor matches. Whichever side finds
 * its counterpart sooner is the side that advances, so a single insertion in a
 * long walk costs one deviation rather than realigning everything after it.
 * `indexOf` from the live cursor, never from 0 — a session can walk one edge
 * more than once (`frequentRoutes` orders a walk by the recorded moment
 * precisely because of that), and searching from the start would pair a walk's
 * second visit with the baseline's first.
 */
export function alignWalk(baseline: readonly string[], walk: readonly string[]): Alignment {
  const skipped: EdgeDeviation[] = [];
  const inserted: EdgeDeviation[] = [];
  const matched = new Array<boolean>(baseline.length).fill(false);

  let b = 0;
  let w = 0;
  while (b < baseline.length && w < walk.length) {
    const wantEdge = baseline[b]!;
    const gotEdge = walk[w]!;
    if (wantEdge === gotEdge) {
      matched[b] = true;
      b += 1;
      w += 1;
      continue;
    }
    const wantLaterInWalk = walk.indexOf(wantEdge, w + 1);
    const gotLaterInBaseline = baseline.indexOf(gotEdge, b + 1);

    if (wantLaterInWalk === -1 && gotLaterInBaseline === -1) {
      // A SUBSTITUTION: neither edge can ever match, so advancing only one
      // cursor drags the mismatch along the rest of the sequence. Measured on
      // paper before it was written: advancing the baseline alone turned
      // `[a,b,c]` against `[a,x,c]` into "c skipped AND c inserted", which the
      // post-pass then collapsed into a `reordered` c that never moved. Both
      // cursors advance, and both deviations take index `b` — the position a
      // reader is looking at.
      skipped.push({ kind: "skipped", stepIndex: b, edgeId: wantEdge });
      inserted.push({ kind: "inserted", stepIndex: b, edgeId: gotEdge });
      b += 1;
      w += 1;
    } else if (wantLaterInWalk === -1) {
      skipped.push({ kind: "skipped", stepIndex: b, edgeId: wantEdge });
      b += 1;
    } else if (gotLaterInBaseline === -1) {
      inserted.push({ kind: "inserted", stepIndex: b, edgeId: gotEdge });
      w += 1;
    } else if (wantLaterInWalk - w <= gotLaterInBaseline - b) {
      // Both reappear. Whichever finds its counterpart sooner is the side that
      // advances, so one insertion in a long walk costs one deviation rather
      // than realigning everything after it.
      inserted.push({ kind: "inserted", stepIndex: b, edgeId: gotEdge });
      w += 1;
    } else {
      skipped.push({ kind: "skipped", stepIndex: b, edgeId: wantEdge });
      b += 1;
    }
  }
  while (b < baseline.length) {
    skipped.push({ kind: "skipped", stepIndex: b, edgeId: baseline[b]! });
    b += 1;
  }
  while (w < walk.length) {
    // Past the end there is no baseline index to point at, so they attribute to
    // one PAST the last step rather than to it — a trailing extra is not a
    // property of the final step.
    inserted.push({ kind: "inserted", stepIndex: baseline.length, edgeId: walk[w]! });
    w += 1;
  }

  const deviations = collapseReordered(skipped, inserted);
  deviations.sort((x, y) => x.stepIndex - y.stepIndex || x.edgeId.localeCompare(y.edgeId));

  return {
    deviations,
    reachedEnd: baseline.length === 0 || matched[baseline.length - 1] === true,
  };
}

/**
 * An edge in BOTH lists was moved, not dropped and separately added.
 *
 * Collapsing is the honest count: doing steps 3 and 4 the other way round is
 * ONE difference, and reporting it as two overstates the divergence in the same
 * way `cautionsFor` guards against when it counts distinct EDGES rather than
 * flattened variant steps — that miscount inflated a denominator to 54 against
 * a graph holding 53.
 *
 * It keeps the BASELINE index, because that is the position a reader is looking
 * at when they ask what moved.
 */
function collapseReordered(
  skipped: readonly EdgeDeviation[],
  inserted: readonly EdgeDeviation[],
): EdgeDeviation[] {
  const insertedEdges = new Set(inserted.map((d) => d.edgeId));
  const movedEdges = new Set(skipped.filter((d) => insertedEdges.has(d.edgeId)).map((d) => d.edgeId));
  if (movedEdges.size === 0) return [...skipped, ...inserted];

  const out: EdgeDeviation[] = [];
  for (const d of skipped) {
    out.push(movedEdges.has(d.edgeId) ? { ...d, kind: "reordered" } : d);
  }
  for (const d of inserted) {
    if (!movedEdges.has(d.edgeId)) out.push(d);
  }
  return out;
}
