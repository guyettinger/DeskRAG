import { describe, expect, it } from "vitest";
import { ActiveWindowProducer, type WindowSnapshot } from "../src/capture/producers/active-window.js";
import { FakeDisplaySource } from "../src/capture/env/fake.js";
import type { DisplayInfo } from "../src/capture/env/types.js";
import type { CaptureContext, EmittedEvent } from "../src/capture/types.js";
import { MonotonicClock } from "../src/timeline/clock.js";

const primary: DisplayInfo = { id: "1", x: 0, y: 0, w: 2560, h: 1440, scale: 2, primary: true };
const right: DisplayInfo = { id: "2", x: 2560, y: 0, w: 1920, h: 1080, scale: 1, primary: false };

/** A producer whose window query is scripted rather than native. */
class ScriptedProducer extends ActiveWindowProducer {
  private i = 0;
  constructor(
    private readonly script: (WindowSnapshot | undefined)[],
    opts: ConstructorParameters<typeof ActiveWindowProducer>[0] = {},
  ) {
    super(opts);
  }
  protected override async queryWindow(): Promise<WindowSnapshot | undefined> {
    return this.script[Math.min(this.i++, this.script.length - 1)];
  }
}

function harness(): { ctx: CaptureContext; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  const ctx = {
    sessionId: "s1",
    clock: MonotonicClock.start(),
    emitEvent: (ev: EmittedEvent) => void events.push(ev),
    ingestFrame: async () => ({ kept: false }),
    ingestAudio: async () => {},
    reserveBlob: async () => null,
    commitBlob: async () => {},
  } as unknown as CaptureContext;
  return { ctx, events };
}

const win = (app: string, title: string, bounds: WindowSnapshot["bounds"]): WindowSnapshot => ({
  app,
  title,
  windowId: 1,
  bundleId: `com.example.${app}`,
  ...(bounds !== undefined ? { bounds } : {}),
});

describe("ActiveWindowProducer", () => {
  it("emits the enriched focus_change payload", async () => {
    const { ctx, events } = harness();
    const p = new ScriptedProducer([win("Mail", "Inbox", { x: 10, y: 20, w: 800, h: 600 })]);
    await p.pollOnce(ctx);
    const focus = events.find((e) => e.kind === "focus_change");
    expect(focus?.data).toMatchObject({
      app: "Mail",
      title: "Inbox",
      bundleId: "com.example.Mail",
      bounds: { x: 10, y: 20, w: 800, h: 600 },
    });
  });

  it("emits display_change once at first poll, before any focus_change", async () => {
    const { ctx, events } = harness();
    const displays = new FakeDisplaySource([primary]);
    const p = new ScriptedProducer([win("Mail", "Inbox", { x: 10, y: 20, w: 800, h: 600 })], {
      displaySource: displays,
    });
    await p.pollOnce(ctx);
    expect(events[0]?.kind).toBe("display_change");
    expect(events[0]?.data).toEqual({ displays: [primary] });
    expect(displays.queries).toBe(1);
  });

  it("does not re-emit display_change while the topology is unchanged", async () => {
    const { ctx, events } = harness();
    const displays = new FakeDisplaySource([primary]);
    const p = new ScriptedProducer(
      [win("Mail", "A", { x: 0, y: 0, w: 100, h: 100 }), win("Mail", "B", { x: 5, y: 5, w: 100, h: 100 })],
      { displaySource: displays },
    );
    await p.pollOnce(ctx);
    await p.pollOnce(ctx);
    expect(events.filter((e) => e.kind === "display_change")).toHaveLength(1);
    expect(displays.queries).toBe(1);
  });

  it("RE-QUERIES when a window lands outside every known display", async () => {
    const { ctx, events } = harness();
    const displays = new FakeDisplaySource([primary]);
    const p = new ScriptedProducer(
      [
        win("Mail", "A", { x: 0, y: 0, w: 100, h: 100 }),
        win("Mail", "B", { x: 3000, y: 100, w: 400, h: 300 }), // off the known display
      ],
      { displaySource: displays },
    );
    await p.pollOnce(ctx);
    displays.set([primary, right]); // a monitor was plugged in
    await p.pollOnce(ctx);

    const changes = events.filter((e) => e.kind === "display_change");
    expect(changes).toHaveLength(2);
    expect(changes[1]!.data).toEqual({ displays: [primary, right] });
    expect(displays.queries).toBe(2);
  });

  it("keeps the previous topology when a re-query returns nothing", async () => {
    const { ctx, events } = harness();
    const displays = new FakeDisplaySource([primary]);
    const p = new ScriptedProducer(
      [
        win("Mail", "A", { x: 0, y: 0, w: 100, h: 100 }),
        win("Mail", "B", { x: 3000, y: 100, w: 400, h: 300 }),
      ],
      { displaySource: displays },
    );
    await p.pollOnce(ctx);
    displays.set([]); // the sidecar failed
    await p.pollOnce(ctx);
    // Stale beats empty: no second display_change, and no wiping of what we knew.
    expect(events.filter((e) => e.kind === "display_change")).toHaveLength(1);
  });

  it("works with no display source at all", async () => {
    const { ctx, events } = harness();
    const p = new ScriptedProducer([win("Mail", "Inbox", { x: 0, y: 0, w: 10, h: 10 })]);
    await p.pollOnce(ctx);
    expect(events.filter((e) => e.kind === "display_change")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "focus_change")).toHaveLength(1);
  });

  it("does not re-emit focus_change for an unchanged window", async () => {
    const { ctx, events } = harness();
    const p = new ScriptedProducer([win("Mail", "Inbox", { x: 0, y: 0, w: 10, h: 10 })]);
    await p.pollOnce(ctx);
    await p.pollOnce(ctx);
    expect(events.filter((e) => e.kind === "focus_change")).toHaveLength(1);
  });

  it("survives a query that yields nothing", async () => {
    const { ctx, events } = harness();
    const p = new ScriptedProducer([undefined]);
    await p.pollOnce(ctx);
    expect(events).toHaveLength(0);
  });
});
