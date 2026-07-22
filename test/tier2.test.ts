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
import { FrameIngestor, type SampledFrame } from "../src/capture/frame-ingest.js";
import { KeyframeGate } from "../src/capture/keyframe.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import { Tier1Retriever } from "../src/retrieve/retriever.js";
import { Tier2Retriever } from "../src/retrieve/tier2.js";
import { TextViewSearcher } from "../src/retrieve/searchers.js";
import type { EventInsert } from "../src/store/types.js";

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

describe("Tier 2: frame association + image embedding + scoped retrieval", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;
  const fake = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-t2-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
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

    // Two keyframes: A early (t=1000), B late (t=6000), with distinct images.
    const ing = new FrameIngestor(store, sessionId, new KeyframeGate({ hammingThreshold: 1 }), blobs);
    const frame = (tMono: number, gray: Uint8Array, image: Uint8Array): SampledFrame => ({
      tMono, width: 1920, height: 1080, gray, grayW: 9, grayH: 8, image: { bytes: image, codec: "png" },
    });
    const a = await ing.ingest(frame(1000, grad(false), imgA));
    const b = await ing.ingest(frame(6000, grad(true), imgB));

    await new Segmenter(store).segment(sessionId);
    await new Representer(store, { digestEmbedder: fake }).represent(sessionId);
    const frameRep = await new FrameRepresenter(store, { imageEmbedder: fake, blobStore: blobs }).represent(sessionId);

    return { sessionId, frameA: a.frameId!, frameB: b.frameId!, frameRep };
  }

  it("associates frames to the segments that contain them and embeds their images", async () => {
    const { sessionId, frameA, frameB, frameRep } = await setup();
    expect(frameRep.embeddedCount).toBe(2);
    expect(frameRep.namespace).toBe("frame_image:fake:m:8");

    const segs = store.getSegmentsBySession(sessionId);
    const early = segs.find((s) => s.granularity === "action" && s.tMonoStart === 0)!;
    const late = segs.find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;
    const task = segs.find((s) => s.granularity === "task")!;

    // frame A (t=1000) -> early action + task; frame B (t=6000) -> late action + task.
    expect(new Set(store.getFrame(frameA)!.segmentIds)).toEqual(new Set([early.id, task.id]));
    expect(new Set(store.getFrame(frameB)!.segmentIds)).toEqual(new Set([late.id, task.id]));
  });

  it("excludes an exact visual match that falls outside the Tier-1 segment scope", async () => {
    const { sessionId, frameA, frameB } = await setup();
    const segs = store.getSegmentsBySession(sessionId);
    const early = segs.find((s) => s.granularity === "action" && s.tMonoStart === 0)!;
    const late = segs.find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;

    const tier2 = new Tier2Retriever(store, fake);

    // imgB is the exact image of frame B. Scoped to B's segment -> found.
    const inScope = await tier2.retrieveFrames({ image: imgB }, [late.id]);
    expect(inScope[0]!.frameId).toBe(frameB);
    expect(inScope[0]!.distance).toBeCloseTo(0, 5);
    expect(inScope[0]!.frame?.tMono).toBe(6000); // hydrated

    // Scoped to the EARLY segment (which holds frame A, not B): the exact match
    // is pre-filtered out; only the in-scope frame A can come back.
    const outOfScope = await tier2.retrieveFrames({ image: imgB }, [early.id]);
    expect(outOfScope.map((h) => h.frameId)).not.toContain(frameB);
    expect(outOfScope.map((h) => h.frameId)).toEqual([frameA]);
  });

  it("chains Tier 1 -> Tier 2: segment retrieval scopes the frame search", async () => {
    const { sessionId, frameB } = await setup();
    const late = store
      .getSegmentsBySession(sessionId)
      .find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;

    // Tier 1: a text query matching the late segment's digest ranks it first.
    const tier1 = new Tier1Retriever(store, [new TextViewSearcher(fake, "digest")]);
    const t1 = await tier1.retrieve({ text: late.digest! });
    const scope = t1.segments.map((s) => s.segmentId);
    expect(scope).toContain(late.id);

    // Tier 2: the visual query, scoped to Tier-1's segments, returns frame B.
    const tier2 = new Tier2Retriever(store, fake);
    const frames = await tier2.retrieveFrames({ image: imgB }, scope);
    expect(frames.map((h) => h.frameId)).toContain(frameB);
  });

  it("returns nothing without an image or with empty scope", async () => {
    const { sessionId } = await setup();
    const anySeg = store.getSegmentsBySession(sessionId)[0]!.id;
    const tier2 = new Tier2Retriever(store, fake);
    expect(await tier2.retrieveFrames({}, [anySeg])).toEqual([]);
    expect(await tier2.retrieveFrames({ image: imgB }, [])).toEqual([]);
  });
});
