/**
 * The live desktop as a predicate set — the replay-time counterpart of what
 * `lift` builds from a stored AX snapshot plus the session's `focus_change`
 * events.
 *
 * It exists because the two sides source predicates differently. At lift time
 * `app` and `window` come from the event stream; at replay there is no event
 * stream, so they have to come from the actuator. Without this, a live tree
 * produced ONLY `ax_exists`, and since verification requires every expected
 * predicate to hold, every node carrying an `app` predicate was unverifiable in
 * every state — measured on a real desktop as 16 observed predicates, none of
 * them `app` or `window`.
 *
 * Uses the SAME `extractPredicates` as lift, never a parallel implementation:
 * the two sides must agree on the stability filter, the role canonicalization
 * and the cap, or a node could never match its own recording.
 */

import { extractPredicates } from "../trace/predicates.js";
import type { Actuator, AxObservation, Predicate, Vec2 } from "./types.js";

/**
 * Express ONE observation as predicates — the dump-free half of `observe`.
 *
 * Exposed because the run loop needs the predicates AND the window origin from
 * the same instant: dumping twice to get both is the split-fact hazard that made
 * boundary snapshots describe the previous application.
 */
export function predicatesOf(o: AxObservation): Predicate[] {
  return extractPredicates(o.elements, {
    ...(o.app !== undefined && o.app.length > 0 ? { app: o.app } : {}),
    ...(o.windowTitle !== undefined && o.windowTitle.length > 0
      ? { windowTitle: o.windowTitle }
      : {}),
  });
}

/** Dump the live state and express it as predicates. */
export async function observe(actuator: Actuator): Promise<Predicate[]> {
  return predicatesOf(await actuator.dump());
}

/**
 * Origin of the window the live tree belongs to — the top-left of its root
 * `Window` element. Resolution needs it to compare geometry in WINDOW space, so
 * a window that merely moved does not veto a correctly-identified element.
 */
export function windowOriginOf(o: AxObservation): Vec2 | undefined {
  const win = o.elements.find((e) => e.role === "Window") ?? o.elements[0];
  return win === undefined ? undefined : { x: win.x, y: win.y };
}
