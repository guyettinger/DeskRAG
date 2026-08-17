import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";

/**
 * The durable indexing queue.
 *
 * It exists because capture and indexing used to be ONE awaited call: a second
 * recording could not start while the first indexed, and a crash mid-index left
 * nothing on disk saying it had ever been attempted — "indexed" was inferred
 * from derived rows, which cannot tell "never indexed" from "indexing failed".
 *
 * Two properties carry the weight here and both are tested against real SQLite
 * rather than a fake, because both are about what survives a process:
 *
 *  - **Enqueue is idempotent while a job is live.** That guarantee used to be
 *    bought by a synchronous state claim in the app, and it was paid for: a
 *    double `index()` over one recording measured 28 segment rows where 14 were
 *    expected, because `Segmenter.segment()` has no dedup and just re-inserts.
 *  - **A `running` row at open time is a crash.** Nothing else can produce one,
 *    which is what makes recovery possible at all.
 */

const payload = (purge: boolean): string => JSON.stringify({ purge, batchId: null });

describe("DualStore indexing queue", () => {
  let dir: string;
  let store: DualStore;
  let sessionId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-jobs-"));
    store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
    sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const enqueue = (kind: string, sid: string | null, purge = false) =>
    store.enqueueIndexJob({ id: ulid(), sessionId: sid, kind, payload: payload(purge) });

  it("enqueues a job in the queued state with no attempts", async () => {
    const job = await enqueue("record", sessionId);
    expect(job.state).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.sessionId).toBe(sessionId);
    expect(job.startedAt).toBeNull();
    expect(job.progress).toBeNull();
    expect(JSON.parse(job.payload)).toEqual({ purge: false, batchId: null });
  });

  /**
   * The dedup guarantee. A second stop, a double-pressed rebuild button, or an
   * unguarded second `ipcMain.handle` call must all fold into the live job.
   */
  it("folds a duplicate enqueue into the live job instead of adding a second", async () => {
    const first = await enqueue("record", sessionId);
    const second = await enqueue("record", sessionId);
    expect(second.id).toBe(first.id);
    expect(store.listIndexJobs()).toHaveLength(1);
  });

  it("deduplicates against a RUNNING job too, not only a queued one", async () => {
    const first = await enqueue("record", sessionId);
    await store.claimIndexJob();
    const second = await enqueue("record", sessionId);
    expect(second.id).toBe(first.id);
    expect(second.state).toBe("running");
    expect(store.listIndexJobs()).toHaveLength(1);
  });

  it("allows a new job once the previous one has finished", async () => {
    const first = await enqueue("record", sessionId);
    await store.finishIndexJob(first.id, "done");
    const second = await enqueue("record", sessionId);
    expect(second.id).not.toBe(first.id);
    expect(store.listIndexJobs()).toHaveLength(2);
  });

  it("scopes dedup by kind, so a re-index can queue behind a record job", async () => {
    await enqueue("record", sessionId);
    await enqueue("reindex", sessionId);
    expect(store.listIndexJobs()).toHaveLength(2);
  });

  /**
   * `session_id IS NULL` for library-scoped work, and `NULL = NULL` is NULL in
   * SQL, not true. A plain `=` in the dedup predicate therefore matches nothing
   * and lets every trace rebuild enqueue a duplicate — which is exactly the
   * shape of bug that survives a hand test with one recording.
   */
  it("deduplicates library-scoped jobs, whose session_id is NULL", async () => {
    const first = await enqueue("trace-rebuild", null);
    const second = await enqueue("trace-rebuild", null);
    expect(second.id).toBe(first.id);
    expect(store.listIndexJobs()).toHaveLength(1);
  });

  it("claims the oldest queued job first and marks it running", async () => {
    const a = await enqueue("record", sessionId);
    const other = ulid();
    await store.putSession({ id: other, startedAt: Date.now(), epochMono: 0 });
    const b = await enqueue("record", other);

    const claimed = await store.claimIndexJob();
    expect(claimed?.id).toBe(a.id);
    expect(claimed?.state).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.startedAt).not.toBeNull();

    expect((await store.claimIndexJob())?.id).toBe(b.id);
    expect(await store.claimIndexJob()).toBeUndefined();
  });

  it("returns undefined from an empty queue rather than throwing", async () => {
    expect(await store.claimIndexJob()).toBeUndefined();
  });

  /**
   * `enqueued_at` is a MILLISECOND, and a full-library re-index fans out one job
   * per recording inside a single loop — so every one of them shares a
   * timestamp and the TIEBREAK is what actually orders the rebuild. It has to be
   * insertion order (rowid). The obvious tiebreak, the ULID primary key, is
   * wrong: `ulid()` randomizes its suffix within a millisecond rather than
   * incrementing, so "oldest recording first" would have come out shuffled on
   * every library rebuild, deterministically nowhere and reproducibly never.
   */
  it("claims same-millisecond jobs in enqueue order", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const sid = ulid();
      await store.putSession({ id: sid, startedAt: 1_000 + i, epochMono: 0 });
      ids.push((await enqueue("record", sid)).id);
    }
    const stamps = new Set(store.listIndexJobs().map((j) => j.enqueuedAt));
    expect(stamps.size, "the whole point is that these collide").toBeLessThan(8);

    const claimed: string[] = [];
    for (let i = 0; i < 8; i++) claimed.push((await store.claimIndexJob())!.id);
    expect(claimed).toEqual(ids);
    expect(store.listIndexJobs().map((j) => j.id)).toEqual(ids);
  });

  it("round-trips an opaque progress payload", async () => {
    const job = await enqueue("record", sessionId);
    await store.updateIndexJobProgress(job.id, JSON.stringify([{ id: "segment", state: "done" }]));
    expect(JSON.parse(store.getIndexJob(job.id)!.progress!)).toEqual([
      { id: "segment", state: "done" },
    ]);
  });

  it("stamps a terminal state with its end time and error", async () => {
    const job = await enqueue("record", sessionId);
    await store.claimIndexJob();
    await store.finishIndexJob(job.id, "failed", "ffmpeg exited 1");
    const row = store.getIndexJob(job.id)!;
    expect(row.state).toBe("failed");
    expect(row.error).toBe("ffmpeg exited 1");
    expect(row.endedAt).not.toBeNull();
  });

  it("filters by state", async () => {
    const a = await enqueue("record", sessionId);
    const other = ulid();
    await store.putSession({ id: other, startedAt: Date.now(), epochMono: 0 });
    await enqueue("record", other);
    await store.finishIndexJob(a.id, "done");

    expect(store.listIndexJobs(["queued"])).toHaveLength(1);
    expect(store.listIndexJobs(["done"])).toHaveLength(1);
    expect(store.listIndexJobs(["queued", "done"])).toHaveLength(2);
  });

  describe("crash recovery", () => {
    /**
     * A `running` row can only be left by a process that died inside the job —
     * nothing else writes that state and then stops. Re-queueing it is what
     * makes a quit mid-index recoverable instead of silently lost.
     */
    it("re-queues a job left running by a dead process", async () => {
      const job = await enqueue("record", sessionId);
      await store.claimIndexJob();

      const touched = await store.requeueRunningJobs(3);
      expect(touched).toHaveLength(1);
      const row = store.getIndexJob(job.id)!;
      expect(row.state).toBe("queued");
      expect(row.startedAt).toBeNull();
      // The attempt is KEPT. It is how the app knows this is a retry, and
      // therefore that it must purge before running the plan again.
      expect(row.attempts).toBe(1);
    });

    it("leaves queued and finished jobs alone", async () => {
      const queued = await enqueue("record", sessionId);
      const other = ulid();
      await store.putSession({ id: other, startedAt: Date.now(), epochMono: 0 });
      const done = await enqueue("record", other);
      await store.finishIndexJob(done.id, "done");

      expect(await store.requeueRunningJobs(3)).toHaveLength(0);
      expect(store.getIndexJob(queued.id)!.state).toBe("queued");
      expect(store.getIndexJob(done.id)!.state).toBe("done");
    });

    /**
     * A job that kills the app on every attempt must not resurrect itself
     * forever — otherwise the crash IS the loop, and the app never starts.
     */
    it("fails a job that has exhausted its attempts instead of re-queueing it", async () => {
      const job = await enqueue("record", sessionId);
      // Two crash-and-retry rounds still come back queued.
      for (let i = 0; i < 2; i++) {
        await store.claimIndexJob();
        await store.requeueRunningJobs(3);
        expect(store.getIndexJob(job.id)!.state, `round ${i}`).toBe("queued");
      }
      // The third claim takes it to the ceiling, and the next recovery gives up.
      await store.claimIndexJob();
      expect(store.getIndexJob(job.id)!.attempts).toBe(3);

      await store.requeueRunningJobs(3);
      const row = store.getIndexJob(job.id)!;
      expect(row.state).toBe("failed");
      expect(row.error).toMatch(/did not survive/);
      expect(await store.claimIndexJob()).toBeUndefined();
    });

    it("survives a close and re-open, which is the whole point of the table", async () => {
      const job = await enqueue("record", sessionId);
      await store.claimIndexJob();
      store.close();

      store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
      expect(store.getIndexJob(job.id)!.state).toBe("running");
      await store.requeueRunningJobs(3);
      expect((await store.claimIndexJob())?.id).toBe(job.id);
    });
  });

  /** Deleting a recording must not leave work queued against a session that is gone. */
  it("cascades a queued job when its session is deleted", async () => {
    const job = await enqueue("record", sessionId);
    await store.deleteSession(sessionId);
    expect(store.getIndexJob(job.id)).toBeUndefined();
  });

  it("keeps library-scoped jobs when a session is deleted", async () => {
    const job = await enqueue("trace-rebuild", null);
    await store.deleteSession(sessionId);
    expect(store.getIndexJob(job.id)).toBeDefined();
  });

  describe("pruning", () => {
    it("keeps the newest N terminal jobs and never touches live ones", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const sid = ulid();
        await store.putSession({ id: sid, startedAt: Date.now() + i, epochMono: 0 });
        const job = await enqueue("record", sid);
        await store.finishIndexJob(job.id, "done");
        ids.push(job.id);
      }
      const live = await enqueue("record", sessionId);

      expect(await store.pruneIndexJobs(2)).toBe(3);
      const left = store.listIndexJobs().map((j) => j.id);
      expect(left).toContain(live.id);
      expect(left).toContain(ids[4]);
      expect(left).not.toContain(ids[0]);
      expect(left).toHaveLength(3);
    });

    it("deletes nothing when there is less than the keep count", async () => {
      const job = await enqueue("record", sessionId);
      await store.finishIndexJob(job.id, "done");
      expect(await store.pruneIndexJobs(10)).toBe(0);
    });
  });
});
