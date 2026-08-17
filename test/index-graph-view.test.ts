import { describe, expect, it } from "vitest";
import type { IndexStageDTO, StageProgress } from "../app/src/shared/types.js";
import {
  MAX_SHARE_SEGMENTS,
  MIN_SHARE_PCT,
  RATE_MIN_MS,
  RATE_MIN_UNITS,
  groupByPhase,
  liveElapsedMs,
  reducedNeeds,
  stageElapsed,
  stageMeter,
  stageRate,
  stageTone,
  timeShares,
} from "../app/src/renderer/src/screens/index-graph-view.js";
import { buildStageGraph } from "../app/src/main/index-graph.js";
import { initialStages } from "../app/src/main/index-queue.js";
import { STAGE_PHASES } from "../app/src/shared/types.js";

/**
 * What the ladder SAYS — the renderer's half of the split `session-tracks` and
 * `track-view` already make: main decides what a row MEANS, this decides how it
 * reads.
 *
 * The wire-geometry tests this replaced asserted channel assignment, gutter
 * width and path uniqueness — every one of them passed while the picture was
 * unreadable, which is exactly why the wires are gone. Reachable from the root
 * suite only because the module is `.ts` and imports nothing from `api.ts`.
 */

const ALL_ON = { patchEmbedder: true, captioner: true, hasAudio: true, whisper: true };
const ladder = (): IndexStageDTO[] => buildStageGraph(initialStages("record", ALL_ON));

const at = (stages: IndexStageDTO[], id: string): IndexStageDTO =>
  stages.find((s) => s.id === id)!;

const running = (over: Partial<IndexStageDTO> = {}): IndexStageDTO => ({
  id: "captions",
  label: "Captions",
  describe: "…",
  phase: "enrichment",
  state: "running",
  detail: null,
  progress: null,
  startedAt: null,
  elapsedMs: null,
  row: 0,
  col: 0,
  needs: [],
  ...over,
});

const progress = (
  done: number,
  total: number,
  unit = "segments",
  at = 0,
): StageProgress => ({ done, total, unit, at });

describe("groupByPhase", () => {
  it("puts every stage in exactly one band, losing none", () => {
    const stages = ladder();
    const bands = groupByPhase(stages);
    expect(bands.flatMap((b) => b.stages.map((s) => s.id))).toEqual(stages.map((s) => s.id));
  });

  it("preserves execution order inside and across bands", () => {
    const flat = groupByPhase(ladder()).flatMap((b) => b.stages);
    const rows = flat.map((s) => s.row);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
  });

  it("emits only bands that have stages — a trace rebuild draws ONE", () => {
    const bands = groupByPhase(buildStageGraph(initialStages("trace-rebuild", ALL_ON)));
    expect(bands).toHaveLength(1);
    expect(bands[0]!.phase).toBe("library");
  });

  it("carries each band's title and purpose from the shared table", () => {
    for (const band of groupByPhase(ladder())) {
      const meta = STAGE_PHASES.find((p) => p.id === band.phase)!;
      expect(band.title).toBe(meta.title);
      expect(band.purpose).toBe(meta.purpose);
    }
  });

  it("never emits the same phase twice, because the table is contiguous", () => {
    const seen = groupByPhase(ladder()).map((b) => b.phase);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("stageMeter", () => {
  it("draws nothing for a stage that is not running", () => {
    for (const state of ["pending", "done", "skipped", "failed"] as const) {
      // Even carrying progress: only a RUNNING stage has a meter, so a crashed
      // job's stale `running` row cannot leave a bar under a finished stage.
      const s = running({ state, progress: progress(3, 10) });
      expect(stageMeter(s).kind).toBe("none");
    }
  });

  it("is indeterminate when a running stage cannot count", () => {
    expect(stageMeter(running()).kind).toBe("indeterminate");
  });

  it("is determinate when it can, and reports the unit it was given", () => {
    const m = stageMeter(running({ progress: progress(118, 289) }));
    expect(m).toEqual({
      kind: "determinate",
      done: 118,
      total: 289,
      unit: "segments",
      pct: (118 / 289) * 100,
    });
  });

  it("refuses a zero total rather than dividing by it", () => {
    // NaN would render as a blank bar — a meter that looks like it exists and
    // measures nothing, which is worse than declining to draw one.
    expect(stageMeter(running({ progress: progress(0, 0) })).kind).toBe("indeterminate");
  });

  it("clamps into the track, so a bar can never exceed its own width", () => {
    const m = stageMeter(running({ progress: progress(12, 10) }));
    expect(m.kind === "determinate" && m.pct).toBe(100);
  });
});

describe("liveElapsedMs", () => {
  /**
   * The queue snapshot is rebuilt only on stage TRANSITIONS, so a running
   * stage's `elapsedMs` is computed once, at `begin`. Measured in the running
   * app: the row read "0ms" for the whole of a stage while its meter advanced,
   * and no rate ever appeared because the two-second floor could never be met.
   */
  it("runs a LIVE clock for the stage that is running", () => {
    const s = running({ startedAt: 1000, elapsedMs: 0 });
    expect(liveElapsedMs(s, 61_000)).toBe(60_000);
  });

  it("keeps a finished stage's closed measurement, which must not keep growing", () => {
    const s = running({ state: "done", startedAt: 1000, elapsedMs: 8 });
    expect(liveElapsedMs(s, 999_999)).toBe(8);
  });

  it("says nothing for a stage that has not started", () => {
    expect(liveElapsedMs(running({ state: "pending" }), 5000)).toBeNull();
  });

  it("never reports a negative interval if the clocks disagree", () => {
    expect(liveElapsedMs(running({ startedAt: 9000 }), 1000)).toBe(0);
  });
});

describe("stageRate", () => {
  /** `startedAt` is a wall clock; the progress carries the clock it was seen at. */
  const seenAt = (done: number, afterMs: number, total = 100): StageProgress =>
    progress(done, total, "segments", 1_000_000 + afterMs);
  const START = 1_000_000;

  it("says nothing without both a count and a start", () => {
    expect(stageRate(null, START)).toBeNull();
    expect(stageRate(seenAt(50, 10_000), null)).toBeNull();
  });

  it("withholds a rate below the floors — the rail's 25 keys/s lesson", () => {
    // One unit 200ms in is arithmetically 5/s and practically noise; it would
    // fall by an order of magnitude on the very next sample.
    expect(stageRate(seenAt(1, 200), START)).toBeNull();
    expect(stageRate(seenAt(RATE_MIN_UNITS - 1, 60_000), START)).toBeNull();
    expect(stageRate(seenAt(50, RATE_MIN_MS - 1), START)).toBeNull();
  });

  it("reports units per second once there is enough to measure", () => {
    expect(stageRate(seenAt(20, 10_000), START)).toBe("2.0/s");
  });

  it("inverts below 1/s, because that is the readable number for captions", () => {
    // The stage anybody actually watches runs at seconds PER unit.
    expect(stageRate(seenAt(10, 34_000, 289), START)).toBe("3.4s each");
  });

  /**
   * THE POINT OF `StageProgress.at`. Measured against a live clock, a stage
   * sitting at 2/4 climbed from "1.0s each" to "7.0s each" without a single unit
   * completing, then snapped back when one did. The rate must be a closed
   * interval that moves only when the count moves.
   */
  it("does not drift while the count stands still", () => {
    const p = seenAt(2, 4000);
    expect(stageRate(p, START)).toBe("2.0s each");
    // Ten seconds of wall clock later, with no new unit, the SAME answer —
    // because nothing new has been measured.
    expect(stageRate(p, START)).toBe("2.0s each");
  });

  it("withholds rather than inventing one for a record written before `at` existed", () => {
    // Decoded as 0, which precedes any real `startedAt`, so the interval is
    // negative and the floor rejects it.
    expect(stageRate(progress(50, 100, "segments", 0), START)).toBeNull();
  });
});

describe("timeShares", () => {
  const stage = (id: string, elapsedMs: number | null, state: IndexStageDTO["state"]): IndexStageDTO =>
    running({ id, label: id, state, elapsedMs });

  it("has nothing to show before anything has run", () => {
    const t = timeShares([stage("segment", null, "pending")]);
    expect(t).toEqual({ segments: [], folded: 0, foldedMs: 0, totalMs: 0 });
  });

  it("excludes a RUNNING stage, whose elapsed grows on every tick", () => {
    const t = timeShares([stage("a", 1000, "done"), stage("b", 5000, "running")]);
    expect(t.totalMs).toBe(1000);
    expect(t.segments.map((s) => s.id)).toEqual(["a"]);
  });

  it("sums stage time — which is NOT the job's wall clock", () => {
    const t = timeShares([stage("a", 1000, "done"), stage("b", 3000, "done")]);
    expect(t.totalMs).toBe(4000);
  });

  it("orders by cost, because the question is what took the time", () => {
    const t = timeShares([
      stage("small", 1000, "done"),
      stage("big", 8000, "done"),
      stage("mid", 3000, "done"),
    ]);
    expect(t.segments.map((s) => s.id)).toEqual(["big", "mid", "small"]);
  });

  it("FOLDS a sliver instead of widening it, and counts what it folded", () => {
    // 8ms against 22 minutes is 0.0006% — sub-pixel at any width. A minimum-width
    // block would be a bar widened to be seen, which the rail forbids outright.
    const t = timeShares([
      stage("captions", 856_000, "done"),
      stage("segment", 8, "done"),
      stage("linkFrames", 2, "done"),
    ]);
    expect(t.segments.map((s) => s.id)).toEqual(["captions"]);
    expect(t.folded).toBe(2);
    expect(t.foldedMs).toBe(10);
  });

  it("keeps every drawn share at or above the fold threshold", () => {
    const t = timeShares([stage("a", 990, "done"), stage("b", 10, "done")]);
    for (const seg of t.segments) expect(seg.pct).toBeGreaterThanOrEqual(MIN_SHARE_PCT);
  });

  /**
   * The palette has five positional slots plus a neutral fold. A sixth coloured
   * block would wrap to the first slot and put two stages in one colour while
   * the legend claimed they differ — the exact collision this rollup shipped
   * once, caught only in a screenshot.
   */
  it("never draws more blocks than the palette has distinct colours", () => {
    const many = Array.from({ length: 12 }, (_, i) => stage(`s${i}`, 1000, "done"));
    const t = timeShares(many);
    expect(t.segments.length).toBe(MAX_SHARE_SEGMENTS);
    expect(t.folded).toBe(12 - MAX_SHARE_SEGMENTS);
  });

  it("folds the CHEAPEST when it runs out of slots, never the first it met", () => {
    const many = [
      stage("tiny", 1000, "done"),
      ...Array.from({ length: 5 }, (_, i) => stage(`big${i}`, 10_000, "done")),
    ];
    const t = timeShares(many);
    expect(t.segments.map((s) => s.id)).not.toContain("tiny");
    expect(t.foldedMs).toBe(1000);
  });

  it("accounts for all of the time — drawn plus folded is the whole sum", () => {
    const t = timeShares([
      stage("a", 5000, "done"),
      stage("b", 4000, "done"),
      stage("c", 3, "done"),
    ]);
    expect(t.segments.reduce((n, s) => n + s.ms, 0) + t.foldedMs).toBe(t.totalMs);
  });
});

describe("reducedNeeds", () => {
  it("drops a need that another need already reaches", () => {
    // `searchIndex` declares five and four are implied by `compose` needing
    // them. Printing all five restates the hub instead of describing the stage.
    const stages = ladder();
    const kept = reducedNeeds(stages).get("searchIndex")!;
    expect(at(stages, "searchIndex").needs).toHaveLength(5);
    expect(kept).toEqual(["compose"]);
  });

  it("reduces digest and trace to their one real predecessor", () => {
    const r = reducedNeeds(ladder());
    expect(r.get("digest")).toEqual(["regions"]);
    expect(r.get("trace")).toEqual(["regions"]);
  });

  it("keeps genuinely independent needs", () => {
    expect(reducedNeeds(ladder()).get("regions")).toEqual(["segment", "linkAx"]);
  });

  it("never invents a need, and never keeps one off the ladder", () => {
    const stages = ladder();
    const ids = new Set(stages.map((s) => s.id));
    for (const [id, kept] of reducedNeeds(stages)) {
      const declared = at(stages, id).needs;
      for (const n of kept) {
        expect(declared).toContain(n);
        expect(ids.has(n)).toBe(true);
      }
    }
  });

  it("answers for every stage, including the ones with no needs", () => {
    const stages = ladder();
    const r = reducedNeeds(stages);
    expect(r.size).toBe(stages.length);
    expect(r.get("segment")).toEqual([]);
  });
});

describe("stageTone", () => {
  it("maps every state to a defined tone slot", () => {
    expect(stageTone("done")).toBe("ok");
    expect(stageTone("running")).toBe("accent");
    expect(stageTone("failed")).toBe("alarm");
    expect(stageTone("skipped")).toBe("neutral");
  });

  it("does not paint pending as an outcome", () => {
    expect(stageTone("pending")).toBe("neutral");
  });
});

describe("stageElapsed", () => {
  it("says nothing for a stage that never ran", () => {
    expect(stageElapsed(null)).toBeNull();
  });

  it("reports sub-second stages in milliseconds", () => {
    // Half the pipeline is pure SQLite; a ladder of "0s" says less than one that
    // shows the two stages that actually cost something.
    expect(stageElapsed(8)).toBe("8ms");
  });

  it("reports seconds with one decimal", () => {
    expect(stageElapsed(2400)).toBe("2.4s");
  });

  it("reports minutes for the stages that take them", () => {
    expect(stageElapsed(299_000)).toBe("4m 59s");
  });

  it("rolls a rounded-up remainder into the minute instead of printing 60s", () => {
    // The real Frame patches stage printed "4m 60s" at 299.6s. Every unit test
    // passed: none happened to land in the last half-second of a minute.
    expect(stageElapsed(299_600)).toBe("5m 00s");
  });
});
