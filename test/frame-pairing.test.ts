import { describe, expect, it } from "vitest";
import { drainPairs } from "../src/capture/frame-pairing.js";

const g = (n: number) => Uint8Array.of(n);

describe("drainPairs", () => {
  it("emits only tuples every stream has, leaving the rest queued", () => {
    const gray = [g(1), g(2), g(3)];
    const pts = [100, 200];
    const jpeg = [g(11)];
    expect(drainPairs(gray, pts, jpeg)).toEqual([{ gray: g(1), ptsMs: 100, jpeg: g(11) }]);
    // The unmatched remainder stays queued for the next arrival on the short
    // stream — dropping it would desynchronize every later frame.
    expect(gray).toEqual([g(2), g(3)]);
    expect(pts).toEqual([200]);
    expect(jpeg).toEqual([]);
  });

  it("drains several complete tuples in one call", () => {
    const gray = [g(1), g(2)];
    const pts = [100, 200];
    const jpeg = [g(11), g(22)];
    expect(drainPairs(gray, pts, jpeg)).toEqual([
      { gray: g(1), ptsMs: 100, jpeg: g(11) },
      { gray: g(2), ptsMs: 200, jpeg: g(22) },
    ]);
    expect(gray).toEqual([]);
  });

  it("omits the jpeg member entirely when images are not stored", () => {
    const gray = [g(1)];
    const pts = [100];
    const out = drainPairs(gray, pts, null);
    expect(out).toEqual([{ gray: g(1), ptsMs: 100 }]);
    expect("jpeg" in out[0]!).toBe(false);
  });

  it("reports ptsMs null when the graph carries no timestamp output", () => {
    // A caller-supplied `ffmpegArgs` override replaces the whole arg list and
    // therefore has no pts pipe. Waiting for one would emit no frames at all.
    const gray = [g(1), g(2)];
    const jpeg = [g(11), g(22)];
    expect(drainPairs(gray, null, jpeg)).toEqual([
      { gray: g(1), ptsMs: null, jpeg: g(11) },
      { gray: g(2), ptsMs: null, jpeg: g(22) },
    ]);
  });

  it("emits nothing when any required stream is empty", () => {
    expect(drainPairs([], [100], [g(1)])).toEqual([]);
    expect(drainPairs([g(1)], [], [g(1)])).toEqual([]);
    expect(drainPairs([g(1)], [100], [])).toEqual([]);
  });
});
