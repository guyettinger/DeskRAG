import { afterEach, describe, expect, it } from "vitest";
import { indexSegmentText } from "../src/represent/segment-text.js";
import type { DualStore } from "../src/store/store.js";
import { id, makeStore } from "./helpers.js";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function withSession(): Promise<{ store: DualStore; sessionId: string }> {
  const ctx = await makeStore();
  cleanup = ctx.cleanup;
  const sessionId = id();
  await ctx.store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  return { store: ctx.store, sessionId };
}

describe("segment_fts includes composed summaries", () => {
  it("indexes a composed level whose ONLY text is its summary", async () => {
    const { store, sessionId } = await withSession();
    const task = id();
    await store.putSegments([
      { id: task, sessionId, granularity: "level:1", tMonoStart: 0, tMonoEnd: 2000 },
    ]);
    await store.putSegmentSummaries([
      { segmentId: task, text: "renamed the capture clock", source: "llm" },
    ]);

    const r = indexSegmentText(store, sessionId);

    // On a default install the lexical lane is the ONLY route from a query to
    // an exact term, so a task unreachable here is unreachable full stop.
    expect(r.indexedCount).toBe(1);
  });

  it("makes the summary findable by an exact term", async () => {
    const { store, sessionId } = await withSession();
    const task = id();
    await store.putSegments([
      { id: task, sessionId, granularity: "level:1", tMonoStart: 0, tMonoEnd: 2000 },
    ]);
    await store.putSegmentSummaries([
      { segmentId: task, text: "filed the expense report", source: "llm" },
    ]);
    indexSegmentText(store, sessionId);

    expect(store.ftsSegments("expense", 10)).toContain(task);
  });

  it("leaves a leaf indexed by its own views, not by a summary it lacks", async () => {
    const { store, sessionId } = await withSession();
    const action = id();
    await store.putSegments([
      {
        id: action,
        sessionId,
        granularity: "action",
        tMonoStart: 0,
        tMonoEnd: 1000,
        digest: "Calculator — clicked 7",
      },
    ]);

    expect(indexSegmentText(store, sessionId).indexedCount).toBe(1);
    expect(store.ftsSegments("Calculator", 10)).toContain(action);
  });
});
