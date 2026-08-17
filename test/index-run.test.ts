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
 * The fakes read nothing but `detail`, which runStages supplies. The facts are
 * real, because the driver reads them to build a label.
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

/** Every reporter callback, flattened in the order it fired. */
type Emitted =
  | { at: "begin"; id: StageId; label: string; index: number; total: number }
  | { at: "detail"; id: StageId; text: string }
  | { at: "finish"; id: StageId; outcome: "done" | "failed"; detail: string | null };

const recorder = (): { out: Emitted[]; reporter: Parameters<typeof runStages>[2] } => {
  const out: Emitted[] = [];
  return {
    out,
    reporter: {
      begin: (id, label, index, total) => out.push({ at: "begin", id, label, index, total }),
      detail: (id, text) => out.push({ at: "detail", id, text }),
      finish: (id, outcome, detail) => out.push({ at: "finish", id, outcome, detail }),
    },
  };
};

const finishes = (out: Emitted[]): Extract<Emitted, { at: "finish" }>[] =>
  out.filter((e): e is Extract<Emitted, { at: "finish" }> => e.at === "finish");

/** A runner map where every stage is a no-op, so a test can override just one. */
const noops = (over: Partial<Record<StageId, StageRun>> = {}): Record<StageId, StageRun> =>
  Object.fromEntries(
    INDEX_STAGES.map((s) => [s.id, over[s.id] ?? (async (): Promise<void> => {})]),
  ) as Record<StageId, StageRun>;

describe("runStages", () => {
  it("announces each stage by its label, numbered against the plan it was given", async () => {
    const { out, reporter } = recorder();
    await runStages(["segment", "digest", "trace"], world, reporter, noops());
    expect(out.filter((e) => e.at === "begin")).toEqual([
      { at: "begin", id: "segment", label: "Segmenting", index: 0, total: 3 },
      { at: "begin", id: "digest", label: "Digest + behavior", index: 1, total: 3 },
      { at: "begin", id: "trace", label: "Trace", index: 2, total: 3 },
    ]);
  });

  it("finishes every stage it began, in the same order", async () => {
    const { out, reporter } = recorder();
    await runStages(["segment", "digest", "trace"], world, reporter, noops());
    expect(finishes(out)).toEqual([
      { at: "finish", id: "segment", outcome: "done", detail: null },
      { at: "finish", id: "digest", outcome: "done", detail: null },
      { at: "finish", id: "trace", outcome: "done", detail: null },
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
  it("emits the detail a stage reports", async () => {
    const { out, reporter } = recorder();
    await runStages(["compose"], world, reporter, {
      ...noops(),
      compose: async (ctx: StageCtx) => ctx.detail("3 levels, 12 nodes (8 summarized)"),
    });
    expect(out).toContainEqual({
      at: "detail",
      id: "compose",
      text: "3 levels, 12 nodes (8 summarized)",
    });
  });

  /**
   * The evidence a stage computed has to OUTLIVE the stage. Before this it
   * existed only while the stage ran — a label that flashed past — so a finished
   * job could not say what it had done. `finish` carries the last detail.
   */
  it("carries a stage's last detail into its finish, so the evidence survives", async () => {
    const { out, reporter } = recorder();
    await runStages(["framePatches"], world, reporter, {
      ...noops(),
      framePatches: async (ctx: StageCtx) => {
        ctx.detail("1/40 frames");
        ctx.detail("40/40 frames");
      },
    });
    expect(finishes(out)).toEqual([
      { at: "finish", id: "framePatches", outcome: "done", detail: "40/40 frames" },
    ]);
  });

  /**
   * A per-frame count is EVIDENCE ABOUT ONE STAGE, not a second progress axis.
   * It used to be plotted on the same bar as the stage count, so the bar changed
   * scale mid-run — stages, then recordings, then frames.
   */
  it("does not let an intra-stage count become a second progress scale", async () => {
    const { out, reporter } = recorder();
    await runStages(["framePatches"], world, reporter, {
      ...noops(),
      framePatches: async (ctx: StageCtx) => ctx.detail("3/40 frames"),
    });
    const begins = out.filter((e) => e.at === "begin");
    expect(begins).toEqual([
      { at: "begin", id: "framePatches", label: "Frame patches", index: 0, total: 1 },
    ]);
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
    expect(finishes(out)).toContainEqual({
      at: "finish",
      id: "transcribe",
      outcome: "failed",
      detail: "skipped — checksum mismatch",
    });
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

  /**
   * The pause hook. Indexing yields to recording because capture is real-time
   * and unrepeatable — but only at a stage BOUNDARY: a stage abandoned halfway
   * leaves the half-written derived rows that every stage's append-only write
   * path turns into duplicates on the next pass.
   */
  describe("the pause gate", () => {
    it("is awaited before each stage, never inside one", async () => {
      const order: string[] = [];
      await runStages(
        ["segment", "digest", "trace"],
        world,
        recorder().reporter,
        noops(
          Object.fromEntries(
            INDEX_STAGES.map((s) => [
              s.id,
              async (): Promise<void> => {
                order.push(`run:${s.id}`);
              },
            ]),
          ),
        ),
        async () => {
          order.push("gate");
        },
      );
      expect(order).toEqual([
        "gate",
        "run:segment",
        "gate",
        "run:digest",
        "gate",
        "run:trace",
      ]);
    });

    it("holds the run while the gate is unresolved, without abandoning anything", async () => {
      const ran: StageId[] = [];
      let release = (): void => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      let first = true;

      const run = runStages(
        ["segment", "digest"],
        world,
        recorder().reporter,
        {
          ...noops(),
          segment: async () => void ran.push("segment"),
          digest: async () => void ran.push("digest"),
        },
        async () => {
          if (!first) return;
          first = false;
          await held;
        },
      );

      await Promise.resolve();
      expect(ran, "nothing may start while the gate is held").toEqual([]);

      release();
      await run;
      expect(ran).toEqual(["segment", "digest"]);
    });

    it("defaults to a no-op, so a caller with nothing to yield to says nothing", async () => {
      const ran: StageId[] = [];
      await runStages(["segment"], world, recorder().reporter, {
        ...noops(),
        segment: async () => void ran.push("segment"),
      });
      expect(ran).toEqual(["segment"]);
    });
  });
});
