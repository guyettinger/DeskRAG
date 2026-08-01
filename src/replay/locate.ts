/**
 * Locating the live desktop in a recorded graph — "which recorded state is still
 * true here?".
 *
 * Deliberately NOT `trace/identity.ts`'s `matchNode`. That matches on
 * `samePredicateSet`, exact equality, which is right for MERGING: a differing
 * set is a different state. Locating asks the other question, and a live screen
 * that gained anything since recording would never match exactly — which, given
 * how aggressive the stability filter is, is the common case rather than the
 * exception. Same distinction `verifyNode` already makes, reused rather than
 * re-derived.
 *
 * `matchNode`'s visual fallback is unavailable here in any case: there is no
 * live frame at replay time, which is the same reason `resolve.ts` records the
 * visual rung as "no live frame to corroborate against".
 *
 * Pure: no subprocess, no clock, no I/O.
 */

import type { TraceNode } from "../trace/types.js";
import type { NodeLocation, Predicate } from "./types.js";
import { verifyNode } from "./verify.js";

export function locateNode(
  observed: readonly Predicate[],
  nodes: readonly TraceNode[],
): NodeLocation {
  // A node with NO predicates is vacuously satisfied by every observation, so it
  // would verify against any desktop at all. Excluded outright rather than
  // ranked last: ranking cannot help when it is the only candidate.
  const candidates = nodes.filter(
    (n) => n.predicates.length > 0 && verifyNode(n.predicates, observed).satisfied,
  );
  if (candidates.length === 0) return { candidates: 0, ambiguous: false };

  // Subset matching is monotone — fewer predicates are satisfied by strictly
  // more worlds — so the most specific description that still holds wins.
  const most = Math.max(...candidates.map((n) => n.predicates.length));
  const top = candidates.filter((n) => n.predicates.length === most);

  // Ambiguity declines, exactly as merging does. A redundant node is visible and
  // fixable; guessing sends replay down another context's branch, silently.
  if (top.length > 1) return { candidates: candidates.length, ambiguous: true };
  return { nodeId: top[0]!.id, candidates: candidates.length, ambiguous: false };
}
