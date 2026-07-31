/**
 * Node identity — the hard problem the graph model buys. Merging depends on it,
 * and so does replay: arriving at a node is how you know where you are.
 *
 * Predicate set is primary and authoritative; visual similarity corroborates and
 * covers AX-blind applications. Predicates stay primary even where visual would
 * be easier, because a node whose identity cannot be read is a node that cannot
 * be debugged.
 *
 * The bias is deliberately asymmetric. Failing to merge leaves a redundant node
 * that is visible and fixable; merging wrongly corrupts the graph silently and
 * sends replay down a branch belonging to another context. So any ambiguity
 * declines to match.
 */

import { samePredicateSet } from "./predicates.js";
import type { FrameRef, TraceNode, VisualMatcher } from "./types.js";

export const DEFAULT_VISUAL_THRESHOLD = 0.92;
/** Runner-up within this of the best score means "cannot tell them apart". */
export const DEFAULT_VISUAL_MARGIN = 0.03;

export interface MatchOptions {
  visual?: VisualMatcher;
  visualThreshold?: number;
  visualMargin?: number;
}

export interface MatchResult {
  /** Undefined means "create a distinct node" — including on ambiguity. */
  nodeId?: string;
  /** Which layer decided. Recorded so brittleness is measurable, not guessed. */
  layer: "predicate" | "visual" | "none";
  confidence: number;
  ambiguous: boolean;
}

export async function matchNode(
  candidate: TraceNode,
  existing: readonly TraceNode[],
  opts: MatchOptions = {},
): Promise<MatchResult> {
  if (existing.length === 0) return { layer: "none", confidence: 0, ambiguous: false };

  const exact = existing.filter((n) => samePredicateSet(candidate.predicates, n.predicates));
  if (exact.length === 1) {
    return { nodeId: exact[0]!.id, layer: "predicate", confidence: 1, ambiguous: false };
  }
  if (exact.length > 1) {
    return { layer: "predicate", confidence: 1, ambiguous: true };
  }

  const matcher = opts.visual;
  if (matcher === undefined || candidate.visual === undefined) {
    return { layer: "none", confidence: 0, ambiguous: false };
  }

  const withVisual = existing.filter(
    (n): n is TraceNode & { visual: NonNullable<TraceNode["visual"]> } => n.visual !== undefined,
  );
  if (withVisual.length === 0) return { layer: "none", confidence: 0, ambiguous: false };

  const ref: FrameRef = { frameId: candidate.visual.frameBlobId, phash: candidate.visual.phash };
  const candidates: FrameRef[] = withVisual.map((n) => ({
    frameId: n.visual.frameBlobId,
    phash: n.visual.phash,
  }));
  const scores = await matcher.similar(ref, candidates);

  let bestIdx = -1;
  let best = -Infinity;
  let second = -Infinity;
  for (let i = 0; i < withVisual.length; i++) {
    const s = scores[i] ?? 0;
    if (s > best) {
      second = best;
      best = s;
      bestIdx = i;
    } else if (s > second) {
      second = s;
    }
  }

  const threshold = opts.visualThreshold ?? DEFAULT_VISUAL_THRESHOLD;
  const margin = opts.visualMargin ?? DEFAULT_VISUAL_MARGIN;
  if (bestIdx < 0 || best < threshold) {
    return { layer: "none", confidence: Math.max(0, best), ambiguous: false };
  }
  if (second > -Infinity && best - second < margin) {
    return { layer: "visual", confidence: best, ambiguous: true };
  }
  return { nodeId: withVisual[bestIdx]!.id, layer: "visual", confidence: best, ambiguous: false };
}
