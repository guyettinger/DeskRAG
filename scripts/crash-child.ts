/**
 * Child process for the crash-recovery test. It performs a real putSegments with
 * a co-written vector: the SQLite segment row COMMITS, and then the process is
 * killed DURING the Lance add (via a kill-on-add vector layer). The result on
 * disk is exactly the failure the write-order rule is designed to make
 * recoverable: a relational row with no vector, whose source TEXT is still there.
 *
 * It was a region write until the single-vector image lane was removed — regions
 * no longer carry a vector at all. The write ORDER under test is unchanged; only
 * which table still exercises it moved.
 *
 * Invoked as:  node --import tsx scripts/crash-child.ts <sqlitePath> <lanceDir> <payloadJson>
 */

import { LanceStore, type VecRow, type VectorSide } from "../src/store/lance/tables.js";
import { DualStore } from "../src/store/store.js";

interface Payload {
  sessionId: string;
  segId: string;
  namespace: string;
  digest: string;
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
    dropSpace: (...a) => real.dropSpace(...a),
    add: async (_ns: string, _rows: VecRow[]) => {
      process.exit(1); // die in the gap
    },
    // A patch write is a vector write: it must die in the gap too, or a future
    // multivector fixture would silently stop exercising the crash path.
    addPatches: async () => {
      process.exit(1);
    },
    searchSegment: (...a) => real.searchSegment(...a),
    searchFramePatches: (...a) => real.searchFramePatches(...a),
    ensurePatchIndex: (...a) => real.ensurePatchIndex(...a),
    getFramePatches: (...a) => real.getFramePatches(...a),
    deleteByIds: (...a) => real.deleteByIds(...a),
    allIds: (...a) => real.allIds(...a),
    close: () => real.close(),
  };

  const store = await DualStore.open(sqlitePath, lanceDir, killOnAdd);
  await store.registerVectorSpace({
    namespace: p.namespace,
    view: "digest",
    providerId: "fake",
    model: "m",
    dimensions: 4,
    sharedTextSpace: true,
  });
  await store.putSession({ id: p.sessionId, startedAt: Date.now(), epochMono: 0 });
  // This commits the segment (digest text included) to SQLite, then the
  // kill-on-add fires on its vector.
  await store.putSegments([
    {
      id: p.segId,
      sessionId: p.sessionId,
      granularity: "action",
      tMonoStart: 0,
      tMonoEnd: 10,
      digest: p.digest,
      vectors: [{ namespace: p.namespace, vector: Float32Array.from([1, 0, 0, 0]) }],
    },
  ]);

  // Unreachable: putSegments must have exited during the Lance add.
  process.exit(99);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
