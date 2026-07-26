/**
 * Pure tensor post-processing for the ONNX adapters. Kept separate from
 * `runtime.ts` so the maths is unit-testable without loading a native module or
 * any model weights.
 */

/**
 * Mean-pool a `[seqLen, dims]` hidden state over unmasked positions.
 * Returns zeros when the mask is empty rather than dividing by zero.
 */
export function meanPool(
  hidden: Float32Array,
  mask: number[],
  seqLen: number,
  dims: number,
): Float32Array {
  const out = new Float32Array(dims);
  let n = 0;
  for (let t = 0; t < seqLen; t++) {
    if (!mask[t]) continue;
    n++;
    const base = t * dims;
    for (let d = 0; d < dims; d++) out[d]! += hidden[base + d]!;
  }
  if (n === 0) return out;
  for (let d = 0; d < dims; d++) out[d]! /= n;
  return out;
}

/** L2-normalize in place. A zero vector is returned unchanged. */
export function l2Normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

/** Split a flat `[rows, dims]` buffer into one Float32Array per row. */
export function sliceRows(
  flat: Float32Array,
  rows: number,
  dims: number,
): Float32Array[] {
  const out: Float32Array[] = [];
  for (let r = 0; r < rows; r++) {
    out.push(flat.slice(r * dims, (r + 1) * dims));
  }
  return out;
}
