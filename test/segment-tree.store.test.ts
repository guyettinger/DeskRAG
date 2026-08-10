import { afterEach, describe, expect, it } from "vitest";
import type { DualStore } from "../src/store/store.js";
import { id, makeStore } from "./helpers.js";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** A store with an open session — segment rows need one to reference. */
async function withSession(): Promise<{ store: DualStore; sessionId: string }> {
  const ctx = await makeStore();
  cleanup = ctx.cleanup;
  const sessionId = id();
  await ctx.store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  return { store: ctx.store, sessionId };
}

describe("segment tree", () => {
  it("round-trips edges and resolves descendant leaves", async () => {
    const { store, sessionId } = await withSession();
    const a = id();
    const b = id();
    const task = id();
    const root = id();
    await store.putSegments([
      { id: a, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000 },
      { id: b, sessionId, granularity: "action", tMonoStart: 1000, tMonoEnd: 2000 },
      { id: task, sessionId, granularity: "level:1", tMonoStart: 0, tMonoEnd: 2000 },
      { id: root, sessionId, granularity: "session", tMonoStart: 0, tMonoEnd: 2000 },
    ]);
    await store.putSegmentTree([
      { sessionId, parentId: task, childId: a },
      { sessionId, parentId: task, childId: b },
      { sessionId, parentId: root, childId: task },
    ]);

    expect(store.getSegmentChildren(task).sort()).toEqual([a, b].sort());
    expect(store.getSegmentChildren(a)).toEqual([]);
    expect(store.getDescendantLeaves(root).sort()).toEqual([a, b].sort());
    // A leaf resolves to itself, so Tier-2 scoping needs no special case for
    // a hit that is already at level 0.
    expect(store.getDescendantLeaves(a)).toEqual([a]);
  });

  it("reads a segment's parent, and undefined for a root", async () => {
    const { store, sessionId } = await withSession();
    const child = id();
    const parent = id();
    await store.putSegments([
      { id: child, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000 },
      { id: parent, sessionId, granularity: "session", tMonoStart: 0, tMonoEnd: 1000 },
    ]);
    await store.putSegmentTree([{ sessionId, parentId: parent, childId: child }]);

    expect(store.getSegmentParent(child)).toBe(parent);
    expect(store.getSegmentParent(parent)).toBeUndefined();
  });

  it("is idempotent — re-inserting the same edge does not duplicate it", async () => {
    const { store, sessionId } = await withSession();
    const child = id();
    const parent = id();
    await store.putSegments([
      { id: child, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000 },
      { id: parent, sessionId, granularity: "session", tMonoStart: 0, tMonoEnd: 1000 },
    ]);
    const edge = { sessionId, parentId: parent, childId: child };
    await store.putSegmentTree([edge]);
    await store.putSegmentTree([edge]);
    expect(store.getSegmentChildren(parent)).toEqual([child]);
  });
});

describe("segment summary", () => {
  it("stores summaries with their source and reads them per session", async () => {
    const { store, sessionId } = await withSession();
    const task = id();
    await store.putSegments([
      { id: task, sessionId, granularity: "level:1", tMonoStart: 0, tMonoEnd: 2000 },
    ]);
    await store.putSegmentSummaries([
      { segmentId: task, text: "renamed the capture clock", source: "llm" },
    ]);

    expect(store.getSegmentSummary(task)).toEqual({
      segmentId: task,
      text: "renamed the capture clock",
      source: "llm",
    });
    expect(store.getSegmentSummariesBySession(sessionId)).toHaveLength(1);
    expect(store.getSegmentSummary(id())).toBeUndefined();
  });

  it("replaces on re-write, so composing twice leaves one summary", async () => {
    const { store, sessionId } = await withSession();
    const task = id();
    await store.putSegments([
      { id: task, sessionId, granularity: "level:1", tMonoStart: 0, tMonoEnd: 2000 },
    ]);
    await store.putSegmentSummaries([{ segmentId: task, text: "first", source: "template" }]);
    await store.putSegmentSummaries([{ segmentId: task, text: "second", source: "llm" }]);

    expect(store.getSegmentSummary(task)).toEqual({
      segmentId: task,
      text: "second",
      source: "llm",
    });
    expect(store.getSegmentSummariesBySession(sessionId)).toHaveLength(1);
  });
});

describe("deleting", () => {
  it("cascades both tables when the session is deleted", async () => {
    const { store, sessionId } = await withSession();
    const child = id();
    const parent = id();
    await store.putSegments([
      { id: child, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000 },
      { id: parent, sessionId, granularity: "level:1", tMonoStart: 0, tMonoEnd: 1000 },
    ]);
    await store.putSegmentTree([{ sessionId, parentId: parent, childId: child }]);
    await store.putSegmentSummaries([{ segmentId: parent, text: "x", source: "template" }]);

    await store.deleteSession(sessionId);

    expect(store.getSegmentChildren(parent)).toEqual([]);
    expect(store.getSegmentSummary(parent)).toBeUndefined();
  });

  it("deleteSegments removes the rows and their edges, leaving the leaves", async () => {
    const { store, sessionId } = await withSession();
    const leaf = id();
    const parent = id();
    await store.putSegments([
      { id: leaf, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000 },
      { id: parent, sessionId, granularity: "session", tMonoStart: 0, tMonoEnd: 1000 },
    ]);
    await store.putSegmentTree([{ sessionId, parentId: parent, childId: leaf }]);
    await store.putSegmentSummaries([{ segmentId: parent, text: "x", source: "template" }]);

    // Composing may run twice; a second root would make "the session's purpose"
    // ambiguous, so the stale levels are dropped first.
    await store.deleteSegments([parent]);

    expect(store.getSegmentsBySession(sessionId).map((s) => s.id)).toEqual([leaf]);
    expect(store.getSegmentSummary(parent)).toBeUndefined();
    expect(store.getSegmentParent(leaf)).toBeUndefined();
  });
});
