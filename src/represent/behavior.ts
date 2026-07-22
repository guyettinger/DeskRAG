/**
 * Behavioral feature vector (view 4): input dynamics as a small, fixed-length
 * numeric embedding. This is NOT a network embedding provider — it's a "builtin"
 * feature extractor that owns its own vector namespace
 * (behavior:builtin:input-dynamics-v1:12). Text queries never hit this space
 * (sharedTextSpace = false); it answers "sessions like what I'm doing now".
 *
 * Every feature is scaled/clamped into [0, 1] so cosine/L2 in Lance is meaningful
 * despite the raw signals living on very different scales.
 */

import type { NamespacedProvider } from "../embed/types.js";

export const BEHAVIOR_MODEL = "input-dynamics-v1";
export const BEHAVIOR_DIMENSIONS = 12;

export interface BehaviorEvent {
  tMono: number;
  kind: string;
  x?: number | null;
  y?: number | null;
}

export interface TimeWindow {
  tMonoStart: number;
  tMonoEnd: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class BehaviorFeatureExtractor implements NamespacedProvider {
  readonly id = "builtin";
  readonly model = BEHAVIOR_MODEL;
  readonly dimensions = BEHAVIOR_DIMENSIONS;
  readonly sharedTextSpace = false;

  extract(events: readonly BehaviorEvent[], window: TimeWindow): Float32Array {
    const durationMs = Math.max(window.tMonoEnd - window.tMonoStart, 0);
    const durationSec = Math.max(durationMs / 1000, 1e-3);
    const ordered = [...events].sort((a, b) => a.tMono - b.tMono);

    let clicks = 0;
    let keys = 0;
    let scrolls = 0;
    let moves = 0;
    const quarters = [0, 0, 0, 0];
    const activeBuckets = new Set<number>();
    const BUCKET_MS = 250;
    const qDur = durationMs / 4 || 1;

    // Mouse-path stats.
    const dirBins = new Array(8).fill(0);
    let dirPairs = 0;
    let speedSum = 0;
    let speedN = 0;
    let prevMove: BehaviorEvent | undefined;

    for (const ev of ordered) {
      if (ev.kind === "mouse_down") clicks++;
      else if (ev.kind === "key_down") keys++;
      else if (ev.kind === "scroll") scrolls++;
      else if (ev.kind === "mouse_move") {
        moves++;
        if (
          prevMove &&
          prevMove.x != null && prevMove.y != null &&
          ev.x != null && ev.y != null
        ) {
          const dx = ev.x - prevMove.x;
          const dy = ev.y - prevMove.y;
          const dt = ev.tMono - prevMove.tMono;
          const dist = Math.hypot(dx, dy);
          if (dt > 0) {
            speedSum += dist / dt;
            speedN++;
          }
          if (dist > 0) {
            const angle = Math.atan2(dy, dx); // (-π, π]
            const bin = Math.min(7, Math.floor(((angle + Math.PI) / (2 * Math.PI)) * 8));
            dirBins[bin]++;
            dirPairs++;
          }
        }
        prevMove = ev;
      }

      const rel = ev.tMono - window.tMonoStart;
      activeBuckets.add(Math.floor(rel / BUCKET_MS));
      quarters[Math.min(3, Math.max(0, Math.floor(rel / qDur)))]!++;
    }

    const totalEvents = clicks + keys + scrolls + moves;
    const meanSpeed = speedN > 0 ? speedSum / speedN : 0;
    const pathEntropy = normalizedEntropy(dirBins, dirPairs);
    const totalBuckets = Math.max(1, Math.ceil(durationMs / BUCKET_MS));
    const activeFraction = clamp01(activeBuckets.size / totalBuckets);

    const v = new Float32Array(BEHAVIOR_DIMENSIONS);
    v[0] = clamp01(clicks / durationSec / 5);
    v[1] = clamp01(keys / durationSec / 10);
    v[2] = clamp01(scrolls / durationSec / 10);
    v[3] = clamp01(moves / durationSec / 60);
    v[4] = clamp01(meanSpeed / 5);
    v[5] = pathEntropy;
    v[6] = clicks + keys > 0 ? clicks / (clicks + keys) : 0;
    v[7] = activeFraction;
    for (let q = 0; q < 4; q++) {
      v[8 + q] = totalEvents > 0 ? quarters[q]! / totalEvents : 0;
    }
    return v;
  }
}

/** Shannon entropy of the direction histogram, normalized to [0, 1] over 8 bins. */
function normalizedEntropy(bins: number[], total: number): number {
  if (total <= 0) return 0;
  let h = 0;
  for (const c of bins) {
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return clamp01(h / Math.log2(8));
}
