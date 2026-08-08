import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";

describe("setAxSnapshotFrame", () => {
  let dir: string;
  let store: DualStore;
  let sessionId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "deskrag-frame-ax-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  });

  afterEach(async () => {
    store.close(); // synchronous — DualStore.close() returns void
    await rm(dir, { recursive: true, force: true });
  });

  it("re-points a stored walk at another frame", async () => {
    const frameId = ulid();
    await store.putFrames([
      {
        id: frameId,
        sessionId,
        tMono: 1000,
        width: 100,
        height: 100,
        phash: 0n,
        frameOffset: 0,
        segmentIds: [],
      },
    ]);
    const snapId = ulid();
    await store.putAxSnapshot({
      id: snapId,
      sessionId,
      tMono: 3200,
      frameId: null,
      reason: "keyframe",
      walkMs: 12,
      // UIElement is flat x/y/w/h — there is no `bbox` member.
      elements: [{ role: "Button", label: "Save", x: 0, y: 0, w: 10, h: 10 }],
    });

    expect(store.getFrameAx(frameId)).toEqual([]);
    await store.setAxSnapshotFrame(snapId, frameId);
    expect(store.getFrameAx(frameId)).toHaveLength(1);
    expect(store.getAxSnapshotsBySession(sessionId)[0]!.frameId).toBe(frameId);
  });
});
