/**
 * The indexing stages themselves — one runner per id declared in `index-plan.ts`,
 * plus the driver that walks a plan.
 *
 * Split from the table so the ORDER can be argued about without loading a store,
 * and split from `DeskRagService` so a stage body reaches for an injected `ctx`
 * rather than for `this`. The map is a `Record<StageId, StageRun>`, which is what
 * makes the compiler find a stage that was declared and never implemented — the
 * same device as `showLabels` being required on `TrackLaneDTO`.
 *
 * Imports nothing from `deskrag-service.ts` and nothing from `electron`, so this
 * module is reachable from the ROOT suite.
 */

import {
  AppCaptionRepresenter,
  CaptionRepresenter,
  ComposeRepresenter,
  FramePatchRepresenter,
  RegionRepresenter,
  Representer,
  Segmenter,
  StoredAxProvider,
  TranscriptRepresenter,
  associateFrameAx,
  associateFrames,
  indexSegmentText,
  renderReflection,
  type BehaviorFeatureExtractor,
  type BlobStore,
  type CaptionProvider as LibCaptionProvider,
  type DualStore,
  type EmbeddingProvider,
  type MultiVectorProvider,
  type ReflectionProvider,
  type RegionCropper,
  type Reranker,
  type SummaryProvider as LibSummaryProvider,
  type TranscriptRepresenterOptions,
} from "deskrag";
import { stageSpec, type StageFacts, type StageId } from "./index-plan.js";
import { digestContextFor } from "./digest-context.js";
import { composedRoot, reflectionBriefFor } from "./reflection-brief.js";
import { indexTrace } from "./trace-index.js";
import { ModelFilesMissingError } from "./model-store.js";
import { MODELS } from "./models.js";

/**
 * The providers one indexing run was built with. Rebuilt per run rather than
 * held on the service, because settings can change between recordings.
 */
export interface Providers {
  textEmbedder: EmbeddingProvider;
  behavior: BehaviorFeatureExtractor;
  /**
   * Single-vector visual path — frame + region embeddings, and therefore the
   * Tier-3 region ANN + AX-label FTS highlights. Mutually exclusive with
   * patchEmbedder: the library's Retriever rejects both at once.
   */
  /** The visual path. Null on the default install, which has none. */
  patchEmbedder: MultiVectorProvider | null;
  captioner: LibCaptionProvider | null;
  /**
   * Composes actions into named levels. Null does NOT disable the hierarchy —
   * the tree is always built, structurally, and every node gets a templated
   * rollup. This only upgrades the prose.
   */
  summarizer: LibSummaryProvider | null;
  /**
   * Writes the per-session reflection. Built from the SAME setting as
   * `summarizer` and therefore null exactly when it is — two objects, one
   * switch, because the two take different briefs and return different shapes.
   *
   * Unlike `summarizer`, null here means the artefact does not exist at all: a
   * reflection is a judgement and nothing templates one.
   */
  reflector: ReflectionProvider | null;
  reranker: Reranker | null;
}

/**
 * Everything a stage needs from outside itself.
 *
 * `loadCropper` and `buildTranscriber` are functions rather than values because
 * both are expensive and conditional: the cropper is a lazy native import that
 * may fail, and resolving the whisper model can DOWNLOAD 57MB — which is why it
 * is deliberately not part of `buildProviders`, whose result the search path
 * also uses.
 */
export interface StageWorld {
  sessionId: string;
  /**
   * The same facts the plan was built from. A label can depend on them — Regions
   * says "(proposal only)" without an image embedder — so the driver needs them
   * to announce a stage, not only to select it.
   */
  facts: StageFacts;
  store: DualStore;
  blobs: BlobStore;
  providers: Providers;
  loadCropper(): Promise<RegionCropper | null>;
  buildTranscriber(): Promise<TranscriptRepresenterOptions["transcriber"]>;
}

export interface StageCtx extends StageWorld {
  /**
   * This stage's one-line DETAIL — the evidence under its name, not a second
   * progress bar.
   *
   * It replaced a `progress(done, total, label)` whose numbers were plotted on
   * the SAME bar as the stage count, so the bar changed scale mid-run: `total`
   * meant stages on the record path, recordings during a re-index, and frames
   * inside this one stage. A per-frame count is evidence about one stage, so it
   * is written as evidence — `"41/546 frames"` — and the bar counts stages only.
   *
   * Called freely, including per frame; the reporter decides how often to
   * forward it.
   */
  detail(text: string): void;

  /**
   * How far through its own units this stage is.
   *
   * Separate from `detail` because the two are different kinds of claim.
   * `detail` is EVIDENCE — prose the stage computed, which survives the run and
   * is what the reader sees afterwards. This is a MEASURE, true only while the
   * stage runs, and it is cleared the moment it ends.
   *
   * A stage calls this only when it can genuinely count. Composing deliberately
   * does not: its expensive work is inside `composeLadder`, whose total number
   * of model calls is not known until each level's frontier is built, so any
   * total it could report would be invented. It draws an indeterminate meter
   * instead — the case that state exists for.
   */
  progress(done: number, total: number, unit: string): void;
}

export type StageRun = (ctx: StageCtx) => Promise<void>;

export interface StageReporter {
  begin(id: StageId, label: string, index: number, total: number): void;
  /** The running stage's detail line changed. May fire hundreds of times. */
  detail(id: StageId, text: string): void;
  /** The running stage's unit count advanced. Fires at least as often. */
  progress(id: StageId, done: number, total: number, unit: string): void;
  /**
   * This stage reached a terminal state.
   *
   * `failed` here is always a TOLERATED failure — an untolerated one throws past
   * the driver and the job as a whole fails. The distinction matters on screen:
   * a session with no transcript is still a session.
   */
  finish(id: StageId, outcome: "done" | "failed", detail: string | null): void;
}

/**
 * Why transcription was skipped, in one line a user can act on.
 *
 * A "Model directory" is the case worth naming: setting it disables managed
 * downloads by design (see model-store.ts), so the whisper GGML has to be put
 * there by hand. Reaching around the override to download anyway would break
 * the one promise that setting makes.
 */
export function transcribeFailure(err: unknown): string {
  if (err instanceof ModelFilesMissingError) {
    return (
      `the model directory has no ${MODELS.whisper.files[0]!.path} — add it there, ` +
      `or clear the Model directory setting to use the managed download`
    );
  }
  return err instanceof Error ? err.message : String(err);
}

export const STAGE_RUNNERS: Record<StageId, StageRun> = {
  segment: async (ctx) => {
    await new Segmenter(ctx.store).segment(ctx.sessionId);
  },

  linkFrames: async (ctx) => {
    await associateFrames(ctx.store, ctx.sessionId);
  },

  linkAx: async (ctx) => {
    await associateFrameAx(ctx.store, ctx.sessionId);
  },

  regions: async (ctx) => {
    // Proposal only, always: nothing crops or embeds a region. What it writes —
    // geometry, source, AX role/label — is what `region_fts`, the digest and
    // `Anchor.visual` read, and none of that needs a model.
    await new RegionRepresenter(ctx.store, {
      axProvider: new StoredAxProvider(ctx.store).provide,
      onProgress: (done, total) => ctx.progress(done, total, "frames"),
    }).represent(ctx.sessionId);
  },

  digest: async (ctx) => {
    await new Representer(ctx.store, {
      digestEmbedder: ctx.providers.textEmbedder,
      behavior: ctx.providers.behavior,
      // Typed text and clicked labels — resolved against the session's own
      // keymap and the regions the stage above just wrote. Absent either, the
      // digest degrades to tallies rather than guessing.
      digestContext: digestContextFor(ctx.store, ctx.sessionId),
      onProgress: (done, total) => ctx.progress(done, total, "segments"),
    }).represent(ctx.sessionId);
  },

  framePatches: async (ctx) => {
    // The count moved from `detail` to `progress`: it is a measure, not
    // evidence. What the stage leaves BEHIND is the result — how many frames
    // actually got a vector, which is not the same as how many were walked (a
    // frame with no blob is processed and embeds nothing).
    const r = await new FramePatchRepresenter(ctx.store, {
      patchEmbedder: ctx.providers.patchEmbedder!,
      blobStore: ctx.blobs,
      onProgress: (done, total) => ctx.progress(done, total, "frames"),
    }).represent(ctx.sessionId);
    ctx.detail(`${r.embeddedCount} of ${r.frameCount} frames embedded`);
  },

  captions: async (ctx) => {
    const r = await new CaptionRepresenter(ctx.store, {
      captioner: ctx.providers.captioner!,
      captionEmbedder: ctx.providers.textEmbedder,
      blobStore: ctx.blobs,
      onProgress: (done, total) => ctx.progress(done, total, "segments"),
    }).represent(ctx.sessionId);
    ctx.detail(`${r.captionedCount} of ${r.segmentCount} segments captioned`);
  },

  appCaptions: async (ctx) => {
    // Needs a cropper too (sharp), unlike the whole-frame caption stage — skip
    // entirely rather than write nothing useful when it's unavailable.
    const cropper = await ctx.loadCropper();
    if (!cropper) return;
    const r = await new AppCaptionRepresenter(ctx.store, {
      captioner: ctx.providers.captioner!,
      captionEmbedder: ctx.providers.textEmbedder,
      blobStore: ctx.blobs,
      cropper,
      onProgress: (done, total) => ctx.progress(done, total, "segments"),
    }).represent(ctx.sessionId);
    ctx.detail(`${r.captionedCount} of ${r.segmentCount} focused windows captioned`);
  },

  transcribe: async (ctx) => {
    // Counted in audio CLIPS, because that is the loop whisper actually spends
    // its time in — the per-segment pass afterwards is string slicing over a
    // cache. A meter over segments would sit at zero for the whole run.
    const r = await new TranscriptRepresenter(ctx.store, {
      transcriber: await ctx.buildTranscriber(),
      transcriptEmbedder: ctx.providers.textEmbedder,
      blobStore: ctx.blobs,
      onProgress: (done, total) => ctx.progress(done, total, "audio clips"),
    }).represent(ctx.sessionId);
    ctx.detail(`${r.transcribedCount} of ${r.segmentCount} segments have speech`);
  },

  compose: async (ctx) => {
    const r = await new ComposeRepresenter(ctx.store, {
      ...(ctx.providers.summarizer ? { summarizer: ctx.providers.summarizer } : {}),
      summaryEmbedder: ctx.providers.textEmbedder,
    }).represent(ctx.sessionId);
    if (r.nodes === 0) return;
    // Say WHICH path produced the tree: a structurally-composed hierarchy must
    // not read as a summarized one.
    const how = r.llmNodes === 0 ? "structural" : `${r.llmNodes} summarized`;
    ctx.detail(`${r.levels} levels, ${r.nodes} nodes (${how})`);
  },

  reflect: async (ctx) => {
    const writer = ctx.providers.reflector;
    // The gate reads the same object, so null here is a wiring fault rather than
    // a configuration one. Say so instead of writing nothing quietly — a stage
    // that passed its gate and did nothing is the exact shape of the bug the
    // skipReason discipline exists to make impossible.
    if (writer === null) {
      ctx.detail("no reflection model was built for this run");
      return;
    }

    const session = ctx.store.getSession(ctx.sessionId);
    if (session === undefined) return;
    const segments = ctx.store.getSegmentsBySession(ctx.sessionId);
    // ONE reader for the root: the note hangs off it and the brief is written
    // over its children, and two ways of finding it would agree right up until
    // the day the granularity changed.
    const root = composedRoot(segments);
    if (root === undefined) {
      ctx.detail("nothing to reflect on — this recording has no composed hierarchy");
      return;
    }
    const brief = reflectionBriefFor({
      segments,
      summaries: new Map(
        ctx.store.getSegmentSummariesBySession(ctx.sessionId).map((r) => [r.segmentId, r.text]),
      ),
      childrenOf: (id) => ctx.store.getSegmentChildren(id),
      leavesOf: (id) => ctx.store.getDescendantLeaves(id),
      events: ctx.store.getEventsBySession(ctx.sessionId),
      recordedAt: session.startedAt,
    });

    // Null is a real answer, not a failure: a session composed into one step
    // gives a note that can only restate it.
    if (brief === null) {
      ctx.detail("nothing to reflect on — this recording composed into fewer than two steps");
      return;
    }

    // Caught HERE rather than tolerated by the driver. `tolerateFailure` is for
    // transcribing, which downloads its own weights and can fail for reasons the
    // machine cannot fix mid-run; a reflection is one chat call whose whole
    // artefact is optional, and a run that failed over a missing opinion would
    // take Search index and Trace down with it. The stage still SAYS what
    // happened — the detail survives on the stage record.
    let note;
    try {
      note = await writer.write(brief);
    } catch (err) {
      ctx.detail(
        `no reflection written — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    await ctx.store.putSessionReflection({
      segmentId: root.id,
      text: renderReflection(note),
      // WHICH model, not "llm": the note is an opinion and its author is the
      // whole of its weight. There is no template path for it to be confused
      // with.
      source: `${writer.id} ${writer.model}`,
    });
    ctx.detail(`${brief.steps.length} steps read, note written by ${writer.model}`);
  },

  searchIndex: async (ctx) => {
    indexSegmentText(ctx.store, ctx.sessionId);
  },

  trace: async (ctx) => {
    const r = await indexTrace(ctx.store, ctx.sessionId);
    if (r === undefined) return;
    // The stage's own line is the only surface a trace has until the executor
    // exists, so it carries the counts. The missing-keymap case is the one a
    // user has to be told about: it means every keystroke was discarded, and
    // nothing else would say so. It survives the run now — the detail is kept
    // on the stage record rather than only flashing past in a progress label.
    ctx.detail(
      r.missingKeymap
        ? `${r.actions} actions (no keyboard layout: typed text not captured)`
        : `${r.actions} actions, graph ${r.nodes}/${r.edges}` +
          (r.variables > 0 ? `, ${r.variables} variables` : ""),
    );
    if (r.missingKeymap) {
      console.warn("[deskrag] no keymap captured for this session — typed text was not lifted");
    }
  },
};

/**
 * Walk a plan, announcing each stage and running it.
 *
 * The reporter is a parameter because reporting is not this module's business:
 * it does not know whether the caller is drawing a bar, writing a job row, or
 * asserting in a test. `runners` is a parameter for the same reason — it is what
 * lets the driver be tested with no store at all (`test/index-run.test.ts`).
 *
 * `gate` is awaited BETWEEN stages, never inside one, and that boundary is the
 * whole safety of pausing. Indexing yields to recording because capture is
 * real-time and unrepeatable — but a stage abandoned halfway leaves exactly the
 * half-written derived rows the purge exists to avoid, and every stage APPENDS
 * (`putRegions` mints a fresh ULID per region). So the pause waits for a clean
 * seam. Default is a no-op, so a caller with nothing to yield to says nothing.
 */
export async function runStages(
  ids: readonly StageId[],
  world: StageWorld,
  reporter: StageReporter,
  runners: Record<StageId, StageRun> = STAGE_RUNNERS,
  gate: () => Promise<void> = async () => {},
): Promise<void> {
  const total = ids.length;
  for (let i = 0; i < total; i++) {
    await gate();

    const id = ids[i]!;
    const spec = stageSpec(id);
    const label = spec.label(world.facts);
    reporter.begin(id, label, i, total);

    // The last detail this stage reported, so `finish` can carry it. Without
    // this the evidence a stage computed would be visible only while it ran —
    // which is the bug that made Composing's "N levels, N nodes" line get
    // computed on every run and survive none.
    let last: string | null = null;
    const ctx: StageCtx = {
      ...world,
      detail: (text: string) => {
        last = text;
        reporter.detail(id, text);
      },
      // NOT captured into `last`: progress is not evidence, and a finished stage
      // reporting "546/546 frames" where its digest line belongs would replace
      // what it actually computed with a restatement of the fact that it ended.
      progress: (done: number, total: number, unit: string) => {
        reporter.progress(id, done, total, unit);
      },
    };

    try {
      await runners[id](ctx);
      reporter.finish(id, "done", last);
    } catch (err) {
      if (!spec.tolerateFailure) throw err;
      console.error(`[deskrag] ${id} failed:`, err);
      reporter.finish(id, "failed", `skipped — ${transcribeFailure(err)}`);
    }
  }
}
