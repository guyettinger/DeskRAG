import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";
import { associateFrameAx, nearestFrameId } from "../src/represent/frame-ax.js";

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

describe("nearestFrameId", () => {
  const frames = [
    { id: "a", tMono: 1000 },
    { id: "b", tMono: 2000 },
    { id: "c", tMono: 3000 },
  ];

  it("picks the frame closest in content time, in either direction", () => {
    expect(nearestFrameId(2900, frames)).toBe("c");
    expect(nearestFrameId(1400, frames)).toBe("a");
  });

  it("keeps the earlier frame on an exact tie, so the result is deterministic", () => {
    expect(nearestFrameId(1500, frames)).toBe("a");
  });

  it("returns undefined when there are no frames", () => {
    expect(nearestFrameId(1000, [])).toBeUndefined();
  });
});

describe("associateFrameAx", () => {
  let dir2: string;
  let store2: DualStore;
  let session2: string;

  beforeEach(async () => {
    dir2 = await mkdtemp(join(tmpdir(), "deskrag-assoc-ax-"));
    store2 = await DualStore.open(join(dir2, "meta.sqlite"), join(dir2, "lance"));
    session2 = ulid();
    await store2.putSession({ id: session2, startedAt: Date.now(), epochMono: 0 });
  });

  afterEach(async () => {
    store2.close();
    await rm(dir2, { recursive: true, force: true });
  });

  const putFrame = async (id: string, tMono: number, offset: number) =>
    store2.putFrames([
      {
        id, sessionId: session2, tMono, width: 10, height: 10,
        phash: 0n, frameOffset: offset, segmentIds: [],
      },
    ]);

  const putWalk = async (id: string, tMono: number, label: string) =>
    store2.putAxSnapshot({
      id, sessionId: session2, tMono, frameId: null, reason: "keyframe", walkMs: 5,
      elements: [{ role: "Button", label, x: 0, y: 0, w: 10, h: 10 }],
    });

  it("assigns each walk to the frame it describes, not the one that triggered it", async () => {
    // The walk at 3200 was triggered by the frame that ARRIVED then — but its
    // tree shows the screen at 3200, which is frame f3's picture.
    await putFrame("f1", 1000, 0);
    await putFrame("f3", 3000, 1);
    await putWalk("w1", 3200, "shown-at-3200");

    expect(await associateFrameAx(store2, session2)).toBe(1);
    expect(store2.getFrameAx("f3")[0]!.label).toBe("shown-at-3200");
    expect(store2.getFrameAx("f1")).toEqual([]);
  });

  it("leaves a frame with no nearby walk unlinked rather than borrowing one", async () => {
    await putFrame("f1", 1000, 0);
    await putFrame("f2", 2000, 1);
    await putWalk("w1", 2100, "near-f2");
    await associateFrameAx(store2, session2);
    // f1 is the first keyframe of the session: no walk had happened yet at its
    // content time, so region proposal falls back to hotspots and grid tiling.
    expect(store2.getFrameAx("f1")).toEqual([]);
    expect(store2.getFrameAx("f2")).toHaveLength(1);
  });

  it("is idempotent across re-indexing", async () => {
    await putFrame("f1", 1000, 0);
    await putWalk("w1", 1100, "once");
    expect(await associateFrameAx(store2, session2)).toBe(1);
    expect(await associateFrameAx(store2, session2)).toBe(1);
    expect(store2.getFrameAx("f1")).toHaveLength(1);
  });

  it("ignores boundary walks, which are keyed by t_mono and have no frame", async () => {
    await putFrame("f1", 1000, 0);
    // AxSnapshotReason is "keyframe" | "focus_change" | "bookmark" |
    // "dwell_resume"; the latter three are the boundary-triggered walks, read
    // through getAxForBoundary and never through a frame.
    await store2.putAxSnapshot({
      id: "b1", sessionId: session2, tMono: 1100, frameId: null, reason: "focus_change",
      walkMs: 5, elements: [{ role: "Window", label: "boundary", x: 0, y: 0, w: 1, h: 1 }],
    });
    expect(await associateFrameAx(store2, session2)).toBe(0);
    expect(store2.getFrameAx("f1")).toEqual([]);
  });

  it("returns 0 for a session with no frames", async () => {
    await putWalk("w1", 500, "orphan");
    expect(await associateFrameAx(store2, session2)).toBe(0);
  });
});
