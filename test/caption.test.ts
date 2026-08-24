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
import { KeyframeBudget } from "../src/capture/keyframe-budget.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import { Tier1Retriever } from "../src/retrieve/retriever.js";
import { TextViewSearcher } from "../src/retrieve/searchers.js";
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

    const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);
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
    // Each frame is a scene_change boundary, so segmentation produces
    //   action [0,1000) [1000,5000) [5000,6000) [6000,8000]   (4)
    // and only the two holding a keyframe (t=1000 or t=6000) get captioned —
    // the spans at 0 and 5000 hold none. Level 0 is the only granularity
    // segmentation emits; composed levels are built later and are not captioned.
    expect(result.captionedCount).toBe(2);

    const segs = store.getSegmentsBySession(sessionId);
    expect(segs).toHaveLength(4);
    expect(segs.filter((s) => s.caption !== null)).toHaveLength(2);
    // The captioned span that names Slack is the one HOLDING the late keyframe,
    // which starts at that frame's own scene_change. The span at 5000 carries
    // the focus change but is bracketed by it and the next scene change, so it
    // holds no frame in this synthetic schedule and gets no caption.
    const late = segs.find((s) => s.granularity === "action" && s.tMonoStart === 6000)!;
    // The point is that the structured digest reaches the captioner as context.
    // Asserting on the digest itself rather than on "Slack" keeps that
    // independent of which span happens to contain the focus_change event —
    // this Representer is built with no `focusAt`, so only a span containing the
    // event names the app at all.
    expect(late.caption).toContain(late.digest!);

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

/**
 * The two hooks that made captioning cheap: a width cap for the model, and the
 * recorder skipped outright.
 *
 * Both are optional, and ABSENCE IS THE OLD BEHAVIOUR in each case — that is the
 * property worth pinning, because a downscaler that failed to load or a session
 * with no `focus_change` must cost time or nothing, never a caption.
 */
describe("CaptionRepresenter — downscale and exclusion hooks", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;
  const fake = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-cap3-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Two keyframes in two action spans, one focused on the recorder. */
  async function seed(sessionId: string): Promise<void> {
    const mk = (t: number, kind: string, data?: unknown): EventInsert => ({
      id: ulid(), sessionId, tMono: t, kind, ...(data !== undefined ? { data } : {}),
    });
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([
      // The recording OPENS in the recorder, which is what really happens: the
      // Record button was clicked there.
      mk(0, "focus_change", { app: "DeskRAG" }),
      mk(5000, "focus_change", { app: "Slack" }),
    ]);
    await store.endSession(sessionId, 9000);

    const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);
    const frame = (t: number, gray: Uint8Array, img: Uint8Array): SampledFrame => ({
      tMono: t, width: 100, height: 100, gray, grayW: 9, grayH: 8, image: { bytes: img, codec: "png" },
    });
    await ing.ingest(frame(1000, grad(), new Uint8Array([1, 2, 3])));
    await ing.ingest(frame(6000, grad(true), new Uint8Array([4, 5, 6])));

    await new Segmenter(store).segment(sessionId);
    await new Representer(store, { digestEmbedder: fake }).represent(sessionId);
  }

  it("passes each keyframe through the downscaler before the model, and the ORIGINAL when there is none", async () => {
    const sessionId = ulid();
    await seed(sessionId);

    const seen: Uint8Array[] = [];
    const captioner = {
      caption: async (frames: Uint8Array[]): Promise<string> => {
        seen.push(...frames);
        return "described";
      },
    };

    await new CaptionRepresenter(store, {
      captioner,
      captionEmbedder: fake,
      blobStore: blobs,
      downscale: async () => new Uint8Array([9, 9, 9]),
    }).represent(sessionId);

    expect(seen.length).toBeGreaterThan(0);
    // Every byte the model saw came from the downscaler, and NOTHING was written
    // back: the stored blob keeps its own bytes for visual search.
    for (const got of seen) expect([...got]).toEqual([9, 9, 9]);
    const frames = store.getFramesBySession(sessionId);
    const stored = await blobs.read(store.getBlob(frames[0]!.blobId!)!);
    expect([...stored]).not.toEqual([9, 9, 9]);

    // No downscaler: the original bytes reach the model unchanged.
    seen.length = 0;
    await new CaptionRepresenter(store, {
      captioner,
      captionEmbedder: fake,
      blobStore: blobs,
    }).represent(sessionId);
    expect(seen.length).toBeGreaterThan(0);
    for (const got of seen) expect([...got]).not.toEqual([9, 9, 9]);
  });

  it("skips an excluded segment BEFORE reading its blob, discloses the count, and leaves its caption null", async () => {
    const sessionId = ulid();
    await seed(sessionId);

    let calls = 0;
    const captioner = {
      caption: async (): Promise<string> => {
        calls++;
        return "described";
      },
    };

    const result = await new CaptionRepresenter(store, {
      captioner,
      captionEmbedder: fake,
      blobStore: blobs,
      // Everything before the switch to Slack is the recorder.
      isExcluded: (tMonoStart) => tMonoStart < 5000,
    }).represent(sessionId);

    expect(result.excludedCount).toBeGreaterThan(0);
    expect(result.captionedCount).toBe(1);
    expect(calls).toBe(1);

    const segs = store.getSegmentsBySession(sessionId);
    const early = segs.find((s) => s.granularity === "action" && s.tMonoStart === 1000)!;
    const late = segs.find((s) => s.granularity === "action" && s.tMonoStart === 6000)!;
    // Null, not empty: the excluded segment composes from its digest, which is
    // exactly the fallback `leafChildren` already had.
    expect(early.caption).toBeNull();
    expect(early.digest).not.toBeNull();
    expect(late.caption).toBe("described");

    // And the enrich path stays consistent — a skipped segment is not an orphan.
    const rec = await store.reconcile();
    expect(rec.orphansPruned).toBe(0);
  });

  it("excludes nothing when no predicate is given", async () => {
    const sessionId = ulid();
    await seed(sessionId);
    const result = await new CaptionRepresenter(store, {
      captioner: new FakeCaptionProvider(),
      captionEmbedder: fake,
      blobStore: blobs,
    }).represent(sessionId);
    expect(result.excludedCount).toBe(0);
    expect(result.captionedCount).toBe(2);
  });
});
