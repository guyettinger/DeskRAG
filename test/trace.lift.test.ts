import { describe, expect, it } from "vitest";
import { liftTrace, slotNameFor } from "../src/trace/lift.js";
import type { AxSnapshot } from "../src/trace/lift.js";
import type { TraceEvent } from "../src/trace/types.js";
import type { UIElement } from "../src/embed/types.js";

const ev = (tMono: number, kind: string, x?: number, y?: number, data?: unknown): TraceEvent => ({
  tMono,
  kind,
  x: x ?? null,
  y: y ?? null,
  data: data ?? null,
});

const composeTree: UIElement[] = [
  { role: "AXWindow", label: "New Message", x: 0, y: 0, w: 800, h: 600 },
  { role: "AXTextField", label: "To", x: 100, y: 50, w: 400, h: 24, parent: 0, focused: true },
  { role: "AXButton", label: "Send", x: 700, y: 20, w: 80, h: 32, parent: 0 },
];

const sentTree: UIElement[] = [
  { role: "AXWindow", label: "Inbox", x: 0, y: 0, w: 800, h: 600 },
  { role: "AXStaticText", label: "Message sent", x: 100, y: 50, w: 200, h: 20, parent: 0 },
  { role: "AXSheet", label: "Delivery Report", x: 200, y: 200, w: 300, h: 200, parent: 0 },
];

const axAt = (tMono: number): AxSnapshot =>
  tMono < 1000
    ? { elements: composeTree, frameId: "f_compose", framePhash: "1111" }
    : { elements: sentTree, frameId: "f_sent", framePhash: "2222" };

describe("slotNameFor", () => {
  it("derives a stable name from the focused role and label", () => {
    expect(
      slotNameFor({ ax: { role: "AXTextField", label: "To", path: "p" }, point: { x: 0, y: 0, displayId: "D1" } }, 0),
    ).toBe("axtextfield_to");
  });

  it("falls back to an ordinal without an AX layer", () => {
    expect(slotNameFor(undefined, 3)).toBe("text_3");
    expect(slotNameFor({ point: { x: 0, y: 0, displayId: "D1" } }, 1)).toBe("text_1");
  });
});

describe("liftTrace", () => {
  const events: TraceEvent[] = [
    ev(0, "focus_change", undefined, undefined, { app: "Mail", title: "New Message" }),
    ev(100, "mouse_down", 720, 30, { button: 1 }),
    ev(140, "mouse_up", 720, 30, { button: 1 }),
    ev(300, "key_down", undefined, undefined, { keycode: 1, char: "h" }),
    ev(310, "key_up", undefined, undefined, { keycode: 1, char: "h" }),
    ev(1000, "focus_change", undefined, undefined, { app: "Mail", title: "Inbox" }),
    ev(1100, "mouse_down", 250, 250, { button: 1 }),
    ev(1140, "mouse_up", 250, 250, { button: 1 }),
  ];

  const lifted = () =>
    liftTrace({
      sessionId: "s1",
      events,
      endTMono: 2000,
      axAt,
      regionsAt: () => [{ id: "r_send", x: 700, y: 20, w: 80, h: 32 }],
      displayIdAt: () => "D1",
    });

  it("produces a chain where edges[i] connects nodes[i] to nodes[i+1]", () => {
    const t = lifted();
    expect(t.sessionId).toBe("s1");
    expect(t.edges).toHaveLength(t.nodes.length - 1);
    t.edges.forEach((e, i) => {
      expect(e.from).toBe(t.nodes[i]!.id);
      expect(e.to).toBe(t.nodes[i + 1]!.id);
    });
  });

  it("cuts at the existing segment boundaries, not a new mechanism", () => {
    // session_start, focus_change at 1000, session_end => 3 nodes, 2 edges.
    const t = lifted();
    expect(t.nodes).toHaveLength(3);
    expect(t.edges).toHaveLength(2);
  });

  it("is deterministic — the same input yields the same ids", () => {
    expect(JSON.stringify(lifted())).toBe(JSON.stringify(lifted()));
  });

  it("resolves anchors against the AX tree captured at that moment", () => {
    const t = lifted();
    const click = t.edges[0]!.actions.find((a) => a.kind === "click");
    expect(click?.kind).toBe("click");
    if (click?.kind !== "click") throw new Error("expected click");
    expect(click.anchor.ax).toMatchObject({ role: "AXButton", label: "Send" });
    expect(click.anchor.visual?.regionId).toBe("r_send");
    expect(click.anchor.point.displayId).toBe("D1");
  });

  it("builds node predicates from the tree at each boundary", () => {
    const t = lifted();
    const first = t.nodes[0]!.predicates;
    expect(first).toContainEqual({ kind: "app", args: { app: "Mail" }, reach: "achievable" });
    expect(first).toContainEqual({
      kind: "ax_focused",
      args: { role: "AXTextField", label: "To" },
      reach: "achievable",
    });
  });

  it("names a type slot from the focused element and records one sample", () => {
    const t = lifted();
    const typed = t.edges[0]!.actions.find((a) => a.kind === "type");
    expect(typed).toEqual({ kind: "type", slot: "axtextfield_to", recorded: "h" });
    expect(t.slots).toContainEqual({ name: "axtextfield_to", samples: ["h"], secret: false });
  });

  it("defaults every node to intervene: select", () => {
    expect(lifted().nodes.every((n) => n.intervene === "select")).toBe(true);
  });

  it("records the frame reference for visual corroboration", () => {
    expect(lifted().nodes[0]!.visual).toEqual({ frameBlobId: "f_compose", phash: "1111" });
  });

  it("lifts an idle gap into a wait on a predicate that was NOT already true", () => {
    const t = liftTrace({
      sessionId: "s2",
      endTMono: 6000,
      axAt,
      events: [
        ev(0, "mouse_down", 720, 30, { button: 1 }),
        ev(40, "mouse_up", 720, 30, { button: 1 }),
        ev(4000, "mouse_down", 250, 250, { button: 1 }),
        ev(4040, "mouse_up", 250, 250, { button: 1 }),
      ],
    });
    const wait = t.edges.flatMap((e) => e.actions).find((a) => a.kind === "wait");
    expect(wait?.kind).toBe("wait");
    if (wait?.kind !== "wait") throw new Error("expected wait");
    // The dwell gap boundary put the sent-state tree after the gap, so the wait
    // must key on something new there, never on something already true before.
    expect(wait.until.kind === "ax_exists" || wait.until.kind === "ax_focused").toBe(true);
    expect(wait.timeoutMs).toBeGreaterThanOrEqual(3000);
  });

  it("lifts an intra-span idle gap into a wait too — the other of the two paths", () => {
    // 2s gap: above the gesture idle threshold (1500ms) but below dwellGapMs
    // (3000ms), so it stays INSIDE one span as an idle gesture rather than being
    // cut into a boundary. Distinct code path from the dwell-gap case above.
    const t = liftTrace({
      sessionId: "s2b",
      endTMono: 3000,
      axAt,
      events: [
        ev(0, "mouse_down", 720, 30, { button: 1 }),
        ev(40, "mouse_up", 720, 30, { button: 1 }),
        ev(2200, "mouse_down", 250, 250, { button: 1 }),
        ev(2240, "mouse_up", 250, 250, { button: 1 }),
      ],
    });
    // One span: no dwell_gap boundary was cut.
    expect(t.edges).toHaveLength(1);
    const kinds = t.edges[0]!.actions.map((a) => a.kind);
    expect(kinds).toContain("wait");
    // The wait sits between the two clicks, not appended at the end.
    expect(kinds).toEqual(["click", "wait", "click"]);
  });

  it("degrades to point-only anchors with no AX source", () => {
    const t = liftTrace({
      sessionId: "s3",
      endTMono: 500,
      events: [ev(100, "mouse_down", 10, 10, { button: 1 }), ev(140, "mouse_up", 10, 10, { button: 1 })],
    });
    const click = t.edges.flatMap((e) => e.actions).find((a) => a.kind === "click");
    if (click?.kind !== "click") throw new Error("expected click");
    expect(click.anchor.ax).toBeUndefined();
    expect(click.anchor.point.displayId).toBe("D0");
  });

  it("carries gesture warnings onto the edge", () => {
    const t = liftTrace({
      sessionId: "s4",
      endTMono: 500,
      events: [ev(100, "mouse_down", 10, 10, { button: 1 })],
    });
    expect(t.edges.some((e) => (e.liftWarnings ?? []).some((w) => /mouse_down/.test(w)))).toBe(true);
  });

  it("fits a drag path and stores it endpoint-normalized", () => {
    const t = liftTrace({
      sessionId: "s5",
      endTMono: 500,
      events: [
        ev(100, "mouse_down", 10, 10, { button: 1 }),
        ev(120, "mouse_move", 40, 4),
        ev(140, "mouse_move", 70, 4),
        ev(160, "mouse_up", 100, 10, { button: 1 }),
      ],
    });
    const drag = t.edges.flatMap((e) => e.actions).find((a) => a.kind === "drag");
    if (drag?.kind !== "drag") throw new Error("expected drag");
    expect(drag.path.curve.at(-1)!.end).toEqual({ x: 1, y: 0 });
    expect(drag.path.durationMs).toBe(60);
    expect(drag.from.point).toMatchObject({ x: 10, y: 10 });
    expect(drag.to.point).toMatchObject({ x: 100, y: 10 });
  });

  it("returns a single-node trace with no edges for an empty event stream", () => {
    const t = liftTrace({ sessionId: "s6", events: [], endTMono: 1000 });
    expect(t.nodes.length).toBeGreaterThanOrEqual(1);
    expect(t.edges.every((e) => e.actions.length === 0)).toBe(true);
  });
});
