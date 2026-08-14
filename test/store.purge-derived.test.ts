import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import {
  CAPTURED_TABLES,
  DERIVED_LIBRARY_TABLES,
  DERIVED_SESSION_TABLES,
} from "../src/store/sqlite/schema.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import { namespaceFor } from "../src/embed/types.js";

/**
 * `purgeDerived` is what makes "re-index" mean re-index.
 *
 * The rebuild used to be a text-side subset, hand-written a second time, and it
 * went stale. It is now a genuine re-run from raw capture: discard everything
 * derived for a recording, then run the whole plan over it. That is only safe if
 * the purge is EXHAUSTIVE — `putRegions` is a bare insert with a fresh `ulid()`
 * per region plus a bare `lance.add`, so anything the purge misses is appended
 * to on every subsequent run, and duplicate vectors that still have a SQLite row
 * are not orphans, so `reconcile()` can never prune them.
 *
 * The other half of the contract is that raw capture survives: a re-index that
 * lost events, blobs or AX walks would not be a re-index, it would be a delete.
 */

const provider = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 4 });
const digestNs = namespaceFor("digest", provider);
const frameNs = namespaceFor("frame_image", provider);
const regionNs = namespaceFor("region_image", provider);

const vec = (n: number): Float32Array => Float32Array.from([n, 0, 0, 0]);

interface Seeded {
  sessionId: string;
  segmentId: string;
  parentId: string;
  frameId: string;
  regionId: string;
}

/** One recording with a row in every derived table AND every captured one. */
async function seed(store: DualStore): Promise<Seeded> {
  const sessionId = ulid();
  const segmentId = ulid();
  const parentId = ulid();
  const frameId = ulid();
  const regionId = ulid();
  const blobId = ulid();

  for (const [namespace, view] of [
    [digestNs, "digest"],
    [frameNs, "frame_image"],
    [regionNs, "region_image"],
  ] as const) {
    await store.registerVectorSpace({
      namespace,
      view,
      providerId: "fake",
      model: "m",
      dimensions: 4,
      sharedTextSpace: false,
    });
  }

  // --- captured -------------------------------------------------------------
  await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  await store.putEvents([
    { id: ulid(), sessionId, tMono: 10, kind: "click", x: 1, y: 2 },
    { id: ulid(), sessionId, tMono: 20, kind: "key_down" },
  ]);
  await store.putBlobs([
    {
      id: blobId,
      sessionId,
      media: "keyframe",
      path: "k.jpg",
      byteOffset: 0,
      byteLength: 10,
      tMonoStart: 0,
      tMonoEnd: 100,
    },
  ]);
  await store.putFrames([
    { id: frameId, sessionId, tMono: 15, width: 100, height: 80, phash: 1n, blobId, frameOffset: 0, segmentIds: [] },
  ]);
  await store.putAxSnapshot({
    id: ulid(),
    sessionId,
    tMono: 16,
    frameId: null,
    reason: "keyframe",
    walkMs: 5,
    elements: [],
  });
  // A boundary walk too — it lands in ax_snapshot_boundary, which is how a node
  // fetches its tree BY its boundary rather than by a latest-at-or-before guess.
  await store.putAxSnapshot({
    id: ulid(),
    sessionId,
    tMono: 30,
    frameId: null,
    reason: "focus_change",
    walkMs: 5,
    elements: [],
    boundaryTMono: 28,
  });
  // Superseded by ax_snapshot, still readable for older sessions — and still a
  // captured table, so a re-index must leave it alone.
  await store.putFrameAx(frameId, []);
  await store.putSessionClock({ sessionId, deviceEpochMs: 1, monoEpochMs: 0 });

  // --- derived --------------------------------------------------------------
  await store.putSegments([
    { id: segmentId, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 50 },
    { id: parentId, sessionId, granularity: "level:1", tMonoStart: 0, tMonoEnd: 50 },
  ]);
  await store.updateSegment(segmentId, { digest: "clicked Save", caption: "a dialog" });
  await store.updateSegmentAppCaption(segmentId, "TextEdit window");
  await store.putSegmentTree([{ sessionId, parentId, childId: segmentId }]);
  await store.putSegmentSummaries([{ segmentId: parentId, text: "save the file", source: "llm" }]);
  await store.putTranscriptClips([
    { id: ulid(), sessionId, tMonoStart: 5, tMonoEnd: 9, text: "hello" },
  ]);
  await store.associateFrameSegments(frameId, [segmentId]);
  await store.putRegions([
    {
      id: regionId,
      frameId,
      segmentId,
      sessionId,
      x: 0, y: 0, w: 10, h: 10,
      source: "ax",
      role: "button",
      label: "Save",
      priority: 1,
      vector: { namespace: regionNs, vector: vec(1) },
    },
  ]);
  store.indexSegmentText(segmentId, "clicked Save in TextEdit");
  await store.putSegmentVectors([{ segmentId, sessionId, namespace: digestNs, vector: vec(1) }]);
  await store.putFrameVectors([
    { frameId, sessionId, segmentIds: [segmentId], namespace: frameNs, vector: vec(1) },
  ]);

  return { sessionId, segmentId, parentId, frameId, regionId };
}

describe("DualStore.purgeDerived", () => {
  let dir: string;
  let store: DualStore;
  let sql: Database.Database;
  let s: Seeded;

  const rows = (table: string): number =>
    (sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-purge-"));
    store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
    s = await seed(store);
    sql = new Database(join(dir, "app.db"), { readonly: true });
  });
  afterEach(() => {
    sql.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("seeds every derived table, so the assertions below can mean something", () => {
    for (const t of DERIVED_SESSION_TABLES) expect(rows(t), t).toBeGreaterThan(0);
    for (const t of CAPTURED_TABLES) expect(rows(t), t).toBeGreaterThan(0);
  });

  it("empties every derived table", async () => {
    await store.purgeDerived(s.sessionId);
    for (const t of DERIVED_SESSION_TABLES) expect(rows(t), t).toBe(0);
  });

  /**
   * The half that makes this a re-index rather than a delete. Everything derived
   * is recomputed FROM these rows, so losing one is unrecoverable — the video and
   * the event stream cannot be re-recorded.
   */
  it("leaves every captured row untouched", async () => {
    const before = Object.fromEntries(CAPTURED_TABLES.map((t) => [t, rows(t)]));
    await store.purgeDerived(s.sessionId);
    for (const t of CAPTURED_TABLES) expect(rows(t), t).toBe(before[t]);
    expect(store.getEventsBySession(s.sessionId)).toHaveLength(2);
    expect(store.getFramesBySession(s.sessionId)).toHaveLength(1);
    expect(store.getAxSnapshotsBySession(s.sessionId)).toHaveLength(2);
    expect(store.getSessionClock(s.sessionId)).toBeDefined();
  });

  /**
   * Lance is the half a row count cannot see, and the half that silently
   * accumulates: a duplicate vector whose SQLite row exists is not an orphan.
   */
  it("deletes the vectors in every namespace kind", async () => {
    await store.purgeDerived(s.sessionId);
    expect(await store.searchSegments(digestNs, vec(1), 10)).toHaveLength(0);
    expect(await store.searchFrames(frameNs, vec(1), 10)).toHaveLength(0);
    expect(await store.searchRegions(regionNs, vec(1), 10, { frameIds: [s.frameId] })).toHaveLength(0);
  });

  /**
   * A namespace can be REGISTERED without its Lance table ever existing:
   * `registerVectorSpace` writes the SQLite row, and the table is created lazily
   * on first write. So selecting a provider and never indexing with it leaves a
   * space with nothing behind it — measured on a real store, 12 registered
   * spaces against 11 tables on disk.
   *
   * Deleting from a table that was never created has already achieved its goal,
   * so it must be a no-op. It was not: `deleteByIds` opened the table and threw
   * `Table '…' was not found`, which took down the whole re-index — and takes
   * down `deleteSession` the same way, since both go through here.
   */
  it("tolerates a registered namespace whose table is not on disk", async () => {
    const unused = namespaceFor("caption", provider);
    await store.registerVectorSpace({
      namespace: unused,
      view: "caption",
      providerId: "fake",
      model: "m",
      dimensions: 4,
      sharedTextSpace: false,
    });
    // Registering creates the table eagerly, so the state has to be produced the
    // way the real store produced it: the SQLite row outliving the directory.
    rmSync(join(dir, "lance", `${unused.replace(/:/g, "__")}.lance`), {
      recursive: true,
      force: true,
    });

    await expect(store.purgeDerived(s.sessionId)).resolves.toBeUndefined();
    await expect(store.deleteSession(s.sessionId)).resolves.toBeUndefined();
  });

  /** The namespaces themselves are global registry, not session data. */
  it("keeps the vector spaces registered", async () => {
    await store.purgeDerived(s.sessionId);
    expect(store.listVectorSpaces().map((v) => v.namespace).sort()).toEqual(
      [digestNs, frameNs, regionNs].sort(),
    );
  });

  it("purges only the session it was asked about", async () => {
    const other = await seed(store);
    await store.purgeDerived(s.sessionId);
    expect(store.getSegmentsBySession(other.sessionId)).toHaveLength(2);
    expect(store.getSegmentsBySession(s.sessionId)).toHaveLength(0);
    expect(store.getTranscriptClipsBySession(other.sessionId)).toHaveLength(1);
  });

  /**
   * Two purges in a row must land in the same place as one. The re-index loop
   * purges every session it touches, and a partial run that is retried must not
   * behave differently the second time.
   */
  it("is idempotent", async () => {
    await store.purgeDerived(s.sessionId);
    await store.purgeDerived(s.sessionId);
    for (const t of DERIVED_SESSION_TABLES) expect(rows(t), t).toBe(0);
  });
});

/**
 * The guard, and the reason the two sets are exported from `schema.ts` at all:
 * an unlisted table is exactly how a re-index comes to leave something behind,
 * and nothing else in the system would notice. Adding a table now forces a
 * decision about whether the rebuild has to clear it.
 */
describe("table classification", () => {
  it("classifies every table in the schema as captured or derived", async () => {
    const dir = mkdtempSync(join(tmpdir(), "erag-tables-"));
    const store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
    const sql = new Database(join(dir, "app.db"), { readonly: true });
    try {
      const known = new Set<string>([
        ...CAPTURED_TABLES,
        ...DERIVED_SESSION_TABLES,
        ...DERIVED_LIBRARY_TABLES,
      ]);
      // FTS5 keeps its own shadow tables beside each virtual table; they are an
      // implementation detail of a table that IS classified.
      const shadow = /_(data|idx|content|docsize|config)$/;
      const actual = (
        sql
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
          .all() as { name: string }[]
      )
        .map((r) => r.name)
        .filter((n) => !shadow.test(n));

      expect([...actual].sort().filter((n) => !known.has(n))).toEqual([]);
      // And the reverse: a classified table that no longer exists is stale.
      expect([...known].sort().filter((n) => !actual.includes(n))).toEqual([]);
    } finally {
      sql.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
