/**
 * The focused window's bounds at-or-before a given t_mono, resolved from a
 * session's `focus_change` events — the same "environment facts resolved by
 * latest at-or-before" rule display topology and keymap resolution use
 * elsewhere. `focus_change.data.bounds` is already captured today
 * (ActiveWindowProducer), in the same global screen-coordinate space as AX and
 * region bboxes, so no capture-side change is needed for this.
 *
 * Returns undefined when no focus_change with bounds precedes tMono — many
 * apps never report window bounds at all, and that must stay distinguishable
 * from "the window moved off-screen" rather than defaulting to some box.
 */

import type { Box } from "../regions/geometry.js";
import type { EventRow } from "../../store/types.js";

export function resolveFocusBounds(
  focusEvents: readonly EventRow[],
  tMono: number,
): Box | undefined {
  const ordered = [...focusEvents].sort((a, b) => a.tMono - b.tMono);
  let best: Box | undefined;
  for (const ev of ordered) {
    if (ev.tMono > tMono) break;
    const bounds = (ev.data as { bounds?: Box } | null)?.bounds;
    if (bounds !== undefined) best = bounds;
  }
  return best;
}
