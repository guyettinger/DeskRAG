/**
 * Keyframe gating — kills the near-duplicate haze from static screens so we don't
 * keep (and later embed) a near-identical frame every sample. For each sampled
 * frame's pHash:
 *   - keep it if it differs enough from the LAST KEPT frame (dedup), and
 *   - force a keyframe on a scene-change spike vs the IMMEDIATELY PREVIOUS frame
 *     (a sudden large jump means something happened, even mid-dwell).
 * The very first frame is always kept.
 */

import { hamming64 } from "./phash.js";

export interface KeyframeGateOptions {
  /** Min Hamming distance from the last kept frame to keep a new one. */
  hammingThreshold?: number;
  /** Frame-to-frame Hamming jump that forces a keyframe regardless of dedup. */
  sceneChangeThreshold?: number;
}

export interface GateDecision {
  keep: boolean;
  /** True when kept because of a scene-change spike (not just dedup). */
  forced: boolean;
  /** Hamming distance to the previous considered frame (0 for the first). */
  distancePrev: number;
}

export class KeyframeGate {
  private readonly hammingThreshold: number;
  private readonly sceneChangeThreshold: number;
  private lastKept: bigint | undefined;
  private lastConsidered: bigint | undefined;

  constructor(opts: KeyframeGateOptions = {}) {
    this.hammingThreshold = opts.hammingThreshold ?? 10;
    this.sceneChangeThreshold = opts.sceneChangeThreshold ?? 25;
  }

  consider(phash: bigint): GateDecision {
    let decision: GateDecision;
    if (this.lastKept === undefined) {
      decision = { keep: true, forced: false, distancePrev: 0 };
    } else {
      const distancePrev =
        this.lastConsidered !== undefined ? hamming64(phash, this.lastConsidered) : 0;
      const distanceKept = hamming64(phash, this.lastKept);
      const forced = distancePrev >= this.sceneChangeThreshold;
      const keep = forced || distanceKept >= this.hammingThreshold;
      decision = { keep, forced, distancePrev };
    }
    this.lastConsidered = phash;
    if (decision.keep) this.lastKept = phash;
    return decision;
  }

  reset(): void {
    this.lastKept = undefined;
    this.lastConsidered = undefined;
  }
}
