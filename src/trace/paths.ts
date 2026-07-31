/**
 * Motion fitting and projection.
 *
 * A recorded polyline is normalized into a frame where the first sample sits at
 * (0,0) and the last at (1,0) — translate, rotate, scale — and a chain of cubic
 * Beziers is least-squares fitted there. Because the stored curve carries no
 * absolute coordinates, replaying it is the inverse transform built from
 * whatever endpoints replay actually resolved. Retargeting therefore needs no
 * separate synthesis path: `projectPath` onto the original endpoints reproduces
 * the gesture, and onto new endpoints generalizes it.
 *
 * Pure: no store, no clock, no I/O.
 */

import type { CubicBezier, Path, Vec2 } from "./types.js";

export interface PathSample {
  x: number;
  y: number;
  tMono: number;
}

/** Points in the stored velocity profile. */
export const VELOCITY_SAMPLES = 16;

/** Chord shorter than this (px) means the gesture returned to its origin. */
const DEGENERATE_CHORD_PX = 1e-6;

/**
 * Max residual, in unit space, before a span is split and refitted. 0.01 is 1px
 * of drift per 100px of chord. One cubic cannot hold a real arc to that — a
 * half-sine misses by ~3% — and drift matters on a drag, where the path IS the
 * payload (a lasso, a slider, a brush stroke).
 */
const FIT_TOLERANCE = 0.01;

/** Recursion cap: at most 2^4 = 16 segments. */
const MAX_FIT_DEPTH = 4;

const STRAIGHT: CubicBezier = {
  c1: { x: 1 / 3, y: 0 },
  c2: { x: 2 / 3, y: 0 },
  end: { x: 1, y: 0 },
};

function degenerate(durationMs: number): Path {
  return {
    curve: [STRAIGHT],
    durationMs,
    velocity: Array.from({ length: VELOCITY_SAMPLES }, (_, i) => i / (VELOCITY_SAMPLES - 1)),
    fitConfidence: 0,
  };
}

/**
 * Fit a normalized cubic chain to a recorded polyline. The chain's endpoints are
 * pinned to (0,0) and (1,0), which is what makes the result independent of where
 * on screen the gesture happened and at what angle.
 */
export function fitPath(samples: readonly PathSample[]): Path {
  if (samples.length < 2) return degenerate(0);

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const durationMs = last.tMono - first.tMono;

  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const chord = Math.hypot(dx, dy);
  // A gesture that ends where it began has no chord to normalize against. Its
  // shape is unrecoverable in an endpoint-relative frame, so say so rather than
  // inventing a basis.
  if (chord < DEGENERATE_CHORD_PX) return degenerate(durationMs);

  // Inverse of the placement transform: translate to origin, rotate the chord
  // onto +x, scale to unit length.
  const cos = dx / chord;
  const sin = dy / chord;
  const unit = samples.map((s) => {
    const ox = s.x - first.x;
    const oy = s.y - first.y;
    return {
      x: (ox * cos + oy * sin) / chord,
      y: (-ox * sin + oy * cos) / chord,
    };
  });

  // Chord-length parameterization + the cumulative arc length the velocity
  // profile is read from.
  const cumulative: number[] = [0];
  for (let i = 1; i < unit.length; i++) {
    const a = unit[i - 1]!;
    const b = unit[i]!;
    cumulative.push(cumulative[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cumulative[cumulative.length - 1]!;
  const params = total > 0 ? cumulative.map((c) => c / total) : unit.map((_, i) => i / (unit.length - 1));

  const curve = fitChain(unit, params, { x: 0, y: 0 }, { x: 1, y: 0 }, MAX_FIT_DEPTH);

  // Residual of the fitted chain, in unit space, to score confidence.
  let sq = 0;
  for (let i = 1; i < unit.length - 1; i++) {
    const p = evalChain(curve, params[i]!);
    sq += (p.x - unit[i]!.x) ** 2 + (p.y - unit[i]!.y) ** 2;
  }
  const interior = Math.max(1, unit.length - 2);
  const rms = Math.sqrt(sq / interior);
  const sampleFactor = Math.min(1, (unit.length - 1) / 8);
  const fitFactor = 1 / (1 + rms * 10);
  const fitConfidence = Number((sampleFactor * fitFactor).toFixed(6));

  return { curve, durationMs, velocity: velocityProfile(samples, params), fitConfidence };
}

/**
 * Least-squares cubic through `pts` with both endpoints pinned, then split-and-
 * refit at the index midpoint until the residual is under tolerance or the depth
 * cap is hit. Splitting is why `Path.curve` is a chain rather than one segment: a
 * single cubic cannot hold a real arc (a half-sine misses by ~3% of its chord).
 */
function fitChain(
  pts: readonly Vec2[],
  params: readonly number[],
  p0: Vec2,
  p3: Vec2,
  depth: number,
): CubicBezier[] {
  const seg = fitSingle(pts, params, p0, p3);

  let worst = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = evalSegment(p0, seg, params[i]!);
    worst = Math.max(worst, Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y));
  }

  // Below tolerance, out of depth, or too few interior points to split usefully.
  if (worst <= FIT_TOLERANCE || depth <= 0 || pts.length < 4) return [seg];

  // Split at the INDEX midpoint. Two alternatives were tried and both make the
  // fit non-deterministic for the same gesture recorded in a different screen
  // position, because translating the input perturbs the unit-space coordinates
  // in their last bits through `x - first.x`:
  //   - the worst-fitting sample (Schneider's choice, for convergence speed):
  //     residuals at neighbouring samples sit within that noise of each other;
  //   - the arc-length midpoint: on a symmetric gesture the two samples either
  //     side of it are EXACTLY equidistant, so the noise alone decides.
  // The index midpoint depends only on the sample count, which translation
  // cannot change. Convergence is slower than splitting at peak error; the depth
  // cap and the tolerance re-check still bound the result.
  const splitIdx = pts.length >> 1;
  const split = pts[splitIdx]!;
  const renormalize = (slice: readonly number[]): number[] => {
    const lo = slice[0]!;
    const span = slice[slice.length - 1]! - lo;
    return span > 0 ? slice.map((t) => (t - lo) / span) : slice.map((_, i) => i / (slice.length - 1));
  };

  const leftPts = pts.slice(0, splitIdx + 1);
  const rightPts = pts.slice(splitIdx);
  return [
    ...fitChain(leftPts, renormalize(params.slice(0, splitIdx + 1)), p0, split, depth - 1),
    ...fitChain(rightPts, renormalize(params.slice(splitIdx)), split, p3, depth - 1),
  ];
}

/**
 * One cubic with both endpoints pinned, so only the two interior control points
 * are unknown. With Bernstein weights `b1 = 3t(1-t)^2`, `b2 = 3t^2(1-t)`,
 * minimizing the squared residual gives a 2x2 normal-equation system, solved per
 * component.
 */
function fitSingle(
  pts: readonly Vec2[],
  params: readonly number[],
  p0: Vec2,
  p3: Vec2,
): CubicBezier {
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1x = 0;
  let b1y = 0;
  let b2x = 0;
  let b2y = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const t = params[i]!;
    const mt = 1 - t;
    const w0 = mt * mt * mt;
    const w1 = 3 * t * mt * mt;
    const w2 = 3 * t * t * mt;
    const w3 = t * t * t;
    // Residual after removing the pinned endpoint contributions.
    const rx = pts[i]!.x - (w0 * p0.x + w3 * p3.x);
    const ry = pts[i]!.y - (w0 * p0.y + w3 * p3.y);
    a11 += w1 * w1;
    a12 += w1 * w2;
    a22 += w2 * w2;
    b1x += w1 * rx;
    b1y += w1 * ry;
    b2x += w2 * rx;
    b2y += w2 * ry;
  }

  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-12) {
    // Underdetermined (too few interior points, or collinear): the straight
    // segment between the pinned endpoints.
    return {
      c1: { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 },
      c2: { x: p0.x + (2 * (p3.x - p0.x)) / 3, y: p0.y + (2 * (p3.y - p0.y)) / 3 },
      end: { x: p3.x, y: p3.y },
    };
  }
  return {
    c1: { x: (a22 * b1x - a12 * b2x) / det, y: (a22 * b1y - a12 * b2y) / det },
    c2: { x: (a11 * b2x - a12 * b1x) / det, y: (a11 * b2y - a12 * b1y) / det },
    end: { x: p3.x, y: p3.y },
  };
}

/** Progress along the path at each of VELOCITY_SAMPLES uniform time steps. */
function velocityProfile(samples: readonly PathSample[], params: readonly number[]): number[] {
  const first = samples[0]!;
  const span = samples[samples.length - 1]!.tMono - first.tMono;
  const out: number[] = [];
  for (let k = 0; k < VELOCITY_SAMPLES; k++) {
    const target = first.tMono + (span * k) / (VELOCITY_SAMPLES - 1);
    // Linear interpolation of the parameter against elapsed time.
    let i = 1;
    while (i < samples.length - 1 && samples[i]!.tMono < target) i++;
    const prev = samples[i - 1]!;
    const next = samples[i]!;
    const dt = next.tMono - prev.tMono;
    const f = dt > 0 ? (target - prev.tMono) / dt : 0;
    const v = params[i - 1]! + f * (params[i]! - params[i - 1]!);
    out.push(Math.min(1, Math.max(0, Number(v.toFixed(6)))));
  }
  out[0] = 0;
  out[out.length - 1] = 1;
  return out;
}

function evalSegment(start: Vec2, c: CubicBezier, t: number): Vec2 {
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * t * mt * mt;
  const w2 = 3 * t * t * mt;
  const w3 = t * t * t;
  return {
    x: w0 * start.x + w1 * c.c1.x + w2 * c.c2.x + w3 * c.end.x,
    y: w0 * start.y + w1 * c.c1.y + w2 * c.c2.y + w3 * c.end.y,
  };
}

/**
 * Evaluate the segment chain at overall progress `t`. Segment spans are
 * proportional to each segment's chord, derived here rather than stored: a
 * cached span table on `Path` would be a second source of truth that could
 * disagree with the control points after any edit.
 */
function evalChain(curve: readonly CubicBezier[], t: number): Vec2 {
  if (curve.length === 0) return { x: t, y: 0 };

  const starts: Vec2[] = [{ x: 0, y: 0 }];
  for (let i = 0; i < curve.length - 1; i++) starts.push(curve[i]!.end);
  const lengths = curve.map((c, i) => Math.hypot(c.end.x - starts[i]!.x, c.end.y - starts[i]!.y));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total <= 0) return curve[curve.length - 1]!.end;

  const target = Math.min(1, Math.max(0, t)) * total;
  let acc = 0;
  for (let i = 0; i < curve.length; i++) {
    const len = lengths[i]!;
    if (acc + len >= target || i === curve.length - 1) {
      const local = len > 0 ? (target - acc) / len : 0;
      return evalSegment(starts[i]!, curve[i]!, Math.min(1, Math.max(0, local)));
    }
    acc += len;
  }
  return curve[curve.length - 1]!.end;
}

/**
 * Replay a stored curve between two endpoints, following its velocity profile.
 * `from`/`to` are the endpoints replay actually resolved — pass the recorded
 * ones to reproduce the gesture, or new ones to retarget it.
 */
export function projectPath(path: Path, from: Vec2, to: Vec2, steps = 32): Vec2[] {
  const n = Math.max(2, steps);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chord = Math.hypot(dx, dy);
  const cos = chord > 0 ? dx / chord : 1;
  const sin = chord > 0 ? dy / chord : 0;
  const curve = path.curve.length > 0 ? path.curve : [STRAIGHT];

  const out: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const timeFraction = k / (n - 1);
    const t = sampleVelocity(path.velocity, timeFraction);
    const u = evalChain(curve, t);
    // Forward placement transform: scale by the new chord, rotate onto it,
    // translate to the new origin.
    const sx = u.x * chord;
    const sy = u.y * chord;
    out.push({ x: from.x + sx * cos - sy * sin, y: from.y + sx * sin + sy * cos });
  }
  return out;
}

function sampleVelocity(velocity: readonly number[], fraction: number): number {
  if (velocity.length === 0) return fraction;
  const pos = fraction * (velocity.length - 1);
  const i = Math.min(velocity.length - 2, Math.floor(pos));
  const f = pos - i;
  return velocity[i]! + f * (velocity[i + 1]! - velocity[i]!);
}
