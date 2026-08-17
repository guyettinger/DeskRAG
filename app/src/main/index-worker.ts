/**
 * The drain loop: the one thing that turns queued jobs into indexed recordings.
 *
 * Everything it needs from the world arrives through {@link WorkerDeps} rather
 * than through `this`, the same device that lets `runStages` be tested with no
 * store. What is left here is only the part that is genuinely about *draining*:
 * claiming a job, deciding whether to purge, keeping the stage ladder up to
 * date, and yielding to capture.
 *
 * ## Three rules, each paid for
 *
 * **One job at a time, and one provider build per drain.** `buildProviders`
 * resolves weights and opens ONNX sessions; doing it per job would be thirteen
 * sessions for one library rebuild.
 *
 * **Purge before a re-run, never resume mid-plan.** Every stage APPENDS —
 * `putRegions` mints a fresh ULID per region, `putSegmentVectors` is a bare
 * `lance.add` — so a second pass over live rows doubles them, and duplicates
 * that still have a SQLite row are not orphans, so `reconcile()` can never prune
 * them. Measured: the region table reads 15222 where 7611 is correct.
 *
 * **Yield to capture between stages.** A dropped frame cannot be re-recorded; an
 * index can be rebuilt from the blobs at any time. The check is at a stage
 * boundary because a stage abandoned halfway leaves exactly the half-written
 * rows the purge above exists to clean up.
 */

import type { DualStore, IndexJobRow } from "deskrag";
import type { IndexTickDTO } from "@shared/types";
import { rebuildGraph } from "./trace-index.js";
import { STAGE_RUNNERS, runStages, type StageReporter, type StageWorld } from "./index-run.js";
import type { Providers, StageRun } from "./index-run.js";
import type { StageId } from "./index-plan.js";
import {
  encodeStages,
  initialStages,
  isIndexJobKind,
  mustPurge,
  nextRunnable,
  stageIdsFor,
  type IndexJobKind,
  type StageRecord,
} from "./index-queue.js";

/** How often the gate re-checks whether capture is still running. */
const HOLD_POLL_MS = 500;

/**
 * How many times a job may be claimed before it is abandoned.
 *
 * A job that takes the whole app down on every attempt would otherwise be an
 * infinite crash loop across launches — the app would never finish starting.
 */
export const MAX_JOB_ATTEMPTS = 3;

export interface WorkerDeps {
  store: DualStore;
  /** Read FRESH on every gate check — capture can start mid-drain. */
  isRecording(): boolean;
  buildProviders(): Promise<Providers>;
  /** Everything the stages need. `sessionId` is "" for library-scoped work. */
  stageWorld(sessionId: string, providers: Providers): Promise<StageWorld>;
  /** The stage currently running, so a weight download can label itself. */
  setRunningStage(at: { jobId: string; stageId: StageId; label: string } | null): void;
  /**
   * A job finished. Caches that assume a finished session is immutable have to
   * drop here — a re-index is the one thing that makes that assumption false,
   * and a background one can land while the Library is open.
   */
  onJobSettled(job: IndexJobRow): void;
  /** Full queue snapshot. Fires on transitions only. */
  emitQueue(): void;
  /** The running stage's detail. Fires per frame in the patch stage. */
  emitTick(tick: IndexTickDTO): void;
}

export class IndexWorker {
  private readonly deps: WorkerDeps;
  private draining = false;
  /**
   * Progress writes, serialized.
   *
   * The reporter callbacks are synchronous but the write is not, so firing them
   * off unchained would let a `finish` land before the `begin` it followed and
   * leave the ladder claiming a finished stage is still running. Last-write-wins
   * only produces the right answer if the writes stay in order.
   */
  private writes: Promise<unknown> = Promise.resolve();
  /** True while the gate is holding, so the screen can say so exactly once. */
  private held = false;

  constructor(deps: WorkerDeps) {
    this.deps = deps;
  }

  /** True while a job is actually being worked on. Guards destructive commands. */
  get busy(): boolean {
    return this.draining;
  }

  /**
   * Start draining, or do nothing if a drain is already running.
   *
   * Safe to call after every enqueue, on startup, and when recording stops —
   * which is the point: nothing has to reason about whether the worker is
   * already awake.
   */
  kick(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drain()
      .catch((err) => console.error("[deskrag] indexing worker failed:", err))
      .finally(() => {
        this.draining = false;
        this.deps.emitQueue();
      });
  }

  /**
   * Re-queue whatever a previous process died inside.
   *
   * A `running` row at startup can only mean a crash or a quit mid-job: nothing
   * else writes that state and then stops. Call once, after the store opens and
   * before the first `kick`.
   */
  async recover(): Promise<void> {
    const touched = await this.deps.store.requeueRunningJobs(MAX_JOB_ATTEMPTS);
    if (touched.length > 0) {
      console.info(`[deskrag] recovered ${touched.length} interrupted indexing job(s)`);
      this.deps.emitQueue();
    }
  }

  private async drain(): Promise<void> {
    let providers: Providers | null = null;

    for (;;) {
      const decision = nextRunnable(this.deps.store.listIndexJobs(), {
        recording: this.deps.isRecording(),
      });
      if (decision.held === "empty") break;
      if (decision.held === "recording") {
        await this.hold();
        continue;
      }

      const job = await this.deps.store.claimIndexJob();
      if (!job) break;
      // Built lazily and ONCE: a drain that finds only a trace rebuild never
      // needs an ONNX session at all, and a library rebuild must not open one
      // per recording.
      providers ??= await this.deps.buildProviders();
      await this.runJob(job, providers);
    }
  }

  /** Wait out a recording, announcing the hold exactly once. */
  private async hold(): Promise<void> {
    if (!this.held) {
      this.held = true;
      this.deps.emitQueue();
    }
    await new Promise((r) => setTimeout(r, HOLD_POLL_MS));
    if (!this.deps.isRecording()) {
      this.held = false;
      this.deps.emitQueue();
    }
  }

  /** True while the worker is waiting for a recording to finish. */
  get holding(): boolean {
    return this.held;
  }

  private async runJob(job: IndexJobRow, providers: Providers): Promise<void> {
    // An unrecognised kind is treated as a plain record job rather than thrown
    // away: a job written by a newer build and read by an older one should
    // index the recording, not strand it.
    const kind: IndexJobKind = isIndexJobKind(job.kind) ? job.kind : "record";
    const world = await this.deps.stageWorld(job.sessionId ?? "", providers);
    const stages = initialStages(kind, world.facts);
    this.persist(job.id, stages);
    this.deps.emitQueue();

    try {
      // Derived from (kind, attempts), never read off a stored flag — so there
      // is nothing on disk that can disagree with the situation it describes.
      if (job.sessionId && mustPurge(kind, job.attempts)) {
        await this.deps.store.purgeDerived(job.sessionId);
      }

      await runStages(
        stageIdsFor(kind, world.facts),
        world,
        this.reporterFor(job, stages),
        runnersFor(kind),
        () => this.gate(),
      );
      await this.deps.store.finishIndexJob(job.id, "done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Whatever was mid-flight is the thing that failed. Leaving it "running"
      // forever is how a finished job comes to look like a hung one.
      for (const s of stages) {
        if (s.state !== "running") continue;
        s.state = "failed";
        s.endedAt = Date.now();
        s.detail = message;
      }
      this.persist(job.id, stages);
      await this.deps.store.finishIndexJob(job.id, "failed", message);
      console.error(`[deskrag] indexing job ${job.id} failed:`, err);
    } finally {
      this.deps.setRunningStage(null);
      await this.writes;
      this.deps.onJobSettled(job);
      this.deps.emitQueue();
    }
  }

  /**
   * Awaited between stages, never inside one.
   *
   * Polls rather than subscribes because the answer is cheap and the alternative
   * — a listener the worker has to attach and detach around every stage — has
   * more ways to leak than the poll has to be late. Half a second of latency at
   * the end of a recording is not a cost anyone can perceive.
   */
  private async gate(): Promise<void> {
    while (this.deps.isRecording()) await this.hold();
  }

  private reporterFor(job: IndexJobRow, stages: StageRecord[]): StageReporter {
    const at = (id: StageId): StageRecord | undefined => stages.find((s) => s.id === id);
    return {
      begin: (id, label) => {
        const s = at(id);
        if (!s) return;
        s.state = "running";
        s.startedAt = Date.now();
        s.detail = null;
        this.deps.setRunningStage({ jobId: job.id, stageId: id, label });
        this.persist(job.id, stages);
        this.deps.emitQueue();
      },
      detail: (id, text) => {
        const s = at(id);
        if (!s) return;
        s.detail = text;
        // NOT persisted and NOT a queue snapshot: this fires per frame in the
        // patch stage. It reaches the screen as a tick and reaches disk when
        // the stage finishes.
        this.deps.emitTick({ jobId: job.id, stageId: id, detail: text });
      },
      finish: (id, outcome, detail) => {
        const s = at(id);
        if (!s) return;
        s.state = outcome;
        s.endedAt = Date.now();
        if (detail !== null) s.detail = detail;
        this.persist(job.id, stages);
        this.deps.emitQueue();
      },
    };
  }

  private persist(jobId: string, stages: readonly StageRecord[]): void {
    const snapshot = encodeStages(stages);
    this.writes = this.writes
      .then(() => this.deps.store.updateIndexJobProgress(jobId, snapshot))
      .catch((err) => console.error("[deskrag] could not record indexing progress:", err));
  }
}

/**
 * The runner map for a job kind.
 *
 * A `trace-rebuild` reuses the whole driver — the ladder, the reporter, and
 * above all the pause gate — by swapping ONE runner. The per-session `trace`
 * stage lifts a single recording into the shared graph; the library rebuild
 * discards the graph and replays every recording in order, because a graph
 * accretes and re-lifting a session it already contains double-counts the
 * `observations` that `edgeCost` uses to choose a path.
 */
function runnersFor(kind: IndexJobKind): Record<StageId, StageRun> {
  if (kind !== "trace-rebuild") return STAGE_RUNNERS;
  return {
    ...STAGE_RUNNERS,
    trace: async (ctx) => {
      const r = await rebuildGraph(ctx.store, (done, total) =>
        ctx.detail(`${done}/${total} recordings re-lifted`),
      );
      ctx.detail(
        `${r.sessions} recordings, graph ${r.nodes}/${r.edges}` +
          (r.variables > 0 ? `, ${r.variables} variables` : "") +
          (r.missingKeymap ? " (a recording had no keyboard layout)" : ""),
      );
    },
  };
}
