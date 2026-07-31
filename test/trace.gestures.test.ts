import { describe, expect, it } from "vitest";
import { groupGestures } from "../src/trace/gestures.js";
import type { TraceEvent } from "../src/trace/types.js";

const ev = (tMono: number, kind: string, x?: number, y?: number, data?: unknown): TraceEvent => ({
  tMono,
  kind,
  x: x ?? null,
  y: y ?? null,
  data: data ?? null,
});

describe("groupGestures — pointer", () => {
  it("groups down/up without movement into a click", () => {
    const { gestures } = groupGestures([
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(160, "mouse_up", 11, 10, { button: 1 }),
    ]);
    expect(gestures).toEqual([
      { type: "click", point: { x: 10, y: 10 }, button: 1, count: 1, tMonoStart: 100, tMonoEnd: 160 },
    ]);
  });

  it("merges two nearby clicks into one double click", () => {
    const { gestures } = groupGestures([
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(140, "mouse_up", 10, 10, { button: 1 }),
      ev(220, "mouse_down", 12, 11, { button: 1 }),
      ev(260, "mouse_up", 12, 11, { button: 1 }),
    ]);
    expect(gestures).toHaveLength(1);
    expect(gestures[0]).toMatchObject({ type: "click", count: 2, tMonoEnd: 260 });
  });

  it("does not merge clicks that are far apart in space", () => {
    const { gestures } = groupGestures([
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(140, "mouse_up", 10, 10, { button: 1 }),
      ev(220, "mouse_down", 400, 400, { button: 1 }),
      ev(260, "mouse_up", 400, 400, { button: 1 }),
    ]);
    expect(gestures).toHaveLength(2);
    expect(gestures.every((g) => g.type === "click" && g.count === 1)).toBe(true);
  });

  it("groups down/move/up past the threshold into a drag carrying its samples", () => {
    const { gestures } = groupGestures([
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(120, "mouse_move", 30, 14),
      ev(140, "mouse_move", 60, 22),
      ev(160, "mouse_up", 90, 30, { button: 1 }),
    ]);
    expect(gestures).toHaveLength(1);
    const g = gestures[0]!;
    expect(g.type).toBe("drag");
    if (g.type !== "drag") throw new Error("expected drag");
    expect(g.from).toEqual({ x: 10, y: 10 });
    expect(g.to).toEqual({ x: 90, y: 30 });
    // Samples span the button-down interval, endpoints included.
    expect(g.samples).toHaveLength(4);
    expect(g.samples[0]).toEqual({ x: 10, y: 10, tMono: 100 });
    expect(g.samples.at(-1)).toEqual({ x: 90, y: 30, tMono: 160 });
  });

  it("ignores movement outside the button-down interval", () => {
    const { gestures } = groupGestures([
      ev(50, "mouse_move", 0, 0),
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(120, "mouse_move", 60, 22),
      ev(160, "mouse_up", 90, 30, { button: 1 }),
      ev(200, "mouse_move", 500, 500),
    ]);
    const drag = gestures.find((g) => g.type === "drag");
    expect(drag && drag.type === "drag" && drag.samples).toHaveLength(3);
  });

  it("warns and drops a down with no matching up", () => {
    const { gestures, warnings } = groupGestures([
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(120, "mouse_move", 30, 14),
    ]);
    expect(gestures.filter((g) => g.type === "click" || g.type === "drag")).toHaveLength(0);
    expect(warnings.join(" ")).toMatch(/mouse_down/);
  });

  it("emits a hover when the pointer dwells without clicking", () => {
    const { gestures } = groupGestures([
      ev(0, "mouse_move", 50, 50),
      ev(1200, "mouse_move", 51, 50),
      ev(1300, "mouse_down", 51, 50, { button: 1 }),
      ev(1340, "mouse_up", 51, 50, { button: 1 }),
    ]);
    expect(gestures[0]).toMatchObject({ type: "hover", dwellMs: 1200 });
    expect(gestures[1]).toMatchObject({ type: "click" });
  });

  it("coalesces a scroll burst into one gesture with summed delta", () => {
    const { gestures } = groupGestures([
      ev(100, "scroll", 200, 300, { rotation: -3, direction: 3 }),
      ev(160, "scroll", 200, 300, { rotation: -3, direction: 3 }),
      ev(220, "scroll", 200, 300, { rotation: -2, direction: 3 }),
    ]);
    expect(gestures).toHaveLength(1);
    expect(gestures[0]).toMatchObject({ type: "scroll", steps: 3, delta: { x: 0, y: -8 } });
  });

  it("splits scroll bursts separated by more than the coalesce window", () => {
    const { gestures } = groupGestures([
      ev(100, "scroll", 200, 300, { rotation: -3, direction: 3 }),
      ev(900, "scroll", 200, 300, { rotation: -3, direction: 3 }),
    ]);
    expect(gestures.filter((g) => g.type === "scroll")).toHaveLength(2);
  });
});

describe("groupGestures — keyboard", () => {
  it("coalesces printable keys into one text gesture", () => {
    const { gestures } = groupGestures([
      ev(100, "key_down", undefined, undefined, { keycode: 30, char: "h" }),
      ev(110, "key_up", undefined, undefined, { keycode: 30, char: "h" }),
      ev(160, "key_down", undefined, undefined, { keycode: 18, char: "i" }),
      ev(170, "key_up", undefined, undefined, { keycode: 18, char: "i" }),
    ]);
    expect(gestures).toEqual([{ type: "text", text: "hi", tMonoStart: 100, tMonoEnd: 170 }]);
  });

  it("emits a chord when modifiers are held", () => {
    const { gestures } = groupGestures([
      ev(100, "key_down", undefined, undefined, { keycode: 31, char: "s", modifiers: ["cmd"] }),
      ev(120, "key_up", undefined, undefined, { keycode: 31, char: "s", modifiers: ["cmd"] }),
    ]);
    expect(gestures).toEqual([{ type: "chord", keys: ["cmd", "s"], tMonoStart: 100, tMonoEnd: 120 }]);
  });

  it("warns and emits nothing for a key event with no resolved char", () => {
    const { gestures, warnings } = groupGestures([
      ev(100, "key_down", undefined, undefined, { keycode: 30 }),
      ev(110, "key_up", undefined, undefined, { keycode: 30 }),
    ]);
    expect(gestures).toHaveLength(0);
    expect(warnings.join(" ")).toMatch(/char/);
  });

  it("splits a text run at a focus change", () => {
    const { gestures } = groupGestures([
      ev(100, "key_down", undefined, undefined, { keycode: 1, char: "a" }),
      ev(110, "key_up", undefined, undefined, { keycode: 1, char: "a" }),
      ev(200, "focus_change", undefined, undefined, { app: "Mail" }),
      ev(300, "key_down", undefined, undefined, { keycode: 2, char: "b" }),
      ev(310, "key_up", undefined, undefined, { keycode: 2, char: "b" }),
    ]);
    expect(gestures.filter((g) => g.type === "text")).toEqual([
      { type: "text", text: "a", tMonoStart: 100, tMonoEnd: 110 },
      { type: "text", text: "b", tMonoStart: 300, tMonoEnd: 310 },
    ]);
  });
});

describe("groupGestures — idle", () => {
  it("emits an idle gesture for a gap above the threshold", () => {
    const { gestures } = groupGestures([
      ev(100, "mouse_down", 10, 10, { button: 1 }),
      ev(140, "mouse_up", 10, 10, { button: 1 }),
      ev(5000, "mouse_down", 10, 10, { button: 1 }),
      ev(5040, "mouse_up", 10, 10, { button: 1 }),
    ]);
    expect(gestures[1]).toMatchObject({ type: "idle", durationMs: 4860 });
  });

  it("emits nothing for an empty stream", () => {
    expect(groupGestures([])).toEqual({ gestures: [], warnings: [] });
  });
});
