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

export const COMPOSE_SYSTEM =
  "You group a user's recorded desktop activity into the tasks it composes. " +
  "You are given an ordered, numbered list of consecutive steps. Partition it " +
  "into contiguous runs, where each run is ONE thing the user was trying to " +
  "accomplish. Name each run in one short phrase stating the GOAL, not what was " +
  "on screen. Merge freely: fewer, larger runs are better than many small ones. " +
  'Reply with JSON only: {"groups":[{"start":0,"end":3,"summary":"..."}]} where ' +
  "start is inclusive, end is exclusive, the runs are in order, and together " +
  "they cover every step exactly once. No preamble.";

export function composePrompt(children: readonly ChildSummary[], level: number): string {
  const lines = children.map((c, i) => {
    const app = c.app === null ? "" : `[${c.app}] `;
    // Collapse whitespace: a VLM caption can be several lines, and a step that
    // spans lines would look like several steps to the model.
    return `${i}. ${app}${c.text.replace(/\s+/g, " ").trim()}`;
  });
  const what =
    level === 1
      ? "These are individual actions."
      : "These are already-grouped activities; group them into larger ones.";
  return `${what}\nPartition these ${children.length} steps.\n\n${lines.join("\n")}`;
}

/**
 * Parse a model reply into groups, shifting indices by `offset` into the
 * level's own index space.
 *
 * Returns `undefined` for anything unparseable. It does NOT validate the
 * partition — `validatePartition` does that, and the caller rejects wholesale.
 * Keeping the two apart is what lets one malformed reply be distinguished from
 * a well-formed reply that happens to be a bad partition.
 */
export function parseComposeResponse(raw: string, offset: number): ComposeGroup[] | undefined {
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
  if (!Array.isArray(groups)) return undefined;

  const out: ComposeGroup[] = [];
  for (const g of groups) {
    const o = g as { start?: unknown; end?: unknown; summary?: unknown };
    if (typeof o.start !== "number" || typeof o.end !== "number") return undefined;
    out.push({
      start: o.start + offset,
      end: o.end + offset,
      // A missing name is not a malformed reply — the caller rolls one up.
      summary: typeof o.summary === "string" ? o.summary : "",
    });
  }
  return out;
}
