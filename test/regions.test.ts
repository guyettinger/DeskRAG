import { describe, expect, it } from "vitest";
import { iou, clampToFrame } from "../src/represent/regions/geometry.js";
import { axFilter } from "../src/represent/regions/ax.js";
import {
  dbscanWeighted, eventsToPoints, hotspotRegions, type WeightedPoint,
} from "../src/represent/regions/hotspots.js";
import { gridRegions } from "../src/represent/regions/grid.js";
import { fuseRegions } from "../src/represent/regions/fuse.js";
import type { Region, UIElement } from "../src/embed/types.js";

describe("geometry", () => {
  it("iou and clamp", () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(1);
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 0, w: 10, h: 10 })).toBe(0);
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(1 / 3, 5);
    expect(clampToFrame({ x: -5, y: -5, w: 20, h: 20 }, 10, 10)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

describe("axFilter", () => {
  const F = { frameW: 1000, frameH: 1000 };
  const els: UIElement[] = [
    { role: "button", x: 0, y: 0, w: 4, h: 4 }, // sliver -> dropped
    { role: "window", x: 0, y: 0, w: 1000, h: 1000 }, // whole-window + drop role
    { role: "group", x: 0, y: 0, w: 100, h: 100 }, // structural drop role
    { role: "button", label: "Save", x: 100, y: 100, w: 80, h: 30 },
    { role: "button", label: "Save", x: 101, y: 101, w: 80, h: 30 }, // nested dup
    { role: "textfield", label: "Search", focused: true, x: 200, y: 200, w: 120, h: 24 },
  ];

  it("drops slivers, whole-window containers, and structural roles; collapses dups", () => {
    const out = axFilter(els, F);
    // Save (deduped to one) + focused Search field.
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.source === "ax")).toBe(true);
    const search = out.find((r) => r.label === "Search")!;
    expect(search.priority).toBe(5); // base 2 + label 1 + focused 2
    expect(out.filter((r) => r.label === "Save")).toHaveLength(1);
  });

  it("keepRoles restricts to an allowlist", () => {
    const out = axFilter(els, { ...F, keepRoles: new Set(["textfield"]) });
    expect(out.map((r) => r.role)).toEqual(["textfield"]);
  });
});

describe("hotspots / weighted DBSCAN", () => {
  it("a single heavy click forms a cluster; a light move is noise", () => {
    const pts: WeightedPoint[] = [{ x: 500, y: 500, weight: 3 }];
    expect(dbscanWeighted(pts, 80, 3)).toEqual([0]);
    expect(dbscanWeighted([{ x: 0, y: 0, weight: 0.2 }], 80, 3)).toEqual([-1]);
  });

  it("eventsToPoints weights by kind and drops coordinate-less events", () => {
    const pts = eventsToPoints([
      { kind: "mouse_down", x: 1, y: 2 },
      { kind: "key_down" }, // no weight mapping + no coords
      { kind: "scroll", x: 3, y: 4 },
    ]);
    expect(pts).toEqual([
      { x: 1, y: 2, weight: 3 },
      { x: 3, y: 4, weight: 1 },
    ]);
  });

  it("crops one region per click cluster", () => {
    const regions = hotspotRegions(
      [{ x: 500, y: 500, weight: 3 }, { x: 900, y: 100, weight: 3 }],
      { frameW: 1000, frameH: 1000, eps: 80 },
    );
    expect(regions).toHaveLength(2);
    expect(regions[0]!.source).toBe("hotspot");
    // region contains its click point
    const r = regions.find((x) => x.x <= 500 && 500 <= x.x + x.w)!;
    expect(r.y <= 500 && 500 <= r.y + r.h).toBe(true);
    expect(r.priority).toBeCloseTo(1 + 3 / 9, 5);
  });
});

describe("gridRegions", () => {
  it("produces cols*rows overlapping tiles clamped to the frame", () => {
    const g = gridRegions(1000, 800, { cols: 4, rows: 3, overlap: 0.15 });
    expect(g).toHaveLength(12);
    expect(g.every((r) => r.source === "grid" && r.priority === 0.5)).toBe(true);
    expect(g[0]!.w).toBeGreaterThan(250); // 250 step * 1.15 overlap
    expect(g.every((r) => r.x >= 0 && r.x + r.w <= 1000 + 1e-9)).toBe(true);
  });
});

describe("fuseRegions", () => {
  const ax: Region = { x: 0, y: 0, w: 100, h: 100, source: "ax", priority: 3, label: "Save" };
  const hotspot: Region = { x: 10, y: 10, w: 100, h: 100, source: "hotspot", priority: 1.5 };
  const grid: Region = { x: 500, y: 500, w: 100, h: 100, source: "grid", priority: 0.5 };

  it("NMS keeps higher priority and bumps it on cross-source agreement", () => {
    const out = fuseRegions([hotspot, ax, grid], { iouThreshold: 0.5, agreementBoost: 1.5 });
    // hotspot overlaps ax (>0.5 IoU, different source) -> ax kept + boosted; grid kept.
    expect(out.map((r) => r.source)).toEqual(["ax", "grid"]);
    expect(out.find((r) => r.source === "ax")!.priority).toBe(4.5);
    // inputs are not mutated
    expect(ax.priority).toBe(3);
  });

  it("budget-cut keeps the top region", () => {
    const out = fuseRegions([hotspot, ax, grid], { maxRegions: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe("ax");
  });
});
