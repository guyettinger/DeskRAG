import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStore, id, type TestCtx } from "./helpers.js";

/**
 * listSessions is the app's Library read: every session, newest first, with the
 * counts and byte totals the UI shows — and the `screen` video blob id when the
 * session was recorded with video. SQLite is the source of truth, so a deleted
 * session simply stops appearing.
 */
describe("DualStore.listSessions", () => {
  let ctx: TestCtx;

  beforeEach(async () => {
    ctx = await makeStore([]);
  });
  afterEach(() => ctx.cleanup());

  it("returns sessions newest-first with counts, bytes, and the video blob id", async () => {
    const { store } = ctx;
    const older = id();
    const newer = id();
    await store.putSession({ id: older, startedAt: 1000, epochMono: 0 });
    await store.putSession({ id: newer, startedAt: 2000, epochMono: 0 });
    await store.endSession(newer, 2500);

    const segId = id();
    await store.putSegments([
      { id: segId, sessionId: newer, granularity: "action", tMonoStart: 0, tMonoEnd: 10 },
    ]);
    const videoBlob = id();
    await store.putBlobs([
      {
        id: videoBlob,
        sessionId: newer,
        media: "screen",
        path: "/tmp/v.mp4",
        byteOffset: 0,
        byteLength: 1000,
        tMonoStart: 0,
        tMonoEnd: 500,
        codec: "mp4",
      },
      {
        id: id(),
        sessionId: newer,
        media: "keyframe",
        path: "/tmp/k.jpg",
        byteOffset: 0,
        byteLength: 24,
        tMonoStart: 5,
        tMonoEnd: 5,
        codec: "jpeg",
      },
    ]);
    await store.putFrames([
      {
        id: id(),
        sessionId: newer,
        tMono: 5,
        width: 100,
        height: 50,
        phash: 1n,
        frameOffset: 0,
        segmentIds: [],
      },
    ]);
    await store.putEvents([
      { id: id(), sessionId: newer, tMono: 1, kind: "mouse_down" },
      { id: id(), sessionId: newer, tMono: 2, kind: "mouse_up" },
    ]);

    const list = store.listSessions();

    expect(list.map((s) => s.id)).toEqual([newer, older]); // started_at DESC
    const top = list[0]!;
    expect(top.endedAt).toBe(2500);
    expect(top.frameCount).toBe(1);
    expect(top.segmentCount).toBe(1);
    expect(top.eventCount).toBe(2);
    expect(top.byteLength).toBe(1024); // 1000 + 24, across BOTH blobs
    expect(top.videoBlobId).toBe(videoBlob);
  });

  it("reports zeroes and a null video id for an empty session", async () => {
    const { store } = ctx;
    const sessionId = id();
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });

    const [row] = store.listSessions();

    expect(row!.frameCount).toBe(0);
    expect(row!.segmentCount).toBe(0);
    expect(row!.eventCount).toBe(0);
    expect(row!.byteLength).toBe(0);
    expect(row!.videoBlobId).toBeNull();
    expect(row!.endedAt).toBeNull();
  });

  it("returns plain numbers, not BigInts (safeIntegers is per-statement)", async () => {
    const { store } = ctx;
    await store.putSession({ id: id(), startedAt: 1000, epochMono: 0 });

    const [row] = store.listSessions();

    expect(typeof row!.frameCount).toBe("number");
    expect(typeof row!.byteLength).toBe("number");
    expect(typeof row!.startedAt).toBe("number");
  });

  it("does not double-count when a session has many rows in several tables", async () => {
    const { store } = ctx;
    const sessionId = id();
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    // 2 segments x 3 frames x 4 events: a naive multi-JOIN would report 24s.
    await store.putSegments([
      { id: id(), sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 10 },
      { id: id(), sessionId, granularity: "task", tMonoStart: 0, tMonoEnd: 20 },
    ]);
    await store.putFrames(
      [1, 2, 3].map((t) => ({
        id: id(),
        sessionId,
        tMono: t,
        width: 10,
        height: 10,
        phash: BigInt(t),
        frameOffset: 0,
        segmentIds: [],
      })),
    );
    await store.putEvents(
      [1, 2, 3, 4].map((t) => ({ id: id(), sessionId, tMono: t, kind: "mouse_move" })),
    );

    const [row] = store.listSessions();

    expect(row!.segmentCount).toBe(2);
    expect(row!.frameCount).toBe(3);
    expect(row!.eventCount).toBe(4);
  });

  it("drops a session from the list once it is deleted", async () => {
    const { store } = ctx;
    const sessionId = id();
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    expect(store.listSessions()).toHaveLength(1);

    await store.deleteSession(sessionId);

    expect(store.listSessions()).toHaveLength(0);
  });
});
