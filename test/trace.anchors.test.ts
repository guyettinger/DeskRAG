import { describe, expect, it } from "vitest";
import { anchorKey, axPathOf, buildAnchor, hitTest } from "../src/trace/anchors.js";
import type { UIElement } from "../src/embed/types.js";

// A small window: root -> group -> two buttons, with explicit parent links (a
// current sidecar build always emits them).
const tree: UIElement[] = [
  { role: "AXWindow", label: "New Message", x: 0, y: 0, w: 800, h: 600 },
  { role: "AXGroup", x: 0, y: 0, w: 800, h: 100, parent: 0 },
  { role: "AXButton", label: "Send", x: 700, y: 20, w: 80, h: 32, parent: 1 },
  { role: "AXButton", label: "Cancel", x: 600, y: 20, w: 80, h: 32, parent: 1 },
];

describe("axPathOf", () => {
  it("builds an ancestor chain with a per-role sibling ordinal", () => {
    expect(axPathOf(tree, 2)).toBe("AXWindow[0]>AXGroup[0]>AXButton[0]");
    expect(axPathOf(tree, 3)).toBe("AXWindow[0]>AXGroup[0]>AXButton[1]");
  });

  it("returns just the role for a root", () => {
    expect(axPathOf(tree, 0)).toBe("AXWindow[0]");
  });

  it("nests by containment when the capture predates parent back-references", () => {
    const flat = tree.map(({ parent: _parent, ...rest }) => rest);
    expect(axPathOf(flat, 2)).toBe("AXWindow[0]>AXGroup[0]>AXButton[0]");
  });
});

describe("hitTest", () => {
  it("returns the deepest element containing the point", () => {
    expect(hitTest(tree, { x: 720, y: 30 })).toBe(2);
  });

  it("prefers the smaller box when two overlap at equal depth", () => {
    const overlap: UIElement[] = [
      { role: "AXGroup", x: 0, y: 0, w: 100, h: 100 },
      { role: "AXButton", label: "Small", x: 10, y: 10, w: 20, h: 20 },
    ];
    expect(hitTest(overlap, { x: 15, y: 15 })).toBe(1);
  });

  it("returns undefined outside every box", () => {
    expect(hitTest(tree, { x: 5000, y: 5000 })).toBeUndefined();
  });

  it("returns undefined for an empty tree — the AX-blind case", () => {
    expect(hitTest([], { x: 1, y: 1 })).toBeUndefined();
  });
});

describe("buildAnchor", () => {
  it("fills all three layers when AX and a region are available", () => {
    const a = buildAnchor({
      point: { x: 720, y: 30 },
      displayId: "D1",
      windowBounds: { x: 500, y: 0, w: 800, h: 600 },
      ax: tree,
      framePhash: "0f1e2d3c4b5a6978",
      regions: [{ id: "r_big", x: 600, y: 0, w: 200, h: 100 }, { id: "r_send", x: 700, y: 20, w: 80, h: 32 }],
    });
    expect(a.ax).toEqual({ role: "AXButton", label: "Send", path: "AXWindow[0]>AXGroup[0]>AXButton[0]" });
    expect(a.visual?.regionId).toBe("r_send"); // tightest containing region wins
    expect(a.visual?.framePhash).toBe("0f1e2d3c4b5a6978");
    expect(a.point).toEqual({ x: 720, y: 30, displayId: "D1", windowRelative: { x: 220, y: 30 } });
  });

  it("degrades to point-only when AX is absent and no region contains the point", () => {
    const a = buildAnchor({ point: { x: 10, y: 10 }, displayId: "D2" });
    expect(a.ax).toBeUndefined();
    expect(a.visual).toBeUndefined();
    expect(a.point).toEqual({ x: 10, y: 10, displayId: "D2" });
  });

  it("omits windowRelative when window bounds are unknown", () => {
    const a = buildAnchor({ point: { x: 10, y: 10 }, displayId: "D1", ax: tree });
    expect(a.point.windowRelative).toBeUndefined();
  });

  it("omits the visual layer without a frame pHash — never a half-populated layer", () => {
    const a = buildAnchor({
      point: { x: 720, y: 30 },
      displayId: "D1",
      regions: [{ id: "r_send", x: 700, y: 20, w: 80, h: 32 }],
    });
    expect(a.visual).toBeUndefined();
  });
});

describe("anchorKey", () => {
  it("keys on the AX path when present, so small coordinate drift is irrelevant", () => {
    const base = { displayId: "D1", ax: tree };
    const a = buildAnchor({ ...base, point: { x: 720, y: 30 } });
    const b = buildAnchor({ ...base, point: { x: 724, y: 33 } });
    expect(anchorKey(a)).toBe(anchorKey(b));
  });

  it("distinguishes different AX targets", () => {
    const a = buildAnchor({ point: { x: 720, y: 30 }, displayId: "D1", ax: tree });
    const b = buildAnchor({ point: { x: 620, y: 30 }, displayId: "D1", ax: tree });
    expect(anchorKey(a)).not.toBe(anchorKey(b));
  });

  it("falls back to a quantized point when there is no AX layer", () => {
    const a = buildAnchor({ point: { x: 100, y: 100 }, displayId: "D1" });
    const b = buildAnchor({ point: { x: 103, y: 97 }, displayId: "D1" });
    expect(anchorKey(a)).toBe(anchorKey(b));
    const far = buildAnchor({ point: { x: 400, y: 400 }, displayId: "D1" });
    expect(anchorKey(a)).not.toBe(anchorKey(far));
  });
});
