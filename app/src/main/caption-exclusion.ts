/**
 * Which segments the captioner should not spend a model call on.
 *
 * THE RECORDER IS NOT PART OF THE WORK IT RECORDS. `liftTrace` has known that
 * since the `n0 — no state` root was removed, and `excludeFocusedApps` drops the
 * recorder's stretches before anything is lifted. Captioning had no equivalent,
 * and it is by far the most expensive stage: measured on the real store, 114 of
 * 367 captions described the DeskRAG window — 41 of 47 in one recording — at
 * roughly 85s each. Worse than the time, `ComposeRepresenter.leafChildren` reads
 * `s.caption ?? s.digest`, caption FIRST, so that prose climbed the ladder and
 * three of eight composed roots named recording rather than the calculator, the
 * news and the music they were actually about.
 *
 * PURE, and it imports no electron and no native subpath, so a root test reaches
 * it — the same condition `index-plan.ts`, `graph-view.ts` and `session-tracks.ts`
 * already meet. `DeskRagService` holds the setting and `index-run.ts` binds this
 * to it, the same arrangement `digest-context.ts` and `trace-index.ts` use.
 *
 * It resolves focus the way every other environment fact in this repo does —
 * LATEST AT-OR-BEFORE — and mirrors `excludeFocusedApps`'s two hard-won rules
 * rather than inventing its own, because two readers of one focus rule is the
 * `ax-dump`/`ax-exec` drift hazard by name.
 */

import { focusOf, type ExcludedFocus, type TraceEvent } from "deskrag";
import { latestAt, type Timeline } from "./trace-index.js";

/** Whether the segment beginning at this `t_mono` should be left uncaptioned. */
export type IsExcludedSegment = (tMonoStart: number) => boolean;

/**
 * The predicate for one session, or `undefined` when nothing can be excluded.
 *
 * Returning `undefined` rather than a never-true function is deliberate: the
 * representer takes the hook as optional and absence is its documented no-op, so
 * this hands back the shape that cannot accidentally exclude anything.
 *
 * Two rules, both taken from `excludeFocusedApps`:
 *
 *  - **No `focus_change` anywhere is a NO-OP.** Without the `active-win` signal
 *    no event can be attributed to any application, and a resolver that answered
 *    "excluded" for an unattributable session would silently caption nothing at
 *    all. This rule must never be the reason a library has no captions.
 *  - **The preamble belongs to the FIRST `focus_change`.** Segmentation pins
 *    `session_start` at t_mono 0, before any focus event exists, so the earliest
 *    segments resolve to nothing under a strict at-or-before rule. `active-win`
 *    emits its first poll unconditionally, naming whatever was already frontmost
 *    — in practice the recorder, since that is what the Record button was
 *    clicked in — so the first focus names the application the recording opened
 *    in, and the preamble goes with it.
 */
export function captionExclusionFor(
  events: readonly TraceEvent[],
  isExcluded: (focus: ExcludedFocus) => boolean,
): IsExcludedSegment | undefined {
  const changes = events.filter((e) => e.kind === "focus_change");
  if (changes.length === 0) return undefined;

  const timeline: Timeline<ExcludedFocus>[] = changes.map((e) => ({
    tMono: e.tMono,
    value: focusOf(e),
  }));
  // Sorted rather than assumed: `getEventsBySession` orders by t_mono today, and
  // `latestAt` walks forward until it passes the mark, so an out-of-order stream
  // would resolve to whichever event happened to be last in the array.
  timeline.sort((a, b) => a.tMono - b.tMono);
  const first = timeline[0]!.value;

  return (tMonoStart: number): boolean =>
    isExcluded(latestAt(timeline, tMonoStart) ?? first);
}
