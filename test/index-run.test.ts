import { describe, expect, it } from "vitest";
import { runStages, type StageCtx, type StageRun, type StageWorld } from "../app/src/main/index-run.js";
import type { StageId } from "../app/src/main/index-plan.js";
import { INDEX_STAGES } from "../app/src/main/index-plan.js";

/**
 * The driver, tested apart from the stages it drives.
 *
 * `runStages` takes its runner map as a parameter precisely so this can happen:
 * the real map needs a store, blobs, providers and a whisper binary, and none of
 * that is what decides whether a stage's label reaches the progress channel or
 * whether a failure stops the run.
 */

/**
 * The fakes read nothing but `progress`/`report`, which runStages supplies. The
 * facts are real, because the driver reads them to build a label.
 */
const world = {
  sessionId: "s",
  facts: {
    imageEmbedder: false,
    patchEmbedder: false,
    captioner: false,
    hasAudio: false,
    whisper: false,
  },
} as unknown as StageWorld;

interface Emitted {
  label: string;
  done: number;
  total: number;
}

const recorder = (): { out: Emitted[]; reporter: Parameters<typeof runStages>[2] } => {
  const out: Emitted[] = [];
  return {
    out,
    reporter: {
      begin: (_id, label, index, total) => out.push({ label, done: index, total }),
      update: (label, done, total) => out.push({ label, done, total }),
    },
  };
};

/** A runner map where every stage is a no-op, so a test can override just one. */
const noops = (over: Partial<Record<StageId, StageRun>> = {}): Record<StageId, StageRun> =>
  Object.fromEntries(
    INDEX_STAGES.map((s) => [s.id, over[s.id] ?? (async (): Promise<void> => {})]),
  ) as Record<StageId, StageRun>;

describe("runStages", () => {
  it("announces each stage by its label, numbered against the plan it was given", async () => {
    const { out, reporter } = recorder();
    await runStages(["segment", "digest", "trace"], world, reporter, noops());
    expect(out).toEqual([
      { label: "Segmenting", done: 0, total: 3 },
      { label: "Digest + behavior", done: 1, total: 3 },
      { label: "Trace", done: 2, total: 3 },
    ]);
  });

  it("runs them in the order given", async () => {
    const ran: StageId[] = [];
    const spy =
      (id: StageId): StageRun =>
      async () => {
        ran.push(id);
      };
    await runStages(["segment", "regions", "compose"], world, recorder().reporter, {
      ...noops(),
      segment: spy("segment"),
      regions: spy("regions"),
      compose: spy("compose"),
    });
    expect(ran).toEqual(["segment", "regions", "compose"]);
  });

  /**
   * The bug this replaced: `run` returned `Promise<unknown>` and the driver
   * discarded it, so composing's "N levels, N nodes" line was computed on every
   * single run and emitted on none of them. Trace got the same job done only by
   * reaching for the service's emitter from inside its own closure.
   */
  it("emits a label a stage reports when it finishes", async () => {
    const { out, reporter } = recorder();
    await runStages(["compose"], world, reporter, {
      ...noops(),
      compose: async (ctx: StageCtx) => ctx.report("Composing — 3 levels, 12 nodes (8 summarized)"),
    });
    expect(out.at(-1)).toEqual({
      label: "Composing — 3 levels, 12 nodes (8 summarized)",
      done: 0,
      total: 1,
    });
  });

  /** Frame patches is seconds per frame, so it counts frames rather than stages. */
  it("forwards a stage's own progress on its own scale", async () => {
    const { out, reporter } = recorder();
    await runStages(["framePatches"], world, reporter, {
      ...noops(),
      framePatches: async (ctx: StageCtx) => ctx.progress(3, 40, "Frame patches 3/40"),
    });
    expect(out.at(-1)).toEqual({ label: "Frame patches 3/40", done: 3, total: 40 });
  });

  /**
   * Transcription is the only stage that downloads on the indexing path, and
   * Trace runs after it. A session with no transcript is still a session; a
   * session with no graph is one the executor cannot use.
   */
  it("carries on past a failure in transcribing, and says why", async () => {
    const { out, reporter } = recorder();
    const ran: StageId[] = [];
    await runStages(["transcribe", "compose"], world, reporter, {
      ...noops(),
      transcribe: async () => {
        throw new Error("checksum mismatch");
      },
      compose: async () => {
        ran.push("compose");
      },
    });
    expect(ran).toEqual(["compose"]);
    expect(out.map((e) => e.label)).toContain("Transcribing skipped — checksum mismatch");
  });

  it("lets a failure anywhere else abort the run", async () => {
    const ran: StageId[] = [];
    await expect(
      runStages(["regions", "digest"], world, recorder().reporter, {
        ...noops(),
        regions: async () => {
          throw new Error("sharp exploded");
        },
        digest: async () => {
          ran.push("digest");
        },
      }),
    ).rejects.toThrow("sharp exploded");
    expect(ran).toEqual([]);
  });
});
