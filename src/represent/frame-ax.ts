/**
 * Frame↔AX association — pairing each accessibility walk with the frame whose
 * pixels it actually describes.
 *
 * Capture cannot do this. `CaptureSession` starts a walk when a frame ARRIVES,
 * and a frame arrives a whole capture latency after the pixels it shows —
 * measured ~2.2s on a real avfoundation device — so the walk reads a screen
 * that is roughly two keyframes NEWER than the frame that triggered it.
 * Recording the trigger as the walk's frame is wrong by construction, and it
 * fed region proposal a tree from one screen and a picture from another.
 *
 * This is the same class of bug as `AxCapturer`'s `boundaryTMono`, which exists
 * because a settle-delayed walk post-dates its boundary and a latest-at-or-
 * before lookup therefore returned the previous state — measured at 54% of
 * nodes incoherent. Same shape, one layer down.
 *
 * The join is only meaningful because `frame.tMono` is now ffmpeg's capture
 * time rather than its arrival time; both sides are finally on the same clock.
 * Pure SQLite over what capture wrote — no model, no provider — so it runs
 * unconditionally, like `associateFrames`.
 */

import type { Store } from "../store/types.js";

/**
 * The frame a walk taken at `walkTMono` describes: the one nearest in content
 * time. An exact tie keeps the EARLIER frame, so a re-run cannot flip the
 * association on floating-point noise.
 */
export function nearestFrameId(
  walkTMono: number,
  frames: readonly { id: string; tMono: number }[],
): string | undefined {
  let best: { id: string; d: number } | undefined;
  for (const f of frames) {
    const d = Math.abs(f.tMono - walkTMono);
    if (best === undefined || d < best.d) best = { id: f.id, d };
  }
  return best?.id;
}

/**
 * Point every keyframe walk in a session at the frame it describes. Returns the
 * number of walks linked. Idempotent, so re-indexing is safe.
 *
 * The direction is WALK → FRAME, never frame → walk. Each walk goes to the
 * frame it best describes, so two walks cannot contend for one frame and "no
 * walk near this frame" stays a real, visible outcome: those frames keep a null
 * `frame_id`, `getFrameAx` returns [], and region proposal falls back to
 * interaction hotspots and grid tiling. Expect the first keyframes of a session
 * to land there — no walk has happened yet at their content time.
 *
 * Boundary walks are untouched: they are keyed by `t_mono` and read through
 * `getAxForBoundary`, which is a different question with a different answer.
 */
export async function associateFrameAx(store: Store, sessionId: string): Promise<number> {
  const frames = store.getFramesBySession(sessionId);
  if (frames.length === 0) return 0;
  const walks = store
    .getAxSnapshotsBySession(sessionId)
    .filter((s) => s.reason === "keyframe");

  let linked = 0;
  for (const walk of walks) {
    const frameId = nearestFrameId(walk.tMono, frames);
    if (frameId === undefined) continue;
    linked++;
    if (walk.frameId === frameId) continue; // already pointed there
    await store.setAxSnapshotFrame(walk.id, frameId);
  }
  return linked;
}
