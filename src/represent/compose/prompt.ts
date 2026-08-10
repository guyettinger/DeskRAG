/**
 * Three prompts, one per level of the compositional hierarchy.
 *
 * The fixed ladder replaces the recursion: each level asks its own question,
 * so the composition is not "bigger goals from smaller goals" (recursion) but
 * a semantic progression from actions through tasks through work phases to a
 * session name.
 */

import type { ChildSummary, ComposeGroup, LevelKind } from "./types.js";

/** The cut-point contract, shared by every GROUPING prompt. */
const CUT_POINTS =
  'Reply with JSON only: {"groups":[{"start":0,"summary":"..."},{"start":5,"summary":"..."}]} ' +
  "where `start` is the step number a run BEGINS at. The first run must start at " +
  "0. Each run continues until the next one begins, so you never state where a " +
  "run ends. If every step belongs to ONE run, reply with a single run starting " +
  "at 0. No preamble.";

/**
 * LEVEL 1 — actions into TASKS.
 *
 * This level already works: measured across five recordings of one task it
 * produced six or seven semantically parallel tasks every time, with the
 * calculator work as one 14-19 action task in all five. The wording is the
 * former COMPOSE_SYSTEM, narrowed to actions.
 */
export const TASK_SYSTEM =
  "You group a user's recorded desktop ACTIONS into the tasks they compose. " +
  "You are given an ordered, numbered list of consecutive actions. Split it into " +
  "contiguous runs, where each run is the smallest stretch you could name as a " +
  "verb and an object — 'copy the result', 'start the calculator'. Name each run " +
  "in one short phrase stating the GOAL, not what was on screen. " +
  CUT_POINTS;

/**
 * LEVEL 2 — tasks into PHASES.
 *
 * A DIFFERENT question, which is the whole point of the fixed ladder. Asking
 * "group these into larger ones" at every altitude is what produced levels that
 * differed in size but not in kind — fan-out 1.6 by level 3, and 21 of 60
 * parents holding a single child.
 */
export const PROCESS_SYSTEM =
  "You group a user's recorded TASKS into the phases of work they form. A phase " +
  "is a stretch of tasks serving one outcome — setting something up, doing the " +
  "work, recording the result. You are given an ordered, numbered list of tasks. " +
  "Split it into contiguous phases and name each in one short phrase stating the " +
  "outcome it serves. If the tasks are all one phase, say so with a single run. " +
  CUT_POINTS;

/**
 * SESSION — naming the whole list as ONE thing.
 *
 * The question the root needs, which partitioning never answers. A separate
 * prompt rather than a flag in the grouping prompts, because the two ask for
 * genuinely different work: "where does this split" against "what was this".
 * Its reply shape is deliberately the SAME single-cut-point JSON, so the
 * parser, the validator and the reject-wholesale rule are shared.
 */
export const NAME_SYSTEM =
  "You name a stretch of a user's recorded desktop activity. You are given an " +
  "ordered, numbered list of the activities it is made of. Reply with ONE short " +
  "phrase naming what the user was accomplishing overall — the GOAL, not what " +
  "was on screen, and not a list. " +
  'Reply with JSON only: {"groups":[{"start":0,"summary":"..."}]}. Exactly one ' +
  "entry, starting at 0. No preamble.";

export function systemFor(kind: LevelKind): string {
  switch (kind) {
    case "task":
      return TASK_SYSTEM;
    case "process":
      return PROCESS_SYSTEM;
    case "session":
      return NAME_SYSTEM;
  }
}

export function composePrompt(
  children: readonly ChildSummary[],
  kind: LevelKind,
): string {
  const lines = children.map((c, i) => {
    const app = c.app === null ? "" : `[${c.app}] `;
    // Collapse whitespace: a VLM caption can be several lines, and a step that
    // spans lines would look like several steps to the model.
    return `${i}. ${app}${c.text.replace(/\s+/g, " ").trim()}`;
  });
  if (kind === "session") {
    return `These ${children.length} activities are all part of one session.\nName the session.\n\n${lines.join("\n")}`;
  }
  const what =
    kind === "task"
      ? `These are individual actions.\nPartition these ${children.length} actions.`
      : `These are tasks the user performed.\nSplit these ${children.length} tasks into phases.`;
  return `${what}\n\n${lines.join("\n")}`;
}

/**
 * Parse a model reply into groups, shifting indices into the level's own index
 * space.
 *
 * The reply carries CUT POINTS; this closes them into ranges against `count`,
 * so each run ends where the next begins and the last runs to the end of the
 * block. Contiguity and coverage therefore come from the geometry — the model
 * cannot state them wrongly because it never states them at all.
 *
 * Returns `undefined` for anything unparseable. It still does NOT validate the
 * partition — `validatePartition` does that, and the caller rejects wholesale.
 * Keeping the two apart is what lets a malformed reply be distinguished from a
 * well-formed reply that happens to be a bad partition (cut points out of
 * order, or past the end).
 *
 * @param count  children in the block, so the final run can be closed.
 * @param offset the block's start in the level's index space.
 */
export function parseComposeResponse(
  raw: string,
  count: number,
  offset: number,
): ComposeGroup[] | undefined {
  // Models wrap JSON in prose or a code fence often enough that finding the
  // object is worth doing; anything past that is the caller's problem.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }

  const groups = (parsed as { groups?: unknown }).groups;
  if (!Array.isArray(groups) || groups.length === 0) return undefined;

  const cuts: { start: number; summary: string }[] = [];
  for (const g of groups) {
    const o = g as { start?: unknown; summary?: unknown };
    if (typeof o.start !== "number") return undefined;
    cuts.push({
      start: o.start,
      // A missing name is not a malformed reply — the caller rolls one up.
      summary: typeof o.summary === "string" ? o.summary : "",
    });
  }

  // Close each cut against the next, and the last against the block's end.
  return cuts.map((c, i) => ({
    start: c.start + offset,
    end: (i + 1 < cuts.length ? cuts[i + 1]!.start : count) + offset,
    summary: c.summary,
  }));
}
