import { describe, expect, it } from "vitest";
import {
  INDEX_STAGES,
  STAGE_PHASES,
  planStages,
  reindexPlan,
  stageOrderViolations,
  stagePhaseViolations,
  type StageFacts,
  type StageId,
} from "../app/src/main/index-plan.js";

/**
 * The stage table is the interface of indexing, and until now it existed only as
 * `push()` order inside a private method plus a second hand-written copy in the
 * rebuild path. That copy went stale once already: composing was added to the
 * record path and not to the rebuild, so a rebuilt FTS index carried no summary
 * and an existing recording could never gain a hierarchy.
 *
 * These tests are what a `push()` order could not have: the plan is a VALUE, so
 * the ordering can be asserted with no store, no Electron and no model.
 */

const NOTHING: StageFacts = {
  patchEmbedder: false,
  captioner: false,
  hasAudio: false,
  whisper: false,
  summarizer: false,
};

/** Every combination of the five facts — 32 of them. */
const allFacts = (): StageFacts[] => {
  const keys = Object.keys(NOTHING) as (keyof StageFacts)[];
  const out: StageFacts[] = [];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const f = { ...NOTHING };
    keys.forEach((k, i) => {
      f[k] = (mask & (1 << i)) !== 0;
    });
    out.push(f);
  }
  return out;
};

describe("planStages", () => {
  /**
   * The configuration nobody runs the tests against and everybody runs the app
   * with. Text-only retrieval recalls frames purely by segment membership, so
   * `linkFrames` being here is what makes a default install return anything at
   * all; `searchIndex` is its only route from a query to an exact term.
   */
  it("runs the eight always-on stages, in order, with no provider configured", () => {
    expect(planStages(NOTHING)).toEqual([
      "segment",
      "linkFrames",
      "linkAx",
      "regions",
      "digest",
      "compose",
      "searchIndex",
      "trace",
    ]);
  });

  it("puts frame patches after the digest, not before it", () => {
    const plan = planStages({ ...NOTHING, patchEmbedder: true });
    expect(plan).toContain("framePatches");
    expect(plan.indexOf("framePatches")).toBeGreaterThan(plan.indexOf("digest"));
  });

  /** The ONLY image stage: patches are the regions, so there is no second one. */
  it("has exactly one image stage, gated on the patch embedder", () => {
    expect(planStages({ ...NOTHING, patchEmbedder: true })).toContain("framePatches");
    expect(planStages(NOTHING)).not.toContain("framePatches");
    expect(INDEX_STAGES.filter((s) => s.gate({ ...NOTHING, patchEmbedder: true })).length).toBe(
      INDEX_STAGES.filter((s) => s.gate(NOTHING)).length + 1,
    );
  });

  /**
   * The ONE model-only stage. Composing is always on because the hierarchy has a
   * structural half; a reflection has none — a rollup can name a group of
   * actions but cannot say a session dragged — so with no model there is no
   * note at all rather than an invented one.
   */
  it("gates reflecting on the summary model, and puts it after composing", () => {
    expect(planStages(NOTHING)).not.toContain("reflect");
    const plan = planStages({ ...NOTHING, summarizer: true });
    expect(plan).toContain("reflect");
    expect(plan.indexOf("reflect")).toBeGreaterThan(plan.indexOf("compose"));
    // Composing itself never gates on it: a default install still gets a tree.
    expect(planStages(NOTHING)).toContain("compose");
  });

  /**
   * ONE caption stage, not two. There were two until `app_caption` was retired —
   * a second VLM pass over the same keyframe, cropped to the focused window,
   * which cost 38.5% of all indexing time and whose crop made it worse than the
   * whole-frame caption rather than merely redundant. This asserts the count so
   * a second pass cannot be reintroduced without saying so here.
   */
  it("adds exactly one caption stage from the captioner gate", () => {
    const plan = planStages({ ...NOTHING, captioner: true });
    expect(plan).toContain("captions");
    expect(planStages(NOTHING)).not.toContain("captions");
    expect(INDEX_STAGES.filter((s) => s.gate({ ...NOTHING, captioner: true }) && !s.gate(NOTHING)))
      .toHaveLength(1);
  });

  /**
   * Probed, not configured: the model downloads itself, so audio alone is not
   * enough — a machine with no whisper binary must not fetch 57MB it cannot use.
   */
  it("requires BOTH audio and a whisper binary to transcribe", () => {
    expect(planStages({ ...NOTHING, hasAudio: true })).not.toContain("transcribe");
    expect(planStages({ ...NOTHING, whisper: true })).not.toContain("transcribe");
    expect(planStages({ ...NOTHING, hasAudio: true, whisper: true })).toContain("transcribe");
  });

  /**
   * Composing reads the text every gated stage writes, and the lexical index
   * reads what composing wrote. Both are always on, so under EVERY provider
   * configuration they have to come last but one and last but two.
   */
  it("keeps composing after every text stage and the search index after composing", () => {
    for (const f of allFacts()) {
      const plan = planStages(f);
      const at = (id: StageId): number => plan.indexOf(id);
      expect(at("compose")).toBeGreaterThan(at("digest"));
      expect(at("searchIndex")).toBeGreaterThan(at("compose"));
      for (const id of ["captions", "transcribe"] as const) {
        if (at(id) !== -1) expect(at("compose")).toBeGreaterThan(at(id));
      }
    }
  });

  it("ends every plan with the trace graph", () => {
    for (const f of allFacts()) expect(planStages(f).at(-1)).toBe("trace");
  });
});

describe("reindexPlan", () => {
  /**
   * THE assertion this whole table exists for.
   *
   * The rebuild used to be a hand-written subset of the record path, and it went
   * stale: composing was added to one list and not the other, so a rebuilt
   * lexical index carried no summary at all. A re-index now runs EVERYTHING —
   * the only question a stage gets to answer is whether it runs per recording or
   * once over the library, and `reindex` has no default, so a new stage cannot
   * decline to answer it.
   */
  it("covers every stage of the record plan, with nothing dropped and nothing added", () => {
    for (const f of allFacts()) {
      const { perSession, library } = reindexPlan(f);
      expect([...perSession, ...library].sort()).toEqual([...planStages(f)].sort());
    }
  });

  it("keeps the per-session stages in the record path's order", () => {
    for (const f of allFacts()) {
      const { perSession } = reindexPlan(f);
      const record = planStages(f);
      expect(perSession).toEqual(record.filter((id) => perSession.includes(id)));
    }
  });

  /**
   * A graph accretes across recordings, so re-lifting one session into a graph
   * that still contains it double-counts its observations. Trace is therefore
   * discarded and replayed whole, after the loop — never inside it.
   */
  it("holds trace back as the one library-scoped stage", () => {
    const { perSession, library } = reindexPlan(NOTHING);
    expect(library).toEqual(["trace"]);
    expect(perSession).not.toContain("trace");
  });
});

describe("stageOrderViolations", () => {
  it("finds nothing wrong with any plan the table can produce", () => {
    for (const f of allFacts()) expect(stageOrderViolations(planStages(f))).toEqual([]);
  });

  /**
   * The check has to tolerate a stage that was gated out — otherwise every
   * default install would report composing as violating a caption dependency
   * that legitimately never ran.
   */
  it("ignores a dependency that is absent from the plan", () => {
    expect(stageOrderViolations(["segment", "digest"])).toEqual([]);
  });

  it("names the stage and the dependency it runs ahead of", () => {
    const bad = stageOrderViolations(["digest", "regions", "segment"]);
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.join(" ")).toContain("digest");
    expect(bad.join(" ")).toContain("regions");
  });
});

describe("INDEX_STAGES", () => {
  it("declares each stage exactly once", () => {
    const ids = INDEX_STAGES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares no dependency on a stage that does not exist", () => {
    const ids = new Set(INDEX_STAGES.map((s) => s.id));
    for (const s of INDEX_STAGES) {
      for (const n of s.needs) expect(ids.has(n)).toBe(true);
    }
  });

  /**
   * Region proposal is geometry plus the AX tree and needs NO model — nothing
   * crops or embeds a region. So the label no longer branches, and the stage
   * runs under every configuration: gating it on an image embedder once cost the
   * executor its middle anchor rung silently.
   */
  it("runs regions unconditionally, with one label", () => {
    const regions = INDEX_STAGES.find((s) => s.id === "regions")!;
    expect(regions.label(NOTHING)).toBe("Regions");
    for (const f of allFacts()) expect(regions.gate(f)).toBe(true);
  });

  /**
   * The graph accretes across sessions, so re-lifting one into a graph that
   * already contains it double-counts its observations. A full re-index has to
   * discard the graph and replay every session — which makes trace the one stage
   * a per-session loop must skip.
   */
  /**
   * Re-checked when Reflecting was added, deliberately rather than incidentally.
   * A reflection is written over ONE recording's composed steps, so it is
   * per-session like everything else; only the trace graph accretes across the
   * library. Nothing here changed, and that is the answer, not an omission.
   */
  it("marks trace as the library finisher and everything else per-session", () => {
    for (const s of INDEX_STAGES) {
      expect(s.reindex).toBe(s.id === "trace" ? "library-finisher" : "per-session");
    }
  });

  /**
   * Transcription is the only stage that downloads on the indexing path, and
   * Trace runs after it. A session with no transcript is still a session; a
   * session with no graph is one the executor cannot use.
   */
  /**
   * Also re-checked when Reflecting was added. Reflecting CAN fail — it is a
   * chat call to a daemon that may be down — but it catches its own failure and
   * reports it as the stage's detail, so the driver never sees one. That is a
   * different mechanism from `tolerateFailure`, which exists for transcribing
   * because transcribing downloads its own weights mid-run and its failures are
   * not the caller's to swallow. Widening this list would have let a missing
   * opinion take Search index and Trace down with it.
   */
  it("tolerates failure in transcribing and nowhere else", () => {
    for (const s of INDEX_STAGES) {
      expect(s.tolerateFailure ?? false).toBe(s.id === "transcribe");
    }
  });
});

/**
 * The bands the Indexing screen draws.
 *
 * Phases replaced a wire diagram that was measured and failed: twelve stages
 * declared 21 `needs` edges at the time (thirteen and 22 now), each routed down
 * its own channel, and transitive reduction only reached 14 because NINE of them
 * fanned out of `segment` and into `compose`. A hub cannot be drawn with parallel lines, so the structure is
 * carried by named bands — and a band is only honest if its stages are ADJACENT
 * in the run, which is what these assert.
 */
describe("stage phases", () => {
  /**
   * The load-bearing one. Row is execution order, so a phase appearing in two
   * places would put a band head in the middle of another band's stages and the
   * picture would claim a grouping the run does not have. Nothing else catches
   * it: the ladder still renders, in order, looking entirely reasonable.
   */
  it("gives every phase ONE contiguous run of the table", () => {
    expect(stagePhaseViolations()).toEqual([]);
  });

  it("declares no phase that has no stages, and uses no phase it did not declare", () => {
    const declared = new Set(STAGE_PHASES.map((p) => p.id));
    const used = new Set(INDEX_STAGES.map((s) => s.phase));
    expect([...used].filter((p) => !declared.has(p))).toEqual([]);
    expect([...declared].filter((p) => !used.has(p))).toEqual([]);
  });

  /**
   * Bands are read top to bottom beside stages that are also read top to bottom.
   * If the table's phase order disagreed with `STAGE_PHASES`, the heads would
   * appear in one order and be listed in another.
   */
  it("meets the phases in the order STAGE_PHASES declares them", () => {
    const firstSeen: string[] = [];
    for (const s of INDEX_STAGES) {
      if (!firstSeen.includes(s.phase)) firstSeen.push(s.phase);
    }
    expect(firstSeen).toEqual(STAGE_PHASES.map((p) => p.id));
  });

  /**
   * The screen exists to explain the pipeline and used to show two-word labels
   * from which nothing could be learned. Required with no default, so a new
   * stage cannot decline to answer — the `reindex` precedent.
   */
  it("makes every stage say what it does, under every configuration", () => {
    for (const f of allFacts()) {
      for (const s of INDEX_STAGES) {
        const text = s.describe(f);
        expect(text.length).toBeGreaterThan(20);
        // A sentence, not a restated label: it must not simply echo the name.
        expect(text).not.toBe(s.label(f));
      }
    }
  });

  it("gives every phase a title and a purpose", () => {
    for (const p of STAGE_PHASES) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.purpose.length).toBeGreaterThan(20);
    }
  });
});
