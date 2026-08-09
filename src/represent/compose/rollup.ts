/**
 * The parent's text when no model wrote one — a structural rollup in
 * `buildDigest`'s own vocabulary.
 *
 * It is a CONCATENATION DISCIPLINE over text that already exists, not new
 * extraction: at level 1 the children are actions whose digests already carry
 * the window title, the URL, the typed text and the label of what was clicked.
 *
 * Deterministic and pure, so it doubles as the control the LLM path is measured
 * against.
 */

import type { Block, ChildSummary } from "./types.js";

export function rollupText(
  children: readonly ChildSummary[],
  range: Block,
  level: number,
): string {
  const slice = children.slice(range.start, range.end);
  if (slice.length === 0) return "";

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
