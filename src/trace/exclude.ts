/**
 * Drop the stretches of a recording that belong to the RECORDER rather than to
 * the work.
 *
 * A session is started and stopped from an application, so every recording is
 * bracketed by that application: the first `focus_change` fires while the Record
 * click still has it focused, and the last one fires when the user comes back to
 * press Stop. Neither is work. Left in, they inflate every route key, add steps
 * to every skill written from one, and make two unrelated tasks look like they
 * pass through a shared hub.
 *
 * WHY HERE AND NOT IN THE PROJECTION. Lifting is re-runnable over recordings
 * already taken — that is what `rebuildGraph` is for — so a filter at this layer
 * repairs a library that already exists. A filter in `graph-view.ts` would
 * relabel the routes while leaving the cards on the canvas and the edges in the
 * step lists.
 *
 * THE PREDICATE IS INJECTED, the same way `liftTrace` takes its whole world
 * through callbacks: `trace/` stays a leaf that has never heard of any
 * particular application. The caller decides what "the recorder" means.
 *
 * Pure: no store, no clock, no I/O.
 */

import type { TraceEvent } from "./types.js";

/** What a `focus_change` says about the application it switched to. */
export interface ExcludedFocus {
  app?: string;
  bundleId?: string;
  /**
   * The capture process itself was frontmost — stamped at capture time by
   * comparing the focused window's pid against the recorder's own.
   *
   * Exact where a name is a guess, and correct in a dev checkout and a packaged
   * bundle alike. Recordings taken before this existed carry no such flag, which
   * is precisely why the caller's predicate also gets `app` and `bundleId`.
   */
  recorder?: boolean;
}

export interface ExcludeResult {
  /** What survived, in the order it arrived. */
  events: TraceEvent[];
  /** How many were dropped. Disclosure, not bookkeeping. */
  dropped: number;
  /** Which applications were dropped, first-seen order. */
  apps: string[];
  /**
   * The stream carried no `focus_change` at all, so nothing could be attributed
   * to an application and NOTHING was dropped. True whenever the `active-win`
   * signal was off for the recording.
   */
  unattributable: boolean;
}

const asRecord = (d: unknown): Record<string, unknown> =>
  d !== null && typeof d === "object" ? (d as Record<string, unknown>) : {};

/** The focus a `focus_change` event describes. */
export function focusOf(event: TraceEvent): ExcludedFocus {
  const d = asRecord(event.data);
  return {
    ...(typeof d.app === "string" ? { app: d.app } : {}),
    ...(typeof d.bundleId === "string" ? { bundleId: d.bundleId } : {}),
    ...(d.recorder === true ? { recorder: true } : {}),
  };
}

/**
 * Every event that occurred while an excluded application was frontmost, gone.
 *
 * One pass, in `t_mono` order, mirroring `focusContext`'s latest-at-or-before
 * rule — two readers of one focus rule is the `ax-dump`/`ax-exec` drift hazard
 * by name, so this walk resolves focus exactly the way node building does.
 *
 * The three cases are ONE case. A leading stretch, a trailing stretch and a
 * mid-recording visit to check the meters all reduce to "the recorder was
 * frontmost", and all three become nothing rather than a hole with a stray click
 * inside it.
 *
 * Two rules are worth stating out loud:
 *
 *  - **No `focus_change` anywhere is a NO-OP**, checked before anything else.
 *    Without the `active-win` signal no event can be attributed to any
 *    application, and a walk that started excluded would drop the entire
 *    recording — this rule must never be the reason a library goes empty.
 *  - **The preamble is attributed to the FIRST `focus_change`**, not assumed to
 *    be anything. `active-win` emits its first poll unconditionally, naming
 *    whatever was already frontmost, so the first focus names the application
 *    the recording opened in — the latest-at-or-before rule run backwards across
 *    the one gap where it has no answer. In practice that is the recorder, and
 *    the preamble goes with it; when nothing is excluded this function is a true
 *    no-op, which it would not be if the walk simply started excluded.
 *
 *    That matters more than it looks: leaving the preamble in pins the
 *    timeline's left edge at a moment with no focus, no AX and no keyframe
 *    behind it, which is exactly the stateless entry node this change removes.
 *
 * An excluded `focus_change` is dropped WITH the stretch it opens; a
 * non-excluded one is kept, because it is the arrival at real work and the
 * boundary the first real node is built at.
 */
export function excludeFocusedApps(
  events: readonly TraceEvent[],
  isExcluded: (focus: ExcludedFocus) => boolean,
): ExcludeResult {
  if (!events.some((e) => e.kind === "focus_change")) {
    return { events: [...events], dropped: 0, apps: [], unattributable: true };
  }

  const kept: TraceEvent[] = [];
  const apps: string[] = [];
  // The first focus names what was frontmost when recording began; see above.
  const first = events.find((e) => e.kind === "focus_change")!;
  let excluded = isExcluded(focusOf(first));
  let dropped = 0;

  for (const e of events) {
    if (e.kind === "focus_change") {
      const focus = focusOf(e);
      excluded = isExcluded(focus);
      if (excluded) {
        const name = focus.app ?? focus.bundleId;
        if (name !== undefined && !apps.includes(name)) apps.push(name);
      }
    }
    if (excluded) dropped++;
    else kept.push(e);
  }

  return { events: kept, dropped, apps, unattributable: false };
}

/**
 * Case-insensitive membership in a list of application names AND bundle ids,
 * plus the capture-time `recorder` flag.
 *
 * The two halves answer different vintages of recording: the flag is exact but
 * only exists on sessions captured since it was added, and the list is what
 * reaches everything recorded before that. Both spellings are matched against
 * one list because a caller has no way to know which of the two a given build
 * reports — `active-win` gives a name in a dev checkout and a bundle id from a
 * signed bundle, and getting it wrong fails silently by excluding nothing.
 */
export function excludedByName(
  names: readonly string[],
): (focus: ExcludedFocus) => boolean {
  const wanted = new Set(names.map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0));
  return (focus) => {
    if (focus.recorder === true) return true;
    if (focus.app !== undefined && wanted.has(focus.app.toLowerCase())) return true;
    return focus.bundleId !== undefined && wanted.has(focus.bundleId.toLowerCase());
  };
}
