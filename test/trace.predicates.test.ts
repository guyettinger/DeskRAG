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
  it("emits the app predicate from the context, tagged achievable", () => {
    const ps = extractPredicates([], { app: "Mail", windowTitle: "New Message" });
    expect(ps).toContainEqual({ kind: "app", args: { app: "Mail" }, reach: "achievable" });
  });

  /**
   * A window title is document or page IDENTITY, not state. Emitting it made a
   * recording unusable outside the exact file it was made against: measured on a
   * real desktop, the TextEdit node missed by `window(title="Untitled.rtf")` and
   * `ax_exists(Window,"Untitled.rtf")` while 16 of its 19 predicates held, so it
   * could not be located in a document with any other name.
   */
  it("never emits a window predicate, or a Window ax_exists carrying the title", () => {
    const ps = extractPredicates([el("AXWindow", "Untitled.rtf", 0)], {
      app: "TextEdit",
      windowTitle: "Untitled.rtf",
    });
    expect(ps.some((p) => p.kind === "window")).toBe(false);
    expect(ps.some((p) => p.args.role === "Window")).toBe(false);
  });

  /**
   * A browser's tab strip is SESSION state, not application state. Chrome
   * exposes every open tab as a RadioButton labelled with the page title, and a
   * collapsed tab group as a TabGroup labelled with the group name — measured on
   * a real recording as 27 of one node's 61 predicates, which made that node
   * unverifiable unless the same 20 tabs happened to be open. Same class as a
   * clock or a badge count, one level up.
   *
   * Measured 27/27 of the tabs sit under a TabGroup ancestor, so the rule is
   * structural rather than a guess about labels.
   */
  it("drops a browser's tabs and tab groups, keeping the page beneath them", () => {
    const ps = extractPredicates([
      el("AXTabGroup", "group Reading - 3 Other Tabs", 0),
      { ...el("AXRadioButton", "Some Page Title - Google Chrome", 1), parent: 0 },
      { ...el("AXTabGroup", "group Projects - 2 Other Tabs", 2), parent: 0 },
      el("AXButton", "Reload", 3),
    ]);
    const labels = ps.map((p) => p.args.label);
    expect(labels).not.toContain("Some Page Title - Google Chrome");
    expect(labels).not.toContain("group Reading - 3 Other Tabs");
    expect(labels).not.toContain("group Projects - 2 Other Tabs");
    expect(labels).toContain("Reload");
  });

  /** A RadioButton that is NOT in a tab strip is an ordinary form control. */
  it("keeps a radio button that is not part of a tab strip", () => {
    const ps = extractPredicates([
      el("AXWindow", "Prefs", 0),
      { ...el("AXRadioButton", "Weekly", 1), parent: 0 },
    ]);
    expect(ps.map((p) => p.args.label)).toContain("Weekly");
  });

  /** The unsaved-changes indicator: present while dirty, gone once saved. */
  it("drops the document-dirty indicator but keeps labels that merely start with it", () => {
    const ps = extractPredicates([
      el("AXMenuButton", "Edited", 0),
      el("AXButton", "Edited by Sam", 1),
    ]);
    expect(ps.some((p) => p.args.label === "Edited")).toBe(false);
    expect(ps.some((p) => p.args.label === "Edited by Sam")).toBe(true);
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
    // Canonicalized: args carry the unprefixed role whichever spelling arrived.
    expect(ax[0]!.args).toEqual({ role: "Button", label: "Send" });
  });

  // The Swift sidecar strips the "AX" prefix (`ax-dump.swift`: rawRole.dropFirst(2)),
  // so every role in real capture data arrives unprefixed. Matching prefixed
  // literals meant real recordings produced ZERO ax predicates — every boundary
  // looked like the same state and the whole graph collapsed to one node.
  it("emits ax_exists for the unprefixed roles the real sidecar actually returns", () => {
    const ps = extractPredicates([
      el("Button", "Send", 0),
      el("StaticText", "9:41", 1),
      el("Group", undefined, 2),
    ]);
    const ax = ps.filter((p) => p.kind === "ax_exists");
    expect(ax).toHaveLength(1);
    expect(ax[0]!.args).toEqual({ role: "Button", label: "Send" });
  });

  it("emits ax_focused for an unprefixed focused role", () => {
    const ps = extractPredicates([el("TextField", "To", 0, { focused: true })]);
    expect(ps).toContainEqual({
      kind: "ax_focused",
      args: { role: "TextField", label: "To" },
      reach: "achievable",
    });
  });

  // Both spellings must key identically, or a change of AX source would silently
  // stop merging instead of failing loudly.
  it("canonicalizes the role so prefixed and unprefixed inputs are one predicate", () => {
    const prefixed = extractPredicates([el("AXButton", "Send", 0)]);
    const bare = extractPredicates([el("Button", "Send", 0)]);
    expect(samePredicateSet(prefixed, bare)).toBe(true);
  });

  it("emits ax_focused for the focused element", () => {
    const ps = extractPredicates([
      el("AXButton", "Send", 0),
      el("AXTextField", "To", 1, { focused: true }),
    ]);
    expect(ps).toContainEqual({
      kind: "ax_focused",
      args: { role: "TextField", label: "To" },
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
