/**
 * Frame↔segment association — the lazy denormalization the store's scoped ANN
 * depends on, and the ONLY thing text-only retrieval needs from a frame.
 *
 * This used to live inside the image representers, both of
 * which only run when an image provider is configured. The default is none, so
 * on a default install no frame was ever linked to a segment — and
 * `Retriever.recallFrames`'s non-visual branch, which recalls frames purely by
 * segment membership, returned NOTHING for every text query over a fully
 * indexed library. Measured on a real store: 2 of 4 recordings (38 of 86
 * frames) had zero links and were unreachable by search.
 *
 * Association is pure SQLite over what segmentation already produced; nothing
 * about it needs a model. It lives here so it can run unconditionally, and so
 * the two image paths share ONE window rule instead of two copies that can
 * drift.
 */

import type { FrameRow, SegmentRow, Store } from "../store/types.js";

/**
 * The segments containing `frame`, by t_mono.
 *
 * Segments are half-open [start, end), EXCEPT the one ending at the session's
 * own end, which owns its right edge — otherwise a frame landing exactly there
 * belongs to nothing. `sessionEnd` is the max `tMonoEnd` across the session's
 * segments, not the session row's end: the two can differ, and it is the
 * segment edge a frame is compared against.
 *
 * A frame normally lands in one `action` segment AND one or more overlapping
 * `task` segments — that M:N spread is the point of multi-granularity windows.
 */
export function segmentIdsForFrame(
  frame: Pick<FrameRow, "tMono">,
  segments: readonly Pick<SegmentRow, "id" | "tMonoStart" | "tMonoEnd">[],
  sessionEnd: number,
): string[] {
  return segments
    .filter((s) => {
      const inclusiveRight = s.tMonoEnd === sessionEnd;
      return (
        frame.tMono >= s.tMonoStart &&
        (inclusiveRight ? frame.tMono <= s.tMonoEnd : frame.tMono < s.tMonoEnd)
      );
    })
    .map((s) => s.id);
}

/** The right edge a frame is compared against — see {@link segmentIdsForFrame}. */
export function sessionEndOf(segments: readonly Pick<SegmentRow, "tMonoEnd">[]): number {
  return Math.max(...segments.map((s) => s.tMonoEnd), 0);
}

/**
 * Link every frame in a session to its containing segments. Idempotent —
 * `associateFrameSegments` inserts against a composite primary key — so it is
 * safe to run on a session that a later image stage will also associate, and
 * safe to re-run when re-indexing.
 *
 * Returns the number of frames that landed in at least one segment. A frame
 * outside every segment links to nothing and is NOT an error: it is a frame
 * captured past the last boundary, and counting it separately is what makes
 * "captured nothing" distinguishable from "never ran".
 */
export async function associateFrames(store: Store, sessionId: string): Promise<number> {
  const frames = store.getFramesBySession(sessionId);
  if (frames.length === 0) return 0;
  const segments = store.getSegmentsBySession(sessionId);
  if (segments.length === 0) return 0;
  const sessionEnd = sessionEndOf(segments);

  let linked = 0;
  for (const frame of frames) {
    const ids = segmentIdsForFrame(frame, segments, sessionEnd);
    if (ids.length === 0) continue;
    await store.associateFrameSegments(frame.id, ids);
    linked++;
  }
  return linked;
}
