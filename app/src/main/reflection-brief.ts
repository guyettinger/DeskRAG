/**
 * What the reflecting model is shown about one recording.
 *
 * Pure, and imports only types plus one const from `deskrag` — no electron, no
 * store, no native subpath — so the whole of it is reachable from the ROOT
 * suite, the same condition `index-plan.ts` and `graph-view.ts` meet. The stage
 * runner does the reading; every decision about WHAT a reflection is written
 * over lives here, where it can be asserted with a plain object.
 *
 * The decisions, and why each one is a decision:
 *
 * - **The steps are the composed root's own children, not the actions.** A
 *   40-minute recording is hundreds of actions and a handful of tasks, and the
 *   question is about the shape of the session. Handing over the actions would
 *   also hand over a list too long to judge, which is how a model ends up
 *   naming whichever step it saw last.
 * - **Fewer than two steps and there is NO note.** A reflection over one step
 *   can only restate it, and "the session was one task, which went fine" is
 *   noise that would still cost a model call per recording. Returning null is
 *   how the stage knows to say so rather than writing something empty.
 * - **A step with no composed summary falls back to its digest.** Elision is
 *   real (`composeLadder` adopts a lone child rather than wrapping it), so a
 *   leaf CAN hang directly off the root, and it will never have a summary row.
 *   Printing "(unnamed)" for it would be the model's only impression of a step
 *   that has a perfectly good name one column over.
 */

import { ROOT_GRANULARITY, type EventRow, type ReflectionBrief, type SegmentRow } from "deskrag";

export interface ReflectionInput {
  /** Every segment of this session — leaves and composed levels alike. */
  segments: readonly SegmentRow[];
  /** Composed summaries, by segment id. Leaves have none. */
  summaries: ReadonlyMap<string, string>;
  /** The composed tree, one hop at a time. */
  childrenOf: (segmentId: string) => readonly string[];
  /** Every leaf beneath a segment — the segment itself when it has none. */
  leavesOf: (segmentId: string) => readonly string[];
  /** The session's events, for the application order. */
  events: readonly EventRow[];
  /** `session.started_at`, wall clock, used ONLY to date the note. */
  recordedAt: number;
}

/**
 * The session's composed root, or undefined when composing has not run.
 *
 * Exported because the CALLER needs it too — a reflection is keyed on this
 * segment. Two readers finding the root two ways is the `ax-dump`/`ax-exec`
 * drift in miniature: they would agree until the day the granularity changed.
 */
export function composedRoot(segments: readonly SegmentRow[]): SegmentRow | undefined {
  return segments.find((s) => s.granularity === ROOT_GRANULARITY);
}

/** The brief, or null when there is nothing worth reflecting on. */
export function reflectionBriefFor(input: ReflectionInput): ReflectionBrief | null {
  const root = composedRoot(input.segments);
  if (root === undefined) return null;

  const byId = new Map(input.segments.map((s) => [s.id, s]));
  const steps = input
    .childrenOf(root.id)
    .map((id) => byId.get(id))
    .filter((s): s is SegmentRow => s !== undefined)
    .sort((a, b) => a.tMonoStart - b.tMonoStart)
    .map((s) => ({
      name: nameOf(s, input.summaries),
      seconds: sec(s.tMonoEnd - s.tMonoStart),
      actions: input.leavesOf(s.id).length,
    }));

  if (steps.length < 2) return null;

  return {
    purpose: input.summaries.get(root.id) ?? null,
    recordedOn: localDate(input.recordedAt),
    durationSec: sec(root.tMonoEnd - root.tMonoStart),
    steps,
    apps: appsInOrder(input.events),
  };
}

/**
 * The recording's own calendar day, in the machine's timezone.
 *
 * NOT `toISOString()`. A session recorded at 9pm on the 19th is the 20th in UTC
 * for anyone east of the meridian's evening, and a note headed with the wrong
 * day is wrong in the one way its reader is certain to notice. `started_at` is
 * wall-clock and exists for human display; this is the display.
 */
function localDate(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nameOf(s: SegmentRow, summaries: ReadonlyMap<string, string>): string {
  const summary = summaries.get(s.id);
  if (summary !== undefined && summary.trim() !== "") return summary.trim();
  const digest = s.digest;
  if (digest != null && digest.trim() !== "") return digest.trim();
  return "(unnamed step)";
}

/** ms -> s. The store's `t_mono` is milliseconds; the brief speaks seconds. */
const sec = (ms: number): number => Math.max(0, ms) / 1000;

/**
 * Applications in the order they were FIRST reached, not by how much they were
 * used. The order is the only part of this a model can reason about — "the
 * session began in the browser and ended in the editor" is a real observation,
 * where a ranking by dwell would invite one about importance that the events do
 * not support.
 */
function appsInOrder(events: readonly EventRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of [...events].sort((a, b) => a.tMono - b.tMono)) {
    if (e.kind !== "focus_change") continue;
    const data = e.data;
    const app = data !== null && typeof data === "object" ? (data as { app?: unknown }).app : null;
    if (typeof app !== "string" || app === "") continue;
    if (seen.has(app)) continue;
    seen.add(app);
    out.push(app);
  }
  return out;
}
