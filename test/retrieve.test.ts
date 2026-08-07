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
import { reciprocalRankFusion, DEFAULT_RRF_K } from "../src/retrieve/rrf.js";
import { Tier1Retriever } from "../src/retrieve/retriever.js";
import type { EmbedOptions, EmbeddingProvider } from "../src/embed/types.js";
import {
  BehaviorViewSearcher,
  LexicalSegmentSearcher,
  TextViewSearcher,
} from "../src/retrieve/searchers.js";
import { indexSegmentText } from "../src/represent/segment-text.js";
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

  /**
   * The property k is chosen for: with five lanes, RANK must be able to outweigh
   * lane COUNT. At the published k=60 it cannot — the count term spans 5x while
   * rank over a 100-long list spans 2.6x — so a segment ranked ~20th everywhere
   * beat one ranked 1st in two lanes by construction. Measured on a real
   * library: a sentence the user typed was #1 in the digest lane and #1 in the
   * lexical lane, and came 13th fused.
   */
  it("a top hit in two lanes beats a mediocre hit in all five", () => {
    const filler = (offset: number) =>
      Array.from({ length: 100 }, (_, i) => `f${(i + offset) % 100}`);
    // `exact` is #1 in two lanes and absent from three.
    // `ubiquitous` sits at rank 20 in all five.
    const lists = ["a", "b", "c", "d", "e"].map((key, lane) => {
      const ids = filler(lane);
      ids.splice(19, 0, "ubiquitous");
      if (lane < 2) ids.unshift("exact");
      return { key, ids };
    });
    const fused = reciprocalRankFusion(lists, DEFAULT_RRF_K);
    const rank = (id: string) => fused.findIndex((f) => f.id === id);
    expect(rank("exact")).toBeLessThan(rank("ubiquitous"));

    // And the inversion this replaced, so the reason stays visible.
    const atSixty = reciprocalRankFusion(lists, 60);
    const rank60 = (id: string) => atSixty.findIndex((f) => f.id === id);
    expect(rank60("ubiquitous")).toBeLessThan(rank60("exact"));
  });

  it("still rewards genuine agreement — k damps, it does not disable", () => {
    // Same rank in both lanes vs a single lane's #1: agreement should win.
    const fused = reciprocalRankFusion(
      [
        { key: "l1", ids: ["solo", "agreed"] },
        { key: "l2", ids: ["other", "agreed"] },
      ],
      DEFAULT_RRF_K,
    );
    expect(fused[0]!.id).toBe("agreed");
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

describe("TextViewSearcher role", () => {
  it("embeds the query with role=query, not the document default", async () => {
    const seen: (EmbedOptions | undefined)[] = [];
    const probe: EmbeddingProvider = {
      id: "probe",
      model: "probe",
      dimensions: 4,
      async embed(inputs, opts) {
        seen.push(opts);
        return inputs.map(() => Float32Array.from([1, 0, 0, 0]));
      },
    };
    await new TextViewSearcher(probe, "digest").queryVector({ text: "hello" });
    expect(seen[0]).toEqual({ role: "query" });
  });

  it("does not embed at all for an empty query", async () => {
    const seen: unknown[] = [];
    const probe: EmbeddingProvider = {
      id: "probe",
      model: "probe",
      dimensions: 4,
      async embed(inputs) {
        seen.push(inputs);
        return [];
      },
    };
    expect(await new TextViewSearcher(probe, "digest").queryVector({})).toBeNull();
    expect(seen.length).toBe(0);
  });
});

/**
 * The lexical lane. Every text view is dense-only, so a rare literal token —
 * the case a person is MOST certain about — had no exact-match route at all.
 */
describe("LexicalSegmentSearcher + segment_fts", () => {
  let dir: string;
  let store: DualStore;
  const digestEmbedder = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });
  const behavior = new BehaviorFeatureExtractor();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-fts-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed(): Promise<{ sessionId: string; segs: string[] }> {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      { id: ulid(), sessionId, tMono: 0, kind: "mouse_move" },
      { id: ulid(), sessionId, tMono: 5000, kind: "focus_change", data: { app: "Slack" } },
    ]);
    await store.endSession(sessionId, 9000);
    await new Segmenter(store).segment(sessionId);
    const segs = store.getSegmentsBySession(sessionId).map((s) => s.id);
    return { sessionId, segs };
  }

  it("indexes a segment's views together and matches an exact literal", async () => {
    const { sessionId, segs } = await seed();
    await store.updateSegment(segs[0]!, { digest: "Terminal — zsh" });
    await store.updateSegment(segs[0]!, { transcript: "the build broke on ENOTDIR again" });
    await store.updateSegment(segs[1]!, { digest: "Calculator — Calculator. 1 click." });
    indexSegmentText(store, sessionId);

    expect(store.ftsSegments("ENOTDIR", 10)).toEqual([segs[0]]);
    expect(store.ftsSegments("Calculator", 10)).toEqual([segs[1]]);
  });

  it("survives a natural-language query full of FTS5 syntax characters", async () => {
    const { sessionId, segs } = await seed();
    await store.updateSegment(segs[0]!, { digest: "Chrome. https://github.com/x/y. clicked" });
    indexSegmentText(store, sessionId);
    // ':' '/' '.' '→' are all MATCH syntax; unsanitized this throws rather than
    // simply not matching, which would take the whole search down.
    expect(() => store.ftsSegments("what was that github.com PR → the one I opened?", 10)).not.toThrow();
    expect(store.ftsSegments("github.com", 10)).toEqual([segs[0]]);
  });

  it("is idempotent — re-indexing does not duplicate or stale a row", async () => {
    const { sessionId, segs } = await seed();
    await store.updateSegment(segs[0]!, { digest: "quarterly budget spreadsheet" });
    indexSegmentText(store, sessionId);
    indexSegmentText(store, sessionId);
    expect(store.ftsSegments("quarterly", 10)).toEqual([segs[0]]);

    // A view whose text changed must stop answering with the old text.
    await store.updateSegment(segs[0]!, { digest: "annual budget spreadsheet" });
    indexSegmentText(store, sessionId);
    expect(store.ftsSegments("quarterly", 10)).toEqual([]);
    expect(store.ftsSegments("annual", 10)).toEqual([segs[0]]);
  });

  it("fuses into Tier 1 as a peer list, lifting a segment the dense views miss", async () => {
    const { sessionId, segs } = await seed();
    await new Representer(store, { digestEmbedder, behavior }).represent(sessionId);
    // A literal that appears in NO digest the embedder saw — only in a caption.
    const needle = segs[segs.length - 1]!;
    await store.updateSegment(needle, { caption: "the ENOTDIR stack trace" });
    indexSegmentText(store, sessionId);

    const withLexical = new Tier1Retriever(
      store,
      [new TextViewSearcher(digestEmbedder, "digest")],
      { lexical: new LexicalSegmentSearcher(store) },
    );
    const res = await withLexical.retrieve({ text: "ENOTDIR" });
    const hit = res.segments.find((s) => s.segmentId === needle);
    expect(hit).toBeDefined();
    expect(hit!.lexicalRank).toBe(1);

    // Without the lane the same query cannot reach it by that term.
    const dense = new Tier1Retriever(store, [new TextViewSearcher(digestEmbedder, "digest")]);
    expect((await dense.retrieve({ text: "ENOTDIR" })).segments.every((s) => s.lexicalRank === undefined)).toBe(true);
  });

  /**
   * The hazard that had to be fixed before any re-index path could exist:
   * `putSegmentVectors` is a bare Lance add, so re-running a represent stage
   * leaves TWO vectors under one id. Neither is an orphan — both have a live
   * SQLite row — so `reconcile()` can never prune the duplicate.
   */
  it("replaceSegmentVectors leaves exactly one vector per id after two runs", async () => {
    const { sessionId } = await seed();
    // Two identical represent passes, as a re-index performs.
    await new Representer(store, { digestEmbedder, behavior }).represent(sessionId);
    await new Representer(store, { digestEmbedder, behavior }).represent(sessionId);

    const segs = store.getSegmentsBySession(sessionId);
    const ns = new TextViewSearcher(digestEmbedder, "digest").namespace;
    const [vec] = await digestEmbedder.embed([segs[0]!.digest!], { role: "query" });
    // Ask for far more neighbors than there are segments: any duplicate row
    // would come back as a second hit carrying the same id.
    const hits = await store.searchSegments(ns, vec!, segs.length * 4);
    expect(hits.length).toBe(segs.length);
    expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length);
  });

  it("deleting a recording clears its lexical rows — FTS has no foreign key", async () => {
    const { sessionId, segs } = await seed();
    await store.updateSegment(segs[0]!, { digest: "ENOTDIR" });
    indexSegmentText(store, sessionId);
    expect(store.ftsSegments("ENOTDIR", 10)).toEqual([segs[0]]);

    await store.deleteSession(sessionId);
    expect(store.ftsSegments("ENOTDIR", 10)).toEqual([]);
  });
});
