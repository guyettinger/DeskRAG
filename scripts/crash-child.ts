/**
 * Child process for the crash-recovery test. It performs a real putRegions:
 * the SQLite region rows + FTS COMMIT, and then the process is killed DURING the
 * Lance add (via a kill-on-add vector layer). The result on disk is exactly the
 * failure the write-order rule is designed to make recoverable: a relational row
 * with no vector.
 *
 * Invoked as:  node --import tsx scripts/crash-child.ts <sqlitePath> <lanceDir> <payloadJson>
 */

import { LanceStore, type VecRow, type VectorSide } from "../src/store/lance/tables.js";
import { DualStore } from "../src/store/store.js";

interface Payload {
  sessionId: string;
  segId: string;
  frameId: string;
  regionId: string;
  namespace: string;
  label: string;
  role: string;
}

async function main() {
  const [sqlitePath, lanceDir, payloadJson] = process.argv.slice(2);
  if (!sqlitePath || !lanceDir || !payloadJson) {
    throw new Error("usage: crash-child <sqlitePath> <lanceDir> <payloadJson>");
  }
  const p = JSON.parse(payloadJson) as Payload;

  const real = await LanceStore.open(lanceDir);
  // Everything delegates to the real layer EXCEPT add, which kills the process —
  // simulating a crash after the SQLite commit but before the vector lands.
  const killOnAdd: VectorSide = {
    ensureTable: (ns) => real.ensureTable(ns),
    add: async (_ns: string, _rows: VecRow[]) => {
      process.exit(1); // die in the gap
    },
    searchSegment: (...a) => real.searchSegment(...a),
    searchFrame: (...a) => real.searchFrame(...a),
    searchRegion: (...a) => real.searchRegion(...a),
    deleteByIds: (...a) => real.deleteByIds(...a),
    allIds: (...a) => real.allIds(...a),
    close: () => real.close(),
  };

  const store = await DualStore.open(sqlitePath, lanceDir, killOnAdd);
  await store.registerVectorSpace({
    namespace: p.namespace,
    view: "region_image",
    providerId: "fake",
    model: "m",
    dimensions: 4,
    sharedTextSpace: true,
  });
  await store.putSession({ id: p.sessionId, startedAt: Date.now(), epochMono: 0 });
  await store.putSegments([
    { id: p.segId, sessionId: p.sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 10 },
  ]);
  // Frame with NO vector, so the first Lance add is the region one (the kill).
  await store.putFrames([
    { id: p.frameId, sessionId: p.sessionId, tMono: 1, width: 10, height: 10, phash: 7n, frameOffset: 0, segmentIds: [p.segId] },
  ]);
  // This commits the region to SQLite, then the kill-on-add fires.
  await store.putRegions([
    {
      id: p.regionId, frameId: p.frameId, segmentId: p.segId, sessionId: p.sessionId,
      x: 0, y: 0, w: 5, h: 5, source: "ax", role: p.role, label: p.label, priority: 1,
      vector: { namespace: p.namespace, vector: Float32Array.from([1, 0, 0, 0]) },
    },
  ]);

  // Unreachable: putRegions must have exited during the Lance add.
  process.exit(99);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
