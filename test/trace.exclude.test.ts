import { describe, expect, it } from "vitest";
import {
  excludeFocusedApps,
  excludedByName,
  focusOf,
} from "../src/trace/exclude.js";
import type { TraceEvent } from "../src/trace/types.js";

const ev = (tMono: number, kind: string, data?: unknown): TraceEvent => ({
  tMono,
  kind,
  x: null,
  y: null,
  data: data ?? null,
});

const focus = (tMono: number, app: string, extra: Record<string, unknown> = {}): TraceEvent =>
  ev(tMono, "focus_change", { app, title: `${app} window`, ...extra });

const isDeskRag = excludedByName(["DeskRAG", "Electron", "com.deskrag.app"]);

/**
 * The shape every recording actually has: the recorder is frontmost when Record
 * is pressed and frontmost again when Stop is pressed, so it brackets the work.
 */
const bracketed: TraceEvent[] = [
  ev(0, "mouse_move"),
  focus(120, "Electron"),
  ev(200, "mouse_down"),
  focus(3000, "Calculator"),
  ev(3200, "mouse_down"),
  ev(3400, "key_down"),
  focus(9000, "TextEdit"),
  ev(9200, "key_down"),
  focus(15000, "Electron"),
  ev(15200, "mouse_down"),
  ev(15300, "session_end"),
];

describe("excludeFocusedApps", () => {
  it("drops the leading and trailing recorder stretches, keeping the work between", () => {
    const r = excludeFocusedApps(bracketed, isDeskRag);
    expect(r.events.map((e) => e.tMono)).toEqual([3000, 3200, 3400, 9000, 9200]);
    expect(r.unattributable).toBe(false);
  });

  it("drops the excluded focus_change itself and keeps the arrival at real work", () => {
    const r = excludeFocusedApps(bracketed, isDeskRag);
    const focuses = r.events.filter((e) => e.kind === "focus_change");
    // Keeping the excluded one would build a node carrying app(Electron) — the
    // card this whole filter exists to remove.
    expect(focuses.map((e) => (e.data as { app: string }).app)).toEqual([
      "Calculator",
      "TextEdit",
    ]);
  });

  it("drops a mid-recording visit to the recorder, not just the bookends", () => {
    const events: TraceEvent[] = [
      focus(0, "Electron"),
      focus(1000, "Calculator"),
      ev(1200, "mouse_down"),
      focus(4000, "Electron"),
      // Checking the signal meters. These clicks land on the recorder's own UI,
      // so leaving them in would anchor actions to it.
      ev(4200, "mouse_down"),
      ev(4400, "mouse_down"),
      focus(6000, "Calculator"),
      ev(6200, "mouse_down"),
    ];
    const r = excludeFocusedApps(events, isDeskRag);
    expect(r.events.map((e) => e.tMono)).toEqual([1000, 1200, 6000, 6200]);
    expect(r.dropped).toBe(4);
  });

  it("drops everything before the first focus_change", () => {
    // A session begins with a button press inside the recorder, so the preamble
    // is overhead by construction — and leaving it in re-pins the timeline's
    // left edge at a moment with no state behind it.
    const r = excludeFocusedApps(bracketed, isDeskRag);
    expect(r.events.some((e) => e.tMono < 3000)).toBe(false);
  });

  it("reports what was dropped, first-seen order and no repeats", () => {
    const r = excludeFocusedApps(bracketed, isDeskRag);
    expect(r.apps).toEqual(["Electron"]);
    expect(r.dropped).toBe(bracketed.length - r.events.length);
  });

  it("is a NO-OP when the stream carries no focus_change at all", () => {
    // active-win off: nothing can be attributed to an application, and a walk
    // that started excluded would drop the whole recording.
    const events = [ev(0, "mouse_move"), ev(100, "mouse_down"), ev(200, "key_down")];
    const r = excludeFocusedApps(events, isDeskRag);
    expect(r.events).toEqual(events);
    expect(r.dropped).toBe(0);
    expect(r.unattributable).toBe(true);
  });

  it("keeps everything when nothing is excluded", () => {
    const r = excludeFocusedApps(bracketed, () => false);
    expect(r.events).toEqual(bracketed);
    expect(r.dropped).toBe(0);
    expect(r.apps).toEqual([]);
  });

  it("can empty a recording that never left the recorder", () => {
    const events = [focus(0, "Electron"), ev(100, "mouse_down"), ev(200, "mouse_down")];
    expect(excludeFocusedApps(events, isDeskRag).events).toEqual([]);
  });
});

describe("excludedByName", () => {
  it("matches on app name, case-insensitively", () => {
    expect(isDeskRag({ app: "electron" })).toBe(true);
    expect(isDeskRag({ app: "Calculator" })).toBe(false);
  });

  it("matches on bundle id, which is what a packaged build reports", () => {
    expect(isDeskRag({ app: "DeskRAG", bundleId: "com.deskrag.app" })).toBe(true);
    expect(isDeskRag({ app: "Numbers", bundleId: "com.apple.iWork.Numbers" })).toBe(false);
  });

  it("honours the capture-time flag whatever the app is called", () => {
    // The exact half: a build whose name is in nobody's list still says so.
    expect(isDeskRag({ app: "Some Renamed Build", recorder: true })).toBe(true);
  });

  it("ignores blank entries rather than matching an app with no name", () => {
    const anyBlank = excludedByName(["", "   "]);
    expect(anyBlank({ app: "" })).toBe(false);
    expect(anyBlank({ app: "Calculator" })).toBe(false);
  });
});

describe("focusOf", () => {
  it("reads only the three fields the predicate is entitled to", () => {
    expect(
      focusOf(focus(0, "Electron", { bundleId: "com.github.Electron", pid: 42, recorder: true })),
    ).toEqual({ app: "Electron", bundleId: "com.github.Electron", recorder: true });
  });

  it("survives an event with no data at all", () => {
    expect(focusOf({ tMono: 0, kind: "focus_change", x: null, y: null, data: null })).toEqual({});
  });
});

/**
 * The filter and the lift are useless apart: filtering removes the recorder's
 * events, and `startTMono` is what stops `computeBoundaries` re-pinning the left
 * edge at zero and manufacturing the stateless node all over again.
 */
describe("filtered events, lifted", () => {
  it("produces no stateless leading node once the left edge moves with them", async () => {
    const { liftTrace } = await import("../src/trace/lift.js");
    const r = excludeFocusedApps(bracketed, isDeskRag);
    const endTMono = r.events[r.events.length - 1]!.tMono;

    const pinnedAtZero = liftTrace({
      sessionId: "s",
      events: r.events,
      endTMono,
    });
    // Without it: a boundary at 0, before every surviving event, with nothing
    // behind it to extract a predicate from.
    expect(pinnedAtZero.nodes[0]!.predicates).toEqual([]);

    const lifted = liftTrace({
      sessionId: "s",
      events: r.events,
      endTMono,
      startTMono: r.events[0]!.tMono,
    });
    expect(lifted.nodes.every((n) => n.id !== "s:n0" || n.predicates.length > 0)).toBe(true);
    // And the recorder is nowhere in the app predicates.
    const apps = lifted.nodes.flatMap((n) =>
      n.predicates.filter((p) => p.kind === "app").map((p) => String(p.args["app"])),
    );
    expect(apps).not.toContain("Electron");
    expect(apps).toContain("Calculator");
  });
});

/**
 * The whole point, end to end: a route's key is its place-label sequence, so the
 * recorder brackets EVERY route until it is filtered out — which is what made
 * unrelated tasks look like they pass through a shared hub.
 */
describe("route keys, once the recorder is gone", () => {
  const routeKeyOf = async (events: readonly TraceEvent[], filter: boolean): Promise<string> => {
    const { liftTrace } = await import("../src/trace/lift.js");
    const { mergeTrace } = await import("../src/trace/merge.js");
    const { frequentRoutes } = await import("../app/src/main/graph-view.js");
    const r = filter
      ? excludeFocusedApps(events, isDeskRag)
      : { events: [...events] as TraceEvent[] };
    const trace = liftTrace({
      sessionId: "s1",
      events: r.events,
      startTMono: r.events[0]!.tMono,
      endTMono: r.events[r.events.length - 1]!.tMono,
    });
    const routes = frequentRoutes(await mergeTrace(undefined, trace));
    return routes[0]?.label ?? "";
  };

  it("no longer opens and closes on the recorder", async () => {
    expect(await routeKeyOf(bracketed, false)).toContain("Electron");
    const filtered = await routeKeyOf(bracketed, true);
    expect(filtered).not.toContain("Electron");
    expect(filtered).toBe("Calculator → TextEdit");
  });
});
