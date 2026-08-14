/**
 * The indexing pipeline, declared.
 *
 * **Stage ORDER is the interface of indexing** — Linking AX before Regions,
 * Regions before Digest, Composing before Search index, Trace last — and until
 * this table existed that order lived only as `push()` order inside a private
 * 210-line method, plus a second hand-written copy in the rebuild path. The copy
 * went stale exactly once and that was enough: composing was added to the record
 * path and not to the rebuild, so a rebuilt FTS index carried no summary at all
 * and an existing recording could never gain a hierarchy. Nothing structural
 * stopped it, because the knowledge was in two places and only one was edited.
 *
 * So: ONE table, and both callers select from it. `planStages` returns the
 * ordered selection as a plain VALUE, which is what makes the ordering
 * assertable with no store, no Electron and no model — see
 * `test/index-plan.test.ts` in the ROOT suite. This module deliberately imports
 * NOTHING: no `electron`, no `deskrag`, no native subpath. That is the condition
 * for a root test to reach an `app/src/main` module at all, the same condition
 * `graph-view.ts` and `session-tracks.ts` already meet.
 *
 * The runners live next door in `index-run.ts`, keyed by the ids declared here.
 */

export type StageId =
  | "segment"
  | "linkFrames"
  | "linkAx"
  | "regions"
  | "digest"
  | "frameEmbeddings"
  | "framePatches"
  | "captions"
  | "appCaptions"
  | "transcribe"
  | "compose"
  | "searchIndex"
  | "trace";

/**
 * Everything a gate is allowed to know, as booleans.
 *
 * Booleans rather than the providers themselves, so `planStages` stays pure and
 * a plan can be asserted without constructing an ONNX session. Two of these are
 * facts about the SESSION (`hasAudio`) or the MACHINE (`whisper`) rather than
 * about configuration — transcription is probed, not configured, because the
 * model downloads itself and only the binary can still be missing.
 */
export interface StageFacts {
  imageEmbedder: boolean;
  patchEmbedder: boolean;
  captioner: boolean;
  hasAudio: boolean;
  whisper: boolean;
}

export interface StageSpec {
  id: StageId;
  /** What the progress line says while this stage runs. */
  label: (f: StageFacts) => string;
  /**
   * Stages that must have run EARLIER IN THE SAME PASS.
   *
   * Checked, never obeyed. A topological sort of this graph is not unique, so
   * its tiebreak would have to be table order anyway — deriving the order from
   * `needs` would add nondeterminism and buy nothing. The array below IS the
   * order; `needs` states the REASON each stage sits where it does, and turns
   * what used to be a prose comment into something a test can fail on.
   */
  needs: readonly StageId[];
  /** Whether this stage runs at all. */
  gate: (f: StageFacts) => boolean;
  /**
   * How a full re-index runs it. No default, deliberately: every stage has to
   * say, so a new stage cannot be quietly left out of the rebuild the way
   * composing was.
   */
  reindex: "per-session" | "library-finisher";
  /** The one stage allowed to fail without failing the run. */
  tolerateFailure?: true;
}

const always = (): boolean => true;

export const INDEX_STAGES: readonly StageSpec[] = [
  {
    id: "segment",
    label: () => "Segmenting",
    needs: [],
    gate: always,
    reindex: "per-session",
  },
  {
    // ALWAYS on, and it has to be: text-only retrieval recalls frames purely by
    // segment membership, so without these links a default install (no image
    // provider) returns nothing for every query. It used to happen only inside
    // the image stages, which are gated on a provider that defaults to "none" —
    // measured on a real store, 2 of 4 recordings had zero links. Pure SQLite
    // over what Segmenting just wrote; no model involved.
    id: "linkFrames",
    label: () => "Linking frames",
    needs: ["segment"],
    gate: always,
    reindex: "per-session",
  },
  {
    // AX walks post-date the pixels they describe by the capture latency, so the
    // frame that TRIGGERED a walk is not the frame it shows. Capture writes no
    // frame_id and this assigns one by content time. It MUST run before Regions,
    // which reads it through StoredAxProvider.
    id: "linkAx",
    label: () => "Linking AX",
    needs: [],
    gate: always,
    reindex: "per-session",
  },
  {
    // Regions run BEFORE the digest, and under every image configuration
    // including none. Proposal is geometry + the AX tree; only the crops need a
    // model. Two things downstream read what this writes: the digest names what
    // was clicked from these labels, and `Anchor.visual` in the trace graph is
    // built from these rows — gating the whole stage on `imageEmbedder` once
    // meant the late-interaction (patch) path wrote no region rows at all and
    // silently cost the executor its middle anchor rung.
    id: "regions",
    label: (f) => (f.imageEmbedder ? "Regions" : "Regions (proposal only)"),
    needs: ["segment", "linkAx"],
    gate: always,
    reindex: "per-session",
  },
  {
    id: "digest",
    label: () => "Digest + behavior",
    needs: ["segment", "regions"],
    gate: always,
    reindex: "per-session",
  },
  {
    id: "frameEmbeddings",
    label: () => "Frame embeddings",
    needs: ["segment"],
    gate: (f) => f.imageEmbedder,
    reindex: "per-session",
  },
  {
    // The multivector path replaces BOTH the frame and region image stages:
    // patches are the regions. It is also by far the slowest stage (seconds per
    // frame), so it reports per-frame progress.
    id: "framePatches",
    label: () => "Frame patches",
    needs: ["segment"],
    gate: (f) => f.patchEmbedder,
    reindex: "per-session",
  },
  {
    id: "captions",
    label: () => "Captions",
    needs: ["segment"],
    gate: (f) => f.captioner,
    reindex: "per-session",
  },
  {
    id: "appCaptions",
    label: () => "App captions",
    needs: ["segment"],
    gate: (f) => f.captioner,
    reindex: "per-session",
  },
  {
    // Probed, not "configured": the model downloads itself, so the only thing
    // that can still be missing is the whisper.cpp binary — and skipping here is
    // what keeps a machine without it from fetching 57MB it cannot use.
    id: "transcribe",
    label: () => "Transcribing",
    needs: ["segment"],
    gate: (f) => f.hasAudio && f.whisper,
    reindex: "per-session",
    // The ONLY stage allowed to fail without failing the run, and it has to be:
    // transcription is on by default and fetches its own weights, so a download,
    // a checksum, or a binary that vanished between the probe and here would
    // otherwise abort indexing — and Trace, which runs after it, would be lost
    // with it. A session with no transcript is still a session; a session with
    // no trace graph is a session the executor cannot use.
    tolerateFailure: true,
  },
  {
    // Compose the hierarchy: actions -> tasks -> processes -> one root whose
    // summary is the session's purpose. AFTER Digest/Captions/Transcribing,
    // because it reads their text; BEFORE Search index, so summaries reach the
    // lexical lane. Always on — the structural path needs no provider, and
    // composing can never fail the run.
    id: "compose",
    label: () => "Composing",
    needs: ["digest", "captions", "appCaptions", "transcribe"],
    gate: always,
    reindex: "per-session",
  },
  {
    // After every text-writing stage, because it reads what they wrote: digest,
    // caption, app_caption, transcript and the composed summaries are produced
    // by five stages under five different provider configurations, and one
    // reader at the end sees whatever actually landed. Needs no provider, so it
    // always runs — on a default install this lane is the only route from a
    // query to an exact term.
    id: "searchIndex",
    label: () => "Search index",
    needs: ["compose", "digest", "captions", "appCaptions", "transcribe"],
    gate: always,
    reindex: "per-session",
  },
  {
    // Last: the trace graph. After Regions because `regionsAt` reads what that
    // stage wrote, and after Segmenting because boundaries define the nodes.
    //
    // The one LIBRARY-scoped stage. A graph accretes across sessions, so
    // re-lifting one session into a graph that already contains it double-counts
    // its `observations` and corrupts exactly the counts `edgeCost` uses to
    // choose a path. A full re-index therefore discards the graph and replays
    // every session in order — `rebuildGraph`, once, after the per-session loop.
    id: "trace",
    label: () => "Trace",
    needs: ["segment", "regions", "linkAx"],
    gate: always,
    reindex: "library-finisher",
  },
];

/** The stages this configuration runs, in the order they run. */
export function planStages(f: StageFacts): StageId[] {
  return INDEX_STAGES.filter((s) => s.gate(f)).map((s) => s.id);
}

/**
 * The same plan, split by scope, for a full re-index.
 *
 * NOT a subset. The rebuild used to be a hand-written selection of the text-side
 * stages and it went stale — composing was added to the record path and not to
 * it, so a rebuilt lexical index carried no summary at all. Every stage now runs;
 * the only question is whether it runs once per recording or once over the whole
 * library, and `StageSpec.reindex` has no default, so a new stage cannot decline
 * to answer it.
 */
export function reindexPlan(f: StageFacts): {
  perSession: StageId[];
  library: StageId[];
} {
  const perSession: StageId[] = [];
  const library: StageId[] = [];
  for (const s of INDEX_STAGES) {
    if (!s.gate(f)) continue;
    (s.reindex === "library-finisher" ? library : perSession).push(s.id);
  }
  return { perSession, library };
}

/** The spec for one id. Every `StageId` is in the table, so this cannot miss. */
export function stageSpec(id: StageId): StageSpec {
  return INDEX_STAGES.find((s) => s.id === id)!;
}

/**
 * Every place a plan runs a stage ahead of something it needs. Empty is correct.
 *
 * A dependency ABSENT from the plan is not a violation: gated stages drop out
 * under a default install, and composing still has to run after whatever text
 * stages actually ran. Only relative order between two present stages is checked.
 */
export function stageOrderViolations(ids: readonly StageId[]): string[] {
  const at = new Map(ids.map((id, i) => [id, i]));
  const out: string[] = [];
  for (const spec of INDEX_STAGES) {
    const i = at.get(spec.id);
    if (i === undefined) continue;
    for (const need of spec.needs) {
      const j = at.get(need);
      if (j !== undefined && j > i) out.push(`${spec.id} runs before ${need}, which it needs`);
    }
  }
  return out;
}
