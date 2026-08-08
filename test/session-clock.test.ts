import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";

describe("session_clock", () => {
  let dir: string;
  let store: DualStore;
  let sessionId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "deskrag-clock-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a calibration", async () => {
    await store.putSessionClock({ sessionId, deviceEpochMs: 3_477_946_316.602, monoEpochMs: 250 });
    expect(store.getSessionClock(sessionId)).toEqual({
      sessionId,
      deviceEpochMs: 3_477_946_316.602,
      monoEpochMs: 250,
    });
  });

  it("returns undefined for a session recorded before calibration existed", () => {
    // ABSENCE is the marker. Every existing recording has no row, and the rail
    // says the axis is uncalibrated rather than pretending it is aligned.
    expect(store.getSessionClock(sessionId)).toBeUndefined();
  });

  it("cascades with the session, so a deleted recording leaves no calibration", async () => {
    await store.putSessionClock({ sessionId, deviceEpochMs: 1, monoEpochMs: 2 });
    await store.deleteSession(sessionId);
    expect(store.getSessionClock(sessionId)).toBeUndefined();
  });
});
