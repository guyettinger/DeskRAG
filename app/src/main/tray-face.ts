/**
 * WHAT THE MENU-BAR GHOST IS WEARING, AND WHAT THE MENU SAYS UNDER IT.
 *
 * Pure: no electron import, so the root suite reaches it the same way it reaches
 * `graph-view.ts` (see vitest.config.ts). `index.ts` does the drawing; this file
 * decides.
 *
 * The tray used to say its state in menu-bar TEXT beside the mark — `⏺ REC`,
 * `⏳`, `◉` — so the bar carried two symbols where one would do. The ghost now
 * carries it alone, in its face: the eye row is capture, a row of dots low on
 * the body is indexing. The art is in `scripts/gen/brand/emit-icons.ts`.
 *
 * The two axes are INDEPENDENT and there is no precedence rule, which is the
 * point: indexing yields to recording only between stages, so a stage already in
 * flight keeps running for minutes after a capture starts, and a tray that
 * arbitrated would go quiet about one of the two while both were true.
 */

import type { IndexQueueDTO, RecordingStatus } from "@shared/types";

/**
 * The four faces the emitter writes, keyed the way the runtime asks for them.
 *
 * The idle basename is `trayTemplate` unchanged, so a build that predates the
 * other three still finds its icon. `scripts/gen/brand/emit-icons.ts` owns the same
 * four names in `TRAY_FACES` and cannot be imported from the app; a test asserts
 * the two sets agree rather than leaving them to drift.
 */
export function trayFaceAsset(recording: boolean, indexing: boolean): string {
  if (recording) return indexing ? "trayRecordingIndexingTemplate" : "trayRecordingTemplate";
  return indexing ? "trayIndexingTemplate" : "trayTemplate";
}

/**
 * INDEXING MEANS A STAGE IS RUNNING RIGHT NOW, never "there is a queue".
 *
 * The worker holds the queue while a recording is in flight, so during a capture
 * there are usually jobs waiting and nothing being done to them. Dots there
 * would claim work that is not happening — the same rule the retired `⏳` glyph
 * used, moved into the face.
 */
export function trayIndexing(queue: IndexQueueDTO): boolean {
  return queue.runningJobId !== null;
}

/** `2:41 PM`. Injected so the status line is testable without a locale. */
export type TimeFormatter = (at: number) => string;

const defaultTime: TimeFormatter = (at) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * The disabled first line of the tray menu, and the body of the tooltip.
 *
 * A START TIME, NEVER AN ELAPSED COUNTER. The menu and the tooltip are rebuilt
 * only when the state changes, so a duration would be wrong the moment after it
 * was drawn; a live one would need a timer, and a timer in the menu bar is the
 * thing this whole design rules out — a changing menu-bar pixel is what let
 * DeskRAG's own window defeat `mpdecimate` (docs/internals/capture.md). A wall
 * clock is correct forever and costs nothing.
 */
export function trayStatusLine(
  status: RecordingStatus,
  queue: IndexQueueDTO,
  formatTime: TimeFormatter = defaultTime,
): string {
  const parts: string[] = [];
  if (status.state === "recording") {
    parts.push(
      status.startedAt ? `Recording since ${formatTime(status.startedAt)}` : "Recording",
    );
  }
  if (trayIndexing(queue)) parts.push(indexingPhrase(queue, parts.length > 0));
  if (parts.length === 0) return "Ready to record";
  return parts.join(" · ");
}

/** `DeskRAG — Recording since 2:41 PM`. One sentence, one place it is written. */
export function trayTooltip(
  status: RecordingStatus,
  queue: IndexQueueDTO,
  formatTime: TimeFormatter = defaultTime,
): string {
  return `DeskRAG — ${trayStatusLine(status, queue, formatTime)}`;
}

/**
 * `Indexing 2 of 3`, counting the jobs still outstanding. Bare `Indexing` when
 * it is the only one: "1 of 1" is a ratio pretending to be progress.
 */
function indexingPhrase(queue: IndexQueueDTO, lowercase: boolean): string {
  const word = lowercase ? "indexing" : "Indexing";
  const outstanding = queue.jobs.filter((j) => j.state === "queued" || j.state === "running");
  if (outstanding.length < 2) return word;
  const at = outstanding.findIndex((j) => j.id === queue.runningJobId);
  if (at < 0) return word;
  return `${word} ${at + 1} of ${outstanding.length}`;
}
