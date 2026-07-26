import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { FramePatchRepresenter } from "../src/represent/frame-patch-representer.js";
import { FakeMultiVectorProvider } from "../src/embed/fake.js";
import { namespaceFor } from "../src/embed/types.js";

const provider = new FakeMultiVectorProvider(16, 3);
const NS = namespaceFor("frame_patches", provider);

let dir: string;
let store: DualStore;
let blobs: BlobStore;
let sessionId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "fpr-"));
  store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
  blobs = new BlobStore(join(dir, "blobs"));
  sessionId = ulid();
  await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function frameWithBlob(
  id: string,
  tMono: number,
  bytes: number[],
): Promise<void> {
  const blob = await blobs.write(sessionId, "keyframe", Uint8Array.from(bytes), {
    tMonoStart: tMono,
    tMonoEnd: tMono,
    codec: "jpeg",
  });
  await store.putBlobs([blob]);
  await store.putFrames([
    {
      id,
      sessionId,
      tMono,
      width: 1280,
      height: 800,
      phash: 0n,
      blobId: blob.id,
      frameOffset: 0,
      segmentIds: [],
    },
  ]);
}

const rep = () =>
  new FramePatchRepresenter(store, { patchEmbedder: provider, blobStore: blobs });

describe("FramePatchRepresenter", () => {
  it("registers the namespace and embeds every keyframe with a blob", async () => {
    await frameWithBlob("f1", 100, [1, 2, 3]);
    await frameWithBlob("f2", 200, [4, 5, 6]);
    const res = await rep().represent(sessionId);

    expect(res.namespace).toBe(NS);
    expect(res.frameCount).toBe(2);
    expect(res.embeddedCount).toBe(2);
    expect(store.listVectorSpaces().map((s) => s.namespace)).toContain(NS);
  });

  it("makes each frame retrievable by its own bytes", async () => {
    await frameWithBlob("f1", 100, [1, 2, 3]);
    await frameWithBlob("f2", 200, [9, 9, 9]);
    await rep().represent(sessionId);

    const [q] = await provider.embedImages([Uint8Array.from([9, 9, 9])]);
    const hits = await store.searchFramePatches(NS, q!, 5);
    expect(hits[0]!.id).toBe("f2");
  });

  it("writes one multivector row per frame, with the right vector count", async () => {
    await frameWithBlob("f1", 100, [1, 2, 3]);
    await rep().represent(sessionId);
    const stored = await store.getFramePatches(NS, "f1");
    expect(stored!.length).toBe(3); // FakeMultiVectorProvider emits 3 per image
    expect(stored![0]!.length).toBe(16);
  });

  it("associates frames with their containing segments for Tier-2 scoping", async () => {
    await store.putSegments([
      { id: "segA", sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 150 },
      { id: "segB", sessionId, granularity: "action", tMonoStart: 150, tMonoEnd: 300 },
    ]);
    await frameWithBlob("f1", 100, [1, 2, 3]);
    await frameWithBlob("f2", 200, [9, 9, 9]);
    await rep().represent(sessionId);

    const [q] = await provider.embedImages([Uint8Array.from([9, 9, 9])]);
    const scoped = await store.searchFramePatches(NS, q!, 5, { segmentIds: ["segB"] });
    expect(scoped.map((h) => h.id)).toEqual(["f2"]);
  });

  it("includes a frame on the final segment's right edge", async () => {
    // The last segment's end is inclusive; every other boundary is half-open, so
    // a frame landing exactly on the session end must not be dropped.
    await store.putSegments([
      { id: "segA", sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 200 },
    ]);
    await frameWithBlob("f1", 200, [1, 2, 3]);
    await rep().represent(sessionId);

    const [q] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    const scoped = await store.searchFramePatches(NS, q!, 5, { segmentIds: ["segA"] });
    expect(scoped.map((h) => h.id)).toEqual(["f1"]);
  });

  it("skips frames with no keyframe blob rather than failing the pass", async () => {
    await frameWithBlob("f1", 100, [1, 2, 3]);
    await store.putFrames([
      {
        id: "f2",
        sessionId,
        tMono: 200,
        width: 1280,
        height: 800,
        phash: 0n,
        frameOffset: 0,
        segmentIds: [],
      },
    ]);
    const res = await rep().represent(sessionId);
    expect(res.frameCount).toBe(2);
    expect(res.embeddedCount).toBe(1);
  });

  it("handles a session with no frames at all", async () => {
    const res = await rep().represent(sessionId);
    expect(res).toEqual({ frameCount: 0, embeddedCount: 0, namespace: NS });
  });

  it("is idempotent — a second pass does not duplicate rows", async () => {
    await frameWithBlob("f1", 100, [1, 2, 3]);
    const r = rep();
    await r.represent(sessionId);
    await r.represent(sessionId);
    const [q] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    const hits = await store.searchFramePatches(NS, q!, 10);
    expect(hits.filter((h) => h.id === "f1").length).toBe(1);
  });

  it("reports progress per frame", async () => {
    await frameWithBlob("f1", 100, [1, 2, 3]);
    await frameWithBlob("f2", 200, [4, 5, 6]);
    const seen: Array<{ done: number; total: number }> = [];
    await new FramePatchRepresenter(store, {
      patchEmbedder: provider,
      blobStore: blobs,
      onProgress: (done, total) => seen.push({ done, total }),
    }).represent(sessionId);
    expect(seen).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });
});
