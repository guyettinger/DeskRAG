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
import { resolveFocusBounds } from "../src/represent/caption/focus-bounds.js";
import { AppCaptionRepresenter } from "../src/represent/caption/app-caption-representer.js";
import type { RegionCropper } from "../src/represent/regions/cropper.js";
import type { Box } from "../src/represent/regions/geometry.js";
import type { EventInsert, EventRow } from "../src/store/types.js";

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
    // Every segment (2 actions + 2 tasks, now that task splits at the same
    // focus_change action does) contains a keyframe -> all captioned.
    expect(result.captionedCount).toBe(4);

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

describe("resolveFocusBounds", () => {
  const mkEvent = (tMono: number, bounds?: { x: number; y: number; w: number; h: number }): EventRow => ({
    id: "e", sessionId: "s", tMono, kind: "focus_change", x: null, y: null,
    data: bounds ? { app: "X", bounds } : { app: "X" },
  });

  it("returns the latest bounds at-or-before tMono", () => {
    const events = [mkEvent(0, { x: 1, y: 1, w: 1, h: 1 }), mkEvent(5000, { x: 9, y: 9, w: 9, h: 9 })];
    expect(resolveFocusBounds(events, 4999)).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    expect(resolveFocusBounds(events, 5000)).toEqual({ x: 9, y: 9, w: 9, h: 9 });
  });

  it("returns undefined when no focus_change with bounds precedes tMono", () => {
    expect(resolveFocusBounds([mkEvent(5000, { x: 9, y: 9, w: 9, h: 9 })], 1000)).toBeUndefined();
    expect(resolveFocusBounds([], 1000)).toBeUndefined();
  });

  it("skips a focus_change with no bounds, keeping the last one that had them", () => {
    const events = [mkEvent(0, { x: 1, y: 1, w: 1, h: 1 }), mkEvent(2000)]; // no bounds at 2000
    expect(resolveFocusBounds(events, 3000)).toEqual({ x: 1, y: 1, w: 1, h: 1 });
  });

  it("tolerates out-of-order input (sorts defensively)", () => {
    const events = [mkEvent(5000, { x: 9, y: 9, w: 9, h: 9 }), mkEvent(0, { x: 1, y: 1, w: 1, h: 1 })];
    expect(resolveFocusBounds(events, 5000)).toEqual({ x: 9, y: 9, w: 9, h: 9 });
  });
});

describe("AppCaptionRepresenter (app_caption view)", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;
  const fake = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-appcap-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("captions the focused window's crop (using the resolved bounds), and skips a segment with no resolvable bounds — never falling back to the full frame", async () => {
    const sessionId = ulid();
    const mk = (t: number, kind: string, data?: unknown): EventInsert => ({
      id: ulid(), sessionId, tMono: t, kind, ...(data !== undefined ? { data } : {}),
    });
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      mk(0, "mouse_move"),
      // Bounds arrive with the focus_change at 5000 — the EARLY segment's
      // frame (t=1000, before this event) has no prior focus_change at all.
      mk(5000, "focus_change", { app: "Calculator", bounds: { x: 10, y: 20, w: 300, h: 200 } }),
      mk(6000, "key_down"),
    ]);
    await store.endSession(sessionId, 9000);

    const ing = new FrameIngestor(store, sessionId, new KeyframeGate({ hammingThreshold: 1 }), blobs);
    const frame = (t: number, gray: Uint8Array, img: Uint8Array): SampledFrame => ({
      tMono: t, width: 1000, height: 1000, gray, grayW: 9, grayH: 8, image: { bytes: img, codec: "png" },
    });
    await ing.ingest(frame(1000, grad(false), Uint8Array.from([1, 2, 3])));
    await ing.ingest(frame(6000, grad(true), Uint8Array.from([9, 8, 7])));

    await new Segmenter(store).segment(sessionId);
    await new Representer(store, { digestEmbedder: fake }).represent(sessionId);
    await new CaptionRepresenter(store, {
      captioner: new FakeCaptionProvider(),
      captionEmbedder: fake,
      blobStore: blobs,
    }).represent(sessionId);

    const seenBoxes: Box[] = [];
    const cropper: RegionCropper = {
      async crop(_img, _fw, _fh, box) {
        seenBoxes.push(box);
        // A different byte LENGTH than the whole-frame crop (3 bytes, from
        // ing.ingest above) so FakeCaptionProvider's length-based signature
        // actually distinguishes app_caption from caption in this test.
        return Uint8Array.from([1, 2, 3, 4, 5]);
      },
    };
    const rep = new AppCaptionRepresenter(store, {
      captioner: new FakeCaptionProvider(),
      captionEmbedder: fake,
      blobStore: blobs,
      cropper,
    });
    const result = await rep.represent(sessionId);
    expect(result.namespace).toBe("app_caption:fake:m:8");

    const segs = store.getSegmentsBySession(sessionId);
    const early = segs.find((s) => s.granularity === "action" && s.tMonoStart === 0)!;
    const late = segs.find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;

    // Early segment's only frame (t=1000) precedes any focus_change with
    // bounds -> no app_caption at all, never a copy of the whole-frame caption.
    expect(early.caption).not.toBeNull(); // the whole-frame caption still exists
    expect(store.getAppCaption(early.id)).toBeUndefined();

    // Late segment's frame (t=6000) resolves to the Calculator bounds.
    expect(store.getAppCaption(late.id)).toBeDefined();
    expect(store.getAppCaption(late.id)).not.toBe(late.caption);
    expect(seenBoxes).toContainEqual({ x: 10, y: 20, w: 300, h: 200 });

    const rec = await store.reconcile();
    expect(rec.missing).toHaveLength(0);
    expect(rec.orphansPruned).toBe(0);
  });
});
