import { describe, expect, it } from "vitest";
import { identityPredicates, isLocatable } from "../src/trace/identity-set.js";
import type { Action, Anchor, Path, Predicate, TraceEdge } from "../src/trace/types.js";

const p = (kind: Predicate["kind"], args: Predicate["args"]): Predicate => ({
  kind,
  args,
  reach: kind === "display" || kind === "file" ? "assertable" : "achievable",
});

const anchor = (ax?: Anchor["ax"]): Anchor => ({
  point: { x: 1, y: 2, displayId: "d0" },
  ...(ax !== undefined ? { ax } : {}),
});

const edge = (id: string, actions: Action[]): TraceEdge => ({
  id,
  from: "n0",
  to: "n1",
  actions,
  provenance: "recorded",
  observations: 1,
  outcomes: { attempts: 0, successes: 0 },
});

/** A real Path, not a cast — a cast would hide a shape change. */
const PATH: Path = {
  curve: [{ c1: { x: 0.3, y: 0 }, c2: { x: 0.7, y: 0 }, end: { x: 1, y: 0 } }],
  durationMs: 120,
  velocity: [0, 0.5, 1],
  fitConfidence: 0.9,
};

const APP = p("app", { app: "Google Chrome" });
const URL = p("url", { prefix: "github.com/o/r/pull" });
const TOUCHED = p("ax_exists", { role: "Button", label: "Files changed" });
const PAGE = p("ax_exists", { role: "Button", label: "assign yourself" });

const click = (ax?: Anchor["ax"]): Action => ({
  kind: "click",
  anchor: anchor(ax),
  button: 0,
  count: 1,
});

describe("identityPredicates", () => {
  it("keeps app and url, and drops untouched page content", () => {
    const out = identityPredicates({
      observed: [APP, URL, TOUCHED, PAGE],
      outgoing: [edge("e0", [click({ role: "Button", label: "Files changed", path: "W[0]>B[1]" })])],
      incoming: [],
    });
    expect(out).toContainEqual(APP);
    expect(out).toContainEqual(URL);
    expect(out).toContainEqual(TOUCHED);
    expect(out).not.toContainEqual(PAGE);
  });

  it("matches an anchor by identifier when it has one", () => {
    const byId = p("ax_exists", { role: "TextArea", identifier: "First Text View" });
    const out = identityPredicates({
      observed: [APP, byId, PAGE],
      outgoing: [
        edge("e0", [
          click({ role: "TextArea", identifier: "First Text View", path: "W[0]>T[0]" }),
        ]),
      ],
      incoming: [],
    });
    expect(out).toContainEqual(byId);
  });

  it("falls back to the label when the identifier is not in the tree", () => {
    // The anchor recorded both; only the label survived into the observation.
    const out = identityPredicates({
      observed: [APP, TOUCHED],
      outgoing: [
        edge("e0", [
          click({ role: "Button", label: "Files changed", identifier: "gone", path: "x" }),
        ]),
      ],
      incoming: [],
    });
    expect(out).toContainEqual(TOUCHED);
  });

  it("unions every outgoing edge, and both ends of a drag", () => {
    const a = p("ax_exists", { role: "Button", label: "A" });
    const b = p("ax_exists", { role: "Button", label: "B" });
    const drag: Action = {
      kind: "drag",
      from: anchor({ role: "Button", label: "B", path: "y" }),
      to: anchor({ role: "Button", label: "A", path: "x" }),
      path: PATH,
      button: 0,
    };
    const out = identityPredicates({
      observed: [APP, a, b],
      outgoing: [edge("e0", [click({ role: "Button", label: "A", path: "x" })]), edge("e1", [drag])],
      incoming: [],
    });
    expect(out).toContainEqual(a);
    expect(out).toContainEqual(b);
  });

  it("keeps ax_focused when an outgoing edge types", () => {
    const focused = p("ax_focused", { role: "TextArea", identifier: "First Text View" });
    const out = identityPredicates({
      observed: [APP, focused, PAGE],
      outgoing: [edge("e0", [{ kind: "type", slot: "textarea", recorded: "hi" }])],
      incoming: [],
    });
    expect(out).toContainEqual(focused);
  });

  it("drops ax_focused when nothing types — focus is then incidental", () => {
    const focused = p("ax_focused", { role: "TextArea", identifier: "First Text View" });
    const out = identityPredicates({
      observed: [APP, focused],
      outgoing: [edge("e0", [click({ role: "Button", label: "x", path: "p" })])],
      incoming: [],
    });
    expect(out).not.toContainEqual(focused);
  });

  it("takes waits from the INCOMING edge, and only when they hold", () => {
    const holds = p("app", { app: "Google Chrome" });
    const stale = p("ax_exists", { role: "Button", label: "gone" });
    const out = identityPredicates({
      observed: [holds],
      outgoing: [],
      incoming: [
        edge("e0", [
          { kind: "wait", until: holds, timeoutMs: 1000 },
          { kind: "wait", until: stale, timeoutMs: 1000 },
        ]),
      ],
    });
    expect(out).toContainEqual(holds);
    expect(out).not.toContainEqual(stale);
  });

  it("ignores an outgoing edge's waits, which describe the NEXT state", () => {
    // Deliberately NOT an `app` predicate: an observation carries exactly one,
    // since only one application is frontmost, so an `app` here would be taken
    // by the always-include rule and prove nothing about waits.
    const next = p("ax_exists", { role: "Button", label: "Appears Later" });
    const out = identityPredicates({
      observed: [APP, next],
      outgoing: [edge("e0", [{ kind: "wait", until: next, timeoutMs: 1000 }])],
      incoming: [],
    });
    expect(out).not.toContainEqual(next);
    expect(out).toEqual([APP]);
  });

  it("emits nothing extra for an anchor that is path-only", () => {
    const out = identityPredicates({
      observed: [APP, PAGE],
      outgoing: [edge("e0", [click({ role: "Button", path: "W[0]>B[3]" })])],
      incoming: [],
    });
    expect(out).toEqual([APP]);
  });

  it("never emits duplicates", () => {
    const out = identityPredicates({
      observed: [APP, TOUCHED],
      outgoing: [
        edge("e0", [click({ role: "Button", label: "Files changed", path: "x" })]),
        edge("e1", [click({ role: "Button", label: "Files changed", path: "x" })]),
      ],
      incoming: [],
    });
    expect(out.filter((q) => q.kind === "ax_exists")).toHaveLength(1);
  });

  it("normalizes a prefixed anchor role, because real data has none", () => {
    const out = identityPredicates({
      observed: [APP, TOUCHED],
      outgoing: [edge("e0", [click({ role: "AXButton", label: "Files changed", path: "x" })])],
      incoming: [],
    });
    expect(out).toContainEqual(TOUCHED);
  });

  it("is far smaller than the observation it came from", () => {
    const noise = Array.from({ length: 40 }, (_, i) =>
      p("ax_exists", { role: "Button", label: `noise-${i}` }),
    );
    const out = identityPredicates({
      observed: [APP, URL, TOUCHED, ...noise],
      outgoing: [edge("e0", [click({ role: "Button", label: "Files changed", path: "x" })])],
      incoming: [],
    });
    expect(out).toHaveLength(3);
  });
});

describe("isLocatable", () => {
  it("rejects a set that is only app", () => {
    expect(isLocatable([APP])).toBe(false);
  });
  it("rejects an empty set", () => {
    expect(isLocatable([])).toBe(false);
  });
  it("accepts app plus anything else", () => {
    expect(isLocatable([APP, URL])).toBe(true);
  });
});

describe("assertable environment gates survive narrowing", () => {
  it("keeps display and file, which no UI action can produce", () => {
    // They can only refuse, which is precisely why narrowing must not drop
    // them: they are the only check that a replay is on the same hardware.
    const display = p("display", { id: "d0", w: 2560, h: 1440 });
    const file = p("file", { path: "/Users/x/notes.txt" });
    const out = identityPredicates({
      observed: [APP, display, file, PAGE],
      outgoing: [],
      incoming: [],
    });
    expect(out).toContainEqual(display);
    expect(out).toContainEqual(file);
    expect(out).not.toContainEqual(PAGE);
  });
});
