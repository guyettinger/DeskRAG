import { describe, expect, it } from "vitest";
import { SampleClock } from "../src/capture/sample-clock.js";

describe("SampleClock", () => {
  it("anchors to the video blob's origin so a frame lands where the video shows it", () => {
    const c = new SampleClock(1800);
    // Media time IS the pts, so (tMono - videoTMonoStart) / 1000 is the exact
    // seek offset the Library already computes.
    expect(c.tMonoFor(0, 99_999)).toBe(1800);
    expect(c.tMonoFor(20_109, 99_999)).toBe(21_909);
  });

  it("ignores arrival time entirely when an origin is known", () => {
    const c = new SampleClock(1000);
    // Same pts, wildly different arrival times, same answer — that is the whole
    // point: delivery latency stops reaching the timestamp.
    expect(c.tMonoFor(5000, 6000)).toBe(6000);
    expect(c.tMonoFor(5000, 60_000)).toBe(6000);
  });

  it("seeds the origin from the first sample when there is no video", () => {
    const c = new SampleClock();
    expect(c.tMonoFor(500, 3000)).toBe(3000); // origin = 3000 - 500 = 2500
    expect(c.tMonoFor(1500, 9999)).toBe(4000); // same origin, spacing exact
  });

  it("honours a zero origin instead of re-seeding from arrival", () => {
    // A session whose screen producer starts at t_mono 0 is legitimate, and `||`
    // rather than `??` here would silently swap it for an arrival-derived one.
    const c = new SampleClock(0);
    expect(c.tMonoFor(250, 7777)).toBe(250);
  });
});
