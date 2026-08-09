/**
 * Whether a composed level earns its existence.
 *
 * Pure and separate from the ladder so the rule can be read and tested on its
 * own — it is the fix for the measured defect, where 21 of 60 parents held a
 * single child and fan-out collapsed to 1.6 by level 3.
 */

import type { LevelKind } from "./types.js";

/** The `granularity` written on a row, per level. */
export const LEVEL_GRANULARITY: Record<LevelKind, string> = {
  task: "level:1",
  process: "level:2",
  session: "session",
};

/**
 * A level exists only if it actually composed something.
 *
 * Two conditions, and both are needed. At least one node must hold 2+ children,
 * or the "level" is a relabelling of the one below. And the level must be
 * strictly smaller, or nothing was composed at all.
 *
 * A single node swallowing everything PASSES: "this recording was one phase" is
 * a real answer, not a degenerate one.
 */
export function levelQualifies(groupSizes: readonly number[], below: number): boolean {
  if (groupSizes.length === 0) return false;
  if (groupSizes.length >= below) return false;
  return groupSizes.some((n) => n >= 2);
}
