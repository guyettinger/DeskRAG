import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_AX_PREDICATES,
  extractPredicates,
  isVolatileLabel,
  predicateKey,
  samePredicateSet,
} from "../src/trace/predicates.js";
import type { UIElement } from "../src/embed/types.js";

// `exactOptionalPropertyTypes` is on, so an absent label must be omitted rather
// than set to undefined.
const el = (role: string, label: string | undefined, i: number, extra: Partial<UIElement> = {}): UIElement => ({
  role,
  ...(label !== undefined ? { label } : {}),
  x: i * 10,
  y: i * 10,
  w: 100,
  h: 20,
  ...extra,
});

describe("isVolatileLabel", () => {
  it("rejects clocks, counts, and bare numbers", () => {
    for (const s of ["9:41", "12:05 PM", "Inbox (14)", "42", "3 unread", "7 items", "Updated 2 minutes ago"]) {
      expect(isVolatileLabel(s), s).toBe(true);
    }
  });

  it("keeps stable UI copy, including copy that merely contains a digit", () => {
    for (const s of ["Send", "New Message", "Save As…", "Tab 1", "iCloud Drive"]) {
      expect(isVolatileLabel(s), s).toBe(false);
    }
  });
});

describe("extractPredicates", () => {
  it("emits app and window predicates from the context, tagged achievable", () => {
    const ps = extractPredicates([], { app: "Mail", windowTitle: "New Message" });
    expect(ps).toContainEqual({ kind: "app", args: { app: "Mail" }, reach: "achievable" });
    expect(ps).toContainEqual({ kind: "window", args: { title: "New Message" }, reach: "achievable" });
  });

  it("emits ax_exists only for stable roles with non-volatile labels", () => {
    const ps = extractPredicates([
      el("AXButton", "Send", 0),
      el("AXStaticText", "9:41", 1),
      el("AXButton", "Inbox (14)", 2),
      el("AXGroup", undefined, 3),
    ]);
    const ax = ps.filter((p) => p.kind === "ax_exists");
    expect(ax).toHaveLength(1);
    expect(ax[0]!.args).toEqual({ role: "AXButton", label: "Send" });
  });

  it("emits ax_focused for the focused element", () => {
    const ps = extractPredicates([
      el("AXButton", "Send", 0),
      el("AXTextField", "To", 1, { focused: true }),
    ]);
    expect(ps).toContainEqual({
      kind: "ax_focused",
      args: { role: "AXTextField", label: "To" },
      reach: "achievable",
    });
  });

  it("tags display predicates assertable — they have no repair path", () => {
    const ps = extractPredicates([], { displays: [{ id: "D1", w: 2560, h: 1440 }] });
    expect(ps).toContainEqual({
      kind: "display",
      args: { id: "D1", w: 2560, h: 1440 },
      reach: "assertable",
    });
  });

  it("is deterministic and capped", () => {
    const many = Array.from({ length: 200 }, (_, i) => el("AXButton", `Button ${String.fromCharCode(65 + (i % 26))}${i}`, i));
    const a = extractPredicates(many);
    const b = extractPredicates([...many].reverse());
    expect(a.filter((p) => p.kind === "ax_exists").length).toBeLessThanOrEqual(DEFAULT_MAX_AX_PREDICATES);
    expect(a.map(predicateKey)).toEqual(b.map(predicateKey));
  });

  it("returns only context predicates for an empty AX tree — the AX-blind case", () => {
    const ps = extractPredicates([], { app: "Terminal" });
    expect(ps.every((p) => p.kind !== "ax_exists")).toBe(true);
    expect(ps).toHaveLength(1);
  });
});

describe("samePredicateSet", () => {
  it("ignores order", () => {
    const a = extractPredicates([el("AXButton", "Send", 0), el("AXButton", "Cancel", 1)]);
    expect(samePredicateSet(a, [...a].reverse())).toBe(true);
  });

  it("distinguishes different sets", () => {
    const a = extractPredicates([el("AXButton", "Send", 0)]);
    const b = extractPredicates([el("AXButton", "Cancel", 0)]);
    expect(samePredicateSet(a, b)).toBe(false);
  });

  it("treats a subset as different — not merely overlapping", () => {
    const a = extractPredicates([el("AXButton", "Send", 0), el("AXButton", "Cancel", 1)]);
    const b = extractPredicates([el("AXButton", "Send", 0)]);
    expect(samePredicateSet(a, b)).toBe(false);
  });
});
