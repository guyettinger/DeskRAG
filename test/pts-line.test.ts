import { describe, expect, it } from "vitest";
import { firstPtsTimeMs } from "../src/capture/pts-line.js";

describe("firstPtsTimeMs", () => {
  it("reads pts_time as device milliseconds", () => {
    // The real shape of an `ametadata=mode=print` frame header, followed by the
    // key the producer adds so the frame prints at all.
    const text = "frame:0    pts:167014825542 pts_time:3483322.542625\ndeskrag=1\n";
    expect(firstPtsTimeMs(text)).toBeCloseTo(3483322542.625, 3);
  });

  it("takes the FIRST frame when several have arrived in one chunk", () => {
    const text =
      "frame:0    pts:0       pts_time:100.5\ndeskrag=1\n" +
      "frame:1    pts:1024    pts_time:100.523\ndeskrag=1\n";
    expect(firstPtsTimeMs(text)).toBeCloseTo(100500, 3);
  });

  it("returns null until a complete pts_time has arrived", () => {
    // The producer accumulates and re-scans, so a chunk boundary mid-number
    // simply means "not yet" rather than a truncated, plausible-looking value.
    expect(firstPtsTimeMs("frame:0    pts:0       pts_ti")).toBeNull();
    expect(firstPtsTimeMs("")).toBeNull();
    expect(firstPtsTimeMs("pts_time:notanumber")).toBeNull();
  });
});
