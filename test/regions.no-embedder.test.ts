/**
 * Region proposal decoupled from region embedding.
 *
 * Proposal is pure geometry plus the AX tree; only the crop-and-embed half needs
 * an image model. They were fused, and the consequence was structural: the app
 * makes `imageEmbedder` and `patchEmbedder` mutually exclusive, so selecting the
 * ColSmol (late-interaction) path skipped the Regions stage entirely — and with
 * no region rows, `Anchor.visual` in the trace IR could never be populated. The
 * executor's `ax -> visual -> point` ladder silently lost its middle rung.
 *
 * A region row without a vector is already a state this store models: it is what
 * a crash between the SQLite commit and the Lance add leaves behind, and what
 * reconciliation exists to find and re-embed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegionRepresenter } from "../src/represent/regions/region-representer.js";
import { id, makeStore, seedSessionWithSegments, type TestCtx } from "./helpers.js";
import type { UIElement } from "../src/embed/types.js";

describe("regions without an image embedder", () => {
  let ctx: TestCtx;
  beforeEach(async () => {
    ctx = await makeStore(["frame_image", "region_image"]);
  });
  afterEach(() => ctx.cleanup());

  it("putRegions persists a row with no vector, and adds nothing to Lance", async () => {
    const { store, ns } = ctx;
    const { sessionId, segA } = await seedSessionWithSegments(store);
    const frameId = id();
    await store.putFrames([
      {
        id: frameId, sessionId, tMono: 1, width: 100, height: 100, phash: 1n,
        frameOffset: 0, segmentIds: [segA],
        vector: { namespace: ns("frame_image"), vector: Float32Array.from([1, 0, 0, 0]) },
      },
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

    // ...and nothing landed in the vector table.
    const { missing } = await store.reconcile();
    expect(missing.map((m) => m.id)).toContain(regionId);
  });

  it("RegionRepresenter proposes and persists regions with no embedder and no cropper", async () => {
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

    // No embedder, no cropper, no blob store: proposal needs none of them.
    const rep = new RegionRepresenter(store, { axProvider: () => axTree });
    const result = await rep.represent(sessionId);

    expect(result.regionCount).toBeGreaterThan(0);
    const rows = store.getRegionsByFrame(frameId);
    expect(rows.length).toBe(result.regionCount);
    expect(rows.some((r) => r.label === "Save")).toBe(true);
  });
});
