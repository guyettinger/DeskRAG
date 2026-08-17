/**
 * The indexing queue's POLICY, as pure functions over a list of job rows.
 *
 * Indexing used to be awaited inside `stopRecording`, which made recording and
 * indexing one state — you could not start a recording while the last one
 * indexed, and an image-provider run over 546 frames takes about ten minutes.
 * Splitting them needs somewhere to say *which job runs next and why not*, and
 * that somewhere had better not require an Electron window, a store, or an ONNX
 * session to interrogate.
 *
 * So the rules live here as data-in/data-out, the same device as `index-plan.ts`
 * next door: `planStages` returns the ordered selection as a VALUE, and
 * `nextRunnable` returns the scheduling decision as a VALUE. Both are assertable
 * from the ROOT suite. The only imports are type-level or from `index-plan.ts`,
 * which itself imports nothing — so nothing here can pull in `electron` or a
 * native module.
 *
 * The WORKER that acts on these decisions lives in `deskrag-service.ts`, because
 * acting requires the store and the providers. This module never performs work;
 * it only says what the work should be.
 */

import {
  INDEX_STAGES,
  planStages,
  reindexPlan,
  stageSpec,
  type StageFacts,
  type StageId,
} from "./index-plan.js";
import type { IndexJobRow } from "deskrag";

/**
 * What a job is for.
 *
 * `record` and `reindex` differ in exactly one respect — whether the derived
 * rows are purged first — but they are separate kinds rather than a flag,
 * because the store deduplicates by (kind, session): a manual re-index must be
 * able to queue behind the automatic job for the same recording rather than
 * being folded into it and silently doing nothing.
 */
export type IndexJobKind = "record" | "reindex" | "trace-rebuild";

export const INDEX_JOB_KINDS: readonly IndexJobKind[] = ["record", "reindex", "trace-rebuild"];

export function isIndexJobKind(s: string): s is IndexJobKind {
  return (INDEX_JOB_KINDS as readonly string[]).includes(s);
}

/** Where one stage of one job got to. Serialized into the job row's `progress`. */
export interface StageRecord {
  id: StageId;
  state: IndexStageState;
  /**
   * The one line of evidence under the stage name: a count it produced, the
   * reason its gate said no, or the message from a tolerated failure. Null
   * while pending.
   */
  detail: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export type IndexStageState = "pending" | "running" | "done" | "skipped" | "failed";

/**
 * The app's half of the job row's opaque `payload`.
 *
 * Deliberately thin. Whether a job must purge before running is NOT stored here
 * — it is derived by {@link mustPurge} from the kind and the attempt count, so
 * there is no flag on disk that can disagree with the situation it describes.
 * A re-queued job's payload comes back byte-identical, which is what keeps the
 * store's `payload` genuinely opaque to the store.
 */
export interface JobPayload {
  /** Groups the fan-out of one full-library re-index. Null for a lone job. */
  batchId: string | null;
}

export function encodePayload(p: JobPayload): string {
  return JSON.stringify(p);
}

/** Tolerant on purpose: a payload written by an older build must not crash the queue. */
export function decodePayload(raw: string): JobPayload {
  try {
    const v = JSON.parse(raw) as Partial<JobPayload>;
    return { batchId: typeof v.batchId === "string" ? v.batchId : null };
  } catch {
    return { batchId: null };
  }
}

export function encodeStages(stages: readonly StageRecord[]): string {
  return JSON.stringify(stages);
}

/**
 * Tolerant for the same reason, plus one more: a stage that no longer exists
 * must not reach the diagram, or a job indexed by an older build would draw a
 * node with no place in the ladder.
 */
export function decodeStages(raw: string | null): StageRecord[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as StageRecord[];
    if (!Array.isArray(v)) return [];
    const known = new Set<string>(INDEX_STAGES.map((s) => s.id));
    return v.filter((s) => s && typeof s.id === "string" && known.has(s.id));
  } catch {
    return [];
  }
}

/**
 * Whether this run must discard the recording's derived rows before re-running
 * the plan over it.
 *
 * DERIVED, never stored, from two facts the store already keeps. Three cases:
 *
 *  - A **manual re-index** always purges. That is what makes it a re-index
 *    rather than a second pass.
 *  - **Any retry** purges (`attempts > 1`; the count is incremented at claim, so
 *    the first run sees 1). A job that died mid-plan left derived rows behind,
 *    and every stage APPENDS — `putRegions` mints a fresh ULID per region and
 *    `putSegmentVectors` is a bare `lance.add`, so a second pass over live rows
 *    doubles them, and duplicates that still have a SQLite row are not orphans,
 *    so `reconcile()` can never prune them. Measured: the region table would
 *    read 15222 rather than 7611.
 *  - A **first-attempt record** job does not, because there is nothing derived
 *    yet and the purge would be a no-op with a transaction's cost.
 *
 * `trace-rebuild` never purges here: `rebuildGraph` is already delete-then-
 * insert over the whole graph, and `purgeDerived` is per-session anyway.
 */
export function mustPurge(kind: IndexJobKind, attempts: number): boolean {
  if (kind === "trace-rebuild") return false;
  return kind === "reindex" || attempts > 1;
}

/** Which stages this kind of job runs, in the order it runs them. */
export function stageIdsFor(kind: IndexJobKind, facts: StageFacts): StageId[] {
  if (kind === "record") return planStages(facts);
  const split = reindexPlan(facts);
  return kind === "reindex" ? split.perSession : split.library;
}

/**
 * The stage ladder a job starts with — every stage in its scope, with the ones
 * that will not run ALREADY MARKED SKIPPED AND ALREADY CARRYING THEIR REASON.
 *
 * That is the point of building it up front rather than as the run goes: a
 * queued job can show what will not happen to it *before* it happens, which is
 * the question a reader actually has when a recording comes back with no
 * captions. A stage that merely never appeared would be indistinguishable from
 * one that was forgotten.
 */
export function initialStages(kind: IndexJobKind, facts: StageFacts): StageRecord[] {
  const planned = new Set(stageIdsFor(kind, facts));
  // A trace rebuild is one library-scoped operation, not a per-session plan with
  // eleven things crossed out — listing them would be noise, not disclosure.
  const scope =
    kind === "trace-rebuild"
      ? INDEX_STAGES.filter((s) => s.reindex === "library-finisher")
      : INDEX_STAGES;

  return scope.map((spec) => ({
    id: spec.id,
    state: planned.has(spec.id) ? ("pending" as const) : ("skipped" as const),
    detail: planned.has(spec.id) ? null : skipDetail(spec.id, facts),
    startedAt: null,
    endedAt: null,
  }));
}

/**
 * Why a stage is not going to run.
 *
 * A gate that says no answers for itself (`StageSpec.skipReason`). A stage that
 * passed its gate and is still absent was excluded by SCOPE — it is the trace
 * graph, which accretes across recordings and so runs once at the end of a
 * batch rather than once per recording.
 */
export function skipDetail(id: StageId, facts: StageFacts): string {
  const spec = stageSpec(id);
  if (!spec.gate(facts)) return spec.skipReason?.(facts) ?? "not configured";
  return "runs once for the whole library";
}

/**
 * Progress over STAGES, and only over stages.
 *
 * This retires an axis that was overloaded three ways: `done/total` used to mean
 * stages on the record path, recordings during a full re-index, and *frames*
 * inside the patch stage — all plotted on one bar, which therefore changed scale
 * mid-run. Per-frame counts are now a stage's `detail` string, where they read
 * as evidence rather than as a second, contradictory measure of the same thing.
 *
 * Skipped stages are excluded from BOTH halves: a job whose captioner is off is
 * not 20% finished before it starts.
 */
export function jobProgress(stages: readonly StageRecord[]): { done: number; total: number } {
  const live = stages.filter((s) => s.state !== "skipped");
  return {
    done: live.filter((s) => s.state === "done" || s.state === "failed").length,
    total: live.length,
  };
}

/** Why the worker is not running anything. */
export type HoldReason = "recording" | "empty";

export type QueueDecision = { job: IndexJobRow; held: null } | { job: null; held: HoldReason };

/**
 * Which job to run next, or why none.
 *
 * **Indexing yields to recording, and that is the whole rule.** Capture is
 * real-time and unrepeatable: a dropped frame or a silent microphone cannot be
 * re-recorded, whereas indexing can be re-run from the blobs at any time. The
 * heaviest stages here are patch embedding and whisper, and `better-sqlite3` is
 * synchronous on the same event loop the capture batcher runs on — so the
 * contention is real, not theoretical. Holding costs a few minutes of latency;
 * losing the capture costs the recording.
 *
 * The hold is checked BETWEEN stages by the worker, never mid-stage: a stage
 * abandoned halfway leaves exactly the half-written derived rows this design
 * spends a purge to avoid.
 *
 * `empty` is reported ahead of `recording` because it is the more specific
 * answer — "nothing to do" and "something to do, but later" are different
 * screens, and a queue that reported "paused" while empty would look broken.
 */
export function nextRunnable(
  jobs: readonly IndexJobRow[],
  world: { recording: boolean },
): QueueDecision {
  const queued = jobs.filter((j) => j.state === "queued");
  if (queued.length === 0) return { job: null, held: "empty" };
  if (world.recording) return { job: null, held: "recording" };
  // The store already returns jobs in enqueue order (`enqueued_at`, then rowid
  // — NOT the ULID, which randomizes within a millisecond and would shuffle a
  // whole library rebuild's fan-out). Taking the first preserves that.
  return { job: queued[0]!, held: null };
}

/**
 * Human-readable, and the one place the wording lives.
 *
 * **`midStage` is not a detail.** The gate is checked BETWEEN stages, and the
 * slowest stage measured on a real recording took 14m 16s — so "indexing is
 * paused" can be false for a quarter of an hour after a recording starts, while
 * the stage already in flight runs to its end. Saying "Paused" then would be a
 * plain lie, and saying nothing at all is what the screen actually did: measured
 * by driving the app, a second recording ran with a job visibly `running` beside
 * it and no word anywhere about yielding.
 *
 * So there are two sentences, and which one is true depends on whether a stage
 * is mid-flight. Stopping that stage early is not the alternative: every stage
 * appends, and a half-written one is exactly what the purge exists to clean up.
 */
export function holdMessage(held: HoldReason, midStage = false): string | null {
  if (held !== "recording") return null;
  return midStage
    ? "Recording — indexing pauses as soon as the current stage finishes"
    : "Paused — recording in progress";
}
