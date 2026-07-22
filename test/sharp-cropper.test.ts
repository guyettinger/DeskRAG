import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import sharp from "sharp";
import { SharpRegionCropper } from "../src/represent/regions/sharp-cropper.js";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { Segmenter } from "../src/segment/segmenter.js";
import { RegionRepresenter } from "../src/represent/regions/region-representer.js";
import { Tier3Retriever } from "../src/retrieve/tier3.js";
import { FrameIngestor, type SampledFrame } from "../src/capture/frame-ingest.js";
import { KeyframeGate } from "../src/capture/keyframe.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import type { EventInsert } from "../src/store/types.js";
import type { UIElement } from "../src/embed/types.js";

/** A 40x30 image: left half red, right half blue. */
async function twoTone(): Promise<Uint8Array> {
  const H = 30;
  const red = await sharp({ create: { width: 20, height: H, channels: 3, background: { r: 220, g: 0, b: 0 } } }).png().toBuffer();
  const blue = await sharp({ create: { width: 20, height: H, channels: 3, background: { r: 0, g: 0, b: 220 } } }).png().toBuffer();
  const out = await sharp({ create: { width: 40, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: red, left: 0, top: 0 }, { input: blue, left: 20, top: 0 }])
    .jpeg()
    .toBuffer();
  return new Uint8Array(out);
}

async function centerPixel(img: Uint8Array): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(img).raw().toBuffer({ resolveWithObject: true });
  const cx = Math.floor(info.width / 2);
  const cy = Math.floor(info.height / 2);
  const i = (cy * info.width + cx) * info.channels;
  return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
}

describe("SharpRegionCropper", () => {
  it("crops to the requested bbox dimensions and emits a valid JPEG", async () => {
    const img = await twoTone();
    const crop = await new SharpRegionCropper().crop(img, 40, 30, { x: 5, y: 5, w: 10, h: 8 });
    expect(crop[0]).toBe(0xff); // JPEG SOI
    expect(crop[1]).toBe(0xd8);
    const meta = await sharp(crop).metadata();
    expect([meta.width, meta.height]).toEqual([10, 8]);
  });

  it("maps bbox from frame space to a downscaled image (scale 0.5)", async () => {
    const img = await twoTone(); // actual image is 40x30
    // Frame is 80x60 (2x), so a 20x16 frame box maps to a 10x8 image crop.
    const crop = await new SharpRegionCropper().crop(img, 80, 60, { x: 10, y: 10, w: 20, h: 16 });
    const meta = await sharp(crop).metadata();
    expect([meta.width, meta.height]).toEqual([10, 8]);
  });

  it("extracts the correct region (left = red, right = blue)", async () => {
    const img = await twoTone();
    const cropper = new SharpRegionCropper({ format: "png" });
    const left = await cropper.crop(img, 40, 30, { x: 0, y: 0, w: 20, h: 30 });
    const right = await cropper.crop(img, 40, 30, { x: 20, y: 0, w: 20, h: 30 });

    const lc = await centerPixel(left);
    expect(lc.r).toBeGreaterThan(150);
    expect(lc.b).toBeLessThan(80);
    const rc = await centerPixel(right);
    expect(rc.b).toBeGreaterThan(150);
    expect(rc.r).toBeLessThan(80);
  });

  it("clamps a bbox that runs past the image bounds", async () => {
    const img = await twoTone();
    const crop = await new SharpRegionCropper().crop(img, 40, 30, { x: 35, y: 25, w: 100, h: 100 });
    const meta = await sharp(crop).metadata();
    expect(meta.width!).toBeLessThanOrEqual(5);
    expect(meta.height!).toBeLessThanOrEqual(5);
    expect(meta.width!).toBeGreaterThan(0);
  });
});

function gradGray(): Uint8Array {
  const g = new Uint8Array(72);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) g[y * 9 + x] = Math.round((x * 255) / 8);
  return g;
}

describe("SharpRegionCropper in the region pipeline", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;
  const fake = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-sc-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("crops real stored JPEG keyframes and persists searchable regions", async () => {
    const sessionId = ulid();
    const mk = (t: number, kind: string, x?: number, y?: number): EventInsert => ({
      id: ulid(), sessionId, tMono: t, kind, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}),
    });
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    await store.putEvents([mk(0, "mouse_down", 30, 20), mk(50, "mouse_down", 32, 22)]);
    await store.endSession(sessionId, 1000);

    // A real 64x48 JPEG keyframe, ingested with matching frame dims (scale 1).
    const jpeg = new Uint8Array(
      await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 120, g: 60, b: 30 } } }).jpeg().toBuffer(),
    );
    const ing = new FrameIngestor(store, sessionId, new KeyframeGate({ hammingThreshold: 1 }), blobs);
    const frame: SampledFrame = {
      tMono: 100, width: 64, height: 48, gray: gradGray(), grayW: 9, grayH: 8, image: { bytes: jpeg, codec: "jpeg" },
    };
    const kf = await ing.ingest(frame);

    await new Segmenter(store).segment(sessionId);

    const axEl: UIElement = { role: "button", label: "Save", x: 10, y: 10, w: 20, h: 15 };
    const result = await new RegionRepresenter(store, {
      imageEmbedder: fake,
      blobStore: blobs,
      cropper: new SharpRegionCropper({ format: "jpeg" }),
      axProvider: () => [axEl],
    }).represent(sessionId);

    expect(result.regionCount).toBeGreaterThan(0);

    // The AX region is retrievable (its real crop was embedded + FTS-indexed).
    const tier3 = new Tier3Retriever(store, fake);
    const hits = await tier3.retrieveRegions({ text: "Save" }, [kf.frameId!]);
    expect(hits.find((h) => h.label === "Save")).toBeDefined();
  });
});
