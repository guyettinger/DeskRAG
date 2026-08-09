/**
 * Types for the compositional segment hierarchy.
 *
 * Everything here is INDEX space, never time space: a partitioner chooses cut
 * points among children that exist, so it cannot invent a moment nothing was
 * recorded in. Times ride along on ChildSummary for coherence scoring only, and
 * always as DIFFERENCES — a uniform time shift must never change a layout.
 */

import type { SummarySource } from "../../store/types.js";

/**
 * WHICH question a compose call is asking.
 *
 * Semantic rather than numeric, so the provider interface carries meaning and a
 * future adapter can phrase each kind however its model prefers. It replaced
 * `{ level: number, single?: boolean }`, which could not express three distinct
 * prompts.
 */
export type LevelKind = "task" | "process" | "session";

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

/**
 * A reference from a ladder node to one of its children.
 *
 * TAGGED because the tree is NOT level-uniform: a node whose only child was
 * elided points at that child directly, so a `level:2` node may hold a
 * `level:1` node or even a leaf. `getDescendantLeaves` walks to leaves and
 * `collapseAncestors` walks children, so neither notices.
 */
export type LadderChild =
  | { kind: "leaf"; index: number }
  | { kind: "node"; index: number };

export interface LadderNode {
  /** The row's `granularity`: "level:1" | "level:2" | "session". */
  granularity: string;
  children: LadderChild[];
  summary: string;
  source: SummarySource;
}

/**
 * The composed tree as an explicit graph.
 *
 * Replaces the old per-level `ComposedLevel[]` with its index ranges, which
 * could only describe a UNIFORM tree — every node's children exactly one level
 * down. Elision breaks that, so the shape has to say which child it means.
 *
 * Topologically ordered: a node's children always precede it, and the ROOT is
 * last, so a single forward pass can mint ids.
 */
export interface Ladder {
  nodes: LadderNode[];
}
