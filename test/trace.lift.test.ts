import { describe, expect, it } from "vitest";
import { liftTrace, resolveKeys, slotNameFor } from "../src/trace/lift.js";
import type { Keymap } from "../src/capture/env/types.js";
import { displayIdAt } from "../src/capture/env/displays.js";
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

const us: Keymap = {
  layoutId: "com.apple.keylayout.US",
  entries: { 0: ["a", "A", "\u00e5", "\u00c5"], 1: ["s", "S", "\u00df", "\u00cd"] },
};

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

describe("resolveKeys", () => {
  it("fills char on key events from the layout in force", () => {
    const out = resolveKeys(
      [ev(100, "key_down", undefined, undefined, { keycode: 30, modifiers: [] })],
      () => us,
    );
    expect(out[0]!.data).toEqual({ keycode: 30, modifiers: [], char: "a" });
  });

  it("CONSUMES shift, so a capital lifts as text and not a chord", () => {
    const out = resolveKeys(
      [ev(100, "key_down", undefined, undefined, { keycode: 30, modifiers: ["shift"] })],
      () => us,
    );
    expect(out[0]!.data).toEqual({ keycode: 30, modifiers: [], char: "A" });
  });

  it("keeps modifiers on a command chord and names the key from the plain column", () => {
    // A command consumes nothing: the char identifies the key (cmd+S is the S
    // key), and the surviving modifier is what makes groupGestures call it a
    // chord rather than text.
    const out = resolveKeys(
      [ev(100, "key_down", undefined, undefined, { keycode: 31, modifiers: ["cmd"] })],
      () => us,
    );
    expect(out[0]!.data).toEqual({ keycode: 31, modifiers: ["cmd"], char: "s" });
  });

  it("leaves non-key events untouched", () => {
    const move = ev(100, "mouse_move", 5, 6);
    expect(resolveKeys([move], () => us)[0]).toEqual(move);
  });

  it("leaves key events untouched when no keymap covers that t_mono", () => {
    const k = ev(100, "key_down", undefined, undefined, { keycode: 30, modifiers: [] });
    expect(resolveKeys([k], () => undefined)[0]).toEqual(k);
  });

  it("applies the layout in force at each event's t_mono", () => {
    const dvorak: Keymap = { layoutId: "dv", entries: { 1: ["o", "O", "ø", "Ø"] } };
    const out = resolveKeys(
      [
        ev(100, "key_down", undefined, undefined, { keycode: 31, modifiers: [] }),
        ev(9000, "key_down", undefined, undefined, { keycode: 31, modifiers: [] }),
      ],
      (t) => (t < 5000 ? us : dvorak),
    );
    expect((out[0]!.data as { char?: string }).char).toBe("s");
    expect((out[1]!.data as { char?: string }).char).toBe("o");
  });
});

describe("liftTrace — typed text end to end", () => {
  it("REGRESSION: a capital letter lifts as text, not a chord", () => {
    const t = liftTrace({
      sessionId: "cap",
      endTMono: 1000,
      keymapAt: () => us,
      events: [
        ev(100, "key_down", undefined, undefined, { keycode: 30, modifiers: ["shift"] }),
        ev(110, "key_up", undefined, undefined, { keycode: 30, modifiers: ["shift"] }),
      ],
    });
    const actions = t.edges.flatMap((e) => e.actions);
    expect(actions.map((a) => a.kind)).toEqual(["type"]);
    const typed = actions[0];
    if (typed?.kind !== "type") throw new Error("expected type");
    expect(typed.recorded).toBe("A");
  });

  it("still lifts a real chord as a chord", () => {
    const t = liftTrace({
      sessionId: "chord",
      endTMono: 1000,
      keymapAt: () => us,
      events: [
        ev(100, "key_down", undefined, undefined, { keycode: 31, modifiers: ["cmd"] }),
        ev(110, "key_up", undefined, undefined, { keycode: 31, modifiers: ["cmd"] }),
      ],
    });
    const actions = t.edges.flatMap((e) => e.actions);
    expect(actions).toEqual([{ kind: "chord", keys: ["cmd", "s"] }]);
  });

  it("drops text with no keymap, exactly as before", () => {
    const t = liftTrace({
      sessionId: "nokm",
      endTMono: 1000,
      events: [
        ev(100, "key_down", undefined, undefined, { keycode: 30, modifiers: [] }),
        ev(110, "key_up", undefined, undefined, { keycode: 30, modifiers: [] }),
      ],
    });
    expect(t.edges.flatMap((e) => e.actions)).toHaveLength(0);
    expect(t.edges.some((e) => (e.liftWarnings ?? []).some((w) => /char/.test(w)))).toBe(true);
  });

  it("populates a slot with the resolved text — the point of the whole chain", () => {
    const t = liftTrace({
      sessionId: "slot",
      endTMono: 1000,
      keymapAt: () => us,
      events: [
        ev(100, "key_down", undefined, undefined, { keycode: 30, modifiers: ["shift"] }),
        ev(110, "key_up", undefined, undefined, { keycode: 30, modifiers: ["shift"] }),
        ev(200, "key_down", undefined, undefined, { keycode: 31, modifiers: [] }),
        ev(210, "key_up", undefined, undefined, { keycode: 31, modifiers: [] }),
      ],
    });
    expect(t.slots).toHaveLength(1);
    expect(t.slots[0]!.samples).toEqual(["As"]);
  });
});

describe("liftTrace — time-varying display topology", () => {
  const left = { id: "L", x: 0, y: 0, w: 1000, h: 1000, scale: 1, primary: true };
  const right = { id: "R", x: 1000, y: 0, w: 1000, h: 1000, scale: 1, primary: false };

  it("resolves a point against the topology in force at that t_mono", () => {
    // A monitor is plugged in mid-session: the same coordinate belongs to no
    // display before, and to R after. Without a t_mono the callback cannot
    // express that, which is what the capture spec requires.
    const t = liftTrace({
      sessionId: "topo",
      endTMono: 10_000,
      displayIdAt: (p, tMono) => {
        const displays = tMono < 5000 ? [left] : [left, right];
        return displayIdAt(displays, p);
      },
      events: [
        ev(100, "mouse_down", 1500, 100, { button: 1 }),
        ev(140, "mouse_up", 1500, 100, { button: 1 }),
        ev(9000, "mouse_down", 1500, 100, { button: 1 }),
        ev(9040, "mouse_up", 1500, 100, { button: 1 }),
      ],
    });
    const clicks = t.edges.flatMap((e) => e.actions).filter((a) => a.kind === "click");
    expect(clicks).toHaveLength(2);
    if (clicks[0]?.kind !== "click" || clicks[1]?.kind !== "click") throw new Error("expected clicks");
    // Before: off every known display, so it falls back to the primary.
    expect(clicks[0].anchor.point.displayId).toBe("L");
    // After: the new monitor owns it.
    expect(clicks[1].anchor.point.displayId).toBe("R");
  });

  it("still defaults to D0 with no callback", () => {
    const t = liftTrace({
      sessionId: "nodisp",
      endTMono: 500,
      events: [ev(100, "mouse_down", 10, 10, { button: 1 }), ev(140, "mouse_up", 10, 10, { button: 1 })],
    });
    const click = t.edges.flatMap((e) => e.actions).find((a) => a.kind === "click");
    if (click?.kind !== "click") throw new Error("expected click");
    expect(click.anchor.point.displayId).toBe("D0");
  });
});
