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

// The band table lives in the shared contract, not here: main assigns a phase
// and the renderer draws it, and two copies of one band table is precisely the
// drift `ax-dump`/`ax-exec` already paid for. Type-only plus one const, no
// electron and no native subpath, so the root suite still reaches this module.
import { STAGE_PHASES, type StagePhase } from "@shared/types";

export { STAGE_PHASES, type StagePhase };

export type StageId =
  | "segment"
  | "linkFrames"
  | "linkAx"
  | "regions"
  | "digest"
  | "framePatches"
  | "captions"
  | "appCaptions"
  | "transcribe"
  | "compose"
  | "reflect"
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
  patchEmbedder: boolean;
  captioner: boolean;
  hasAudio: boolean;
  whisper: boolean;
  /**
   * A chat model is configured for summarising — which is the SAME setting the
   * reflection is written by, and deliberately one fact rather than two.
   *
   * Named for the setting rather than for the stage because that is what both
   * derivations read: `stageWorld` asks the provider it built, `plannedFacts`
   * asks `summaryProvider !== "none"`, and the two have to agree. Composing does
   * NOT gate on it — the hierarchy is always built and a missing model costs
   * prose, not shape. A reflection has no such structural half, so it does.
   */
  summarizer: boolean;
}

export interface StageSpec {
  id: StageId;
  /** What the progress line says while this stage runs. */
  label: (f: StageFacts) => string;
  /**
   * Which band this stage is drawn in. REQUIRED, with no default — the same
   * device as `reindex`, so a new stage cannot decline to answer and quietly
   * land in whichever band happens to be adjacent.
   */
  phase: StagePhase;
  /**
   * One sentence, present tense: what this stage does and what it buys.
   *
   * Required for the same reason `skipReason` is. Before this the screen showed
   * `"Linking AX"` and `"Regions"` — two-word labels from which a reader could
   * learn nothing about the pipeline the screen exists to explain.
   *
   * Takes `StageFacts` for the same reason `label` does: it names the one place
   * a fact would have to be threaded if a description ever had to branch.
   */
  describe: (f: StageFacts) => string;
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
   * Why the gate said no, in the words a reader needs — REQUIRED of every stage
   * whose gate is not `always`, and enforced by a test rather than by comment.
   *
   * It sits beside the gate because that is the one place that knows which fact
   * failed, and because the indexing screen states a skipped stage's reason
   * instead of merely dimming it. A stage that dropped out with no explanation
   * is indistinguishable from one that was forgotten — which is the whole class
   * of bug the gates keep producing (a default install once returned nothing at
   * all for every text query, silently, because `associateFrames` was gated).
   */
  skipReason?: (f: StageFacts) => string;
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
    phase: "foundation",
    describe: () =>
      "Cuts the recording into actions at every visual state change — one segment per keyframe.",
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
    phase: "foundation",
    describe: () =>
      "Attaches each keyframe to the segment it fell in. With no image model this is the only route from a text query to a frame.",
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
    phase: "foundation",
    describe: () =>
      "Assigns each accessibility walk to the frame whose pixels it describes, a capture latency earlier.",
    needs: [],
    gate: always,
    reindex: "per-session",
  },
  {
    // Regions run BEFORE the digest, and under every configuration. Proposal is
    // geometry + the AX tree and needs no model at all — nothing crops or embeds
    // a region any more. Two things downstream read what this writes: the digest
    // names what was clicked from these labels, and `Anchor.visual` in the trace
    // graph is built from these rows. Gating the whole stage on an image
    // embedder once meant the patch path wrote no region rows at all and
    // silently cost the executor its middle anchor rung.
    id: "regions",
    label: () => "Regions",
    phase: "foundation",
    describe: () =>
      "Proposes the boxes worth naming on each frame, from the accessibility tree and where the mouse went.",
    needs: ["segment", "linkAx"],
    gate: always,
    reindex: "per-session",
  },
  {
    id: "digest",
    label: () => "Digest + behavior",
    phase: "foundation",
    describe: () =>
      "Writes each segment's searchable summary — window title, URL, typed text, what was clicked — and its behaviour vector.",
    needs: ["segment", "regions"],
    gate: always,
    reindex: "per-session",
  },
  {
    // The ONLY image stage: patches are the regions, so there is no separate
    // frame or region embedding pass. It is by far the slowest stage (seconds
    // per frame), so it reports per-frame progress.
    id: "framePatches",
    label: () => "Frame patches",
    phase: "enrichment",
    describe: () =>
      "Embeds every keyframe as a grid of patches. This is what makes visual search and highlight boxes possible.",
    needs: ["segment"],
    gate: (f) => f.patchEmbedder,
    skipReason: () => "no image model — visual search is off",
    reindex: "per-session",
  },
  {
    id: "captions",
    label: () => "Captions",
    phase: "enrichment",
    describe: () =>
      "Describes each keyframe in a sentence with a vision model, so a screen can be found by what it looked like.",
    needs: ["segment"],
    gate: (f) => f.captioner,
    skipReason: () => "no captioner configured",
    reindex: "per-session",
  },
  {
    id: "appCaptions",
    label: () => "App captions",
    phase: "enrichment",
    describe: () =>
      "Describes just the focused window on each keyframe, cropped away from the rest of the desktop.",
    needs: ["segment"],
    gate: (f) => f.captioner,
    skipReason: () => "no captioner configured",
    reindex: "per-session",
  },
  {
    // Probed, not "configured": the model downloads itself, so the only thing
    // that can still be missing is the whisper.cpp binary — and skipping here is
    // what keeps a machine without it from fetching 57MB it cannot use.
    id: "transcribe",
    label: () => "Transcribing",
    phase: "enrichment",
    describe: () => "Turns the recorded microphone audio into text and per-utterance clips.",
    needs: ["segment"],
    gate: (f) => f.hasAudio && f.whisper,
    // The two facts fail for completely different reasons and the fix differs:
    // one is a property of the recording and cannot be changed after the fact,
    // the other is a missing binary the reader can go and install. Collapsing
    // them into one message would send half the readers to the wrong place.
    skipReason: (f) =>
      !f.hasAudio ? "no audio in this recording" : "whisper-cli not found on PATH",
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
    phase: "consolidation",
    describe: () => "Gathers actions into tasks and a session, each named by what it was for.",
    needs: ["digest", "captions", "appCaptions", "transcribe"],
    gate: always,
    reindex: "per-session",
  },
  {
    // The one MODEL-ONLY stage, and the only one whose absence costs a whole
    // artefact rather than its prose. A reflection is a judgement about how a
    // session went — what dragged, what order would have been better — and every
    // other derived row in this pipeline is silent about that by construction: a
    // digest names a gesture, a caption describes a screen, a rollup names a
    // stretch of work. None of them can say a session stalled, so there is no
    // structural fallback to write and none is invented; with no model there is
    // simply no note, and the ladder says so.
    //
    // AFTER Composing and not before it: the note is written over the composed
    // steps and their durations, which do not exist until that stage has run.
    // Before Search index only because the table's order is the run's order and
    // the note is not indexed — it reaches a reader through a skill's prompt,
    // never through a query.
    id: "reflect",
    label: () => "Reflecting",
    phase: "consolidation",
    describe: () =>
      "Writes a short note on how this session went — what it was for, what stalled, what order would have been better.",
    needs: ["compose"],
    gate: (f) => f.summarizer,
    skipReason: () => "no summary model configured — a reflection is a judgement, and nothing templates one",
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
    phase: "consolidation",
    describe: () =>
      "Feeds every piece of text this run produced into the lexical index — the only route from a query to an exact term with no model.",
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
    phase: "library",
    describe: () =>
      "Lifts this recording into the shared graph of states and the actions between them.",
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
/**
 * Every phase that does not occupy ONE contiguous run of the table. Empty is
 * correct, and a root test asserts it.
 *
 * This is the invariant that lets the screen draw phases as bands. Row is
 * execution order, so a band is only honest if its stages are adjacent in the
 * run — a phase appearing in two places would put a band head in the middle of
 * another band's stages, and the picture would claim a grouping the run does not
 * have. Nothing else would catch it: the ladder would still render, in order,
 * looking entirely reasonable.
 *
 * Checked over the WHOLE table rather than over one plan, for the same reason
 * `depths()` is: a gate removing a stage must not be able to change the shape.
 */
export function stagePhaseViolations(): string[] {
  const out: string[] = [];
  const seen = new Set<StagePhase>();
  let current: StagePhase | null = null;
  for (const spec of INDEX_STAGES) {
    if (spec.phase === current) continue;
    if (seen.has(spec.phase)) {
      out.push(`phase ${spec.phase} is split — it resumes at ${spec.id}`);
    }
    seen.add(spec.phase);
    current = spec.phase;
  }
  for (const phase of STAGE_PHASES) {
    if (!seen.has(phase.id)) out.push(`phase ${phase.id} is declared but has no stages`);
  }
  return out;
}

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
