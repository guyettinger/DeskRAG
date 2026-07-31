import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore, CaptureSession, SyntheticInputProducer, type EmittedEvent } from "deskrag";
import { DEFAULT_GRAPH_ID, indexTrace } from "../src/main/trace-index.js";

/** The US layout entries the tests type against: vk0 = A, vk1 = S. */
const usKeymap = {
  layoutId: "com.apple.keylayout.US",
  entries: { 0: ["a", "A", "å", "Å"], 1: ["s", "S", "ß", "Í"] },
};

const displays = [{ id: "D1", x: 0, y: 0, w: 2560, h: 1440, scale: 2, primary: true }];

let dir: string;
let store: DualStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "deskrag-traceidx-"));
  store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Record a session from a scripted event list, then index its trace. */
async function record(events: EmittedEvent[]): Promise<{ sessionId: string }> {
  const session = new CaptureSession(store);
  session.addProducer(new SyntheticInputProducer("script", events));
  const sessionId = await session.start();
  await session.stop();
  return { sessionId };
}

/** A click at (x, y): down then up, no movement. */
const click = (tMono: number, x: number, y: number): EmittedEvent[] => [
  { kind: "mouse_down", x, y, data: { button: 1 }, tMono },
  { kind: "mouse_up", x, y, data: { button: 1 }, tMono: tMono + 40 },
];

/** Type one character by scancode, with modifiers. */
const key = (tMono: number, keycode: number, modifiers: string[] = []): EmittedEvent[] => [
  { kind: "key_down", data: { keycode, modifiers }, tMono },
  { kind: "key_up", data: { keycode, modifiers }, tMono: tMono + 10 },
];

describe("indexTrace", () => {
  it("returns undefined for a session with no events", async () => {
    const session = new CaptureSession(store);
    const sessionId = await session.start();
    await session.stop();
    expect(await indexTrace(store, sessionId)).toBeUndefined();
  });

  it("lifts clicks into a graph and persists it under the shared id", async () => {
    const { sessionId } = await record([
      { kind: "keymap_change", data: usKeymap, tMono: 0 },
      ...click(100, 500, 300),
      ...click(2000, 700, 400),
    ]);

    const result = await indexTrace(store, sessionId);
    expect(result).toBeDefined();
    expect(result!.actions).toBeGreaterThanOrEqual(2);
    expect(result!.missingKeymap).toBe(false);

    const graph = store.getGraph(DEFAULT_GRAPH_ID);
    expect(graph).toBeDefined();
    expect(graph!.id).toBe(DEFAULT_GRAPH_ID);
    expect(graph!.nodes.length).toBe(result!.nodes);
  });

  it("RESOLVES TYPED TEXT — the whole point of the chain", async () => {
    const { sessionId } = await record([
      { kind: "keymap_change", data: usKeymap, tMono: 0 },
      ...key(100, 30, ["shift"]), // capital A
      ...key(200, 31), // s
    ]);

    await indexTrace(store, sessionId);
    const graph = store.getGraph(DEFAULT_GRAPH_ID)!;
    const typed = graph.edges
      .flatMap((e) => e.actions)
      .filter((a): a is Extract<typeof a, { kind: "type" }> => a.kind === "type");

    expect(typed).toHaveLength(1);
    // Capital A is TEXT, not the chord shift+A — the regression the design found.
    expect(typed[0]!.recorded).toBe("As");
    expect(graph.slots.map((s) => s.samples)).toEqual([["As"]]);
  });

  it("reports missingKeymap when no layout was ever captured", async () => {
    const { sessionId } = await record([...key(100, 30)]);
    const result = await indexTrace(store, sessionId);
    // No events other than keys, so a trace still forms — but with no text.
    expect(result?.missingKeymap).toBe(true);
    const graph = store.getGraph(DEFAULT_GRAPH_ID);
    expect(graph?.edges.flatMap((e) => e.actions).some((a) => a.kind === "type")).toBe(false);
  });

  it("resolves a point against the display topology in force", async () => {
    const { sessionId } = await record([
      { kind: "display_change", data: { displays }, tMono: 0 },
      ...click(100, 500, 300),
    ]);
    await indexTrace(store, sessionId);
    const graph = store.getGraph(DEFAULT_GRAPH_ID)!;
    const clicked = graph.edges.flatMap((e) => e.actions).find((a) => a.kind === "click");
    if (clicked?.kind !== "click") throw new Error("expected a click");
    expect(clicked.anchor.point.displayId).toBe("D1");
  });

  it("falls back to D0 when no display topology was captured", async () => {
    const { sessionId } = await record([...click(100, 500, 300)]);
    await indexTrace(store, sessionId);
    const graph = store.getGraph(DEFAULT_GRAPH_ID)!;
    const clicked = graph.edges.flatMap((e) => e.actions).find((a) => a.kind === "click");
    if (clicked?.kind !== "click") throw new Error("expected a click");
    expect(clicked.anchor.point.displayId).toBe("D0");
  });

  it("records window-relative coordinates from focus_change bounds", async () => {
    const { sessionId } = await record([
      { kind: "focus_change", data: { app: "Mail", title: "Inbox", bounds: { x: 100, y: 50, w: 800, h: 600 } }, tMono: 0 },
      ...click(500, 300, 200),
    ]);
    await indexTrace(store, sessionId);
    const graph = store.getGraph(DEFAULT_GRAPH_ID)!;
    const clicked = graph.edges.flatMap((e) => e.actions).find((a) => a.kind === "click");
    if (clicked?.kind !== "click") throw new Error("expected a click");
    expect(clicked.anchor.point.windowRelative).toEqual({ x: 200, y: 150 });
  });

  it("ACCRETES across sessions rather than replacing the graph", async () => {
    const script = (text: number): EmittedEvent[] => [
      { kind: "keymap_change", data: usKeymap, tMono: 0 },
      ...click(100, 500, 300),
      ...key(200, text),
    ];

    const first = await record(script(30)); // types "a"
    const a = await indexTrace(store, first.sessionId);

    const second = await record(script(31)); // types "s"
    const b = await indexTrace(store, second.sessionId);

    // One graph, and the second session did not create a parallel copy of it.
    expect(store.listGraphs()).toHaveLength(1);
    expect(b!.nodes).toBe(a!.nodes);

    // The two typed values collapsed into ONE slot with two samples — variables
    // are discovered by recording twice, not declared.
    const graph = store.getGraph(DEFAULT_GRAPH_ID)!;
    expect(graph.slots).toHaveLength(1);
    expect(graph.slots[0]!.samples.sort()).toEqual(["a", "s"]);
    expect(b!.variables).toBe(1);
  });
});
