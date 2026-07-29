import { describe, expect, it } from "vitest";
import { nestAxElements } from "../src/capture/ax/tree.js";
import { coerceAxElements } from "../src/capture/ax/parse.js";
import type { UIElement } from "../src/embed/types.js";

const el = (role: string, x: number, y: number, w: number, h: number): UIElement => ({ role, x, y, w, h });

/** Resolve an element's ancestor chain to roles, outermost first. */
function chain(els: readonly UIElement[], i: number): string[] {
  const path: string[] = [];
  for (let cur: number | undefined = i; cur !== undefined; cur = els[cur]!.parent) path.unshift(els[cur]!.role);
  return path;
}

describe("coerceAxElements parent links", () => {
  it("remaps parent indices across dropped elements", () => {
    const els = coerceAxElements([
      { role: "window", x: 0, y: 0, w: 100, h: 100 }, // src 0 -> out 0
      { role: "group", x: 0, y: 0, w: 5 }, // src 1 -> dropped (missing h)
      { role: "button", x: 1, y: 1, w: 2, h: 2, parent: 0 }, // src 2 -> out 1
    ]);
    expect(els).toHaveLength(2);
    expect(els[1]).toEqual({ role: "button", x: 1, y: 1, w: 2, h: 2, parent: 0, depth: 1 });
  });

  it("re-roots an element whose parent was dropped", () => {
    const els = coerceAxElements([
      { role: "group", x: 0, y: 0, w: 5 }, // dropped
      { role: "button", x: 1, y: 1, w: 2, h: 2, parent: 0 },
    ]);
    expect(els).toEqual([{ role: "button", x: 1, y: 1, w: 2, h: 2 }]);
  });

  it("derives depth down a chain", () => {
    const els = coerceAxElements([
      { role: "window", x: 0, y: 0, w: 100, h: 100 },
      { role: "group", x: 0, y: 0, w: 50, h: 50, parent: 0 },
      { role: "button", x: 0, y: 0, w: 10, h: 10, parent: 1 },
    ]);
    expect(els.map((e) => e.depth)).toEqual([undefined, 1, 2]);
    expect(chain(els, 2)).toEqual(["window", "group", "button"]);
  });

  it("rejects forward, self and out-of-range parents (no cycles possible)", () => {
    const els = coerceAxElements([
      { role: "a", x: 0, y: 0, w: 1, h: 1, parent: 1 }, // forward reference
      { role: "b", x: 0, y: 0, w: 1, h: 1, parent: 1 }, // self
      { role: "c", x: 0, y: 0, w: 1, h: 1, parent: 99 }, // out of range
      { role: "d", x: 0, y: 0, w: 1, h: 1, parent: -1 }, // negative
      { role: "e", x: 0, y: 0, w: 1, h: 1, parent: 1.5 }, // non-integer
    ]);
    expect(els.every((e) => e.parent === undefined)).toBe(true);
  });

  it("leaves a payload with no hierarchy byte-identical", () => {
    const flat = [{ role: "button", label: "Save", x: 1, y: 2, w: 3, h: 4, focused: true }];
    expect(coerceAxElements(flat)).toEqual(flat);
  });
});

describe("nestAxElements", () => {
  it("passes sidecar parent links through untouched", () => {
    const sidecar: UIElement[] = [
      el("window", 0, 0, 100, 100),
      // Deliberately NOT the containment answer: geometry would make this a root.
      { ...el("button", 500, 500, 10, 10), parent: 0, depth: 1 },
    ];
    expect(nestAxElements(sidecar)).toEqual(sidecar);
  });

  it("nests three levels by containment", () => {
    const els = nestAxElements([
      el("button", 20, 20, 10, 10),
      el("window", 0, 0, 100, 100),
      el("group", 10, 10, 40, 40),
    ]);
    expect(chain(els, 0)).toEqual(["window", "group", "button"]);
    expect(els[1]!.parent).toBeUndefined();
    expect(els.map((e) => e.depth)).toEqual([2, undefined, 1]);
  });

  it("picks the tightest container, not the first-processed one", () => {
    // The naive ancestor-stack sweep gets this wrong: `sibling` (processed
    // between `group` and `button` by area) pops `group` off the stack, so
    // `button` reparents to `window` instead of `group`.
    const els = nestAxElements([
      el("window", 0, 0, 100, 100),
      el("group", 0, 0, 40, 40),
      el("sibling", 50, 50, 30, 30),
      el("button", 5, 5, 5, 5),
    ]);
    expect(chain(els, 3)).toEqual(["window", "group", "button"]);
    expect(chain(els, 2)).toEqual(["window", "sibling"]);
  });

  it("keeps disjoint boxes as separate roots", () => {
    const els = nestAxElements([el("a", 0, 0, 10, 10), el("b", 50, 50, 10, 10)]);
    expect(els.every((e) => e.parent === undefined)).toBe(true);
  });

  it("nests identical bboxes in input order rather than cycling", () => {
    const els = nestAxElements([el("outer", 0, 0, 10, 10), el("inner", 0, 0, 10, 10)]);
    expect(els[0]!.parent).toBeUndefined();
    expect(els[1]!.parent).toBe(0);
  });

  it("does not mutate its input", () => {
    const input = [el("window", 0, 0, 100, 100), el("button", 1, 1, 2, 2)];
    const copy = structuredClone(input);
    nestAxElements(input);
    expect(input).toEqual(copy);
  });

  it("returns [] for an empty list", () => {
    expect(nestAxElements([])).toEqual([]);
  });
});
