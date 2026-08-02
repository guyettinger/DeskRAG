import { describe, expect, it } from "vitest";
import { liftTrace } from "../src/trace/lift.js";
import type { TraceEvent } from "../src/trace/types.js";
import type { UIElement } from "../src/embed/types.js";

const el = (over: Partial<UIElement>): UIElement => ({
  role: "Button",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  ...over,
});

/**
 * One touched control, and page furniture the recording never goes near.
 *
 * Laid out so they do NOT overlap: the click below lands at (5,5), and with
 * every element stacked at the origin the anchor resolves to whichever one wins
 * a tie — which tests the tie-break, not identity.
 */
const TREE: UIElement[] = [
  el({ role: "Button", label: "Files changed", x: 0, y: 0, w: 20, h: 20 }),
  el({ role: "Button", label: "assign yourself", x: 100, y: 100 }),
  el({ role: "Button", label: "Reviewers", x: 200, y: 200 }),
  el({ role: "Button", label: "Copy head branch name to clipboard", x: 300, y: 300 }),
];

const ev = (tMono: number, kind: string, data: unknown, x: number | null = null): TraceEvent => ({
  tMono,
  kind,
  x,
  y: x,
  data,
});

const events: TraceEvent[] = [
  ev(0, "focus_change", { app: "Google Chrome", title: "PR" }),
  ev(10, "mouse_down", { button: 0 }, 5),
  ev(60, "mouse_up", { button: 0 }, 5),
  ev(5000, "session_end", {}),
];

const lift = (): ReturnType<typeof liftTrace> =>
  liftTrace({ sessionId: "s1", events, endTMono: 5000, axAt: () => ({ elements: TREE }) });

const axLabels = (trace: ReturnType<typeof liftTrace>): string[] =>
  trace.nodes.flatMap((n) =>
    n.predicates
      .filter((q) => q.kind === "ax_exists")
      .map((q) => String(q.args["label"] ?? q.args["identifier"])),
  );

describe("lift produces task-derived identity", () => {
  it("drops page content the task never touched", () => {
    // This is the measured failure: a node absorbed 18 predicates that were the
    // contents of one GitHub pull-request page, so it could only be re-entered
    // with that exact PR open.
    const labels = axLabels(lift());
    expect(labels).not.toContain("assign yourself");
    expect(labels).not.toContain("Reviewers");
    expect(labels).not.toContain("Copy head branch name to clipboard");
  });

  it("still carries the app on every node", () => {
    expect(lift().nodes.every((n) => n.predicates.some((q) => q.kind === "app"))).toBe(true);
  });

  it("keeps every node far below the observed tree's predicate count", () => {
    // The tree yields four ax_exists predicates; identity should use at most the
    // one the task touches.
    for (const n of lift().nodes) expect(n.predicates.length).toBeLessThanOrEqual(2);
  });

  it("produces a graph at all — narrowing must not empty it", () => {
    const trace = lift();
    expect(trace.nodes.length).toBeGreaterThan(1);
    expect(trace.edges.length).toBeGreaterThan(0);
  });
});
