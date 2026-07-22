/**
 * Perceptual hashing for keyframe gating + the Tier-0 coarse visual index.
 *
 * dHash (difference hash): downscale the grayscale frame to 9x8, then for each
 * row emit 8 bits comparing horizontally-adjacent pixels. 64 bits total, robust
 * to small changes (compression, cursor movement) but sensitive to real scene
 * changes. We hash EVERY sampled frame (it's cheap); the gate decides which
 * frames are worth keeping/embedding.
 *
 * Hamming distance over these hashes reuses the store's hamming64, so the pHash
 * we compute here is directly comparable to what Tier-0 (phashPrefilter) scans.
 */

import { hamming64 } from "../store/sqlite/db.js";

export { hamming64 };

/** Nearest-neighbour downscale of a grayscale (w x h) buffer to (tw x th). */
export function resizeNearestGray(
  src: Uint8Array,
  w: number,
  h: number,
  tw: number,
  th: number,
): Uint8Array {
  const out = new Uint8Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const sy = Math.min(h - 1, Math.floor((ty * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const sx = Math.min(w - 1, Math.floor((tx * w) / tw));
      out[ty * tw + tx] = src[sy * w + sx]!;
    }
  }
  return out;
}

/** 64-bit dHash of a grayscale (w x h) buffer. */
export function dHash(gray: Uint8Array, w: number, h: number): bigint {
  if (gray.length !== w * h) {
    throw new Error(`dHash: buffer length ${gray.length} != ${w}x${h}`);
  }
  const small = resizeNearestGray(gray, w, h, 9, 8);
  let hash = 0n;
  let bit = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (small[y * 9 + x]! > small[y * 9 + x + 1]!) hash |= 1n << bit;
      bit++;
    }
  }
  return hash;
}
