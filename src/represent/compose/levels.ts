/**
 * The recursion: merge adjacent siblings into parents, level by level, until one
 * node covers the recording.
 *
 * Bottom-up rather than top-down, for two reasons. It SCALES — a 3h session has
 * thousands of actions and they do not fit one context, which is exactly where
 * a hierarchy matters most. And every node stays GROUNDED: a parent's span is
 * exactly the union of its children's, so no node can claim time nothing was
 * recorded in.
 *
 * Pure. The model arrives as an injected `Partitioner`, so this file has no
 * provider, no store and no I/O.
 */

import {
  DEFAULT_BATCH_CAP,
  splitIntoBlocks,
  structuralRanges,
  validatePartition,
} from "./agglomerate.js";
import { rollupText } from "./rollup.js";
import type {
  Block,
  ChildSummary,
  ComposedLevel,
  ComposedNode,
  Partitioner,
} from "./types.js";

/**
 * A stop the geometry should already guarantee — every level at least halves.
 * Cheap insurance against a loop, and the reason the tail below exists.
 */
export const MAX_DEPTH = 8;

export interface ComposeLevelsOptions {
  partitioner?: Partitioner;
  batchCap?: number;
  maxDepth?: number;
}

export async function composeLevels(
  leaves: readonly ChildSummary[],
  opts: ComposeLevelsOptions = {},
): Promise<ComposedLevel[]> {
  if (leaves.length === 0) return [];
  const cap = opts.batchCap ?? DEFAULT_BATCH_CAP;
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;

  const out: ComposedLevel[] = [];
  let children: ChildSummary[] = leaves.map((c, i) => ({ ...c, index: i }));
  let level = 1;

  while (children.length > 1 && level <= maxDepth) {
    const nodes = await composeOneLevel(children, level, cap, opts.partitioner);
    // A level that failed to shrink would loop forever. Wrapping everything into
    // one node terminates AND is honest: "this could not be subdivided further".
    // Reachable only when every block is a single child — i.e. a bookmark
    // between every pair.
    const shrunk =
      nodes.length < children.length
        ? nodes
        : [rollupNode(children, { start: 0, end: children.length }, level)];

    out.push({ level, nodes: shrunk });
    const below = children;
    children = shrunk.map((n, i) => liftNode(below, n, i));
    level += 1;
  }

  // A single leaf gets a root of its own, and a depth cap reached without one
  // still gets it, so a caller can always rely on "the last level holds exactly
  // one node".
  if (children.length !== 1 || out.length === 0) {
    out.push({
      level,
      nodes: [rollupNode(children, { start: 0, end: children.length }, level)],
    });
  }
  return out;
}

async function composeOneLevel(
  children: readonly ChildSummary[],
  level: number,
  cap: number,
  partitioner: Partitioner | undefined,
): Promise<ComposedNode[]> {
  const nodes: ComposedNode[] = [];
  for (const block of splitIntoBlocks(children, cap)) {
    nodes.push(...(await composeBlock(children, block, level, partitioner)));
  }
  return nodes;
}

async function composeBlock(
  children: readonly ChildSummary[],
  block: Block,
  level: number,
  partitioner: Partitioner | undefined,
): Promise<ComposedNode[]> {
  const size = block.end - block.start;
  if (size <= 1) return [rollupNode(children, block, level)];

  if (partitioner !== undefined) {
    let groups;
    try {
      groups = await partitioner(children, block, level);
    } catch {
      // Composing NEVER fails the run: an unreachable daemon, a timeout or a
      // torn response all degrade to the structural path.
      groups = undefined;
    }
    if (
      groups !== undefined &&
      validatePartition(groups, block.start, block.end) &&
      groups.length < size
    ) {
      return groups.map((g) => ({
        range: { start: g.start, end: g.end },
        summary:
          g.summary.trim().length > 0
            ? g.summary.trim()
            : rollupText(children, { start: g.start, end: g.end }, level),
        source: "llm" as const,
      }));
    }
    // Rejected WHOLESALE — not repaired. Nothing the model said survives, not
    // the ranges and not the names. Repairing a malformed partition means
    // guessing intent, the rule `parseInterventionResponse` sets in `trace/`.
  }

  return structuralRanges(children, block).map((r) => rollupNode(children, r, level));
}

function rollupNode(
  children: readonly ChildSummary[],
  range: Block,
  level: number,
): ComposedNode {
  return { range, summary: rollupText(children, range, level), source: "template" };
}

/** Turn a composed parent into a child of the level above it. */
function liftNode(
  children: readonly ChildSummary[],
  n: ComposedNode,
  index: number,
): ChildSummary {
  const slice = children.slice(n.range.start, n.range.end);
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  // One app only when EVERY child agrees: a parent spanning two applications is
  // not "in" either of them, and claiming one would feed a false signal upward.
  const app = slice.every((c) => c.app === first.app) ? first.app : null;
  const url = slice.every((c) => c.url === first.url) ? first.url : null;
  return {
    index,
    text: n.summary,
    app,
    url,
    startSec: first.startSec,
    endSec: last.endSec,
    // A parent inherits its FIRST child's barrier, so a bookmark keeps barring
    // all the way up rather than being swallowed at level 1.
    barrier: first.barrier,
  };
}
