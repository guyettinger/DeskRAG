import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { id, makeStore, seedSessionWithSegments, type TestCtx } from "./helpers.js";

/**
 * The load-bearing test: scoping must PRE-filter, not post-filter.
 *
 * We place an out-of-scope vector NEARER to the query than the in-scope one, and
 * ask for k=1. With prefiltering, the out-of-scope row is removed before the ANN,
 * so we get the in-scope row. With postfiltering, the ANN would pick the nearer
 * out-of-scope row and then drop it, yielding ZERO results. So this test both
 * proves scope correctness AND validates that `array_has_any` / `frame_id IN`
 * genuinely prefilter in the LanceDB JS SDK.
 */
describe("scoped ANN (Tier 2 -> Tier 3)", () => {
  let ctx: TestCtx;
  const q = Float32Array.from([0, 1, 0, 0]); // nearest to the [0,1,0,0] vectors

  beforeEach(async () => {
    ctx = await makeStore(["frame_image", "region_image"], 4);
  });
  afterEach(() => ctx.cleanup());

  it("frame search scoped by segment excludes a nearer out-of-scope frame", async () => {
    const { store, ns } = ctx;
    const { sessionId, segA, segB } = await seedSessionWithSegments(store);
    const fA = id();
    const fB = id();

    // fA lives in segment A but is FAR from q; fB lives in B and is NEAR q.
    await store.putFrames([
      {
        id: fA, sessionId, tMono: 1, width: 100, height: 100, phash: 1n,
        frameOffset: 0, segmentIds: [segA],
        vector: { namespace: ns("frame_image"), vector: Float32Array.from([1, 0, 0, 0]) },
      },
      {
        id: fB, sessionId, tMono: 2, width: 100, height: 100, phash: 2n,
        frameOffset: 1, segmentIds: [segB],
        vector: { namespace: ns("frame_image"), vector: Float32Array.from([0, 1, 0, 0]) },
      },
    ]);

    // Sanity: unscoped, fB (nearer) wins.
    const unscoped = await store.searchFrames(ns("frame_image"), q, 1);
    expect(unscoped.map((h) => h.id)).toEqual([fB]);

    // Scoped to segment A: prefilter drops fB, so we get fA (NOT empty).
    const scoped = await store.searchFrames(ns("frame_image"), q, 1, {
      segmentIds: [segA],
    });
    expect(scoped.map((h) => h.id)).toEqual([fA]);
  });

  it("region search scoped by frameIds chains from the frame tier", async () => {
    const { store, ns } = ctx;
    const { sessionId, segA, segB } = await seedSessionWithSegments(store);
    const fA = id();
    const fB = id();
    await store.putFrames([
      { id: fA, sessionId, tMono: 1, width: 10, height: 10, phash: 1n, frameOffset: 0, segmentIds: [segA],
        vector: { namespace: ns("frame_image"), vector: Float32Array.from([1, 0, 0, 0]) } },
      { id: fB, sessionId, tMono: 2, width: 10, height: 10, phash: 2n, frameOffset: 1, segmentIds: [segB],
        vector: { namespace: ns("frame_image"), vector: Float32Array.from([0, 1, 0, 0]) } },
    ]);

    const rA = id();
    const rB = id();
    await store.putRegions([
      { id: rA, frameId: fA, segmentId: segA, sessionId, x: 0, y: 0, w: 5, h: 5,
        source: "ax", role: "button", label: "Save", priority: 1,
        vector: { namespace: ns("region_image"), vector: Float32Array.from([1, 0, 0, 0]) } },
      { id: rB, frameId: fB, segmentId: segB, sessionId, x: 0, y: 0, w: 5, h: 5,
        source: "ax", role: "button", label: "Cancel", priority: 1,
        vector: { namespace: ns("region_image"), vector: Float32Array.from([0, 1, 0, 0]) } },
    ]);

    // Chain: frames scoped to segA -> use those frameIds to scope regions.
    const frames = await store.searchFrames(ns("frame_image"), q, 5, { segmentIds: [segA] });
    expect(frames.map((h) => h.id)).toEqual([fA]);

    const regions = await store.searchRegions(ns("region_image"), q, 1, {
      frameIds: frames.map((h) => h.id),
    });
    expect(regions.map((h) => h.id)).toEqual([rA]); // rB (nearer) is out of scope
  });

  it("FTS makes region role/label searchable", async () => {
    const { store, ns } = ctx;
    const { sessionId, segA } = await seedSessionWithSegments(store);
    const fA = id();
    await store.putFrames([
      { id: fA, sessionId, tMono: 1, width: 10, height: 10, phash: 1n, frameOffset: 0, segmentIds: [segA],
        vector: { namespace: ns("frame_image"), vector: Float32Array.from([1, 0, 0, 0]) } },
    ]);
    const rSave = id();
    await store.putRegions([
      { id: rSave, frameId: fA, segmentId: segA, sessionId, x: 0, y: 0, w: 5, h: 5,
        source: "ax", role: "dialog", label: "Save As", priority: 1,
        vector: { namespace: ns("region_image"), vector: Float32Array.from([1, 0, 0, 0]) } },
    ]);
    expect(store.ftsRegions("Save")).toContain(rSave);
    expect(store.ftsRegions("dialog")).toContain(rSave);
    expect(store.ftsRegions("nonexistent")).toHaveLength(0);
  });
});
