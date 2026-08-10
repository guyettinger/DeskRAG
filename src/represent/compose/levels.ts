/**
 * The FIXED ladder: actions -> tasks -> phases -> one root.
 *
 * Three levels, never more, each asking its OWN question. It replaced a
 * recursion whose levels differed in SIZE but not in KIND — measured across
 * five real recordings, fan-out collapsed to 1.6 by level 3 and 21 of 60
 * parents held a single child, half of those repeating that child's name.
 *
 * Pure. The model arrives as an injected `ComposeFn`, so this file has no
 * provider, no store and no I/O.
 */

import { DEFAULT_BATCH_CAP, splitIntoBlocks, structuralRanges, validatePartition } from "./agglomerate.js";
import { LEVEL_GRANULARITY, levelQualifies } from "./admission.js";
import { rollupText } from "./rollup.js";
import type { SummarySource } from "../../store/types.js";
import type { Block, ChildSummary, ComposeGroup, Ladder, LadderChild, LadderNode, LevelKind } from "./types.js";

/** The ladder, in order. `modelOnly` levels do not fall back structurally. */
export const LEVELS: readonly { kind: LevelKind; modelOnly: boolean }[] = [
  { kind: "task", modelOnly: false },
  // A phase is a SEMANTIC judgment. Halving tasks into positional pairs is not
  // one, so without a model there is simply no Process level — the hierarchy is
  // Action -> Task -> Session, which is still complete.
  { kind: "process", modelOnly: true },
];

export type ComposeFn = (
  children: readonly ChildSummary[],
  kind: LevelKind,
) => Promise<ComposeGroup[]>;

export interface ComposeLadderOptions {
  compose?: ComposeFn;
  batchCap?: number;
}

export async function composeLadder(
  leaves: readonly ChildSummary[],
  opts: ComposeLadderOptions = {},
): Promise<Ladder> {
  if (leaves.length === 0) return { nodes: [] };
  const cap = opts.batchCap ?? DEFAULT_BATCH_CAP;
  const nodes: LadderNode[] = [];

  /** The current frontier: what the next level would compose. */
  let frontier: { ref: LadderChild; child: ChildSummary }[] = leaves.map((c, i) => ({
    ref: { kind: "leaf", index: i },
    child: { ...c, index: i },
  }));

  for (const level of LEVELS) {
    if (frontier.length < 2) break;
    const children = frontier.map((f, i) => ({ ...f.child, index: i }));
    const groups = await composeOneLevel(children, level, cap, opts.compose);
    if (groups === undefined) continue; // model-only level with no model

    if (!levelQualifies(groups.map((g) => g.range.end - g.range.start), frontier.length)) {
      // Never created. The level above adopts this frontier unchanged.
      continue;
    }

    const next: typeof frontier = [];
    for (const g of groups) {
      const members = frontier.slice(g.range.start, g.range.end);
      // ELIDED: a lone child is adopted by the level above rather than wrapped
      // in a node that could only restate it.
      if (members.length === 1) {
        next.push(members[0]!);
        continue;
      }
      nodes.push({
        granularity: LEVEL_GRANULARITY[level.kind],
        children: members.map((m) => m.ref),
        summary: g.summary,
        source: g.source,
      });
      next.push({
        ref: { kind: "node", index: nodes.length - 1 },
        child: liftChild(members.map((m) => m.child), g.summary),
      });
    }
    frontier = next;
  }

  // The ROOT always exists and is exempt from elision: it answers a different
  // question from its child rather than restating it.
  nodes.push(await makeRoot(frontier, opts.compose));
  return { nodes };
}

/** A group as the ladder needs it: a range plus who named it. */
interface LevelGroup {
  range: Block;
  summary: string;
  source: SummarySource;
}

/**
 * One level's groups, or `undefined` when a model-only level has no model.
 *
 * Blocks, validation, wholesale rejection and the structural fallback are all
 * unchanged — every one of them cost a measurement.
 */
async function composeOneLevel(
  children: readonly ChildSummary[],
  level: { kind: LevelKind; modelOnly: boolean },
  cap: number,
  compose: ComposeFn | undefined,
): Promise<LevelGroup[] | undefined> {
  if (level.modelOnly && compose === undefined) return undefined;
  const out: LevelGroup[] = [];
  for (const block of splitIntoBlocks(children, cap)) {
    const size = block.end - block.start;
    let accepted: LevelGroup[] | undefined;

    if (compose !== undefined && size > 1) {
      const slice = children.slice(block.start, block.end).map((c, i) => ({ ...c, index: i }));
      let groups;
      try {
        groups = await compose(slice, level.kind);
      } catch {
        // Composing NEVER fails the run.
        groups = undefined;
      }
      const shifted = groups?.map((g) => ({
        start: g.start + block.start,
        end: g.end + block.start,
        summary: g.summary,
      }));
      if (
        shifted !== undefined &&
        validatePartition(shifted, block.start, block.end) &&
        shifted.length < size
      ) {
        accepted = shifted.map((g) => ({
          range: { start: g.start, end: g.end },
          summary:
            g.summary.trim().length > 0
              ? g.summary.trim()
              : rollupText(children, { start: g.start, end: g.end }, levelNumber(level.kind)),
          source: "llm" as const,
        }));
      }
      // Rejected WHOLESALE — not repaired. Nothing the model said survives.
    }

    if (accepted === undefined) {
      // A model-only level does NOT abandon the whole level here. A block of
      // ONE child was never shown to the model, so it is not a model failure;
      // and a block the model got wrong must not cost the blocks it got right.
      // Measured: a 40-action recording split into sixteen size-1 blocks plus
      // one 24-block, and the early return threw away all twelve phases the
      // model had just composed. One singleton group per child instead —
      // elision dissolves every one of them, so no structural Process node is
      // ever written and the level above adopts those children directly.
      const ranges = level.modelOnly
        ? singletonRanges(block)
        : structuralRanges(children, block);
      accepted = ranges.map((r) => ({
        range: r,
        summary: rollupText(children, r, levelNumber(level.kind)),
        source: "template" as const,
      }));
    }
    out.push(...accepted);
  }
  return out;
}

/** `rollupText` still keys on a level NUMBER: level 1 tallies, above it composes. */
function levelNumber(kind: LevelKind): number {
  return kind === "task" ? 1 : 2;
}

/**
 * One range per child — what a model-only level falls back to, so that
 * elision can dissolve them rather than a template node claiming to be a
 * phase.
 */
function singletonRanges(block: Block): Block[] {
  const out: Block[] = [];
  for (let i = block.start; i < block.end; i++) out.push({ start: i, end: i + 1 });
  return out;
}

/** The root: one call asking what the whole recording was for. */
async function makeRoot(
  frontier: readonly { ref: LadderChild; child: ChildSummary }[],
  compose: ComposeFn | undefined,
): Promise<LadderNode> {
  const children = frontier.map((f, i) => ({ ...f.child, index: i }));
  const fallback = rollupText(children, { start: 0, end: children.length }, 2);
  if (compose !== undefined) {
    try {
      const groups = await compose(children, "session");
      const text = groups[0]?.summary.trim();
      if (text !== undefined && text.length > 0) {
        return {
          granularity: LEVEL_GRANULARITY.session,
          children: frontier.map((f) => f.ref),
          summary: text,
          source: "llm",
        };
      }
    } catch {
      // Falls through to the rollup: the root still exists and still says
      // `template`, so a root nothing named discloses it.
    }
  }
  return {
    granularity: LEVEL_GRANULARITY.session,
    children: frontier.map((f) => f.ref),
    summary: fallback,
    source: "template",
  };
}

/** Turn a composed group into a child of the level above it. */
function liftChild(members: readonly ChildSummary[], summary: string): ChildSummary {
  const first = members[0]!;
  const last = members[members.length - 1]!;
  // One app only when EVERY member agrees: a parent spanning two applications
  // is not "in" either, and claiming one would feed a false signal upward.
  const app = members.every((c) => c.app === first.app) ? first.app : null;
  const url = members.every((c) => c.url === first.url) ? first.url : null;
  return {
    index: 0,
    text: summary,
    app,
    url,
    startSec: first.startSec,
    endSec: last.endSec,
    // A parent inherits its FIRST member's barrier, so a bookmark keeps barring
    // all the way up rather than being swallowed at level 1.
    barrier: first.barrier,
  };
}
