/**
 * The one prompt, for every level.
 *
 * At level 1 the input is action captions; at level 2 it is level-1 goals, and
 * composing goals into bigger goals is the same instruction with the depth
 * passed as context. Recursion needs exactly one prompt.
 *
 * It asks for the GOAL, not the appearance — which is the whole defect being
 * fixed. `CAPTION_SYSTEM` says "describe what is on screen", and running that
 * over a longer window produces a longer screenshot description, never a higher
 * altitude.
 */

import type { ChildSummary, ComposeGroup } from "./types.js";

/**
 * CUT POINTS, not ranges — and that was measured, not preferred.
 *
 * Asked for `{start, end}` ranges, the model returned a genuinely good
 * three-task grouping of 24 steps that ended at index 23: it dropped the last
 * step, so the covering check rejected all of it. Naming a run's END is the
 * only thing it got wrong, and it is the one thing it never needs to say.
 *
 * Stating only where a run BEGINS makes a gap, an overlap and a short cover
 * IMPOSSIBLE TO EXPRESS rather than rejected after the fact. Measured on one
 * real 24-step block: 3 of 3 valid against 0 of 1.
 *
 * This is not a softening of the rejection rule. It changes what is ASKED for,
 * never what is accepted: the cut points are still validated (ascending, first
 * is 0, in range, integer) and a violation still discards the whole reply.
 */
export const COMPOSE_SYSTEM =
  "You group a user's recorded desktop activity into the tasks it composes. " +
  "You are given an ordered, numbered list of consecutive steps. Split it into " +
  "contiguous runs, where each run is ONE thing the user was trying to " +
  "accomplish. Name each run in one short phrase stating the GOAL, not what was " +
  "on screen. Merge freely: fewer, larger runs are better than many small ones. " +
  'Reply with JSON only: {"groups":[{"start":0,"summary":"..."},{"start":5,"summary":"..."}]} ' +
  "where `start` is the step number a run BEGINS at. The first run must start at " +
  "0. Each run continues until the next one begins, so you never state where a " +
  "run ends. If every step belongs to ONE task, reply with a single run " +
  "starting at 0 — that is often the right answer for a short list. No preamble.";

/**
 * Naming the whole list as ONE thing — the question the root needs, which
 * partitioning never answers.
 *
 * A separate system prompt rather than a flag inside COMPOSE_SYSTEM, because
 * the two ask for genuinely different work: "where does this split" against
 * "what was this". Its reply shape is deliberately the SAME single-cut-point
 * JSON, so the parser, the validator and the reject-wholesale rule are shared.
 */
export const NAME_SYSTEM =
  "You name a stretch of a user's recorded desktop activity. You are given an " +
  "ordered, numbered list of the activities it is made of. Reply with ONE short " +
  "phrase naming what the user was accomplishing overall — the GOAL, not what " +
  "was on screen, and not a list. " +
  'Reply with JSON only: {"groups":[{"start":0,"summary":"..."}]}. Exactly one ' +
  "entry, starting at 0. No preamble.";

export function composePrompt(
  children: readonly ChildSummary[],
  level: number,
  single = false,
): string {
  const lines = children.map((c, i) => {
    const app = c.app === null ? "" : `[${c.app}] `;
    // Collapse whitespace: a VLM caption can be several lines, and a step that
    // spans lines would look like several steps to the model.
    return `${i}. ${app}${c.text.replace(/\s+/g, " ").trim()}`;
  });
  if (single) {
    return `These ${children.length} activities are all part of one session.\nName the session.\n\n${lines.join("\n")}`;
  }
  const what =
    level === 1
      ? "These are individual actions."
      : "These are already-grouped activities; group them into larger ones.";
  return `${what}\nPartition these ${children.length} steps.\n\n${lines.join("\n")}`;
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
