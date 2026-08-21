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

/**
 * A MENU IS A WINDOW TO THE OS AND A CHILD TO ACCESSIBILITY.
 *
 * macOS reports an open context menu as the FOCUSED WINDOW, so `focus_change`
 * carries the menu's frame and `buildAnchor` computes `windowRelative` against
 * it. The AX tree nests `Menu` UNDER the app window and contains no `Window`
 * element for it, so the live side offers the app window instead. The two
 * origins then differ by the menu's offset inside the window, agreement
 * collapses to zero, and identifier, label AND path are each vetoed as below
 * the floor — having all three FOUND the element. The ladder drops to `point`,
 * which is the outcome `windowOrigin` exists to prevent.
 *
 * Every number below is measured, from `npm run probe:transfer --why` over a
 * real six-recording corpus: the Calculator window at 230x408, its context menu
 * reported at 86x58, and the same "Copy" item recorded at one and replayed at
 * the other. The AX `Menu` element's frame was byte-identical to the OS menu
 * window in all three recordings, which is what makes the fix possible at all.
 */
describe("resolveAnchor across a menu, whose surface is not a Window", () => {
  // RECORDED: menu at {317,351}, the item at {317,356} — offset {0,5} in it.
  const recordedMenuOrigin = { x: 317, y: 351 };
  const item = { x: 317, y: 356, w: 86, h: 24 };
  const copy: Anchor = {
    ax: {
      role: "MenuItem",
      label: "Copy",
      identifier: "_NS:23",
      path: "Window[0]>Group[0]>ScrollArea[1]>Menu[0]>MenuItem[0]",
    },
    visual: { regionId: "r9", framePhash: "cafe", bbox: item },
    point: {
      x: 330,
      y: 367,
      displayId: "180",
      windowRelative: { x: 330 - recordedMenuOrigin.x, y: 367 - recordedMenuOrigin.y },
    },
  };

  // LIVE: the app window sits at {133,242}; the menu opened at {336,335}, so the
  // item is at {336,340} — the SAME {0,5} inside its own menu.
  const liveAppWindow = { x: 133, y: 242 };
  const liveMenuOrigin = { x: 336, y: 335 };
  const liveItem = { x: 336, y: 340, w: 86, h: 24 };
  const found: Locate = async () => ({ handle: 9, bounds: liveItem });

  it("is vetoed when the live origin is the APP WINDOW — the measured defect", async () => {
    const r = await resolveAnchor(copy, found, { windowOrigin: liveAppWindow });
    expect(r.layer).toBe("point");
    // Found by the rung and thrown away on geometry, which is the whole problem:
    // the fallback clicks where the element is NOT.
    expect(r.attempts[0]!.rejected).toMatch(/confidence/i);
  });

  it("resolves when the hit reports the SURFACE it actually sits in", async () => {
    const withSurface: Locate = async () => ({
      handle: 9,
      bounds: liveItem,
      surfaceOrigin: liveMenuOrigin,
    });
    const r = await resolveAnchor(copy, withSurface, { windowOrigin: liveAppWindow });
    expect(r.layer).toBe("identifier");
    expect(r.confidence).toBeCloseTo(1, 5);
  });

  it("the hit's surface WINS over the caller's window origin", async () => {
    // The caller cannot know which surface a rung will land in — it has not
    // located anything yet — so the hit is the only thing that can be right.
    const withSurface: Locate = async () => ({
      handle: 9,
      bounds: liveItem,
      surfaceOrigin: liveMenuOrigin,
    });
    const r = await resolveAnchor(copy, withSurface, { windowOrigin: { x: -9999, y: -9999 } });
    expect(r.layer).toBe("identifier");
  });

  it("still rejects a genuinely different element inside the right surface", async () => {
    const elsewhere: Locate = async () => ({
      handle: 9,
      bounds: { x: liveMenuOrigin.x + 40, y: liveMenuOrigin.y + 300, w: 12, h: 12 },
      surfaceOrigin: liveMenuOrigin,
    });
    const r = await resolveAnchor(copy, elsewhere, { windowOrigin: liveAppWindow });
    expect(r.layer).toBe("point");
  });
});
