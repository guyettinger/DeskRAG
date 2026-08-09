import { afterEach, describe, expect, it } from "vitest";
import { FakeSummaryProvider } from "../src/embed/summary.js";
import { ComposeRepresenter } from "../src/represent/compose/compose-representer.js";
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

/** n one-second action segments, each with a digest. */
async function seedActions(store: DualStore, sessionId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const sid = id();
    ids.push(sid);
    await store.putSegments([
      {
        id: sid,
        sessionId,
        granularity: "action",
        tMonoStart: i * 1000,
        tMonoEnd: (i + 1) * 1000,
        boundaryReason: "scene_change",
        digest: `action ${i}`,
      },
    ]);
  }
  return ids;
}

describe("ComposeRepresenter", () => {
  it("writes composed levels, edges and summaries up to one root", async () => {
    const { store, sessionId } = await withSession();
    const actions = await seedActions(store, sessionId, 8);

    const r = await new ComposeRepresenter(store, {
      summarizer: new FakeSummaryProvider(2),
    }).represent(sessionId);

    expect(r.nodes).toBeGreaterThan(0);
    expect(r.rootSummary).not.toBeNull();

    const roots = store.getSegmentsBySession(sessionId).filter((s) => s.granularity === "session");
    expect(roots).toHaveLength(1);
    // A parent's span IS its children's union.
    expect(roots[0]!.tMonoStart).toBe(0);
    expect(roots[0]!.tMonoEnd).toBe(8000);
    // And it resolves back down to every action.
    expect(store.getDescendantLeaves(roots[0]!.id).sort()).toEqual([...actions].sort());
  });

  it("names level granularities level:1, level:2, … below the root", async () => {
    const { store, sessionId } = await withSession();
    await seedActions(store, sessionId, 8);
    await new ComposeRepresenter(store, {
      summarizer: new FakeSummaryProvider(2),
    }).represent(sessionId);

    const names = new Set(store.getSegmentsBySession(sessionId).map((s) => s.granularity));
    expect(names.has("action")).toBe(true);
    expect(names.has("level:1")).toBe(true);
    expect(names.has("session")).toBe(true);
    expect(names.has("task")).toBe(false);
  });

  it("composes with NO summarizer — the default install still gets a tree", async () => {
    const { store, sessionId } = await withSession();
    await seedActions(store, sessionId, 6);

    const r = await new ComposeRepresenter(store).represent(sessionId);

    expect(r.nodes).toBeGreaterThan(0);
    expect(r.llmNodes).toBe(0);
    const summaries = store.getSegmentSummariesBySession(sessionId);
    expect(summaries).toHaveLength(r.nodes);
    expect(summaries.every((s) => s.source === "template")).toBe(true);
  });

  it("writes a summary for every composed node and none for a leaf", async () => {
    const { store, sessionId } = await withSession();
    const actions = await seedActions(store, sessionId, 4);
    await new ComposeRepresenter(store, {
      summarizer: new FakeSummaryProvider(2),
    }).represent(sessionId);

    for (const a of actions) expect(store.getSegmentSummary(a)).toBeUndefined();
    const composed = store
      .getSegmentsBySession(sessionId)
      .filter((s) => s.granularity !== "action");
    expect(composed.length).toBeGreaterThan(0);
    for (const c of composed) expect(store.getSegmentSummary(c.id)).toBeDefined();
  });

  it("is idempotent — re-running replaces rather than duplicating", async () => {
    const { store, sessionId } = await withSession();
    await seedActions(store, sessionId, 6);
    const rep = new ComposeRepresenter(store, { summarizer: new FakeSummaryProvider(2) });

    await rep.represent(sessionId);
    const first = store.getSegmentsBySession(sessionId).length;
    await rep.represent(sessionId);

    expect(store.getSegmentsBySession(sessionId)).toHaveLength(first);
    expect(
      store.getSegmentsBySession(sessionId).filter((s) => s.granularity === "session"),
    ).toHaveLength(1);
  });

  it("resolves each action's app from focus_change, not from digest prose", async () => {
    const { store, sessionId } = await withSession();
    await seedActions(store, sessionId, 4);
    // Two apps: the seam between them is where a structural cut should fall.
    await store.putEvents([
      { id: id(), sessionId, tMono: 0, kind: "focus_change", data: { app: "Calculator" } },
      { id: id(), sessionId, tMono: 2000, kind: "focus_change", data: { app: "Google Chrome" } },
    ]);

    await new ComposeRepresenter(store).represent(sessionId);

    const level1 = store.getSegmentsBySession(sessionId).filter((s) => s.granularity === "level:1");
    const texts = level1.map((s) => store.getSegmentSummary(s.id)!.text);
    // The rollup names the app it resolved, which only the event stream carries.
    expect(texts.some((t) => t.includes("Calculator"))).toBe(true);
    expect(texts.some((t) => t.includes("Google Chrome"))).toBe(true);
  });

  it("links a parent's frames as the union of its children's", async () => {
    const { store, sessionId } = await withSession();
    const actions = await seedActions(store, sessionId, 2);
    const frame = id();
    await store.putFrames([
      {
        id: frame,
        sessionId,
        tMono: 500,
        width: 100,
        height: 100,
        phash: 0n,
        frameOffset: 0,
        segmentIds: [],
      },
    ]);
    await store.associateFrameSegments(frame, [actions[0]!]);

    await new ComposeRepresenter(store, {
      summarizer: new FakeSummaryProvider(2),
    }).represent(sessionId);

    const root = store.getSegmentsBySession(sessionId).find((s) => s.granularity === "session")!;
    expect(store.getFramesBySegment(root.id).map((f) => f.id)).toContain(frame);
  });

  it("returns an empty result for a session with no actions", async () => {
    const { store, sessionId } = await withSession();
    const r = await new ComposeRepresenter(store).represent(sessionId);
    expect(r).toEqual({ levels: 0, nodes: 0, llmNodes: 0, rootSummary: null });
  });

  it("does not fail the run when the summarizer throws", async () => {
    const { store, sessionId } = await withSession();
    await seedActions(store, sessionId, 4);
    const broken = {
      id: "broken",
      model: "broken",
      compose: async () => {
        throw new Error("ollama is not running");
      },
    };

    const r = await new ComposeRepresenter(store, { summarizer: broken }).represent(sessionId);

    expect(r.nodes).toBeGreaterThan(0);
    expect(r.llmNodes).toBe(0);
    expect(r.rootSummary).not.toBeNull();
  });
});
