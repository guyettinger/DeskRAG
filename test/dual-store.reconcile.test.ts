import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { LanceStore, type VecRow, type VectorSide } from "../src/store/lance/tables.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import { namespaceFor } from "../src/embed/types.js";
import type { MissingVector } from "../src/store/types.js";

const provider = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 4 });
const namespace = namespaceFor("region_image", provider);
const reembed = async (missing: MissingVector[]) =>
  Promise.all(
    missing.map(async (m) => {
      const [vec] = await provider.embed([`${m.region?.role} ${m.region?.label}`]);
      return { namespace: m.namespace, id: m.id, vector: vec! };
    }),
  );

describe("dual-store reconciliation", () => {
  let dir: string;
  let real: LanceStore;
  let store: DualStore;
  let failAdd: boolean;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-rec-"));
    real = await LanceStore.open(join(dir, "lance"));
    failAdd = false;
    // Wrap the real layer so we can make `add` throw on demand.
    const lance: VectorSide = {
      ensureTable: (ns) => real.ensureTable(ns),
      add: async (ns: string, rows: VecRow[]) => {
        if (failAdd) throw new Error("injected Lance add failure");
        return real.add(ns, rows);
      },
      searchSegment: (...a) => real.searchSegment(...a),
      searchFrame: (...a) => real.searchFrame(...a),
      searchRegion: (...a) => real.searchRegion(...a),
      deleteByIds: (...a) => real.deleteByIds(...a),
      allIds: (...a) => real.allIds(...a),
      close: () => real.close(),
    };
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"), lance);
    await store.registerVectorSpace({
      namespace, view: "region_image", providerId: "fake", model: "m",
      dimensions: 4, sharedTextSpace: true,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedFrame() {
    const sessionId = ulid();
    const segId = ulid();
    const frameId = ulid();
    await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
    await store.putSegments([
      { id: segId, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 10 },
    ]);
    await store.putFrames([
      { id: frameId, sessionId, tMono: 1, width: 10, height: 10, phash: 3n, frameOffset: 0, segmentIds: [segId] },
    ]);
    return { sessionId, segId, frameId };
  }

  it("recovers a missing vector when the Lance add fails after the SQLite commit", async () => {
    const { sessionId, segId, frameId } = await seedFrame();
    const regionId = ulid();

    failAdd = true;
    await expect(
      store.putRegions([
        { id: regionId, frameId, segmentId: segId, sessionId, x: 0, y: 0, w: 5, h: 5,
          source: "ax", role: "button", label: "Ok", priority: 1,
          vector: { namespace, vector: Float32Array.from([1, 0, 0, 0]) } },
      ]),
    ).rejects.toThrow(/injected/);

    // SQLite kept the row (write-order rule): reconcile sees it as missing.
    const before = await store.reconcile();
    expect(before.missing.map((m) => m.id)).toEqual([regionId]);

    // Now let adds through and re-embed from retained content.
    failAdd = false;
    await store.reconcileAndReembed(reembed);

    const q = Float32Array.from([1, 0, 0, 0]);
    const hits = await store.searchRegions(namespace, q, 5, { frameIds: [frameId] });
    expect(hits.map((h) => h.id)).toContain(regionId);

    const clean = await store.reconcile();
    expect(clean.missing).toHaveLength(0);
  });

  it("prunes orphan Lance rows that have no SQLite parent", async () => {
    // Inject a vector row directly into Lance with no matching SQLite region.
    const orphanId = ulid();
    await real.add(namespace, [
      { id: orphanId, frame_id: "nope", segment_id: "nope", session_id: "nope",
        vector: [0, 0, 1, 0] } satisfies VecRow,
    ]);
    expect(await real.allIds(namespace)).toContain(orphanId);

    const result = await store.reconcile();
    expect(result.orphansPruned).toBe(1);
    expect(result.missing).toHaveLength(0);
    expect(await real.allIds(namespace)).not.toContain(orphanId);
  });

  it("deleteSession removes rows from BOTH engines", async () => {
    const { sessionId, segId, frameId } = await seedFrame();
    const regionId = ulid();
    await store.putRegions([
      { id: regionId, frameId, segmentId: segId, sessionId, x: 0, y: 0, w: 5, h: 5,
        source: "ax", role: "button", label: "Ok", priority: 1,
        vector: { namespace, vector: Float32Array.from([1, 0, 0, 0]) } },
    ]);
    expect(await real.allIds(namespace)).toContain(regionId);
    expect(store.ftsRegions("Ok")).toContain(regionId);

    await store.deleteSession(sessionId);

    expect(await real.allIds(namespace)).not.toContain(regionId);
    expect(store.ftsRegions("Ok")).not.toContain(regionId);
    // A reconcile finds neither orphans nor missing after a clean delete.
    const result = await store.reconcile();
    expect(result.orphansPruned).toBe(0);
    expect(result.missing).toHaveLength(0);
  });

  it("only expects frame_image vectors for frames that have a stored image", async () => {
    const frameNs = namespaceFor("frame_image", provider);
    await store.registerVectorSpace({
      namespace: frameNs, view: "frame_image", providerId: "fake", model: "m",
      dimensions: 4, sharedTextSpace: true,
    });
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });

    // Imageless frame — no blob, so no frame_image vector is expected.
    const noImg = ulid();
    await store.putFrames([
      { id: noImg, sessionId, tMono: 1, width: 10, height: 10, phash: 1n, frameOffset: 0, segmentIds: [] },
    ]);
    // Frame WITH a stored image (blob) but not yet embedded — genuinely missing.
    const blobId = ulid();
    await store.putBlobs([
      { id: blobId, sessionId, media: "keyframe", path: "x.jpg", byteOffset: 0, byteLength: 0, tMonoStart: 1, tMonoEnd: 1, codec: "jpeg" },
    ]);
    const withImg = ulid();
    await store.putFrames([
      { id: withImg, sessionId, tMono: 2, width: 10, height: 10, phash: 2n, frameOffset: 1, segmentIds: [], blobId },
    ]);

    const rec = await store.reconcile();
    const missingFrames = rec.missing.filter((m) => m.entity === "frame").map((m) => m.id);
    expect(missingFrames).toEqual([withImg]); // imaged frame flagged, imageless one not
    expect(rec.orphansPruned).toBe(0);
  });
});
