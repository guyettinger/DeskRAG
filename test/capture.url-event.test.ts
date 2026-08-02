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
