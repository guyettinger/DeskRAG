/**
 * Types for the compositional segment hierarchy.
 *
 * Everything here is INDEX space, never time space: a partitioner chooses cut
 * points among children that exist, so it cannot invent a moment nothing was
 * recorded in. Times ride along on ChildSummary for coherence scoring only, and
 * always as DIFFERENCES — a uniform time shift must never change a layout.
 */

import type { SummarySource } from "../../store/types.js";

/** One node of the level being composed, as its parent-to-be sees it. */
export interface ChildSummary {
  /** Position in the level's ordered array. */
  index: number;
  /** The text a partitioner reads: a caption/digest at level 0, a summary above. */
  text: string;
  app: string | null;
  url: string | null;
  startSec: number;
  endSec: number;
  /**
   * True when a group may not extend LEFTWARD across this child — an explicit
   * user bookmark. A barrier outranks every similarity score there is.
   */
  barrier: boolean;
}

/** A half-open index range `[start, end)` into a level's children. */
export interface Block {
  start: number;
  end: number;
}

/** A named run a partitioner proposes. Index ranges, never times. */
export interface ComposeGroup {
  start: number;
  end: number;
  summary: string;
}

/** One composed parent: what it covers, what it is called, and who named it. */
export interface ComposedNode {
  range: Block;
  summary: string;
  source: SummarySource;
}

/** One whole level of the tree. `level` is 1-based; level 0 is the input leaves. */
export interface ComposedLevel {
  level: number;
  nodes: ComposedNode[];
}

/**
 * Proposes a partition of one block. Injected, so the recursion stays pure and
 * the suite can drive a model-shaped path with no model.
 *
 * May return anything at all, including a malformed partition. The caller
 * validates and REJECTS WHOLESALE; it never repairs. Repairing means guessing
 * intent, the rule `parseInterventionResponse` already sets in `trace/`.
 */
export type Partitioner = (
  children: readonly ChildSummary[],
  block: Block,
  level: number,
) => Promise<ComposeGroup[]>;
