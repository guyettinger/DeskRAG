import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { Retriever } from "../src/retrieve/assemble.js";
import { Tier2MultiVectorRetriever } from "../src/retrieve/tier2-mv.js";
import { TextViewSearcher } from "../src/retrieve/searchers.js";
import { FakeEmbeddingProvider, FakeMultiVectorProvider } from "../src/embed/fake.js";
import { namespaceFor } from "../src/embed/types.js";
import { computeTileGeometry } from "../src/embed/onnx/geometry.js";

const mv = new FakeMultiVectorProvider(16, 4);
const NS = namespaceFor("frame_patches", mv);

let dir: string;
let store: DualStore;
let sessionId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "t2mv-"));
  store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
  sessionId = ulid();
  await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  await store.registerVectorSpace({
    namespace: NS,
    view: "frame_patches",
    providerId: mv.id,
    model: mv.model,
    dimensions: mv.dimensions,
    sharedTextSpace: true,
  });
  await store.putSegments([
    { id: "segA", sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 150 },
    { id: "segB", sessionId, granularity: "action", tMonoStart: 150, tMonoEnd: 300 },
  ]);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedFrames(): Promise<void> {
  for (const [id, tMono] of [
    ["f1", 100],
    ["f2", 200],
  ] as const) {
    await store.putFrames([
      {
        id,
        sessionId,
        tMono,
        width: 1280,
        height: 800,
        phash: 0n,
        frameOffset: 0,
        segmentIds: [],
      },
    ]);
  }
  const [pa, pb] = await mv.embedImages([
    Uint8Array.from([1, 2, 3]),
    Uint8Array.from([9, 9, 9]),
  ]);
  await store.putFramePatches([
    { frameId: "f1", sessionId, segmentIds: ["segA"], namespace: NS, patches: pa! },
    { frameId: "f2", sessionId, segmentIds: ["segB"], namespace: NS, patches: pb! },
  ]);
}

const t2 = () => new Tier2MultiVectorRetriever(store, mv, { topN: 10 });

describe("Tier2MultiVectorRetriever", () => {
  it("serves an IMAGE query", async () => {
    await seedFrames();
    const r = t2();
    const v = await r.embedQuery({ image: Uint8Array.from([9, 9, 9]) });
    expect((await r.retrieveFramesUnscoped(v!.vectors))[0]!.frameId).toBe("f2");
  });

  it("serves a TEXT query — the single-vector tier cannot", async () => {
    await seedFrames();
    const r = t2();
    const v = await r.embedQuery({ text: "anything" });
    expect(v).not.toBeNull();
    expect((await r.retrieveFramesUnscoped(v!.vectors)).length).toBe(2);
  });

  it("returns null query vectors when the query has neither text nor image", async () => {
    expect(await t2().embedQuery({})).toBeNull();
    expect(await t2().embedQuery({ text: "" })).toBeNull();
  });

  it("scopes to the Tier-1 segments", async () => {
    await seedFrames();
    const r = t2();
    const v = await r.embedQuery({ image: Uint8Array.from([9, 9, 9]) });
    expect((await r.retrieveFrames(v!.vectors, ["segA"])).map((h) => h.frameId)).toEqual(["f1"]);
  });

  it("returns [] for an empty scope rather than widening", async () => {
    await seedFrames();
    const r = t2();
    const v = await r.embedQuery({ image: Uint8Array.from([1]) });
    expect(await r.retrieveFrames(v!.vectors, [])).toEqual([]);
  });
});

it("the fake provider marks one content vector and pads the rest", async () => {
  const [q] = await mv.embedQueries(["x"]);
  expect(q!.vectors.length).toBe(4);
  expect(q!.contentIndices).toEqual([0]);
});

describe("MaxSim highlights", () => {
  const geo = computeTileGeometry(1280, 800);

  it("derives one highlight per distinct argmax patch", async () => {
    const [patches] = await mv.embedImages([Uint8Array.from([1, 2, 3])]);
    const [q] = await mv.embedQueries(["x"]);
    const hl = t2().highlightsFrom("f1", q!.vectors, patches!, 1280, 800);
    expect(hl.length).toBeGreaterThan(0);
    expect(hl.length).toBeLessThanOrEqual(q!.vectors.length);
    for (const h of hl) {
      expect(h.frameId).toBe("f1");
      expect(h.matchedBy).toEqual(["ann"]);
      expect(h.regionId).toMatch(/^f1#p\d+$/);
      expect(h.role).toBeNull();
      expect(h.bbox.x + h.bbox.w).toBeLessThanOrEqual(1280 + 1e-9);
      expect(h.bbox.y + h.bbox.h).toBeLessThanOrEqual(800 + 1e-9);
    }
  });

  it("dedupes when several query vectors hit the same patch", async () => {
    const [patches] = await mv.embedImages([Uint8Array.from([1, 2, 3])]);
    const q = [patches![0]!, patches![0]!, patches![0]!];
    expect(t2().highlightsFrom("f1", q, patches!, 1280, 800).length).toBe(1);
  });

  it("caps at maxHighlights", async () => {
    const r = new Tier2MultiVectorRetriever(store, mv, { maxHighlights: 1 });
    const [patches] = await mv.embedImages([Uint8Array.from([1, 2, 3])]);
    const [q] = await mv.embedQueries(["x"]);
    expect(r.highlightsFrom("f1", q!.vectors, patches!, 1280, 800).length).toBeLessThanOrEqual(1);
  });

  it("drops a whole-frame (global-tile) match rather than outlining everything", () => {
    // Every grid patch points one way, the global tile's patch another, and the
    // query matches only the latter — so the argmax is unambiguously global.
    const globalIdx = geo.cols * geo.rows * geo.tokensPerTile;
    const grid = () => {
      const v = new Float32Array(16);
      v[0] = 1;
      return v;
    };
    const global = new Float32Array(16);
    global[1] = 1;
    const patches = [...Array.from({ length: globalIdx }, grid), global];

    expect(t2().highlightsFrom("f1", [global], patches, 1280, 800)).toEqual([]);
    // Sanity: a query matching a GRID patch still yields a highlight, so the
    // assertion above is about the global tile, not about highlights being off.
    expect(t2().highlightsFrom("f1", [grid()], patches, 1280, 800).length).toBe(1);
  });

  it("reads stored patches when given a frame id", async () => {
    await seedFrames();
    const r = t2();
    const [q] = await mv.embedQueries(["x"]);
    const hl = await r.highlightsForFrame("f1", q!.vectors, 1280, 800);
    expect(hl.length).toBeGreaterThan(0);
  });

  it("returns [] for a frame with no stored patches", async () => {
    const r = t2();
    const [q] = await mv.embedQueries(["x"]);
    expect(await r.highlightsForFrame("nope", q!.vectors, 1280, 800)).toEqual([]);
  });
});

describe("Retriever multivector dispatch", () => {
  const text = new FakeEmbeddingProvider({ dimensions: 8 });

  it("refuses both visual paths at once", () => {
    expect(
      () =>
        new Retriever(store, {
          searchers: [],
          imageEmbedder: text,
          patchEmbedder: mv,
        }),
    ).toThrow(/not both/i);
  });

  it("recalls frames for a TEXT query through the patch space", async () => {
    await seedFrames();
    const r = new Retriever(store, { searchers: [], patchEmbedder: mv });
    const { frames } = await r.retrieve({ text: "anything" });
    expect(frames.length).toBe(2);
    // frameDistance present => recall came from the ANN, not segment membership
    expect(frames[0]!.frameDistance).toBeDefined();
  });

  it("attaches MaxSim highlights to the returned frames", async () => {
    await seedFrames();
    const r = new Retriever(store, { searchers: [], patchEmbedder: mv });
    const { frames } = await r.retrieve({ text: "anything" });
    expect(frames[0]!.highlights.length).toBeGreaterThan(0);
    expect(frames[0]!.highlights[0]!.regionId).toMatch(/#p\d+$/);
  });

  it("limits highlight computation to highlightTopN frames", async () => {
    await seedFrames();
    const r = new Retriever(store, { searchers: [], patchEmbedder: mv }, { highlightTopN: 1 });
    const { frames } = await r.retrieve({ text: "anything" });
    expect(frames[0]!.highlights.length).toBeGreaterThan(0);
    expect(frames[1]!.highlights).toEqual([]);
  });

  it("still works with no visual path at all (text-only recall)", async () => {
    await seedFrames();
    const searcher = new TextViewSearcher(text, "digest");
    await store.registerVectorSpace({
      namespace: searcher.namespace,
      view: "digest",
      providerId: text.id,
      model: text.model,
      dimensions: text.dimensions,
      sharedTextSpace: true,
    });
    const r = new Retriever(store, { searchers: [searcher] });
    const { frames } = await r.retrieve({ text: "anything" });
    expect(Array.isArray(frames)).toBe(true);
  });
});
