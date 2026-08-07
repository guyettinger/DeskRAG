/**
 * KeyframeBudget — the ONLY rate limit on keyframes.
 *
 * What CHANGED on screen is decided by ffmpeg's `mpdecimate` in the filter
 * graph (see FfmpegScreenProducer), which compares 8x8 blocks against the last
 * kept frame and so can see a localized change. This class answers the separate
 * question of how OFTEN a change may produce a keyframe, because every kept
 * frame costs a JPEG blob, a caption, and an embedding — a video or an
 * animation playing on screen would otherwise flood all three.
 *
 * It keeps the FIRST frame of a burst and drops the rest: the frame that
 * started a change is the interesting one, and the ones behind it are the tail
 * of the same event. The clock is the last KEPT frame, never the last
 * considered one — measuring from the latter would let a steady stream just
 * under the interval starve the lane indefinitely.
 *
 * This REPLACES KeyframeGate, which decided keeps by dHash distance over a
 * 32x32 grayscale thumbnail. That could not see a Calculator digit on a
 * 2560x1440 screen — it is sub-pixel after the downscale — and produced one
 * keyframe in sixteen seconds of real use.
 */

export interface KeyframeBudgetOptions {
  /** Minimum gap between kept keyframes, in ms. 0 keeps every frame offered. */
  minIntervalMs?: number;
}

/** Provisional; replaced by a measured value in the calibration task. */
export const DEFAULT_KEYFRAME_MIN_INTERVAL_MS = 500;

export class KeyframeBudget {
  private readonly minIntervalMs: number;
  private lastKeptTMono: number | undefined;

  constructor(opts: KeyframeBudgetOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_KEYFRAME_MIN_INTERVAL_MS;
  }

  /** True when this frame may be kept. Only a kept frame moves the clock. */
  consider(tMono: number): boolean {
    if (
      this.lastKeptTMono !== undefined &&
      tMono - this.lastKeptTMono < this.minIntervalMs
    ) {
      return false;
    }
    this.lastKeptTMono = tMono;
    return true;
  }

  reset(): void {
    this.lastKeptTMono = undefined;
  }
}
