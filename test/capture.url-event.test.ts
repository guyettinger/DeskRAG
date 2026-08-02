import { describe, expect, it } from "vitest";
import { liftTrace } from "../src/trace/lift.js";
import type { TraceEvent } from "../src/trace/types.js";

const ev = (tMono: number, kind: string, data: unknown, x: number | null = null): TraceEvent => ({
  tMono,
  kind,
  x,
  y: x,
  data,
});

const urlsIn = (trace: ReturnType<typeof liftTrace>): (string | number | boolean)[] =>
  trace.nodes.flatMap((n) => n.predicates.filter((q) => q.kind === "url").map((q) => q.args.prefix!));

describe("url_change events reach node identity", () => {
  it("resolves the latest url at-or-before the boundary", () => {
    const events: TraceEvent[] = [
      ev(0, "focus_change", { app: "Google Chrome", title: "PR" }),
      ev(1, "url_change", { url: "https://github.com/o/r/pull/27" }),
      ev(10, "mouse_down", { button: 0 }, 5),
      ev(60, "mouse_up", { button: 0 }, 5),
      ev(5000, "session_end", {}),
    ];
    const trace = liftTrace({
      sessionId: "s",
      events,
      endTMono: 5000,
      axAt: () => ({ elements: [] }),
    });
    expect(urlsIn(trace)).toContain("github.com/o/r/pull");
  });

  it("adopts a later url_change without a focus change", () => {
    // Navigation within one browser: the app never changes, only the page.
    const events: TraceEvent[] = [
      ev(0, "focus_change", { app: "Google Chrome", title: "PR" }),
      ev(1, "url_change", { url: "https://github.com/o/r/pull/27" }),
      ev(10, "mouse_down", { button: 0 }, 5),
      ev(60, "mouse_up", { button: 0 }, 5),
      ev(100, "url_change", { url: "https://github.com/o/r/issues" }),
      ev(5000, "session_end", {}),
    ];
    const trace = liftTrace({
      sessionId: "s",
      events,
      endTMono: 5000,
      axAt: () => ({ elements: [] }),
    });
    expect(urlsIn(trace)).toContain("github.com/o/r/issues");
  });

  it("drops the url when focus moves to another application", () => {
    // A browser's page does not describe a text editor's state.
    const events: TraceEvent[] = [
      ev(0, "focus_change", { app: "Google Chrome", title: "PR" }),
      ev(1, "url_change", { url: "https://github.com/o/r/pull/27" }),
      ev(10, "mouse_down", { button: 0 }, 5),
      ev(60, "mouse_up", { button: 0 }, 5),
      ev(100, "focus_change", { app: "TextEdit", title: "Untitled" }),
      ev(5000, "session_end", {}),
    ];
    const trace = liftTrace({
      sessionId: "s",
      events,
      endTMono: 5000,
      axAt: () => ({ elements: [] }),
    });
    const last = trace.nodes[trace.nodes.length - 1]!;
    expect(last.predicates.some((q) => q.kind === "url")).toBe(false);
  });

  it("carries no url predicate when none was ever recorded", () => {
    const events: TraceEvent[] = [
      ev(0, "focus_change", { app: "TextEdit", title: "Untitled" }),
      ev(10, "mouse_down", { button: 0 }, 5),
      ev(60, "mouse_up", { button: 0 }, 5),
      ev(5000, "session_end", {}),
    ];
    const trace = liftTrace({
      sessionId: "s",
      events,
      endTMono: 5000,
      axAt: () => ({ elements: [] }),
    });
    expect(urlsIn(trace)).toHaveLength(0);
  });
});

describe("url_change is stamped with the boundary, not the walk", () => {
  it("uses boundaryTMono when the walk was boundary-triggered", async () => {
    const { AxCapturer } = await import("../src/capture/ax/ax-capturer.js");
    const stamps: { url: string; tMono: number }[] = [];
    const store = { putAxSnapshot: async (): Promise<void> => {} };
    const source = {
      query: async () => [],
      walk: async () => ({ elements: [], url: "https://example.com/a" }),
    };
    // The walk always post-dates its boundary by the settle delay; here the
    // clock reads 1250 while the boundary being described was at 1000.
    const cap = new AxCapturer(store, source, "s1", () => 1250, (url, tMono) =>
      stamps.push({ url, tMono }),
    );
    await cap.capture("focus_change", undefined, 1000);
    expect(stamps).toEqual([{ url: "https://example.com/a", tMono: 1000 }]);
  });

  it("falls back to the walk's own time for a keyframe walk, which has no boundary", async () => {
    const { AxCapturer } = await import("../src/capture/ax/ax-capturer.js");
    const stamps: { url: string; tMono: number }[] = [];
    const store = { putAxSnapshot: async (): Promise<void> => {} };
    const source = {
      query: async () => [],
      walk: async () => ({ elements: [], url: "https://example.com/a" }),
    };
    const cap = new AxCapturer(store, source, "s1", () => 1250, (url, tMono) =>
      stamps.push({ url, tMono }),
    );
    await cap.capture("keyframe", "f1");
    expect(stamps[0]?.tMono).toBe(1250);
  });

  it("announces only CHANGES, so a settled page emits one event", async () => {
    const { AxCapturer } = await import("../src/capture/ax/ax-capturer.js");
    const stamps: string[] = [];
    const store = { putAxSnapshot: async (): Promise<void> => {} };
    const source = {
      query: async () => [],
      walk: async () => ({ elements: [], url: "https://example.com/a" }),
    };
    const cap = new AxCapturer(store, source, "s1", () => 1, (url) => stamps.push(url));
    await cap.capture("focus_change", undefined, 1);
    await cap.capture("focus_change", undefined, 2);
    expect(stamps).toHaveLength(1);
  });
});
