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
import { Retriever } from "../src/retrieve/assemble.js";
import { FakeReranker } from "../src/retrieve/rerank/fake.js";
import type { RegionCropper } from "../src/represent/regions/cropper.js";
import type { Box } from "../src/represent/regions/geometry.js";
import type { EventInsert } from "../src/store/types.js";

describe("FakeReranker", () => {
  it("orders candidates by query-token overlap, stable on ties", async () => {
    const order = await new FakeReranker().rerank("save dialog", [
      { id: "a", text: "an address bar" },
      { id: "b", text: "the save dialog is open" },
      { id: "c", text: "a save button" },
    ]);
    expect(order[0]).toBe("b"); // "save" + "dialog"
    expect(order[1]).toBe("c"); // "save"
    expect(order[2]).toBe("a"); // no overlap
  });
});

const cropper: RegionCropper = {
  async crop(_i, _w, _h, b: Box) {
    return Uint8Array.from([Math.round(b.x) & 255, Math.round(b.y) & 255, Math.round(b.w) & 255, Math.round(b.h) & 255]);
  },
};
function grad(reverse = false): Uint8Array {
  const g = new Uint8Array(72);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 9; x++) {
      const v = Math.round((x * 255) / 8);
      g[y * 9 + x] = reverse ? 255 - v : v;
    }
  return g;
}
const imgA = Uint8Array.from([1, 2, 3, 4]);
const imgB = Uint8Array.from([9, 8, 7, 6]);

describe("Retriever Tier-4 rerank", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;
  const fake = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-rr-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const sessionId = ulid();
    const mk = (t: number, kind: string, data?: unknown): EventInsert => ({
      id: ulid(), sessionId, tMono: t, kind, ...(data !== undefined ? { data } : {}),
    });
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      mk(0, "mouse_move"),
      mk(5000, "focus_change", { app: "Slack" }),
      mk(6000, "key_down"),
    ]);
    await store.endSession(sessionId, 9000);

    const ing = new FrameIngestor(store, sessionId, new KeyframeGate({ hammingThreshold: 1 }), blobs);
    const frame = (t: number, gray: Uint8Array, img: Uint8Array): SampledFrame => ({
      tMono: t, width: 100, height: 100, gray, grayW: 9, grayH: 8, image: { bytes: img, codec: "png" },
    });
    const a = await ing.ingest(frame(1000, grad(false), imgA)); // early "mouse movement" segment
    const b = await ing.ingest(frame(6000, grad(true), imgB)); // late "Slack" segment

    await new Segmenter(store).segment(sessionId);
    await new Representer(store, { digestEmbedder: fake }).represent(sessionId);
    await new FrameRepresenter(store, { imageEmbedder: fake, blobStore: blobs }).represent(sessionId);
    await new RegionRepresenter(store, { imageEmbedder: fake, blobStore: blobs, cropper }).represent(sessionId);
    return { frameA: a.frameId!, frameB: b.frameId! };
  }

  it("reorders the assembled frames for an NL query; without it, base score wins", async () => {
    const { frameA, frameB } = await setup();
    // No Tier-1 searchers -> unscoped visual recall; imgB is the exact match for
    // frame B, so the base assembled order is [B, A].
    const base = await new Retriever(store, { searchers: [], imageEmbedder: fake })
      .retrieve({ image: imgB, text: "mouse movement" });
    expect(base.frames[0]!.frameId).toBe(frameB);

    // With a reranker + a query whose words overlap frame A's digest ("mouse
    // movement"), Tier 4 promotes A above the higher-scored B.
    const reranked = await new Retriever(store, { searchers: [], imageEmbedder: fake }, {
      reranker: new FakeReranker(),
    }).retrieve({ image: imgB, text: "mouse movement" });
    expect(reranked.frames[0]!.frameId).toBe(frameA);
    expect(reranked.frames.map((f) => f.frameId).sort()).toEqual([frameA, frameB].sort());
  });

  it("does not rerank a pure visual query (no query text)", async () => {
    const { frameB } = await setup();
    const res = await new Retriever(store, { searchers: [], imageEmbedder: fake }, {
      reranker: new FakeReranker(),
    }).retrieve({ image: imgB });
    expect(res.frames[0]!.frameId).toBe(frameB); // rerank skipped -> base order
  });
});
