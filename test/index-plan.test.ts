import { describe, expect, it } from "vitest";
import {
  INDEX_STAGES,
  planStages,
  reindexPlan,
  stageOrderViolations,
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
  imageEmbedder: false,
  patchEmbedder: false,
  captioner: false,
  hasAudio: false,
  whisper: false,
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

  it("puts frame embeddings after the digest, not before it", () => {
    const plan = planStages({ ...NOTHING, imageEmbedder: true });
    expect(plan).toContain("frameEmbeddings");
    expect(plan.indexOf("frameEmbeddings")).toBeGreaterThan(plan.indexOf("digest"));
  });

  /** The multivector path replaces both image stages; it is not additive. */
  it("selects frame patches for a patch embedder and frame embeddings for an image one", () => {
    expect(planStages({ ...NOTHING, patchEmbedder: true })).toContain("framePatches");
    expect(planStages({ ...NOTHING, patchEmbedder: true })).not.toContain("frameEmbeddings");
    expect(planStages({ ...NOTHING, imageEmbedder: true })).not.toContain("framePatches");
  });

  it("adds both caption stages from the one captioner gate", () => {
    const plan = planStages({ ...NOTHING, captioner: true });
    expect(plan).toContain("captions");
    expect(plan).toContain("appCaptions");
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
      for (const id of ["captions", "appCaptions", "transcribe"] as const) {
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
   * Region proposal is geometry plus the AX tree; only the crops need a model.
   * Saying so in the label is what stops a proposal-only pass reading as a full
   * one — gating the whole stage on an image embedder once cost the executor its
   * middle anchor rung silently.
   */
  it("says when regions are proposal-only", () => {
    const regions = INDEX_STAGES.find((s) => s.id === "regions")!;
    expect(regions.label(NOTHING)).toBe("Regions (proposal only)");
    expect(regions.label({ ...NOTHING, imageEmbedder: true })).toBe("Regions");
  });

  /**
   * The graph accretes across sessions, so re-lifting one into a graph that
   * already contains it double-counts its observations. A full re-index has to
   * discard the graph and replay every session — which makes trace the one stage
   * a per-session loop must skip.
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
  it("tolerates failure in transcribing and nowhere else", () => {
    for (const s of INDEX_STAGES) {
      expect(s.tolerateFailure ?? false).toBe(s.id === "transcribe");
    }
  });
});
