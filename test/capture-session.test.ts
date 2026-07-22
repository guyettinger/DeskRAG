import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";
import { MonotonicClock } from "../src/timeline/clock.js";
import { CaptureSession } from "../src/capture/session.js";
import { SyntheticInputProducer } from "../src/capture/synthetic.js";

/**
 * Drives a full capture session against a real DualStore with a deterministic
 * clock (a mono source that ticks +1ms per read). Verifies the orchestration:
 * session row persisted with the clock epoch, events batched + persisted in
 * t_mono order across multiple producers, and ended_at recorded on stop.
 */
describe("CaptureSession", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-cap-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a session and its batched events in t_mono order", async () => {
    // Deterministic monotonic source: each read is +1ms; epoch captured at start.
    let mono = 1000;
    const clock = MonotonicClock.start(() => mono++, () => 1_700_000_000_000);

    const session = new CaptureSession(store, {
      clock,
      deviceId: "test-device",
      maxBatch: 2, // force several flushes mid-capture
      maxIntervalMs: 10_000, // don't rely on the interval timer in tests
    });
    session
      .addProducer(
        new SyntheticInputProducer("input", [
          { kind: "mouse_move", x: 10, y: 20 },
          { kind: "mouse_down", x: 10, y: 20 },
          { kind: "key_down", data: { key: "a" } },
        ]),
      )
      .addProducer(
        new SyntheticInputProducer("active-win", [
          { kind: "focus_change", data: { app: "Slack" } },
          { kind: "focus_change", data: { app: "VS Code" } },
        ]),
      );

    const sessionId = await session.start();
    await session.stop();

    // Session row carries the clock epoch (t_mono zero) and a recorded end.
    const row = store.getSession(sessionId);
    expect(row).toBeDefined();
    expect(row!.epochMono).toBe(1000);
    expect(row!.startedAt).toBe(1_700_000_000_000);
    expect(row!.deviceId).toBe("test-device");
    expect(row!.endedAt).not.toBeNull();

    // All 5 events persisted, ordered by t_mono, stamps strictly ascending.
    const events = store.getEventsBySession(sessionId);
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.kind)).toEqual([
      "mouse_move",
      "mouse_down",
      "key_down",
      "focus_change",
      "focus_change",
    ]);
    const stamps = events.map((e) => e.tMono);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(new Set(stamps).size).toBe(5); // unique, monotonic

    // Structured fields survive the JSON round-trip.
    expect(events[0]!.x).toBe(10);
    expect(events[2]!.data).toEqual({ key: "a" });
    expect(events[4]!.data).toEqual({ app: "VS Code" });
  });

  it("guards lifecycle misuse", async () => {
    const session = new CaptureSession(store, { clock: MonotonicClock.start() });
    expect(() => session.id).toThrow(/not started/);
    await session.start();
    expect(() => session.addProducer(new SyntheticInputProducer("x", []))).toThrow(
      /after start/,
    );
    await session.stop();
  });
});
