import { describe, expect, it } from "vitest";
import type { IndexJobRow } from "../src/store/types.js";
import { INDEX_STAGES, planStages, reindexPlan } from "../app/src/main/index-plan.js";
import {
  decodePayload,
  decodeStages,
  encodePayload,
  encodeStages,
  holdMessage,
  initialStages,
  jobProgress,
  mustPurge,
  nextRunnable,
  skipDetail,
  stageIdsFor,
  type StageRecord,
} from "../app/src/main/index-queue.js";

/**
 * The queue's policy, asserted with no store, no Electron and no model — which
 * is the entire reason it is a set of pure functions over rows rather than
 * methods on the service.
 *
 * The rule that matters most here is the one that cannot be tested any other
 * way: **indexing yields to recording**. Capture is real-time and unrepeatable;
 * indexing can be re-run from the blobs whenever. Getting that backwards costs
 * a recording, and no assertion over the schema would notice.
 */

const ALL_ON = {
  patchEmbedder: true,
  captioner: true,
  hasAudio: true,
  whisper: true,
  summarizer: true,
};
const DEFAULT_INSTALL = {
  patchEmbedder: false,
  captioner: false,
  hasAudio: true,
  whisper: true,
  summarizer: false,
};

const job = (over: Partial<IndexJobRow> = {}): IndexJobRow => ({
  id: "j1",
  sessionId: "s1",
  kind: "record",
  state: "queued",
  enqueuedAt: 1,
  startedAt: null,
  endedAt: null,
  attempts: 0,
  error: null,
  payload: "{}",
  progress: null,
  ...over,
});

describe("nextRunnable", () => {
  it("runs the oldest queued job when nothing is recording", () => {
    const a = job({ id: "a", enqueuedAt: 1 });
    const b = job({ id: "b", enqueuedAt: 2 });
    const d = nextRunnable([a, b], { recording: false });
    expect(d.held).toBeNull();
    expect(d.job?.id).toBe("a");
  });

  /**
   * The load-bearing assertion. A dropped frame or a silent microphone cannot
   * be re-recorded; an index can be rebuilt from the blobs at any time. The
   * heaviest stages are patch embedding and whisper, and better-sqlite3 is
   * synchronous on the same event loop the capture batcher runs on.
   */
  it("holds every job while a recording is in progress", () => {
    const d = nextRunnable([job()], { recording: true });
    expect(d.job).toBeNull();
    expect(d.held).toBe("recording");
  });

  it("resumes the moment recording stops, with no re-enqueue", () => {
    const jobs = [job()];
    expect(nextRunnable(jobs, { recording: true }).job).toBeNull();
    expect(nextRunnable(jobs, { recording: false }).job?.id).toBe("j1");
  });

  /**
   * "Nothing to do" and "something to do, but later" are different screens. A
   * queue reporting "paused" while empty reads as broken.
   */
  it("reports empty ahead of recording, because it is the more specific answer", () => {
    expect(nextRunnable([], { recording: true }).held).toBe("empty");
    expect(nextRunnable([], { recording: false }).held).toBe("empty");
  });

  it("ignores jobs that are not queued", () => {
    const jobs = [
      job({ id: "r", state: "running" }),
      job({ id: "d", state: "done" }),
      job({ id: "f", state: "failed" }),
      job({ id: "c", state: "cancelled" }),
    ];
    expect(nextRunnable(jobs, { recording: false }).held).toBe("empty");
  });

  it("skips finished jobs to reach a queued one behind them", () => {
    const jobs = [job({ id: "d", state: "done" }), job({ id: "q", state: "queued" })];
    expect(nextRunnable(jobs, { recording: false }).job?.id).toBe("q");
  });

  it("names the hold for the reader, and says nothing when idle", () => {
    expect(holdMessage("recording")).toMatch(/recording/i);
    expect(holdMessage("empty")).toBeNull();
    expect(holdMessage("empty", true)).toBeNull();
  });

  /**
   * The gate is checked BETWEEN stages, and the slowest stage measured 14m 16s
   * on a real recording — so "Paused" is false for as long as the stage already
   * in flight takes to finish. Found by driving the app: a second recording ran
   * beside a visibly running job with no word anywhere about yielding.
   */
  it("distinguishes 'pausing shortly' from 'paused'", () => {
    const midStage = holdMessage("recording", true)!;
    const idle = holdMessage("recording", false)!;
    expect(midStage).not.toBe(idle);
    expect(midStage).toMatch(/current stage/i);
    expect(idle).toMatch(/^Paused/);
    // Neither may claim indexing has already stopped when it has not.
    expect(midStage).not.toMatch(/^Paused/);
  });
});

/**
 * Purge-or-not is DERIVED from the kind and the attempt count rather than stored,
 * so there is no flag on disk that can disagree with the situation. Getting it
 * wrong in the permissive direction doubles every derived row — measured, the
 * region table read 15222 where 7611 was correct.
 */
describe("mustPurge", () => {
  it("does not purge a first-attempt record job — there is nothing derived yet", () => {
    expect(mustPurge("record", 1)).toBe(false);
  });

  it("always purges a manual re-index, which is what makes it a re-index", () => {
    expect(mustPurge("reindex", 1)).toBe(true);
  });

  it("purges any retry, because a job that died mid-plan left rows behind", () => {
    expect(mustPurge("record", 2)).toBe(true);
    expect(mustPurge("record", 7)).toBe(true);
  });

  it("never purges a trace rebuild — putGraph is already delete-then-insert", () => {
    expect(mustPurge("trace-rebuild", 1)).toBe(false);
    expect(mustPurge("trace-rebuild", 4)).toBe(false);
  });
});

describe("stageIdsFor", () => {
  it("gives a record job the whole record plan, trace included", () => {
    expect(stageIdsFor("record", ALL_ON)).toEqual(planStages(ALL_ON));
    expect(stageIdsFor("record", ALL_ON)).toContain("trace");
  });

  it("gives a re-index job the per-session half only", () => {
    expect(stageIdsFor("reindex", ALL_ON)).toEqual(reindexPlan(ALL_ON).perSession);
    expect(stageIdsFor("reindex", ALL_ON)).not.toContain("trace");
  });

  it("gives a trace rebuild the library half only", () => {
    expect(stageIdsFor("trace-rebuild", ALL_ON)).toEqual(["trace"]);
  });
});

describe("initialStages", () => {
  it("covers every stage for a record job, in table order", () => {
    const stages = initialStages("record", ALL_ON);
    expect(stages.map((s) => s.id)).toEqual(INDEX_STAGES.map((s) => s.id));
    expect(stages.every((s) => s.state === "pending")).toBe(true);
  });

  /**
   * The point of building the ladder up front: a QUEUED job can already say
   * what will not happen to it. "No captions" with no explanation is the same
   * shape of silence that once let a default install return nothing at all for
   * every text query.
   */
  it("marks gated-out stages skipped and states WHY, before the job runs", () => {
    const stages = initialStages("record", DEFAULT_INSTALL);
    const by = new Map(stages.map((s) => [s.id, s]));

    expect(by.get("framePatches")!.state).toBe("skipped");
    expect(by.get("framePatches")!.detail).toMatch(/image model/i);
    expect(by.get("captions")!.state).toBe("skipped");
    expect(by.get("captions")!.detail).toMatch(/captioner/i);
    expect(by.get("appCaptions")!.state).toBe("skipped");

    // Everything ungated still runs on a default install — that is what makes
    // text search work with no provider configured at all.
    expect(by.get("segment")!.state).toBe("pending");
    expect(by.get("linkFrames")!.state).toBe("pending");
    expect(by.get("searchIndex")!.state).toBe("pending");
    expect(by.get("trace")!.state).toBe("pending");
  });

  /**
   * Two facts, two fixes: one is a property of the recording and can never be
   * changed, the other is a binary the reader can go and install. One shared
   * message would send half of them to the wrong place.
   */
  it("distinguishes no-audio from no-whisper", () => {
    const noAudio = { ...ALL_ON, hasAudio: false };
    const noWhisper = { ...ALL_ON, whisper: false };
    expect(skipDetail("transcribe", noAudio)).toMatch(/no audio/i);
    expect(skipDetail("transcribe", noWhisper)).toMatch(/whisper-cli/i);
  });

  it("explains a scope exclusion as scope, not as a missing provider", () => {
    const stages = initialStages("reindex", ALL_ON);
    const trace = stages.find((s) => s.id === "trace")!;
    expect(trace.state).toBe("skipped");
    expect(trace.detail).toMatch(/whole library/i);
  });

  it("shows a trace rebuild as one operation, not eleven crossed-out ones", () => {
    const stages = initialStages("trace-rebuild", ALL_ON);
    expect(stages.map((s) => s.id)).toEqual(["trace"]);
    expect(stages[0]!.state).toBe("pending");
  });
});

/**
 * One axis. `done/total` used to mean stages, then recordings, then FRAMES —
 * all on one bar, which therefore changed scale mid-run.
 */
describe("jobProgress", () => {
  const rec = (id: string, state: StageRecord["state"]): StageRecord => ({
    id: id as StageRecord["id"],
    state,
    detail: null,
    progress: null,
    startedAt: null,
    endedAt: null,
  });

  it("counts only stages, and only ones that will run", () => {
    const stages = [
      rec("segment", "done"),
      rec("linkFrames", "running"),
      rec("captions", "skipped"),
      rec("trace", "pending"),
    ];
    expect(jobProgress(stages)).toEqual({ done: 1, total: 3 });
  });

  it("does not report a job as part-finished because its captioner is off", () => {
    const stages = [rec("segment", "pending"), rec("captions", "skipped")];
    expect(jobProgress(stages)).toEqual({ done: 0, total: 1 });
  });

  it("counts a tolerated failure as finished — the run moved past it", () => {
    expect(jobProgress([rec("transcribe", "failed")])).toEqual({ done: 1, total: 1 });
  });

  it("reports 0/0 rather than dividing by zero on an all-skipped ladder", () => {
    expect(jobProgress([rec("captions", "skipped")])).toEqual({ done: 0, total: 0 });
  });
});

/**
 * Both codecs are deliberately tolerant. A payload or a ladder written by an
 * older build must degrade, never crash the queue that has to drain it.
 */
describe("payload and stage codecs", () => {
  it("round-trips a payload", () => {
    expect(decodePayload(encodePayload({ batchId: "b1" }))).toEqual({ batchId: "b1" });
    expect(decodePayload(encodePayload({ batchId: null }))).toEqual({ batchId: null });
  });

  it("survives a malformed payload", () => {
    expect(decodePayload("not json")).toEqual({ batchId: null });
    expect(decodePayload("{}")).toEqual({ batchId: null });
    expect(decodePayload('{"batchId":7}')).toEqual({ batchId: null });
  });

  it("round-trips a stage ladder", () => {
    const stages = initialStages("record", DEFAULT_INSTALL);
    expect(decodeStages(encodeStages(stages))).toEqual(stages);
  });

  it("returns an empty ladder for a job that has never reported", () => {
    expect(decodeStages(null)).toEqual([]);
    expect(decodeStages("nonsense")).toEqual([]);
  });

  /**
   * A stage id that no longer exists must not reach the diagram: it has no row
   * in the ladder to occupy, and the layout is derived from the table.
   */
  it("drops stages the current build no longer declares", () => {
    const raw = JSON.stringify([
      { id: "segment", state: "done", detail: null, startedAt: null, endedAt: null },
      { id: "regionImages", state: "done", detail: null, startedAt: null, endedAt: null },
    ]);
    expect(decodeStages(raw).map((s) => s.id)).toEqual(["segment"]);
  });
});

/**
 * The guard that keeps the disclosure honest. A stage whose gate can say no and
 * which cannot say why would render as a dimmed node with no explanation —
 * indistinguishable from a stage somebody forgot to implement.
 */
describe("every gated stage explains itself", () => {
  const NOTHING = {
    patchEmbedder: false,
    captioner: false,
    hasAudio: false,
    whisper: false,
    summarizer: false,
  };

  it("declares a skipReason wherever a gate can reject", () => {
    for (const spec of INDEX_STAGES) {
      if (spec.gate(NOTHING)) continue;
      expect(spec.skipReason, `${spec.id} can be gated out but gives no reason`).toBeDefined();
      expect(spec.skipReason!(NOTHING).length, spec.id).toBeGreaterThan(0);
    }
  });

  it("never leaves a skipped stage without a detail line", () => {
    for (const facts of [NOTHING, DEFAULT_INSTALL, { ...ALL_ON, hasAudio: false }]) {
      for (const kind of ["record", "reindex"] as const) {
        for (const s of initialStages(kind, facts)) {
          if (s.state !== "skipped") continue;
          expect(s.detail, `${kind}/${s.id}`).toBeTruthy();
        }
      }
    }
  });
});
