import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundaryAxTrigger } from "../src/capture/ax/boundary.js";
import { CaptureSession } from "../src/capture/session.js";
import { FakeDeviceClockSource } from "../src/capture/env/fake.js";
import { SyntheticInputProducer } from "../src/capture/synthetic.js";
import { DualStore } from "../src/store/store.js";
import type { AxSource } from "../src/capture/ax/types.js";
import type { AxSnapshotReason } from "../src/store/types.js";
import type { UIElement } from "../src/embed/types.js";

const flushTimers = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("BoundaryAxTrigger", () => {
  // The walk lands AFTER the boundary (settle delay + walk budget), so the
  // snapshot's own t_mono can never identify the boundary it was taken for.
  // Carrying the boundary's t_mono through is what lets lift match exactly
  // instead of looking backwards and finding the previous state's tree.
  it("reports the t_mono of the boundary that armed it", async () => {
    vi.useFakeTimers();
    const fired: { reason: string; boundaryTMono: number }[] = [];
    const t = new BoundaryAxTrigger(
      async (reason, boundaryTMono) => void fired.push({ reason, boundaryTMono: boundaryTMono! }),
      { settleMs: 200 },
    );

    t.onEvent("focus_change", 6692);
    await flushTimers(250);
    expect(fired).toEqual([{ reason: "focus_change", boundaryTMono: 6692 }]);
    t.stop();
  });

  it("keeps the FIRST boundary's t_mono when a burst coalesces", async () => {
    vi.useFakeTimers();
    const fired: { reason: string; boundaryTMono: number }[] = [];
    const t = new BoundaryAxTrigger(
      async (reason, boundaryTMono) => void fired.push({ reason, boundaryTMono: boundaryTMono! }),
      { settleMs: 200 },
    );

    // The first reason in a burst wins; its t_mono must win with it, or the
    // stamp would name a boundary the walk was not actually armed by.
    t.onEvent("focus_change", 1000);
    t.onEvent("focus_change", 1010);
    t.onEvent("focus_change", 1020);
    await flushTimers(250);
    expect(fired).toEqual([{ reason: "focus_change", boundaryTMono: 1000 }]);
    t.stop();
  });

  it("fires after the settle delay, not at the instant of the trigger", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), { settleMs: 200 });

    t.onEvent("focus_change", 1000);
    expect(fired).toEqual([]);
    await flushTimers(199);
    expect(fired).toEqual([]);
    await flushTimers(2);
    expect(fired).toEqual(["focus_change"]);
    t.stop();
  });

  it("COALESCES a burst into one walk", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), { settleMs: 200 });

    for (let i = 0; i < 10; i++) t.onEvent("focus_change", 1000 + i * 10);
    await flushTimers(500);
    expect(fired).toHaveLength(1);
    t.stop();
  });

  it("does not start a second walk while one is in flight", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const t = new BoundaryAxTrigger(
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 300));
        inFlight -= 1;
      },
      { settleMs: 50 },
    );

    t.onEvent("focus_change", 0);
    await flushTimers(60);
    t.onEvent("bookmark", 100); // arrives mid-walk
    await flushTimers(400);
    expect(maxInFlight).toBe(1);
    t.stop();
  });

  it("triggers on bookmark", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), { settleMs: 10 });
    t.onEvent("bookmark", 500);
    await flushTimers(50);
    expect(fired).toEqual(["bookmark"]);
    t.stop();
  });

  it("triggers dwell_resume on the first input AFTER a gap, not on the gap itself", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), {
      settleMs: 10,
      dwellGapMs: 3000,
    });

    t.onEvent("mouse_down", 0);
    await flushTimers(50);
    expect(fired).toEqual([]); // ordinary input triggers nothing

    t.onEvent("mouse_down", 5000); // resumed after a 5s gap
    await flushTimers(50);
    expect(fired).toEqual(["dwell_resume"]);
    t.stop();
  });

  it("does not trigger dwell_resume for a gap below the threshold", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), {
      settleMs: 10,
      dwellGapMs: 3000,
    });
    t.onEvent("mouse_down", 0);
    t.onEvent("mouse_down", 1000);
    await flushTimers(50);
    expect(fired).toEqual([]);
    t.stop();
  });

  it("ignores non-boundary event kinds", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), { settleMs: 10 });
    t.onEvent("mouse_move", 0);
    t.onEvent("scroll", 10);
    t.onEvent("display_change", 20);
    await flushTimers(50);
    expect(fired).toEqual([]);
    t.stop();
  });

  it("stop() cancels a pending walk", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), { settleMs: 200 });
    t.onEvent("focus_change", 0);
    t.stop();
    await flushTimers(500);
    expect(fired).toEqual([]);
  });

  it("flush() runs a pending walk immediately, for session stop()", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), { settleMs: 10_000 });
    t.onEvent("focus_change", 0);
    await t.flush();
    expect(fired).toEqual(["focus_change"]);
    t.stop();
  });

  it("swallows a failing capture rather than sinking the session", async () => {
    vi.useFakeTimers();
    const t = new BoundaryAxTrigger(
      async () => {
        throw new Error("sidecar exploded");
      },
      { settleMs: 10 },
    );
    t.onEvent("focus_change", 0);
    await expect(flushTimers(50)).resolves.toBeUndefined();
    t.stop();
  });
});

/**
 * The wiring, end to end: CaptureSession is the only component that sees every
 * producer's events (emitEvent funnels through it), so it is what turns a
 * focus_change from one producer into an AX walk. Testing the trigger alone
 * cannot catch a wiring mistake.
 */
describe("CaptureSession drives boundary AX capture", () => {
  const button: UIElement = { role: "Button", label: "Send", x: 0, y: 0, w: 10, h: 10 };
  const fakeAx = (els: UIElement[]): AxSource => ({ query: async () => els });

  const withSession = async (
    events: { kind: string; data?: unknown }[],
    fn: (store: DualStore, sessionId: string) => void | Promise<void>,
  ): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "erag-axwire-"));
    const store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    try {
      const session = new CaptureSession(store, {
      deviceClockSource: new FakeDeviceClockSource(0),
        axSource: fakeAx([button]),
        // Long settle, so only stop()'s flush fires the walk — no wall-clock race.
        axSettleMs: 10_000,
      });
      session.addProducer(new SyntheticInputProducer("script", events));
      const sessionId = await session.start();
      await session.stop();
      await fn(store, sessionId);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("captures AX after a focus_change emitted by a producer", async () => {
    await withSession([{ kind: "focus_change", data: { app: "Mail" } }], (store, sessionId) => {
      const snap = store.getAxAt(sessionId, 1e9);
      expect(snap).toBeDefined();
      expect(snap!.reason).toBe("focus_change");
      expect(snap!.frameId).toBeNull(); // a boundary capture has no keyframe
      expect(snap!.elements).toEqual([button]);
    });
  });

  it("captures AX after a bookmark", async () => {
    await withSession([{ kind: "bookmark" }], (store, sessionId) => {
      expect(store.getAxAt(sessionId, 1e9)?.reason).toBe("bookmark");
    });
  });

  it("captures nothing when no boundary event occurs", async () => {
    await withSession(
      [
        { kind: "mouse_move" },
        { kind: "mouse_down" },
        { kind: "mouse_up" },
      ],
      (store, sessionId) => {
        expect(store.getAxAt(sessionId, 1e9)).toBeUndefined();
      },
    );
  });

  it("coalesces a burst of boundaries into a single stored snapshot", async () => {
    await withSession(
      Array.from({ length: 8 }, () => ({ kind: "focus_change", data: { app: "X" } })),
      (store, sessionId) => {
        // getAxAt returns one row; assert the table itself holds exactly one by
        // walking back from the tip.
        const first = store.getAxAt(sessionId, 1e9)!;
        expect(store.getAxAt(sessionId, first.tMono - 0.001)).toBeUndefined();
      },
    );
  });

  it("runs without an axSource at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "erag-axwire-"));
    const store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    try {
      const session = new CaptureSession(store, {
        deviceClockSource: new FakeDeviceClockSource(0),
      });
      session.addProducer(new SyntheticInputProducer("script", [{ kind: "focus_change" }]));
      const sessionId = await session.start();
      await session.stop();
      expect(store.getAxAt(sessionId, 1e9)).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
