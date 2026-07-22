import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { Segmenter } from "../src/segment/segmenter.js";
import { Representer } from "../src/represent/representer.js";
import { CaptionRepresenter } from "../src/represent/caption/caption-representer.js";
import { FakeCaptionProvider } from "../src/represent/caption/fake.js";
import { FrameIngestor, type SampledFrame } from "../src/capture/frame-ingest.js";
import { KeyframeGate } from "../src/capture/keyframe.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import { Tier1Retriever } from "../src/retrieve/retriever.js";
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

describe("CaptionRepresenter (view 2)", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;
  const fake = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-cap2-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("captions each segment's keyframes, persists the text, and makes it Tier-1 searchable", async () => {
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
    await ing.ingest(frame(1000, grad(false), Uint8Array.from([1, 2, 3])));
    await ing.ingest(frame(6000, grad(true), Uint8Array.from([9, 8, 7])));

    await new Segmenter(store).segment(sessionId);
    await new Representer(store, { digestEmbedder: fake }).represent(sessionId); // digests -> caption context

    const rep = new CaptionRepresenter(store, {
      captioner: new FakeCaptionProvider(),
      captionEmbedder: fake,
      blobStore: blobs,
    });
    const result = await rep.represent(sessionId);

    expect(result.namespace).toBe("caption:fake:m:8");
    // Every segment (2 actions + 1 task) contains a keyframe -> all captioned.
    expect(result.captionedCount).toBe(3);

    const segs = store.getSegmentsBySession(sessionId);
    expect(segs.every((s) => s.caption !== null)).toBe(true);
    const late = segs.find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;
    expect(late.caption).toContain("Slack"); // context (digest) flowed into the caption

    // The caption is a Tier-1 view: querying its exact text ranks the segment #1.
    const tier1 = new Tier1Retriever(store, [new TextViewSearcher(fake, "caption")]);
    const hit = await tier1.retrieve({ text: late.caption! });
    expect(hit.segments[0]!.segmentId).toBe(late.id);
    expect(hit.segments[0]!.perView[0]!.view).toBe("caption");

    // Enrich path is consistent — nothing missing or orphaned.
    const rec = await store.reconcile();
    expect(rec.missing).toHaveLength(0);
    expect(rec.orphansPruned).toBe(0);
  });
});
