import { describe, expect, it } from "vitest";
import type { SessionTracksDTO } from "../app/src/shared/types.js";
import {
  densityPath,
  readoutAt,
  thumbPlacement,
} from "../app/src/renderer/src/screens/track-view.js";

describe("thumbPlacement", () => {
  it("keeps images that clear their neighbour and degrades the rest to ticks", () => {
    // Thumbs are 10% of the rail wide. 0.0 and 0.5 clear each other; 0.52 does not.
    expect(thumbPlacement([0, 5, 5.2], 10, 0.1)).toEqual([true, true, false]);
  });

  it("is UNCHANGED by a uniform time shift — a layout that flips under translation twitches", () => {
    const a = thumbPlacement([1, 2, 5], 10, 0.1);
    const b = thumbPlacement([2, 3, 6], 10, 0.1);
    expect(a).toEqual(b);
  });

  it("always shows the first thumb", () => {
    expect(thumbPlacement([3], 10, 0.9)[0]).toBe(true);
  });
});

describe("densityPath", () => {
  it("breaks the path at a null so a coverage gap is literally a gap", () => {
    const d = densityPath([1, null, 1], 10);
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it("returns an empty path when there is nothing covered at all", () => {
    expect(densityPath([null, null], 10)).toBe("");
  });
});

describe("readoutAt", () => {
  const tracks: SessionTracksDTO = {
    sessionId: "s1",
    totalSec: 10,
    anchoredToVideo: true,
    lanes: [
      {
        id: "apps",
        title: "apps",
        shape: "span",
        spans: [{ startSec: 0, endSec: 5, label: "TextEdit", tone: "app-1" }],
        emptyReason: null,
        warning: null,
      },
      {
        id: "typing",
        title: "typing",
        shape: "density",
        density: {
          values: new Array(10).fill(0).map((_, i) => (i === 2 ? 1 : 0)),
          peak: 4,
          unit: "keys/s",
        },
        emptyReason: null,
        warning: null,
      },
      {
        id: "audio-mic",
        title: "audio (mic)",
        shape: "density",
        density: { values: new Array(10).fill(null), peak: 0, unit: "amplitude" },
        emptyReason: null,
        warning: null,
      },
    ],
  };

  it("names the span in force and the density value in real units", () => {
    expect(readoutAt(tracks, 2.5)).toEqual(["0:02", "TextEdit", "4 keys/s"]);
  });

  it("omits a lane with no coverage rather than reporting it as zero", () => {
    expect(readoutAt(tracks, 2.5).some((p) => p.includes("amplitude"))).toBe(false);
  });

  it("drops a span lane once its last span has ended", () => {
    expect(readoutAt(tracks, 7)).toEqual(["0:07", "0 keys/s"]);
  });
});
