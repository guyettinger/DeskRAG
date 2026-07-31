import { describe, expect, it } from "vitest";
import { resolveAnchor } from "../src/replay/resolve.js";
import type { AxDescriptor, Locate } from "../src/replay/types.js";
import type { Anchor } from "../src/trace/types.js";

const recorded = { x: 700, y: 20, w: 80, h: 32 };

const anchor: Anchor = {
  ax: { role: "Button", label: "Send", identifier: "send-btn", path: "Window[0]>Button[1]" },
  visual: { regionId: "r1", framePhash: "beef", bbox: recorded },
  point: { x: 740, y: 36, displayId: "5" },
};

/** A locate that answers only for the descriptor fields listed in `answers`. */
const locateFor = (
  answers: { key: keyof AxDescriptor; bounds: { x: number; y: number; w: number; h: number } }[],
): Locate => {
  let handle = 0;
  return async (d) => {
    for (const a of answers) {
      if (d[a.key] !== undefined) return { handle: handle++, bounds: a.bounds };
    }
    return null;
  };
};

describe("resolveAnchor", () => {
  it("prefers the identifier rung when it resolves", async () => {
    const r = await resolveAnchor(anchor, locateFor([{ key: "identifier", bounds: recorded }]));
    expect(r.layer).toBe("identifier");
    expect(r.confidence).toBe(1);
    expect(r.point).toEqual({ x: 740, y: 36 });
    expect(r.attempts).toEqual([]);
  });

  it("falls to the next rung when the identifier is gone, recording the rejection", async () => {
    const r = await resolveAnchor(anchor, locateFor([{ key: "label", bounds: recorded }]));
    expect(r.layer).toBe("label");
    expect(r.attempts[0]).toMatchObject({ layer: "identifier" });
    expect(r.attempts[0]!.rejected).toMatch(/not found/i);
  });

  /**
   * The rungs are ordered by how much each is trusted for THIS anchor, and a
   * path's trust depends on its depth. AppKit paths (mean depth 4) are steadier
   * than a content-dependent label; Chromium paths (mean 11.4, max 17) are an
   * ordinal chain long enough that a sibling inserted anywhere breaks it. A
   * fixed order cannot serve both, which is why the order is computed.
   */
  it("tries a SHALLOW path before the label — the native case", async () => {
    // anchor.ax.path is "Window[0]>Button[1]": depth 2.
    const r = await resolveAnchor(anchor, locateFor([{ key: "label", bounds: recorded }]));
    expect(r.attempts.map((a) => a.layer)).toEqual(["identifier", "path"]);
    expect(r.layer).toBe("label");
  });

  it("tries the label before a DEEP path — the web case", async () => {
    const deep: Anchor = {
      ...anchor,
      ax: { ...anchor.ax!, path: Array.from({ length: 13 }, (_, i) => `Group[${i}]`).join(">") },
    };
    const r = await resolveAnchor(deep, locateFor([{ key: "path", bounds: recorded }]));
    expect(r.attempts.map((a) => a.layer)).toEqual(["identifier", "label"]);
    expect(r.layer).toBe("path");
  });

  it("rejects a rung that resolves to a wildly different box and falls through", async () => {
    // The identifier resolves, but to something far away and much larger.
    const locate: Locate = async (d) =>
      d.identifier !== undefined
        ? { handle: 1, bounds: { x: 0, y: 900, w: 1200, h: 400 } }
        : d.label !== undefined
          ? { handle: 2, bounds: recorded }
          : null;
    const r = await resolveAnchor(anchor, locate);
    expect(r.layer).toBe("label");
    expect(r.attempts[0]).toMatchObject({ layer: "identifier" });
    expect(r.attempts[0]!.rejected).toMatch(/confidence/i);
  });

  it("re-centres the point on the resolved box when the element has moved", async () => {
    // Same size, shifted 20px right. The shift is deliberately smaller than the
    // box diagonal (~86px): move it much further and proximity floors at 0,
    // which is the rejection case tested above, not the re-projection case.
    const moved = { x: 720, y: 20, w: 80, h: 32 };
    const r = await resolveAnchor(anchor, locateFor([{ key: "identifier", bounds: moved }]));
    // The recorded point sat at the box's centre; keep that relative offset.
    expect(r.point).toEqual({ x: 760, y: 36 });
    expect(r.confidence).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("lands on point with the point ceiling when no AX rung resolves", async () => {
    const r = await resolveAnchor(anchor, async () => null);
    expect(r.layer).toBe("point");
    expect(r.confidence).toBe(0.3);
    expect(r.point).toEqual({ x: 740, y: 36 });
    // Shallow path (depth 2) outranks the label, so it is tried first.
    expect(r.attempts.map((a) => a.layer)).toEqual(["identifier", "path", "label", "visual"]);
  });

  it("skips rungs the anchor never recorded, without inventing them", async () => {
    const pointOnly: Anchor = { point: { x: 10, y: 20, displayId: "5" } };
    const r = await resolveAnchor(pointOnly, async () => {
      throw new Error("locate must not be called for a point-only anchor");
    });
    expect(r.layer).toBe("point");
    expect(r.attempts).toEqual([]);
  });

  it("never derives an AX descriptor from the point", async () => {
    const pointOnly: Anchor = { point: { x: 10, y: 20, displayId: "5" } };
    const seen: AxDescriptor[] = [];
    const r = await resolveAnchor(pointOnly, async (d) => {
      seen.push(d);
      return { handle: 0, bounds: recorded };
    });
    expect(seen).toEqual([]);
    expect(r.layer).toBe("point");
  });
});

/**
 * A window that MOVED must not veto a correctly-identified element.
 *
 * Measured live: TextEdit's text view resolved by identifier to bounds of
 * exactly the recorded size (586x382), 2310px to the right because the window
 * had moved. Compared globally, agreement was 0.0000 and the rung was rejected
 * — sending the ladder down to `point`, which clicks where the element is NOT.
 * The fallback was strictly worse than the rung it rejected.
 *
 * `Anchor.point.windowRelative` is recorded for exactly this reason. The
 * recorded window origin is derivable as `point - windowRelative`, so both
 * sides can be compared in window space, where the same measurement gives
 * 1.0000.
 */
describe("window-relative agreement", () => {
  const recordedBox = { x: 71, y: 140, w: 586, h: 382 };
  const moved: Anchor = {
    ax: { role: "TextArea", identifier: "First Text View", path: "Window[0]>TextArea[0]" },
    visual: { regionId: "r", framePhash: "f", bbox: recordedBox },
    // Window origin was (71, 40): point - windowRelative.
    point: { x: 523, y: 295, displayId: "65", windowRelative: { x: 452, y: 255 } },
  };
  // Same element, same size, window moved right and down. Consistent with the
  // live origin below: the element sits at the SAME window-relative offset
  // (0, 100) it was recorded at, so window-relative agreement must be exactly 1.
  const liveWindowOrigin = { x: 976, y: 57 };
  const liveBounds = { x: 976, y: 157, w: 586, h: 382 };
  const liveLocate: Locate = async () => ({ handle: 1, bounds: liveBounds });

  it("rejects the moved element when comparing globally — the bug", async () => {
    const r = await resolveAnchor(moved, liveLocate);
    expect(r.layer).toBe("point");
    expect(r.attempts[0]!.rejected).toMatch(/confidence/i);
  });

  it("accepts it when the live window origin is known", async () => {
    const r = await resolveAnchor(moved, liveLocate, { windowOrigin: liveWindowOrigin });
    expect(r.layer).toBe("identifier");
    expect(r.confidence).toBeCloseTo(1, 5);
  });

  it("re-projects the click onto the moved element, not the recorded coordinate", async () => {
    const r = await resolveAnchor(moved, liveLocate, { windowOrigin: liveWindowOrigin });
    // Recorded point sat at 77.1%/40.6% inside the recorded box; keep that.
    expect(Math.round(r.point.x)).toBe(1428);
    expect(Math.round(r.point.y)).toBe(312);
  });

  it("still rejects a genuinely different element, even window-relative", async () => {
    const wrong: Locate = async () => ({ handle: 2, bounds: { x: 976, y: 700, w: 40, h: 20 } });
    const r = await resolveAnchor(moved, wrong, { windowOrigin: liveWindowOrigin });
    expect(r.layer).toBe("point");
  });

  it("falls back to global comparison when the anchor has no windowRelative", async () => {
    const noRel: Anchor = { ...moved, point: { x: 523, y: 295, displayId: "65" } };
    const r = await resolveAnchor(noRel, liveLocate, { windowOrigin: liveWindowOrigin });
    expect(r.layer).toBe("point");
  });
});
