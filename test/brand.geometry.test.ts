import { describe, it, expect } from "vitest";
import {
  BOB_AMPLITUDE,
  bezierToPath,
  bob,
  FRAMES,
  ghostBodyBezier,
  ghostBodyPath,
  hemShape,
  KEYFRAMES,
  mouthBezier,
  shadowAt,
} from "../scripts/brand/geometry.js";

describe("ghost geometry", () => {
  it("emits a closed 7-vertex bezier with matching tangent arrays", () => {
    const s = ghostBodyBezier(0);
    expect(s.v).toHaveLength(7);
    expect(s.i).toHaveLength(7);
    expect(s.o).toHaveLength(7);
  });

  it("keeps the vertex count constant across every keyframe phase", () => {
    // Lottie path morphing requires identical vertex counts, or the shape tweens
    // into garbage. This is the invariant that protects that.
    const counts = KEYFRAMES.map((t) => ghostBodyBezier(t).v.length);
    expect(new Set(counts).size).toBe(1);
  });

  it("moves the hem between keyframes so the animation is not static", () => {
    expect(ghostBodyPath(0)).not.toEqual(ghostBodyPath(0.25));
  });

  it("loops seamlessly: phase 1 reproduces phase 0", () => {
    expect(ghostBodyPath(1)).toEqual(ghostBodyPath(0));
  });

  it("holds the body outline fixed while the hem moves", () => {
    // Vertices 1..4 are the sides and dome; only 0, 5, 6 are hem.
    const a = ghostBodyBezier(0);
    const b = ghostBodyBezier(0.5);
    expect(a.v.slice(1, 5)).toEqual(b.v.slice(1, 5));
  });

  it("bobs sinusoidally and returns to rest at the loop point", () => {
    expect(bob(0)).toBe(0);
    expect(bob(0.25)).toBe(-BOB_AMPLITUDE); // risen
    expect(bob(0.75)).toBe(BOB_AMPLITUDE); // sunk
    expect(bob(1)).toBe(bob(0));
  });

  it("tightens and fades the shadow as the ghost rises", () => {
    const high = shadowAt(0.25);
    const low = shadowAt(0.75);
    expect(high.scale).toBeLessThan(low.scale);
    expect(high.opacity).toBeLessThan(low.opacity);
  });

  it("keeps every hem lobe hanging below the hem line", () => {
    for (const t of KEYFRAMES) {
      const { depths, lifts } = hemShape(t);
      for (const d of depths) expect(d).toBeGreaterThan(0);
      for (const l of lifts) expect(l).toBeGreaterThan(0);
    }
  });

  it("renders a path that starts with a move and closes", () => {
    const d = ghostBodyPath(0);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.trimEnd().endsWith("Z")).toBe(true);
    expect(d).not.toMatch(/NaN|Infinity/);
  });

  it("lands keyframes on whole frame numbers", () => {
    for (const t of KEYFRAMES) expect(Number.isInteger(t * FRAMES)).toBe(true);
  });

  it("round-trips a bezier through bezierToPath without NaN", () => {
    expect(bezierToPath(ghostBodyBezier(0.5))).not.toMatch(/NaN/);
  });
});

describe("mouth geometry", () => {
  it("emits an open 2-vertex bezier with matching tangent arrays", () => {
    const s = mouthBezier();
    expect(s.v).toHaveLength(2);
    expect(s.i).toHaveLength(2);
    expect(s.o).toHaveLength(2);
  });

  it("renders as an open path: starts with M, contains a C, does not close", () => {
    const d = bezierToPath(mouthBezier(), false);
    expect(d.startsWith("M ")).toBe(true);
    expect(d).toContain("C ");
    expect(d.trimEnd().endsWith("Z")).toBe(false);
    expect(d).not.toMatch(/NaN|Infinity/);
  });

  it("defaults bezierToPath to closed, leaving the body path unaffected", () => {
    expect(bezierToPath(ghostBodyBezier(0))).toEqual(ghostBodyPath(0));
    expect(bezierToPath(ghostBodyBezier(0)).trimEnd().endsWith("Z")).toBe(true);
  });
});
