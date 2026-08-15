/**
 * Region proposal, which is now the WHOLE of what the Regions stage does.
 *
 * This was an alternate-path test: proposal was fused to crop-and-embed, and
 * selecting the late-interaction provider skipped the Regions stage entirely —
 * so `Anchor.visual` in the trace IR could never be populated and the executor's
 * `ax -> visual -> point` ladder silently lost its middle rung. Splitting them
 * fixed that; removing the single-vector image lane made the split total, so
 * this is the ORDINARY path now and there is no other.
 *
 * What a region row carries is unchanged: geometry, source, and AX role/label,
 * which is what `region_fts`, the digest's "label of what was clicked",
 * `Anchor.visual` and the rail's region counts all read.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegionRepresenter } from "../src/represent/regions/region-representer.js";
import { id, makeStore, seedSessionWithSegments, type TestCtx } from "./helpers.js";
import type { UIElement } from "../src/embed/types.js";

describe("region proposal", () => {
  let ctx: TestCtx;
  beforeEach(async () => {
    ctx = await makeStore(["digest"]);
  });
  afterEach(() => ctx.cleanup());

  it("putRegions persists a row and adds nothing to Lance", async () => {
    const { store } = ctx;
    const { sessionId, segA } = await seedSessionWithSegments(store);
    const frameId = id();
    await store.putFrames([
      { id: frameId, sessionId, tMono: 1, width: 100, height: 100, phash: 1n, frameOffset: 0, segmentIds: [segA] },
    ]);

    const regionId = id();
    await store.putRegions([
      {
        id: regionId, frameId, segmentId: segA, sessionId,
        x: 10, y: 20, w: 30, h: 40,
        source: "ax", role: "Button", label: "Save", priority: 3,
      },
    ]);

    // The relational row — everything an Anchor.visual layer needs — is present.
    const rows = store.getRegionsByFrame(frameId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: regionId, x: 10, y: 20, w: 30, h: 40, label: "Save" });
    // And the label is searchable, which is the ONLY way a text query reaches a
    // region now that there is no region vector to search.
    expect(store.ftsRegions("Save")).toContain(regionId);

    // A region is not "missing a vector": no space is keyed on one any more, so
    // reconciliation has nothing to say about it either way.
    const { missing } = await store.reconcile();
    expect(missing.map((m) => m.id)).not.toContain(regionId);
  });

  it("RegionRepresenter proposes and persists regions from the AX tree alone", async () => {
    const { store } = ctx;
    const { sessionId, segA } = await seedSessionWithSegments(store);
    const frameId = id();
    await store.putFrames([
      { id: frameId, sessionId, tMono: 1, width: 1000, height: 1000, phash: 1n, frameOffset: 0, segmentIds: [segA] },
    ]);

    const axTree: UIElement[] = [
      { role: "Button", label: "Save", x: 100, y: 100, w: 80, h: 30 },
      { role: "TextField", label: "Search", x: 200, y: 200, w: 120, h: 24, focused: true },
    ];

    const rep = new RegionRepresenter(store, { axProvider: () => axTree });
    const result = await rep.represent(sessionId);

    expect(result.regionCount).toBeGreaterThan(0);
    const rows = store.getRegionsByFrame(frameId);
    expect(rows.length).toBe(result.regionCount);
    expect(rows.some((r) => r.label === "Save")).toBe(true);
  });

  /**
   * A frame with NO blob still gets regions. It could not before: the stage
   * needed the image bytes to crop, so an imageless frame was skipped whole and
   * its geometry — which is what anchors an action — went with it.
   */
  it("proposes for a frame that has no blob at all", async () => {
    const { store } = ctx;
    const { sessionId, segA } = await seedSessionWithSegments(store);
    await store.putFrames([
      { id: id(), sessionId, tMono: 1, width: 1000, height: 1000, phash: 1n, frameOffset: 0, segmentIds: [segA] },
    ]);
    const result = await new RegionRepresenter(store, {
      axProvider: () => [{ role: "Button", label: "Save", x: 10, y: 10, w: 80, h: 30 }],
    }).represent(sessionId);
    expect(result.regionCount).toBeGreaterThan(0);
  });
});
