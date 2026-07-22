import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { Segmenter } from "../src/segment/segmenter.js";
import { Representer } from "../src/represent/representer.js";
import { FrameRepresenter } from "../src/represent/frame-representer.js";
import { RegionRepresenter } from "../src/represent/regions/region-representer.js";
import { FrameIngestor, type SampledFrame } from "../src/capture/frame-ingest.js";
import { KeyframeGate } from "../src/capture/keyframe.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import { BehaviorFeatureExtractor } from "../src/represent/behavior.js";
import { Retriever } from "../src/retrieve/assemble.js";
import { TextViewSearcher, BehaviorViewSearcher } from "../src/retrieve/searchers.js";
import type { RegionCropper } from "../src/represent/regions/cropper.js";
import type { Box } from "../src/represent/regions/geometry.js";
import type { EventInsert } from "../src/store/types.js";
import type { UIElement } from "../src/embed/types.js";

const cropper: RegionCropper = {
  async crop(_i, _w, _h, b: Box) {
    return Uint8Array.from([Math.round(b.x) & 255, Math.round(b.y) & 255, Math.round(b.w) & 255, Math.round(b.h) & 255]);
  },
};
const imgA = Uint8Array.from([1, 2, 3, 4]);
const imgB = Uint8Array.from([9, 8, 7, 6]);

// Distinct gradients -> distinct pHashes so both keyframes survive dedup gating.
function grad(reverse = false): Uint8Array {
  const g = new Uint8Array(72);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 9; x++) {
      const v = Math.round((x * 255) / 8);
      g[y * 9 + x] = reverse ? 255 - v : v;
    }
  return g;
}

describe("Retriever (assembly capstone)", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;
  const fake = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });
  const behavior = new BehaviorFeatureExtractor();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-asm-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const sessionId = ulid();
    const mk = (t: number, kind: string, x?: number, y?: number, data?: unknown): EventInsert => ({
      id: ulid(), sessionId, tMono: t, kind,
      ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}), ...(data !== undefined ? { data } : {}),
    });
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      mk(0, "mouse_move", 0, 0),
      mk(5000, "focus_change", undefined, undefined, { app: "Slack" }),
      mk(6000, "mouse_down", 500, 500),
      mk(6100, "mouse_down", 505, 505),
      mk(6200, "key_down"),
    ]);
    await store.endSession(sessionId, 9000);

    const ing = new FrameIngestor(store, sessionId, new KeyframeGate({ hammingThreshold: 1 }), blobs);
    const frame = (t: number, gray: Uint8Array, image: Uint8Array): SampledFrame => ({
      tMono: t, width: 1920, height: 1080, gray, grayW: 9, grayH: 8, image: { bytes: image, codec: "png" },
    });
    const a = await ing.ingest(frame(1000, grad(false), imgA));
    const b = await ing.ingest(frame(6000, grad(true), imgB));

    await new Segmenter(store).segment(sessionId);
    await new Representer(store, { digestEmbedder: fake, behavior }).represent(sessionId);
    await new FrameRepresenter(store, { imageEmbedder: fake, blobStore: blobs }).represent(sessionId);
    const axEl: UIElement = { role: "button", label: "Save", x: 480, y: 480, w: 60, h: 24 };
    await new RegionRepresenter(store, {
      imageEmbedder: fake, blobStore: blobs, cropper, axProvider: () => [axEl],
    }).represent(sessionId);

    const late = store.getSegmentsBySession(sessionId).find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;
    return { sessionId, frameA: a.frameId!, frameB: b.frameId!, late };
  }

  function retriever() {
    return new Retriever(store, {
      searchers: [new TextViewSearcher(fake, "digest"), new BehaviorViewSearcher(behavior)],
      imageEmbedder: fake,
    });
  }

  it("combined text+image: the exact-match frame in the matching segment ranks #1 with highlights", async () => {
    const { frameB, late } = await setup();
    const res = await retriever().retrieve({ text: late.digest!, image: imgB });

    expect(res.segments.map((s) => s.segmentId)).toContain(late.id);
    expect(res.frames[0]!.frameId).toBe(frameB);
    expect(res.frames[0]!.frameDistance).toBeCloseTo(0, 5);
    expect(res.frames[0]!.segmentId).toBe(late.id);
    expect(res.frames[0]!.highlights.length).toBeGreaterThan(0);
    // scores are sorted descending
    const scores = res.frames.map((f) => f.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("pure image query: unscoped frame recall ranks the exact match first, with highlights", async () => {
    const { frameB } = await setup();
    const res = await retriever().retrieve({ image: imgB });

    expect(res.segments).toEqual([]); // Tier 1 not engaged without text/behavior
    expect(res.frames[0]!.frameId).toBe(frameB);
    expect(res.frames[0]!.frameDistance).toBeCloseTo(0, 5);
    expect(res.frames[0]!.highlights.length).toBeGreaterThan(0);
  });

  it("text-only query: returns ranked segments and their frames, no visual highlights", async () => {
    const { frameA, frameB, late } = await setup();
    const res = await retriever().retrieve({ text: late.digest! });

    expect(res.segments[0]!.segmentId).toBe(late.id);
    const ids = res.frames.map((f) => f.frameId);
    expect(ids).toContain(frameB);
    expect(ids).toContain(frameA);
    // no image query -> no ANN distance and no highlights
    expect(res.frames.every((f) => f.frameDistance === undefined)).toBe(true);
    expect(res.frames.every((f) => f.highlights.length === 0)).toBe(true);
    // the frame in the top-scoring segment sorts first
    expect(res.frames[0]!.frameId).toBe(frameB);
  });
});
