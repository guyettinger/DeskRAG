import { describe, expect, it } from "vitest";
import { fitPath, projectPath, VELOCITY_SAMPLES, type PathSample } from "../src/trace/paths.js";

/** A quarter-arc bulging above the chord from (0,0) to (100,0). */
function arcSamples(n: number): PathSample[] {
  const out: PathSample[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push({ x: 100 * t, y: -40 * Math.sin(Math.PI * t), tMono: 1000 + t * 800 });
  }
  return out;
}

const maxDeviation = (a: readonly PathSample[], b: readonly { x: number; y: number }[]): number => {
  let worst = 0;
  for (const p of a) {
    let best = Infinity;
    for (const q of b) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    worst = Math.max(worst, best);
  }
  return worst;
};

describe("fitPath", () => {
  it("normalizes so the curve runs (0,0) -> (1,0) regardless of screen placement", () => {
    const near = fitPath(arcSamples(24));
    const far = fitPath(arcSamples(24).map((s) => ({ ...s, x: s.x + 900, y: s.y + 500 })));
    expect(near.curve.at(-1)!.end.x).toBeCloseTo(1, 6);
    expect(near.curve.at(-1)!.end.y).toBeCloseTo(0, 6);
    // Same shape in a different place must produce the same stored curve.
    expect(far.curve[0]!.c1.x).toBeCloseTo(near.curve[0]!.c1.x, 6);
    expect(far.curve[0]!.c1.y).toBeCloseTo(near.curve[0]!.c1.y, 6);
  });

  it("is rotation invariant — the same gesture at any angle stores the same curve", () => {
    const flat = fitPath(arcSamples(24));
    const turned = fitPath(
      arcSamples(24).map((s) => ({ ...s, x: -s.y, y: s.x })), // rotate 90 degrees
    );
    expect(turned.curve[0]!.c1.x).toBeCloseTo(flat.curve[0]!.c1.x, 6);
    expect(turned.curve[0]!.c1.y).toBeCloseTo(flat.curve[0]!.c1.y, 6);
  });

  it("records duration from the sample timestamps", () => {
    expect(fitPath(arcSamples(24)).durationMs).toBeCloseTo(800, 6);
  });

  it("emits a monotonic velocity profile from 0 to 1", () => {
    const { velocity } = fitPath(arcSamples(24));
    expect(velocity).toHaveLength(VELOCITY_SAMPLES);
    expect(velocity[0]).toBeCloseTo(0, 6);
    expect(velocity.at(-1)).toBeCloseTo(1, 6);
    for (let i = 1; i < velocity.length; i++) {
      expect(velocity[i]!).toBeGreaterThanOrEqual(velocity[i - 1]! - 1e-9);
    }
  });

  it("reports high confidence for a dense clean arc and low for two samples", () => {
    expect(fitPath(arcSamples(40)).fitConfidence).toBeGreaterThan(0.8);
    const sparse = fitPath([
      { x: 0, y: 0, tMono: 0 },
      { x: 100, y: 0, tMono: 200 },
    ]);
    expect(sparse.fitConfidence).toBeLessThan(0.3);
  });

  it("degrades to a straight zero-confidence path when the endpoints coincide", () => {
    const loop: PathSample[] = [
      { x: 50, y: 50, tMono: 0 },
      { x: 80, y: 20, tMono: 100 },
      { x: 50, y: 50, tMono: 200 },
    ];
    const p = fitPath(loop);
    expect(p.fitConfidence).toBe(0);
    expect(p.curve).toHaveLength(1);
  });

  it("degrades rather than throwing on a single sample", () => {
    const p = fitPath([{ x: 3, y: 4, tMono: 7 }]);
    expect(p.fitConfidence).toBe(0);
    expect(p.durationMs).toBe(0);
  });
});

describe("projectPath", () => {
  it("round-trips: fitting then projecting onto the original endpoints reproduces the polyline", () => {
    const samples = arcSamples(32);
    const path = fitPath(samples);
    const out = projectPath(path, { x: samples[0]!.x, y: samples[0]!.y }, { x: samples.at(-1)!.x, y: samples.at(-1)!.y }, 64);
    expect(out[0]!.x).toBeCloseTo(0, 6);
    expect(out.at(-1)!.x).toBeCloseTo(100, 6);
    expect(maxDeviation(samples, out)).toBeLessThan(2);
  });

  it("retargets: the same curve between new endpoints keeps its curvature sign", () => {
    const path = fitPath(arcSamples(32));
    const out = projectPath(path, { x: 500, y: 500 }, { x: 500, y: 900 }, 32);
    expect(out[0]!.x).toBeCloseTo(500, 6);
    expect(out[0]!.y).toBeCloseTo(500, 6);
    expect(out.at(-1)!.y).toBeCloseTo(900, 6);
    // The arc bulged left of the chord; rotated onto a downward chord it must
    // still bulge to the same side, i.e. every interior point sits off-axis
    // consistently.
    const side = out.slice(1, -1).map((p) => Math.sign(p.x - 500));
    expect(new Set(side).size).toBe(1);
    expect(side[0]).not.toBe(0);
  });

  it("scales with the new chord length", () => {
    const path = fitPath(arcSamples(32));
    const short = projectPath(path, { x: 0, y: 0 }, { x: 50, y: 0 }, 32);
    const long = projectPath(path, { x: 0, y: 0 }, { x: 200, y: 0 }, 32);
    const bulge = (pts: { x: number; y: number }[]) => Math.max(...pts.map((p) => Math.abs(p.y)));
    expect(bulge(long) / bulge(short)).toBeCloseTo(4, 1);
  });

  it("returns the requested number of points, endpoints included", () => {
    const path = fitPath(arcSamples(16));
    expect(projectPath(path, { x: 0, y: 0 }, { x: 10, y: 10 }, 20)).toHaveLength(20);
  });
});
