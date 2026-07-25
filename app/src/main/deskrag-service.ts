/**
 * DeskRagService — the single owner of the DeskRAG library in the main process.
 * The renderer never touches the store, native modules, or providers; it only
 * calls this service through IPC and receives plain DTOs. Responsibilities:
 *   - open the dual store + blob store under the app data dir,
 *   - build providers from settings (local-first: Ollama by default),
 *   - run the recording lifecycle (individually-wired producers),
 *   - auto-index (segment -> represent) after each stop, emitting progress,
 *   - search + hydrate result detail into serializable DTOs.
 *
 * Native/subprocess producers (uiohook, active-win, sharp) are imported lazily so
 * a missing native module degrades one signal instead of failing app startup.
 */

import { join } from "node:path";
import {
  DualStore,
  BlobStore,
  OllamaTextEmbedding,
  VoyageImageEmbedding,
  GeminiEmbedding,
  AnthropicCaptionProvider,
  GeminiCaptionProvider,
  LLMReranker,
  BehaviorFeatureExtractor,
  CaptureSession,
  FfmpegScreenProducer,
  FfmpegAudioProducer,
  SwiftAxSource,
  Segmenter,
  Representer,
  FrameRepresenter,
  CaptionRepresenter,
  RegionRepresenter,
  TranscriptRepresenter,
  StoredAxProvider,
  WhisperCppTranscription,
  Retriever,
  TextViewSearcher,
  BehaviorViewSearcher,
  FramePatchRepresenter,
  OllamaCaptionProvider,
  type Producer,
  type EmbeddingProvider,
  type ImageEmbeddingProvider,
  type MultiVectorProvider,
  type CaptionProvider as LibCaptionProvider,
  type BlobRow,
  type Reranker,
  type ViewSearcher,
} from "deskrag";
import type { SettingsStore } from "./settings.js";
import { MODELS } from "./models.js";
import {
  ModelNotBuiltError,
  ModelStore,
  type ModelDownloadProgress,
} from "./model-store.js";
import type {
  Capabilities,
  HighlightDTO,
  IndexingProgress,
  KeyframeMarkerDTO,
  ProviderSettingsView,
  RecordingStatus,
  ResultDetailDTO,
  SearchInput,
  SearchResultDTO,
  SessionDetailDTO,
  SessionSummaryDTO,
  SessionVideoDTO,
  SignalKind,
} from "@shared/types";

interface Providers {
  textEmbedder: EmbeddingProvider;
  behavior: BehaviorFeatureExtractor;
  /** Single-vector visual path (cloud). Mutually exclusive with patchEmbedder. */
  imageEmbedder: ImageEmbeddingProvider | null;
  /** Late-interaction visual path (local). Mutually exclusive with imageEmbedder. */
  patchEmbedder: MultiVectorProvider | null;
  captioner: LibCaptionProvider | null;
  reranker: Reranker | null;
  transcriber: WhisperCppTranscription;
}

/**
 * Capabilities as a pure function so it is testable without Electron.
 *
 * Semantics are *configured intent*, not live reachability — as before, this
 * reports "Voyage selected and a key present", never "Voyage responded". Local
 * providers need no key, so selecting one is enough.
 */
export function capabilitiesFor(p: ProviderSettingsView): Capabilities {
  return {
    imageSearch:
      p.imageProvider === "colsmol" ||
      (p.imageProvider === "voyage" && p.keys.voyage) ||
      (p.imageProvider === "gemini" && p.keys.gemini),
    caption:
      p.captionProvider === "ollama" ||
      (p.captionProvider === "anthropic" && p.keys.anthropic) ||
      (p.captionProvider === "gemini" && p.keys.gemini),
    rerank:
      p.rerankProvider === "onnx" ||
      (p.rerankProvider === "anthropic" && p.keys.anthropic),
    transcript: Boolean(p.whisper.modelPath),
  };
}

export class DeskRagService {
  private store!: DualStore;
  private blobs!: BlobStore;
  private readonly settings: SettingsStore;
  private readonly dir: string;

  private session: CaptureSession | undefined;
  private state: RecordingStatus = { state: "idle", activeSignals: [] };

  private models!: ModelStore;
  private stateListeners = new Set<(s: RecordingStatus) => void>();
  private indexingListeners = new Set<(p: IndexingProgress) => void>();
  private modelListeners = new Set<(p: ModelDownloadProgress) => void>();
  /** Region highlights from the most recent search, for detail() to reuse. */
  private lastHighlights = new Map<string, HighlightDTO[]>();

  constructor(dataDir: string, settings: SettingsStore) {
    this.dir = dataDir;
    this.settings = settings;
  }

  get dataDir(): string {
    return this.dir;
  }
  get settingsStore(): SettingsStore {
    return this.settings;
  }

  async open(): Promise<void> {
    this.store = await DualStore.open(
      join(this.dir, "app.db"),
      join(this.dir, "lance"),
    );
    this.blobs = new BlobStore(join(this.dir, "blobs"));
    this.models = new ModelStore(join(this.dir, "models"), {
      overrideDir: this.settings.view().providers.localModels.dir,
      onProgress: (p) => {
        for (const cb of this.modelListeners) cb(p);
      },
    });
  }

  close(): void {
    this.store?.close();
  }

  // --- events ---------------------------------------------------------------

  onState(cb: (s: RecordingStatus) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }
  onIndexing(cb: (p: IndexingProgress) => void): () => void {
    this.indexingListeners.add(cb);
    return () => this.indexingListeners.delete(cb);
  }
  /** Weight downloads can start from search(), not just index(), so this is its
   *  own channel rather than a stage of IndexingProgress. */
  onModelDownload(cb: (p: ModelDownloadProgress) => void): () => void {
    this.modelListeners.add(cb);
    return () => this.modelListeners.delete(cb);
  }
  private emitState(): void {
    for (const cb of this.stateListeners) cb(this.state);
  }
  private emitIndexing(p: IndexingProgress): void {
    for (const cb of this.indexingListeners) cb(p);
  }

  status(): RecordingStatus {
    return this.state;
  }

  // --- providers ------------------------------------------------------------

  /**
   * Async because the ONNX adapters load native code and therefore arrive via
   * `await import()`, like loadCropper() already does.
   *
   * An EMBEDDER that cannot load throws. It must never silently fall back to a
   * different embedder: that writes into a different vector space while the user
   * believes otherwise. Refinements (the reranker) degrade quietly instead.
   */
  private async buildProviders(): Promise<Providers> {
    const p = this.settings.view().providers;
    const behavior = new BehaviorFeatureExtractor();

    // --- text embedder --------------------------------------------------------
    let textEmbedder: EmbeddingProvider = new OllamaTextEmbedding({
      host: p.ollamaHost,
      model: p.ollamaModel,
    });
    if (p.textProvider === "onnx") {
      const mod = await this.loadOnnx<typeof import("deskrag/embed/onnx/text")>(
        "deskrag/embed/onnx/text",
      );
      if (!mod) {
        throw new Error(
          "Local text embedding is unavailable: onnxruntime-node failed to load.",
        );
      }
      const dir = await this.models.ensure(MODELS.text);
      textEmbedder = new mod.OnnxTextEmbedding({
        modelPath: join(dir, "model_int8.onnx"),
        tokenizerPath: join(dir, "tokenizer.json"),
      });
    }

    // --- visual path (exactly one, or neither) --------------------------------
    let imageEmbedder: ImageEmbeddingProvider | null = null;
    let patchEmbedder: MultiVectorProvider | null = null;
    if (p.imageProvider === "colsmol") {
      const mod = await this.loadOnnx<typeof import("deskrag/embed/onnx/colsmol")>(
        "deskrag/embed/onnx/colsmol",
      );
      if (!mod) {
        throw new Error("Local image search is unavailable: onnxruntime-node failed to load.");
      }
      const dir = await this.models.ensure(MODELS.colsmol);
      patchEmbedder = new mod.ColSmolMultiVector({
        modelPath: join(dir, "model.onnx"),
        tokenizerPath: join(dir, "tokenizer.json"),
        // Read tiling from the model's own config rather than assuming it.
        tileConfig: await mod.readTileConfig(
          join(dir, "preprocessor_config.json"),
          join(dir, "config.json"),
        ),
      });
    } else if (p.imageProvider === "voyage" && this.settings.key("voyage")) {
      imageEmbedder = new VoyageImageEmbedding({ apiKey: this.settings.key("voyage")! });
    } else if (p.imageProvider === "gemini" && this.settings.key("gemini")) {
      imageEmbedder = new GeminiEmbedding({ apiKey: this.settings.key("gemini")! });
    }

    // --- captioner ------------------------------------------------------------
    let captioner: LibCaptionProvider | null = null;
    if (p.captionProvider === "ollama") {
      captioner = new OllamaCaptionProvider({
        host: p.ollamaHost,
        model: p.ollamaCaptionModel,
      });
    } else if (p.captionProvider === "anthropic" && this.settings.key("anthropic")) {
      captioner = new AnthropicCaptionProvider({ apiKey: this.settings.key("anthropic")! });
    } else if (p.captionProvider === "gemini" && this.settings.key("gemini")) {
      captioner = new GeminiCaptionProvider({ apiKey: this.settings.key("gemini")! });
    }

    // --- reranker (Tier 4 is a refinement: degrade, never throw) --------------
    let reranker: Reranker | null = null;
    if (p.rerankProvider === "onnx") {
      const mod = await this.loadOnnx<typeof import("deskrag/retrieve/rerank/onnx")>(
        "deskrag/retrieve/rerank/onnx",
      );
      if (mod) {
        try {
          const dir = await this.models.ensure(MODELS.reranker);
          reranker = new mod.OnnxCrossEncoderReranker({
            modelPath: join(dir, "model_int8.onnx"),
            tokenizerPath: join(dir, "tokenizer.json"),
          });
        } catch (err) {
          console.error("[deskrag] local reranker unavailable:", err);
        }
      }
    } else if (p.rerankProvider === "anthropic" && this.settings.key("anthropic")) {
      reranker = new LLMReranker({ apiKey: this.settings.key("anthropic")! });
    }

    const transcriber = new WhisperCppTranscription({
      binaryPath: p.whisper.binaryPath,
      ...(p.whisper.modelPath ? { modelPath: p.whisper.modelPath } : {}),
    });

    return {
      textEmbedder,
      behavior,
      imageEmbedder,
      patchEmbedder,
      captioner,
      reranker,
      transcriber,
    };
  }

  /**
   * Lazy import for modules that load native code. Returns null on failure so the
   * caller decides: refinements degrade, embedders throw.
   */
  private async loadOnnx<T>(path: string): Promise<T | null> {
    try {
      return (await import(/* @vite-ignore */ path)) as T;
    } catch (err) {
      console.error(`[deskrag] ${path} unavailable:`, err);
      return null;
    }
  }

  capabilities(): Capabilities {
    return capabilitiesFor(this.settings.view().providers);
  }

  // --- recording ------------------------------------------------------------

  async startRecording(): Promise<RecordingStatus> {
    if (this.state.state !== "idle") return this.state;
    const v = this.settings.view();
    const sig = v.signals;
    const active: SignalKind[] = [];

    const axSource = sig.ax.enabled ? new SwiftAxSource() : undefined;
    const session = new CaptureSession(this.store, {
      blobStore: this.blobs,
      ...(axSource ? { axSource } : {}),
    });

    if (sig.screen.enabled) {
      session.addProducer(
        new FfmpegScreenProducer({
          fps: sig.screen.fps,
          imageMaxWidth: sig.screen.imageMaxWidth,
          storeImages: true,
        }),
      );
      active.push("screen");
    }
    if (sig.input.enabled) {
      const p = await this.loadNativeProducer(
        "deskrag/capture/producers/uiohook-input",
        "UiohookInputProducer",
      );
      if (p) {
        session.addProducer(p);
        active.push("input");
      }
    }
    if (sig.activeWin.enabled) {
      const p = await this.loadNativeProducer(
        "deskrag/capture/producers/active-window",
        "ActiveWindowProducer",
      );
      if (p) {
        session.addProducer(p);
        active.push("active-win");
      }
    }
    if (sig.audio.enabled) {
      session.addProducer(
        new FfmpegAudioProducer({
          device: sig.audio.device,
          chunkSeconds: sig.audio.chunkSeconds,
          media: "mic",
        }),
      );
      active.push("audio");
    }
    if (sig.ax.enabled) active.push("ax");

    const sessionId = await session.start();
    this.session = session;
    this.state = { state: "recording", sessionId, startedAt: Date.now(), activeSignals: active };
    this.emitState();
    return this.state;
  }

  private async loadNativeProducer(
    modulePath: string,
    exportName: string,
  ): Promise<Producer | null> {
    try {
      const mod = (await import(/* @vite-ignore */ modulePath)) as Record<
        string,
        new () => Producer
      >;
      const Ctor = mod[exportName];
      return Ctor ? new Ctor() : null;
    } catch (err) {
      console.error(`[deskrag] native producer ${exportName} unavailable:`, err);
      return null;
    }
  }

  async stopRecording(): Promise<RecordingStatus> {
    if (this.state.state !== "recording" || !this.session) return this.state;
    const sessionId = this.state.sessionId!;
    await this.session.stop();
    this.session = undefined;
    this.state = { state: "indexing", sessionId, activeSignals: this.state.activeSignals };
    this.emitState();

    try {
      await this.index(sessionId);
    } catch (err) {
      console.error("[deskrag] indexing failed:", err);
      // A model that was never built is a setup problem with a known fix, not a
      // crash — surface the instruction instead of leaving the user with a
      // progress bar that silently stopped.
      this.emitIndexing({
        stage:
          err instanceof ModelNotBuiltError
            ? `Setup needed — ${err.message.split("\n")[0]}`
            : "Indexing failed — see logs",
        done: 0,
        total: 0,
      });
    }
    this.state = { state: "idle", activeSignals: [] };
    this.emitState();
    return this.state;
  }

  /** segment -> represent, gated on configured providers, with progress. */
  private async index(sessionId: string): Promise<void> {
    const prov = await this.buildProviders();
    const hasAudio = this.store
      .getBlobsBySession(sessionId)
      .some((b) => b.media === "mic" || b.media === "desktop_audio");

    type Stage = { name: string; run: () => Promise<unknown> };
    const stages: Stage[] = [
      { name: "Segmenting", run: () => new Segmenter(this.store).segment(sessionId) },
      {
        name: "Digest + behavior",
        run: () =>
          new Representer(this.store, {
            digestEmbedder: prov.textEmbedder,
            behavior: prov.behavior,
          }).represent(sessionId),
      },
    ];

    if (prov.imageEmbedder) {
      stages.push({
        name: "Frame embeddings",
        run: () =>
          new FrameRepresenter(this.store, {
            imageEmbedder: prov.imageEmbedder!,
            blobStore: this.blobs,
          }).represent(sessionId),
      });
    }
    if (prov.patchEmbedder) {
      // The multivector path replaces BOTH the frame and region image stages:
      // patches are the regions. It is also by far the slowest stage (seconds
      // per frame), so it reports per-frame progress.
      stages.push({
        name: "Frame patches",
        run: () =>
          new FramePatchRepresenter(this.store, {
            patchEmbedder: prov.patchEmbedder!,
            blobStore: this.blobs,
            onProgress: (done, total) =>
              this.emitIndexing({ stage: `Frame patches ${done}/${total}`, done, total }),
          }).represent(sessionId),
      });
    }
    if (prov.captioner) {
      stages.push({
        name: "Captions",
        run: () =>
          new CaptionRepresenter(this.store, {
            captioner: prov.captioner!,
            captionEmbedder: prov.textEmbedder,
            blobStore: this.blobs,
          }).represent(sessionId),
      });
    }
    if (prov.imageEmbedder) {
      stages.push({
        name: "Regions",
        run: async () => {
          const cropper = await this.loadCropper();
          if (!cropper) return;
          return new RegionRepresenter(this.store, {
            imageEmbedder: prov.imageEmbedder!,
            blobStore: this.blobs,
            cropper,
            axProvider: new StoredAxProvider(this.store).provide,
          }).represent(sessionId);
        },
      });
    }
    if (hasAudio && this.settings.view().providers.whisper.modelPath) {
      stages.push({
        name: "Transcribing",
        run: () =>
          new TranscriptRepresenter(this.store, {
            transcriber: prov.transcriber,
            transcriptEmbedder: prov.textEmbedder,
            blobStore: this.blobs,
          }).represent(sessionId),
      });
    }

    const total = stages.length;
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i]!;
      this.emitIndexing({ stage: s.name, done: i, total });
      await s.run();
    }
    this.emitIndexing({ stage: "Done", done: total, total });
  }

  private async loadCropper(): Promise<import("deskrag").RegionCropper | null> {
    try {
      const mod = (await import(
        /* @vite-ignore */ "deskrag/represent/regions/sharp-cropper"
      )) as { SharpRegionCropper: new () => import("deskrag").RegionCropper };
      return new mod.SharpRegionCropper();
    } catch (err) {
      console.error("[deskrag] sharp cropper unavailable:", err);
      return null;
    }
  }

  // --- search ---------------------------------------------------------------

  private buildRetriever(prov: Providers): Retriever {
    // Only query text spaces that actually exist — searchSegments throws on an
    // unregistered namespace, and caption/transcript are absent by default.
    const registered = new Set(this.store.listVectorSpaces().map((s) => s.namespace));
    const searchers: ViewSearcher[] = [];
    for (const view of ["digest", "caption", "transcript"] as const) {
      const s = new TextViewSearcher(prov.textEmbedder, view);
      if (registered.has(s.namespace)) searchers.push(s);
    }
    // Behavior searcher is always safe: it returns null (and is skipped) unless
    // the query carries a behavior vector, so it never hits a missing table.
    searchers.push(new BehaviorViewSearcher(prov.behavior));
    // Exactly one visual path, or neither — Retriever rejects both at once.
    return new Retriever(this.store, {
      searchers,
      ...(prov.patchEmbedder
        ? { patchEmbedder: prov.patchEmbedder }
        : prov.imageEmbedder
          ? { imageEmbedder: prov.imageEmbedder }
          : {}),
      ...(prov.reranker ? { reranker: prov.reranker } : {}),
    });
  }

  async search(input: SearchInput): Promise<SearchResultDTO> {
    const prov = await this.buildProviders();
    if (input.imageBytes) {
      if (!prov.imageEmbedder && !prov.patchEmbedder) {
        throw new Error("Image search requires a configured image provider (Settings).");
      }
      // Each visual path indexes a different view, so check the one in use.
      const wantView = prov.patchEmbedder ? "frame_patches" : "frame_image";
      if (!this.store.listVectorSpaces().some((s) => s.view === wantView)) {
        throw new Error(
          "No image-indexed frames yet. Record a session with an image provider set, then try again.",
        );
      }
    }
    // Namespaces diverge by design and there is no migration path, so prior
    // recordings can sit in a space the CURRENT provider never queries. Detect
    // that before searching, or an empty result over a full library is
    // indistinguishable from "nothing matched".
    const registered = new Set(this.store.listVectorSpaces().map((s) => s.namespace));
    const hasCurrentTextSpace = (["digest", "caption", "transcript"] as const).some((view) =>
      registered.has(new TextViewSearcher(prov.textEmbedder, view).namespace),
    );
    const hasAnyTextSpace = this.store
      .listVectorSpaces()
      .some((s) => s.view === "digest" || s.view === "caption" || s.view === "transcript");

    const retriever = this.buildRetriever(prov);
    const { frames } = await retriever.retrieve({
      ...(input.text ? { text: input.text } : {}),
      ...(input.imageBytes ? { image: input.imageBytes } : {}),
    });

    this.lastHighlights.clear();
    const hits = frames.map((fr) => {
      const frame = fr.frame ?? this.store.getFrame(fr.frameId);
      const session = frame ? this.store.getSession(frame.sessionId) : undefined;
      const seg = fr.segmentId ? this.store.getSegment(fr.segmentId) : undefined;
      const highlights: HighlightDTO[] = fr.highlights.map((h) => ({
        regionId: h.regionId,
        bbox: h.bbox,
        role: h.role,
        label: h.label,
        matchedBy: h.matchedBy,
      }));
      this.lastHighlights.set(fr.frameId, highlights);
      return {
        frameId: fr.frameId,
        score: fr.score,
        tMono: frame?.tMono ?? 0,
        wallClock: session && frame ? session.startedAt + frame.tMono : 0,
        width: frame?.width ?? 0,
        height: frame?.height ?? 0,
        segmentDigest: seg?.digest ?? null,
        thumbUrl: frame?.blobId ? `deskrag://frame/${frame.blobId}` : null,
        highlightCount: highlights.length,
      };
    });

    return {
      frames: hits,
      // Only meaningful when the miss is total: some vectors exist, just not in
      // a space this provider can read.
      ...(hits.length === 0 && hasAnyTextSpace && !hasCurrentTextSpace
        ? { indexedUnderDifferentProvider: true }
        : {}),
    };
  }

  detail(frameId: string): ResultDetailDTO | null {
    const frame = this.store.getFrame(frameId);
    if (!frame) return null;
    const session = this.store.getSession(frame.sessionId);
    const segs = frame.segmentIds
      .map((id) => this.store.getSegment(id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      // Most specific (shortest) segment is the best label context.
      .sort((a, b) => a.tMonoEnd - a.tMonoStart - (b.tMonoEnd - b.tMonoStart));
    const seg = segs[0];
    const ax = this.store.getFrameAx(frameId).map((e) => ({
      role: e.role,
      ...(e.label !== undefined ? { label: e.label } : {}),
      x: e.x,
      y: e.y,
      w: e.w,
      h: e.h,
      ...(e.focused !== undefined ? { focused: e.focused } : {}),
    }));
    return {
      frameId,
      imageUrl: frame.blobId ? `deskrag://frame/${frame.blobId}` : null,
      width: frame.width,
      height: frame.height,
      tMono: frame.tMono,
      wallClock: session ? session.startedAt + frame.tMono : 0,
      session: { id: frame.sessionId, startedAt: session?.startedAt ?? 0 },
      segment: seg
        ? {
            id: seg.id,
            granularity: seg.granularity,
            digest: seg.digest,
            caption: seg.caption,
            transcript: seg.transcript,
          }
        : null,
      ax,
      highlights: this.lastHighlights.get(frameId) ?? [],
    };
  }

  listSessions(): SessionSummaryDTO[] {
    return this.store.listSessions().map((s) => {
      const firstKeyframe = this.store.getFramesBySession(s.id).find((f) => f.blobId);
      return {
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.endedAt ? Math.max(0, s.endedAt - s.startedAt) : 0,
        frameCount: s.frameCount,
        segmentCount: s.segmentCount,
        eventCount: s.eventCount,
        sizeBytes: s.byteLength,
        hasVideo: s.videoBlobId !== null,
        posterUrl: firstKeyframe?.blobId ? `deskrag://frame/${firstKeyframe.blobId}` : null,
      };
    });
  }

  sessionDetail(sessionId: string): SessionDetailDTO | null {
    const s = this.store.listSessions().find((row) => row.id === sessionId);
    if (!s) return null;

    const videoBlob = s.videoBlobId ? this.store.getBlob(s.videoBlobId) : undefined;
    const video: SessionVideoDTO | null = videoBlob
      ? {
          blobId: videoBlob.id,
          url: `deskrag://media/${videoBlob.id}`,
          tMonoStart: videoBlob.tMonoStart,
          tMonoEnd: videoBlob.tMonoEnd,
          sizeBytes: videoBlob.byteLength,
        }
      : null;

    // Frames come back ordered by t_mono, so markers are already in timeline order.
    const keyframes: KeyframeMarkerDTO[] = this.store.getFramesBySession(sessionId).map((f) => {
      // Most specific (shortest) segment is the best label, as in detail().
      const seg = f.segmentIds
        .map((segId) => this.store.getSegment(segId))
        .filter((x): x is NonNullable<typeof x> => Boolean(x))
        .sort((a, b) => a.tMonoEnd - a.tMonoStart - (b.tMonoEnd - b.tMonoStart))[0];
      return {
        frameId: f.id,
        tMono: f.tMono,
        offsetSec: video ? Math.max(0, (f.tMono - video.tMonoStart) / 1000) : f.tMono / 1000,
        thumbUrl: f.blobId ? `deskrag://frame/${f.blobId}` : null,
        segmentDigest: seg?.digest ?? null,
      };
    });

    return {
      id: s.id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: s.endedAt ? Math.max(0, s.endedAt - s.startedAt) : 0,
      video,
      keyframes,
      frameCount: s.frameCount,
      segmentCount: s.segmentCount,
      eventCount: s.eventCount,
      sizeBytes: s.byteLength,
    };
  }

  async removeSession(sessionId: string): Promise<void> {
    if (this.state.state !== "idle" && this.state.sessionId === sessionId) {
      throw new Error("That recording is still in progress — stop it before deleting.");
    }
    // Rows first: a row pointing at a deleted file is a broken read, whereas a
    // file with no row is just reclaimable disk.
    await this.store.deleteSession(sessionId);
    await this.blobs.removeSession(sessionId);
    this.lastHighlights.clear();
  }

  // --- blobs (served over the deskrag:// protocol) --------------------------

  getBlobRow(blobId: string): BlobRow | undefined {
    return this.store.getBlob(blobId);
  }
  async readBlob(blob: BlobRow): Promise<Uint8Array> {
    return this.blobs.read(blob);
  }
}
