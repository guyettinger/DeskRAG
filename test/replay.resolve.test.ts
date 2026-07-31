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

  it("falls to path when the identifier is gone, recording the rejection", async () => {
    const r = await resolveAnchor(anchor, locateFor([{ key: "path", bounds: recorded }]));
    expect(r.layer).toBe("path");
    expect(r.attempts.map((a) => a.layer)).toEqual(["identifier"]);
    expect(r.attempts[0]!.rejected).toMatch(/not found/i);
  });

  it("falls to label when identifier and path are both gone", async () => {
    const r = await resolveAnchor(anchor, locateFor([{ key: "label", bounds: recorded }]));
    expect(r.layer).toBe("label");
    expect(r.attempts.map((a) => a.layer)).toEqual(["identifier", "path"]);
  });

  it("rejects a rung that resolves to a wildly different box and falls through", async () => {
    // The identifier resolves, but to something far away and much larger.
    const locate: Locate = async (d) =>
      d.identifier !== undefined
        ? { handle: 1, bounds: { x: 0, y: 900, w: 1200, h: 400 } }
        : d.path !== undefined
          ? { handle: 2, bounds: recorded }
          : null;
    const r = await resolveAnchor(anchor, locate);
    expect(r.layer).toBe("path");
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
