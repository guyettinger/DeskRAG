/**
 * Node verification — does the state this node claims still hold?
 *
 * SUBSET, not set equality, and the difference is load-bearing.
 * `samePredicateSet` is exact because MERGING needs it: a differing set is a
 * different state. Verification asks a different question — "is this still
 * true?" — and extra observed predicates (a new row, a restored window, a badge
 * that survived the stability filter) are not violations. Requiring equality
 * here would fail on almost every screen that changed at all since recording.
 *
 * Pure: no subprocess, no clock, no I/O.
 */

import { predicateKey } from "../trace/predicates.js";
import type { Predicate, Reach } from "./types.js";

export interface Violation {
  predicate: Predicate;
  reach: Reach;
}

export interface VerifyResult {
  satisfied: boolean;
  violations: Violation[];
}

export function verifyNode(
  expected: readonly Predicate[],
  observed: readonly Predicate[],
): VerifyResult {
  const have = new Set(observed.map(predicateKey));
  const violations: Violation[] = [];
  for (const p of expected) {
    if (!have.has(predicateKey(p))) violations.push({ predicate: p, reach: p.reach });
  }
  return { satisfied: violations.length === 0, violations };
}

/** No UI action can produce these; they can only gate. */
export const blockersOf = (v: readonly Violation[]): Violation[] =>
  v.filter((x) => x.reach === "assertable");

/** Some edge establishes these, so they have a repair path. */
export const repairableOf = (v: readonly Violation[]): Violation[] =>
  v.filter((x) => x.reach === "achievable");
