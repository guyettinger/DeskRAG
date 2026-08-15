import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { BlobStore } from "../src/store/blob-store.js";
import { LanceStore, type VecRow, type VectorSide } from "../src/store/lance/tables.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import { namespaceFor } from "../src/embed/types.js";
import type { MissingVector } from "../src/store/types.js";

const provider = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 4 });
const namespace = namespaceFor("digest", provider);
const reembed = async (missing: MissingVector[]) =>
  Promise.all(
    missing.map(async (m) => {
      const [vec] = await provider.embed([m.segment?.digest ?? ""]);
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
      // Gate patch writes on the same switch — a patch write is a vector write.
      addPatches: async (ns, rows) => {
        if (failAdd) throw new Error("injected Lance add failure");
        return real.addPatches(ns, rows);
      },
      dropSpace: (...a) => real.dropSpace(...a),
      searchSegment: (...a) => real.searchSegment(...a),
      searchFramePatches: (...a) => real.searchFramePatches(...a),
      ensurePatchIndex: (...a) => real.ensurePatchIndex(...a),
      getFramePatches: (...a) => real.getFramePatches(...a),
      deleteByIds: (...a) => real.deleteByIds(...a),
      allIds: (...a) => real.allIds(...a),
      close: () => real.close(),
    };
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"), lance);
    await store.registerVectorSpace({
      namespace, view: "digest", providerId: "fake", model: "m",
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
    const sessionId = ulid();
    const segId = ulid();
    await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });

    failAdd = true;
    await expect(
      store.putSegments([
        { id: segId, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 10,
          digest: "clicked button Ok",
          vectors: [{ namespace, vector: Float32Array.from([1, 0, 0, 0]) }] },
      ]),
    ).rejects.toThrow(/injected/);

    // SQLite kept the row (write-order rule): reconcile sees it as missing.
    const before = await store.reconcile();
    expect(before.missing.map((m) => m.id)).toEqual([segId]);

    // Now let adds through and re-embed from retained content.
    failAdd = false;
    await store.reconcileAndReembed(reembed);

    const [q] = await provider.embed(["clicked button Ok"]);
    const hits = await store.searchSegments(namespace, q!, 5);
    expect(hits.map((h) => h.id)).toContain(segId);

    const clean = await store.reconcile();
    expect(clean.missing).toHaveLength(0);
  });

  it("prunes orphan Lance rows that have no SQLite parent", async () => {
    // Inject a vector row directly into Lance with no matching SQLite segment.
    const orphanId = ulid();
    await real.add(namespace, [
      { id: orphanId, session_id: "nope", vector: [0, 0, 1, 0] } satisfies VecRow,
    ]);
    expect(await real.allIds(namespace)).toContain(orphanId);

    const result = await store.reconcile();
    expect(result.orphansPruned).toBe(1);
    expect(result.missing).toHaveLength(0);
    expect(await real.allIds(namespace)).not.toContain(orphanId);
  });

  it("deleteSession removes rows from BOTH engines", async () => {
    const { sessionId, segId, frameId } = await seedFrame();
    // A vector (Lance) AND a region carrying an FTS entry (SQLite, no foreign
    // key) — the two things a delete has to reach that a cascade will not.
    const regionId = ulid();
    await store.putSegmentVectors([
      { segmentId: segId, sessionId, namespace, vector: Float32Array.from([1, 0, 0, 0]) },
    ]);
    await store.putRegions([
      { id: regionId, frameId, segmentId: segId, sessionId, x: 0, y: 0, w: 5, h: 5,
        source: "ax", role: "button", label: "Ok", priority: 1 },
    ]);
    expect(await real.allIds(namespace)).toContain(segId);
    expect(store.ftsRegions("Ok")).toContain(regionId);

    await store.deleteSession(sessionId);

    expect(await real.allIds(namespace)).not.toContain(segId);
    expect(store.ftsRegions("Ok")).not.toContain(regionId);
    // A reconcile finds neither orphans nor missing after a clean delete.
    const result = await store.reconcile();
    expect(result.orphansPruned).toBe(0);
    expect(result.missing).toHaveLength(0);
  });

  it("pairs with BlobStore.removeSession to reclaim the files on disk", async () => {
    const blobs = new BlobStore(join(dir, "blobs"));
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
    const insert = await blobs.write(sessionId, "keyframe", new Uint8Array([1, 2, 3]), {
      tMonoStart: 0,
      tMonoEnd: 1,
      codec: "jpeg",
    });
    await store.putBlobs([insert]);
    expect(existsSync(insert.path)).toBe(true);

    // The documented pairing: rows first (a row pointing at a deleted file is a
    // broken read; a file with no row is just reclaimable disk).
    await store.deleteSession(sessionId);
    await blobs.removeSession(sessionId);

    expect(store.getBlob(insert.id)).toBeUndefined();
    expect(existsSync(insert.path)).toBe(false);
  });

  it("dropVectorSpace removes the table AND the registry row", async () => {
    const sessionId = ulid();
    const segId = ulid();
    await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
    await store.putSegments([
      { id: segId, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 10,
        vectors: [{ namespace, vector: Float32Array.from([1, 0, 0, 0]) }] },
    ]);
    expect(await real.allIds(namespace)).toContain(segId);

    await store.dropVectorSpace(namespace);
    expect(store.listVectorSpaces()).toHaveLength(0);
    // Dropping again is a no-op, not an error: a registered space whose table
    // was never materialized is an ordinary state (12 rows against 11 dirs on a
    // real store), and this runs over EVERY retired space at once.
    await expect(store.dropVectorSpace(namespace)).resolves.toBeUndefined();
  });

  it("drops a RETIRED namespace on open, and leaves live ones alone", async () => {
    // Registered under a view no build can write any more. Written through the
    // SQLite statement directly, because `registerVectorSpace` takes a `View`
    // and this one deliberately is not in that union any more.
    const dead = "region_image:fake:m:4";
    (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db
      .prepare(
        `INSERT INTO vector_space(namespace, view, provider_id, model, dimensions,
           shared_text_space, created_at) VALUES (?, ?, 'fake', 'm', 4, 1, 0)`,
      )
      .run(dead, "region_image");
    store.close();

    const reopened = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    try {
      expect(reopened.retiredSpacesPurged).toEqual([dead]);
      expect(reopened.listVectorSpaces().map((s) => s.namespace)).toEqual([namespace]);
      // Idempotent: a second open has nothing left to drop.
      reopened.close();
      const again = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
      expect(again.retiredSpacesPurged).toEqual([]);
      again.close();
    } finally {
      // afterEach closes `store`; re-open it so that close still has a subject.
      store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    }
  });
});
