/**
 * The parent's text when no model wrote one — a structural rollup.
 *
 * Deterministic and pure, so it doubles as the control the LLM path is measured
 * against.
 *
 * ABOVE LEVEL 1 IT COMPOSES FROM THE LEVEL BELOW, and that is the whole point.
 * A tally destroys meaning on the way up: measured on a real library, levels 3
 * and 4 were 100% structural (7/7 and 2/2), because by then a block holds two or
 * three children and the model answers "split this" with one group each — no
 * shrink, correctly rejected. So EVERY root was named from strings like
 * `Electron · 2 groups · 25.1s`, and the root's own naming call had nothing but
 * app names in a tally to work from. It produced "launching electron" for a
 * session whose children were about recording, arithmetic and documenting.
 *
 * Composing the children's own names instead keeps the chain intact: a fallback
 * then costs the model's PHRASING, not the meaning, and every level above it can
 * still say what happened.
 */

import type { Block, ChildSummary } from "./types.js";

/**
 * Cap on a composed rollup, in characters.
 *
 * Deep trees concatenate, and a summary is embedded and shown in a lane label.
 * The digest already truncates typed text this way (`DEFAULT_MAX_TYPED_CHARS`),
 * so the ellipsis is the established signal that text was cut.
 */
export const MAX_ROLLUP_CHARS = 200;

export function rollupText(
  children: readonly ChildSummary[],
  range: Block,
  level: number,
): string {
  const slice = children.slice(range.start, range.end);
  if (slice.length === 0) return "";

  // Level 1's children are ACTIONS, whose text is a whole VLM caption — joining
  // ten of them is unreadable, and it would duplicate what the digest already
  // carries. Only levels 2+ have short goal phrases as children, which is
  // exactly what composes.
  if (level >= 2) {
    const names: string[] = [];
    for (const c of slice) {
      const t = c.text.trim();
      // Deduped in first-seen order: a repeated child name says nothing twice.
      if (t.length > 0 && !names.includes(t)) names.push(t);
    }
    if (names.length > 0) {
      const joined = names.join("; ");
      return joined.length > MAX_ROLLUP_CHARS
        ? `${joined.slice(0, MAX_ROLLUP_CHARS).trimEnd()}…`
        : joined;
    }
    // Every child unnamed — fall through rather than emit an empty summary.
  }

  const apps: string[] = [];
  for (const c of slice) {
    if (c.app !== null && c.app.length > 0 && !apps.includes(c.app)) apps.push(c.app);
  }

  const noun = level === 1 ? "action" : "group";
  const count = `${slice.length} ${noun}${slice.length === 1 ? "" : "s"}`;

  // A DIFFERENCE, so a uniform time shift cannot change the text.
  const dur = `${(slice[slice.length - 1]!.endSec - slice[0]!.startSec).toFixed(1)}s`;

  return [apps.length > 0 ? apps.join(", ") : null, count, dur]
    .filter((p): p is string => p !== null)
    .join(" · ");
}
