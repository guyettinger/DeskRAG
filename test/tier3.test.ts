import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { Segmenter } from "../src/segment/segmenter.js";
import { FrameIngestor, type SampledFrame } from "../src/capture/frame-ingest.js";
import { KeyframeGate } from "../src/capture/keyframe.js";
import { RegionRepresenter } from "../src/represent/regions/region-representer.js";
import { Tier3Retriever } from "../src/retrieve/tier3.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import type { Box } from "../src/represent/regions/geometry.js";
import type { RegionCropper } from "../src/represent/regions/cropper.js";
import type { EventInsert } from "../src/store/types.js";
import type { UIElement } from "../src/embed/types.js";

// Deterministic cropper: crop bytes uniquely identify the box, so the fake
// embedder maps each region to a stable vector and a query crop can match.
const cropper: RegionCropper = {
  async crop(_img, _fw, _fh, b: Box) {
    return Uint8Array.from([
      Math.round(b.x) & 255, Math.round(b.y) & 255,
      Math.round(b.w) & 255, Math.round(b.h) & 255,
    ]);
  },
};
const cropBytesFor = (b: Box) =>
  Uint8Array.from([Math.round(b.x) & 255, Math.round(b.y) & 255, Math.round(b.w) & 255, Math.round(b.h) & 255]);

const saveBox: Box = { x: 480, y: 480, w: 60, h: 24 };

describe("Tier 3: region proposal + embedding + scoped highlights", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;
  const fake = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-t3-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const sessionId = ulid();
    const mk = (tMono: number, kind: string, x?: number, y?: number, data?: unknown): EventInsert => ({
      id: ulid(), sessionId, tMono, kind,
      ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}),
      ...(data !== undefined ? { data } : {}),
    });
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      mk(0, "mouse_move", 0, 0),
      mk(5000, "focus_change", undefined, undefined, { app: "Slack" }),
      mk(6000, "mouse_down", 500, 500),
      mk(6100, "mouse_down", 505, 505), // clusters with the above -> one hotspot
      mk(6200, "key_down"),
    ]);
    await store.endSession(sessionId, 9000);

    // One keyframe at t=6000 (in the late action segment where the clicks are).
    const ing = new FrameIngestor(store, sessionId, new KeyframeGate({ hammingThreshold: 1 }), blobs);
    const gray = new Uint8Array(72).fill(128);
    const frame: SampledFrame = {
      tMono: 6000, width: 1920, height: 1080, gray, grayW: 9, grayH: 8,
      image: { bytes: Uint8Array.from([1, 2, 3]), codec: "png" },
    };
    const kf = await ing.ingest(frame);

    await new Segmenter(store).segment(sessionId);

    // Synthetic AX source: one labeled Save button.
    const axEl: UIElement = { role: "button", label: "Save", x: 480, y: 480, w: 60, h: 24 };
    const rep = new RegionRepresenter(store, {
      imageEmbedder: fake, blobStore: blobs, cropper,
      axProvider: () => [axEl],
    });
    const result = await rep.represent(sessionId);
    return { sessionId, frameId: kf.frameId!, result };
  }

  it("proposes and persists regions (AX + hotspot + grid) with the region_image vector", async () => {
    const { result } = await setup();
    expect(result.namespace).toBe("region_image:fake:m:8");
    // 1 AX (Save) + 1 hotspot (click cluster) + up to 12 grid, budget-capped at 14.
    expect(result.regionCount).toBeGreaterThanOrEqual(3);
    expect(result.regionCount).toBeLessThanOrEqual(14);
  });

  it("finds a region by AX label via FTS, scoped to the frame, as a highlight", async () => {
    const { frameId } = await setup();
    const tier3 = new Tier3Retriever(store, fake);

    const hits = await tier3.retrieveRegions({ text: "Save" }, [frameId]);
    const save = hits.find((h) => h.label === "Save")!;
    expect(save).toBeDefined();
    expect(save.matchedBy).toContain("fts");
    expect(save.frameId).toBe(frameId);
    expect(save.bbox).toEqual({ x: 480, y: 480, w: 60, h: 24 }); // highlight bbox

    // Same FTS term, but scoped to a different frame -> excluded.
    expect(await tier3.retrieveRegions({ text: "Save" }, ["other-frame"])).toEqual([]);
  });

  it("image ANN is pre-filtered to the frame scope; empty scope returns nothing", async () => {
    const { frameId } = await setup();
    const tier3 = new Tier3Retriever(store, fake);

    const hits = await tier3.retrieveRegions({ image: Uint8Array.from([1, 1, 1, 1]) }, [frameId]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.frameId === frameId)).toBe(true);
    expect(hits.every((h) => h.matchedBy.includes("ann"))).toBe(true);

    expect(await tier3.retrieveRegions({ image: Uint8Array.from([1, 1, 1, 1]) }, [])).toEqual([]);
  });

  it("a region matched by BOTH image and label reports matchedBy ann+fts", async () => {
    const { frameId } = await setup();
    const tier3 = new Tier3Retriever(store, fake);

    // Query with the Save region's exact crop bytes AND its label.
    const hits = await tier3.retrieveRegions(
      { image: cropBytesFor(saveBox), text: "Save" },
      [frameId],
    );
    expect(hits[0]!.label).toBe("Save"); // exact image match -> distance 0 -> first
    expect(hits[0]!.distance).toBeCloseTo(0, 5);
    expect(hits[0]!.matchedBy.sort()).toEqual(["ann", "fts"]);
  });
});
