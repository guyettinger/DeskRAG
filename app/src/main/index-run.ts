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
  FrameRepresenter,
  RegionRepresenter,
  Representer,
  Segmenter,
  StoredAxProvider,
  TranscriptRepresenter,
  associateFrameAx,
  associateFrames,
  indexSegmentText,
  type BehaviorFeatureExtractor,
  type BlobStore,
  type CaptionProvider as LibCaptionProvider,
  type DualStore,
  type EmbeddingProvider,
  type ImageEmbeddingProvider,
  type MultiVectorProvider,
  type RegionCropper,
  type Reranker,
  type SummaryProvider as LibSummaryProvider,
  type TranscriptRepresenterOptions,
} from "deskrag";
import { stageSpec, type StageFacts, type StageId } from "./index-plan.js";
import { digestContextFor } from "./digest-context.js";
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
  imageEmbedder: ImageEmbeddingProvider | null;
  /** Late-interaction visual path. Mutually exclusive with imageEmbedder. */
  patchEmbedder: MultiVectorProvider | null;
  captioner: LibCaptionProvider | null;
  /**
   * Composes actions into named levels. Null does NOT disable the hierarchy —
   * the tree is always built, structurally, and every node gets a templated
   * rollup. This only upgrades the prose.
   */
  summarizer: LibSummaryProvider | null;
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
  /** Progress WITHIN this stage, on its own scale — frames, not stages. */
  progress(done: number, total: number, label: string): void;
  /** Replace this stage's label now that it knows what it did. */
  report(label: string): void;
}

export type StageRun = (ctx: StageCtx) => Promise<void>;

export interface StageReporter {
  begin(id: StageId, label: string, index: number, total: number): void;
  update(label: string, done: number, total: number): void;
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
    const { imageEmbedder } = ctx.providers;
    const cropper = imageEmbedder ? await ctx.loadCropper() : undefined;
    await new RegionRepresenter(ctx.store, {
      // Without a cropper there is nothing to embed, so drop back to proposal
      // rather than skipping the stage.
      ...(imageEmbedder && cropper
        ? { imageEmbedder, blobStore: ctx.blobs, cropper }
        : {}),
      axProvider: new StoredAxProvider(ctx.store).provide,
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
    }).represent(ctx.sessionId);
  },

  frameEmbeddings: async (ctx) => {
    await new FrameRepresenter(ctx.store, {
      imageEmbedder: ctx.providers.imageEmbedder!,
      blobStore: ctx.blobs,
    }).represent(ctx.sessionId);
  },

  framePatches: async (ctx) => {
    await new FramePatchRepresenter(ctx.store, {
      patchEmbedder: ctx.providers.patchEmbedder!,
      blobStore: ctx.blobs,
      onProgress: (done, total) => ctx.progress(done, total, `Frame patches ${done}/${total}`),
    }).represent(ctx.sessionId);
  },

  captions: async (ctx) => {
    await new CaptionRepresenter(ctx.store, {
      captioner: ctx.providers.captioner!,
      captionEmbedder: ctx.providers.textEmbedder,
      blobStore: ctx.blobs,
    }).represent(ctx.sessionId);
  },

  appCaptions: async (ctx) => {
    // Needs a cropper too (sharp), unlike the whole-frame caption stage — skip
    // entirely rather than write nothing useful when it's unavailable.
    const cropper = await ctx.loadCropper();
    if (!cropper) return;
    await new AppCaptionRepresenter(ctx.store, {
      captioner: ctx.providers.captioner!,
      captionEmbedder: ctx.providers.textEmbedder,
      blobStore: ctx.blobs,
      cropper,
    }).represent(ctx.sessionId);
  },

  transcribe: async (ctx) => {
    await new TranscriptRepresenter(ctx.store, {
      transcriber: await ctx.buildTranscriber(),
      transcriptEmbedder: ctx.providers.textEmbedder,
      blobStore: ctx.blobs,
    }).represent(ctx.sessionId);
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
    ctx.report(`Composing — ${r.levels} levels, ${r.nodes} nodes (${how})`);
  },

  searchIndex: async (ctx) => {
    indexSegmentText(ctx.store, ctx.sessionId);
  },

  trace: async (ctx) => {
    const r = await indexTrace(ctx.store, ctx.sessionId);
    if (r === undefined) return;
    // The stage name is the only surface a trace has until the executor exists,
    // so it carries the counts rather than a bare "Trace". The missing-keymap
    // case is the one a user has to be told about: it means every keystroke was
    // discarded, and nothing else would say so.
    ctx.report(
      r.missingKeymap
        ? `Trace — ${r.actions} actions (no keyboard layout: typed text not captured)`
        : `Trace — ${r.actions} actions, graph ${r.nodes}/${r.edges}` +
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
 * The reporter is a parameter because the two callers count different things:
 * the record path is one recording and counts STAGES, while a re-index is a
 * library and counts RECORDINGS with the stage folded into the label. Neither
 * axis belongs in here.
 *
 * `runners` is a parameter so the driver can be tested without a store — see
 * `test/index-run.test.ts`.
 */
export async function runStages(
  ids: readonly StageId[],
  world: StageWorld,
  reporter: StageReporter,
  runners: Record<StageId, StageRun> = STAGE_RUNNERS,
): Promise<void> {
  const total = ids.length;
  for (let i = 0; i < total; i++) {
    const id = ids[i]!;
    const spec = stageSpec(id);
    const label = spec.label(world.facts);
    reporter.begin(id, label, i, total);

    const ctx: StageCtx = {
      ...world,
      progress: (done: number, n: number, text: string) => reporter.update(text, done, n),
      report: (text: string) => reporter.update(text, i, total),
    };

    try {
      await runners[id](ctx);
    } catch (err) {
      if (!spec.tolerateFailure) throw err;
      console.error(`[deskrag] ${id} failed:`, err);
      reporter.update(`${label} skipped — ${transcribeFailure(err)}`, i, total);
    }
  }
}
