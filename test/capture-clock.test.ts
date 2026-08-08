import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";
import { CaptureSession } from "../src/capture/session.js";
import { MonotonicClock } from "../src/timeline/clock.js";
import { FakeDeviceClockSource } from "../src/capture/env/fake.js";
import type { CaptureContext, Producer } from "../src/capture/types.js";

describe("CaptureSession device clock", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-clk-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  class ClockReader implements Producer {
    readonly id = "probe";
    seen: number | undefined;
    start(ctx: CaptureContext): void {
      // A device timestamp captured 1000ms before the calibration reading.
      this.seen = ctx.deviceClock.toTMono(4000);
    }
    stop(): void {}
  }

  it("calibrates from the source and hands producers the bridge", async () => {
    const clock = MonotonicClock.start();
    const session = new CaptureSession(store, {
      clock,
      deviceClockSource: new FakeDeviceClockSource(5000),
    });
    const probe = new ClockReader();
    session.addProducer(probe);
    const sessionId = await session.start();
    await session.stop();

    // The reading 5000 was paired with some t_mono T; a device stamp of 4000 is
    // one second earlier, so it must land at T - 1000.
    const row = store.getSessionClock(sessionId)!;
    expect(row.deviceEpochMs).toBe(5000);
    expect(probe.seen).toBeCloseTo(row.monoEpochMs - 1000, 6);
  });

  it("REFUSES to start when the clock cannot be read", async () => {
    // Recording without a bridge would store timestamps that mean something
    // different from every calibrated session. Refusing loudly beats silently
    // producing a second convention.
    const failing = { read: () => Promise.reject(new Error("ENOENT ax-dump")) };
    const session = new CaptureSession(store, {
      clock: MonotonicClock.start(),
      deviceClockSource: failing,
    });
    await expect(session.start()).rejects.toThrow(/clock/i);
    // And it refuses BEFORE writing anything: a half-started session would be
    // indistinguishable from a recording that captured nothing.
    expect(store.listSessions()).toHaveLength(0);
  });
});
