import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { Segmenter } from "../src/segment/segmenter.js";
import { TranscriptRepresenter } from "../src/represent/transcript/transcript-representer.js";
import { FakeTranscription } from "../src/represent/transcript/fake.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import { Tier1Retriever } from "../src/retrieve/retriever.js";
import { TextViewSearcher } from "../src/retrieve/searchers.js";
import { CaptureSession } from "../src/capture/session.js";
import { MonotonicClock } from "../src/timeline/clock.js";
import type { CaptureContext, Producer } from "../src/capture/types.js";
import type { EventInsert } from "../src/store/types.js";

describe("TranscriptRepresenter (transcript view)", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;
  const fake = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 8 });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-transcript-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("transcribes each segment's audio, persists the text, and makes it Tier-1 searchable", async () => {
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

    // Two distinct audio windows so early/late segments transcribe differently.
    const a = await blobs.write(sessionId, "mic", Uint8Array.from([1, 2, 3]), {
      tMonoStart: 0, tMonoEnd: 5000, codec: "wav",
    });
    const b = await blobs.write(sessionId, "mic", Uint8Array.from([9, 8, 7]), {
      tMonoStart: 5000, tMonoEnd: 9000, codec: "wav",
    });
    await store.putBlobs([a, b]);

    await new Segmenter(store).segment(sessionId);

    const rep = new TranscriptRepresenter(store, {
      transcriber: new FakeTranscription(),
      transcriptEmbedder: fake,
      blobStore: blobs,
    });
    const result = await rep.represent(sessionId);
    expect(result.namespace).toBe("transcript:fake:m:8");
    expect(result.transcribedCount).toBeGreaterThan(0);

    const segs = store.getSegmentsBySession(sessionId);
    const early = segs.find((s) => s.granularity === "action" && s.tMonoStart === 0)!;
    const late = segs.find((s) => s.granularity === "action" && s.tMonoStart === 5000)!;
    expect(early.transcript).not.toBeNull();
    expect(late.transcript).not.toBeNull();
    // Distinct audio windows -> distinct transcripts.
    expect(early.transcript).not.toBe(late.transcript);

    // The transcript is a Tier-1 view: querying its exact text ranks it #1.
    const tier1 = new Tier1Retriever(store, [new TextViewSearcher(fake, "transcript")]);
    const hit = await tier1.retrieve({ text: late.transcript! });
    expect(hit.segments[0]!.segmentId).toBe(late.id);
    expect(hit.segments[0]!.perView[0]!.view).toBe("transcript");

    // Enrich path is consistent — text-first ordering leaves nothing missing/orphaned.
    const rec = await store.reconcile();
    expect(rec.missing).toHaveLength(0);
    expect(rec.orphansPruned).toBe(0);
  });

  it("reconcile re-embeds a transcript that has text but no vector", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    await store.putEvents([
      { id: ulid(), sessionId, tMono: 0, kind: "mouse_move" },
      { id: ulid(), sessionId, tMono: 4000, kind: "key_down" },
    ]);
    await store.endSession(sessionId, 8000);
    await new Segmenter(store).segment(sessionId);

    // Register the transcript space, then write ONLY the text (no vector) —
    // simulating a crash between updateSegment and putSegmentVectors.
    const rep = new TranscriptRepresenter(store, {
      transcriber: new FakeTranscription(),
      transcriptEmbedder: fake,
      blobStore: blobs,
    });
    await rep.ensureSpace();
    const seg = store.getSegmentsBySession(sessionId)[0]!;
    await store.updateSegment(seg.id, { transcript: "hello world" });

    const before = await store.reconcile();
    expect(before.missing.length).toBeGreaterThan(0);
    expect(before.missing.some((m) => m.entity === "segment" && m.id === seg.id)).toBe(true);
  });
});

describe("CaptureSession.ingestAudio", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-audiohook-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists an audio chunk as a mic blob (bytes round-trip)", async () => {
    const session = new CaptureSession(store, { blobStore: blobs, clock: MonotonicClock.start() });
    let ctx: CaptureContext | undefined;
    const producer: Producer = {
      id: "test-audio",
      start(c) { ctx = c; },
      stop() {},
    };
    session.addProducer(producer);
    const sessionId = await session.start();

    await ctx!.ingestAudio({
      bytes: Uint8Array.from([10, 20, 30, 40]),
      tMonoStart: 0,
      tMonoEnd: 1000,
      media: "mic",
      codec: "wav",
    });
    await session.stop();

    const audioBlobs = store.getBlobsBySession(sessionId).filter((b) => b.media === "mic");
    expect(audioBlobs).toHaveLength(1);
    expect(audioBlobs[0]!.codec).toBe("wav");
    expect(audioBlobs[0]!.tMonoEnd).toBe(1000);
    const bytes = await blobs.read(audioBlobs[0]!);
    expect([...bytes]).toEqual([10, 20, 30, 40]);
  });

  it("drops audio when no blob store is configured (best-effort)", async () => {
    const session = new CaptureSession(store, { clock: MonotonicClock.start() });
    let ctx: CaptureContext | undefined;
    session.addProducer({ id: "a", start(c) { ctx = c; }, stop() {} });
    const sessionId = await session.start();
    await ctx!.ingestAudio({
      bytes: Uint8Array.from([1]), tMonoStart: 0, tMonoEnd: 1, media: "mic", codec: "wav",
    });
    await session.stop();
    expect(store.getBlobsBySession(sessionId)).toHaveLength(0);
  });
});
