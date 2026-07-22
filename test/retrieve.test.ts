import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { Segmenter } from "../src/segment/segmenter.js";
import { Representer } from "../src/represent/representer.js";
import { BehaviorFeatureExtractor } from "../src/represent/behavior.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import { reciprocalRankFusion } from "../src/retrieve/rrf.js";
import { Tier1Retriever } from "../src/retrieve/retriever.js";
import { BehaviorViewSearcher, TextViewSearcher } from "../src/retrieve/searchers.js";
import type { EventInsert } from "../src/store/types.js";

describe("reciprocalRankFusion", () => {
  it("preserves order for a single list", () => {
    const fused = reciprocalRankFusion([{ key: "a", ids: ["x", "y", "z"] }]);
    expect(fused.map((f) => f.id)).toEqual(["x", "y", "z"]);
  });

  it("rewards cross-list agreement (an item in two lists rises)", () => {
    // a: only list1 (rank1). b: both lists (rank2 + rank1). c: only list2 (rank2).
    const fused = reciprocalRankFusion([
      { key: "l1", ids: ["a", "b"] },
      { key: "l2", ids: ["b", "c"] },
    ]);
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "c"]);
    expect(fused[0]!.ranks).toEqual({ l1: 2, l2: 1 });
  });

  it("breaks score ties deterministically by id", () => {
    const fused = reciprocalRankFusion([
      { key: "l1", ids: ["y", "x"] },
      { key: "l2", ids: ["x", "y"] },
    ]);
    // x and y have identical fused scores; id order wins.
    expect(fused.map((f) => f.id)).toEqual(["x", "y"]);
  });

  it("returns nothing for no lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });
});

describe("Tier1Retriever (integration)", () => {
  let dir: string;
  let store: DualStore;
  const digestEmbedder = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });
  const behavior = new BehaviorFeatureExtractor();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-ret-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedAndRepresent() {
    const sessionId = ulid();
    const mkEv = (tMono: number, kind: string, data?: unknown): EventInsert => ({
      id: ulid(), sessionId, tMono, kind, ...(data !== undefined ? { data } : {}),
    });
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      mkEv(0, "mouse_move"),
      mkEv(5000, "focus_change", { app: "Slack" }),
      mkEv(6000, "key_down"),
    ]);
    await store.endSession(sessionId, 9000); // endTMono 8000
    await new Segmenter(store).segment(sessionId);
    await new Representer(store, { digestEmbedder, behavior }).represent(sessionId);
    return sessionId;
  }

  function makeRetriever() {
    return new Tier1Retriever(store, [
      new TextViewSearcher(digestEmbedder, "digest"),
      new BehaviorViewSearcher(behavior),
    ]);
  }

  it("ranks the exact-match segment first for a text query", async () => {
    const sessionId = await seedAndRepresent();
    const target = store
      .getSegmentsBySession(sessionId)
      .find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;

    // Query with the target's own digest text: the fake embedder maps identical
    // text to an identical vector, so the target is the exact nearest neighbor.
    const res = await makeRetriever().retrieve({ text: target.digest! });
    expect(res.segments[0]!.segmentId).toBe(target.id);
    expect(res.segments[0]!.perView[0]!.view).toBe("digest");
    expect(res.segments[0]!.perView[0]!.distance).toBeCloseTo(0, 5);
    expect(res.segments[0]!.segment?.tMonoStart).toBe(5000); // hydrated
  });

  it("ranks the exact-match segment first for a behavioral query", async () => {
    const sessionId = await seedAndRepresent();
    const events = store.getEventsBySession(sessionId);
    const target = store
      .getSegmentsBySession(sessionId)
      .find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;
    // Reproduce the target's stored behavior vector (its window is the session
    // end, so the right edge is inclusive — same events the Representer used).
    const windowEvents = events.filter((e) => e.tMono >= 5000 && e.tMono <= 8000);
    const bvec = behavior.extract(windowEvents, { tMonoStart: 5000, tMonoEnd: 8000 });

    const res = await makeRetriever().retrieve({ behavior: bvec });
    expect(res.segments[0]!.segmentId).toBe(target.id);
    expect(res.segments[0]!.perView[0]!.view).toBe("behavior");
  });

  it("fuses text + behavior; the doubly-agreeing segment wins with two-view provenance", async () => {
    const sessionId = await seedAndRepresent();
    const events = store.getEventsBySession(sessionId);
    const target = store
      .getSegmentsBySession(sessionId)
      .find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;
    const windowEvents = events.filter((e) => e.tMono >= 5000 && e.tMono <= 8000);
    const bvec = behavior.extract(windowEvents, { tMonoStart: 5000, tMonoEnd: 8000 });

    const res = await makeRetriever().retrieve({ text: target.digest!, behavior: bvec });
    expect(res.segments[0]!.segmentId).toBe(target.id);
    // Ranked #1 in BOTH views -> provenance from both namespaces.
    const views = res.segments[0]!.perView.map((p) => p.view).sort();
    expect(views).toEqual(["behavior", "digest"]);
  });

  it("returns nothing when the query addresses no view", async () => {
    await seedAndRepresent();
    const res = await makeRetriever().retrieve({});
    expect(res.segments).toEqual([]);
  });
});
