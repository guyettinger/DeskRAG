import { describe, expect, it } from "vitest";
import type { KeyframeMarkerDTO, SessionTracksDTO } from "../app/src/shared/types.js";
import {
  densityPath,
  labelFits,
  readoutAt,
  spanRects,
  thumbPlacement,
} from "../app/src/renderer/src/screens/track-view.js";

describe("labelFits", () => {
  it("refuses a label the bar cannot hold untruncated", () => {
    // 1s of a 100s axis on a 1000px rail is 10px — nothing fits.
    expect(labelFits(1, 100, 1000, "Calculator")).toBe(false);
  });

  it("allows a short label in a wide bar", () => {
    expect(labelFits(50, 100, 1000, "Calculator")).toBe(true);
  });

  it("depends on DURATION, never position — the rule cannot flip under translation", () => {
    // spanRects moves; labelFits must not. Same duration, same answer.
    expect(labelFits(50, 100, 1000, "Calculator")).toBe(labelFits(50, 100, 1000, "Calculator"));
    expect(labelFits(5, 100, 1000, "Calculator")).toBe(false);
  });

  it("is false before the axis has been measured, and for empty text", () => {
    expect(labelFits(50, 100, 0, "Calculator")).toBe(false);
    expect(labelFits(50, 100, 1000, "")).toBe(false);
  });
});

describe("spanRects", () => {
  it("gives the bar the signal's TRUE extent as percentages", () => {
    const r = spanRects(2, 4, 10, 1000, 12);
    expect(r.leftPct).toBeCloseTo(20);
    expect(r.widthPct).toBeCloseTo(20);
  });

  it("pads a hair-thin bar's HIT rect without widening the bar", () => {
    const r = spanRects(5, 5.01, 10, 1000, 12);
    expect(r.widthPct).toBeCloseTo(0.1); // the bar stays honest: 1px
    expect(r.hit!.widthPx).toBe(12); // the target does not
    // Centred on the bar: 500.5px centre, 12px wide.
    expect(r.hit!.leftPx).toBeCloseTo(494.5);
  });

  it("clamps the hit rect INTO the axis at both ends", () => {
    // A span at t=0 would otherwise put its target over the title gutter,
    // which is the transport's column too.
    expect(spanRects(0, 0, 10, 1000, 12).hit!.leftPx).toBe(0);
    expect(spanRects(10, 10, 10, 1000, 12).hit!.leftPx).toBe(988);
  });

  it("moves the hit rect by exactly the shift under a uniform translation", () => {
    const a = spanRects(2, 4, 10, 1000, 12);
    const b = spanRects(3, 5, 10, 1000, 12);
    expect(b.hit!.leftPx - a.hit!.leftPx).toBeCloseTo(100);
    expect(b.hit!.widthPx).toBe(a.hit!.widthPx);
  });

  it("returns a null hit rect before the axis is measured", () => {
    // The bar still renders from its percentages, so nothing flashes empty on
    // the frame before the ResizeObserver first fires.
    const r = spanRects(2, 4, 10, 0, 12);
    expect(r.leftPct).toBeCloseTo(20);
    expect(r.hit).toBeNull();
  });
});

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

  it("draws a VISIBLE baseline for zero, not one clipped on the bottom edge", () => {
    // A recorded-silent lane must not look identical to an absent one, so a
    // zero is inset rather than sitting exactly on `height`.
    const d = densityPath([0, 0], 24);
    const ys = [...d.matchAll(/,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys.every((y) => y < 24)).toBe(true);
    expect(ys.every((y) => y > 22)).toBe(true);
  });

  it("still puts a full-scale value at the top of the box", () => {
    const ys = [...densityPath([1], 24).matchAll(/,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys[0]).toBeCloseTo(1, 5);
  });
});

describe("readoutAt", () => {
  const marker = (frameId: string): KeyframeMarkerDTO => ({
    frameId,
    thumbUrl: null,
    tMono: 3000,
    offsetSec: 3,
    segmentCaption: "a window of code",
    segmentDigest: null,
  });

  const tracks: SessionTracksDTO = {
    sessionId: "s1",
    totalSec: 10,
    anchoredToVideo: true,
    lanes: [
      {
        id: "apps",
        title: "apps",
        shape: "span",
        showLabels: false,
        spans: [{ startSec: 0, endSec: 5, label: "TextEdit", tone: "app-1" }],
        emptyReason: null,
        warning: null,
      },
      {
        id: "typing",
        title: "typing",
        shape: "density",
        showLabels: false,
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
        showLabels: false,
        density: { values: new Array(10).fill(null), peak: 0, unit: "amplitude" },
        emptyReason: null,
        warning: null,
      },
      {
        id: "markers",
        title: "markers",
        shape: "mark",
        showLabels: false,
        marks: [{ atSec: 3, label: "bookmark", tone: "ok" }],
        emptyReason: null,
        warning: null,
      },
      {
        id: "keyframes",
        title: "keyframes",
        shape: "thumb",
        showLabels: false,
        thumbs: [{ atSec: 3, marker: marker("f1"), regionCount: 7 }],
        emptyReason: null,
        warning: null,
      },
    ],
  };

  const opts = { tolSec: 0.5, label: (m: KeyframeMarkerDTO) => `L:${m.frameId}` };
  const text = (r: ReturnType<typeof readoutAt>, laneId: string): string | undefined =>
    r.rows.find((row) => row.laneId === laneId)?.text;

  it("names the span in force and the density value in real units", () => {
    const r = readoutAt(tracks, 2.5, opts);
    expect(r.timecode).toBe("0:02");
    expect(text(r, "apps")).toBe("TextEdit");
    expect(text(r, "typing")).toBe("4 keys/s");
  });

  it("carries each lane's own title, so the card's left column matches the gutter", () => {
    const r = readoutAt(tracks, 2.5, opts);
    expect(r.rows.find((row) => row.laneId === "audio-mic")).toBeUndefined();
    expect(r.rows.map((row) => row.title)).toContain("apps");
  });

  it("omits a lane with no coverage rather than reporting it as zero", () => {
    expect(text(readoutAt(tracks, 2.5, opts), "audio-mic")).toBeUndefined();
  });

  it("drops a span lane once its last span has ended", () => {
    const r = readoutAt(tracks, 7, opts);
    expect(r.timecode).toBe("0:07");
    expect(text(r, "apps")).toBeUndefined();
    expect(text(r, "typing")).toBe("0 keys/s");
  });

  it("reports a mark only while the cursor is within the pixel tolerance", () => {
    expect(text(readoutAt(tracks, 3.2, opts), "markers")).toBe("bookmark");
    expect(text(readoutAt(tracks, 4.5, opts), "markers")).toBeUndefined();
  });

  it("names a keyframe through the INJECTED label, never its own rule", () => {
    expect(text(readoutAt(tracks, 3, opts), "keyframes")).toBe("L:f1 · 7 regions");
  });
});
