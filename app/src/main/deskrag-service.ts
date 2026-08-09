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
import { screen } from "electron";
import {
  DualStore,
  BlobStore,
  OllamaTextEmbedding,
  BehaviorFeatureExtractor,
  CaptureSession,
  FfmpegScreenProducer,
  FfmpegAudioProducer,
  SwiftAxSource,
  SwiftDeviceClockSource,
  SwiftDisplaySource,
  SwiftKeymapSource,
  KeymapProducer,
  Segmenter,
  Representer,
  associateFrames,
  associateFrameAx,
  indexSegmentText,
  LexicalSegmentSearcher,
  FrameRepresenter,
  CaptionRepresenter,
  AppCaptionRepresenter,
  ComposeRepresenter,
  OllamaSummaryProvider,
  RegionRepresenter,
  TranscriptRepresenter,
  StoredAxProvider,
  WhisperCppTranscription,
  Retriever,
  TextViewSearcher,
  BehaviorViewSearcher,
  FramePatchRepresenter,
  OllamaCaptionProvider,
  nestAxElements,
  wavPeaks,
  type Producer,
  type EmbeddingProvider,
  type ImageEmbeddingProvider,
  type MultiVectorProvider,
  type CaptionProvider as LibCaptionProvider,
  type SummaryProvider as LibSummaryProvider,
  type BlobRow,
  type Reranker,
  type ViewSearcher,
  type Graph,
} from "deskrag";
import type { SettingsStore } from "./settings.js";
import { MODELS } from "./models.js";
import { libUrl } from "./lib-resolve.js";
import { DEFAULT_GRAPH_ID, indexTrace, rebuildGraph } from "./trace-index.js";
import { digestContextFor } from "./digest-context.js";
import { frequentRoutes, toGraphDTO } from "./graph-view.js";
import {
  ModelFilesMissingError,
  ModelStore,
  type ModelDownloadProgress,
} from "./model-store.js";
import { OnnxHost } from "./onnx-host.js";
import { spawnOnnxWorker } from "./onnx-spawn.js";
import { TRACK_BUCKETS } from "@shared/types";
import type {
  Capabilities,
  FlowsDTO,
  HighlightDTO,
  IndexingProgress,
  ReindexResultDTO,
  KeyframeMarkerDTO,
  ProviderSettingsView,
  RecordingStatus,
  ResultDetailDTO,
  SearchInput,
  SearchResultDTO,
  SessionDetailDTO,
  SessionSummaryDTO,
  SessionTracksDTO,
  SessionVideoDTO,
  SignalKind,
} from "@shared/types";
import { request as requestPermission } from "./permissions.js";
import { resolveWhisperBinary, whisperAvailable } from "./whisper.js";
import {
  buildSessionTracks,
  laneOriginOf,
  laneSec,
  levelIndex,
  type AudioLaneInput,
} from "./session-tracks.js";
import { peakCountFor, type AudioBlobPeaks } from "./track-buckets.js";

interface Providers {
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
 * Capabilities as a pure function so it is testable without Electron.
 *
 * Semantics are *configured intent*, not live reachability: this reports
 * "ColSmol is selected", never "ColSmol loaded". Every provider is local and
 * needs no credential, so selecting one is the whole of the condition.
 */
export function capabilitiesFor(p: ProviderSettingsView): Capabilities {
  return {
    imageSearch: p.imageProvider !== "none",
    caption: p.captionProvider !== "none",
    appCaption: p.captionProvider !== "none",
    rerank: p.rerankProvider !== "none",
    // No transcript member, deliberately — see Capabilities in shared/types.ts.
  };
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

/** "downloading model 23/57MB" — MB because a byte count means nothing here. */
export function downloadLabel(p: ModelDownloadProgress): string {
  const mb = (n: number): string => (n / 1_000_000).toFixed(0);
  return p.totalBytes > 0
    ? `downloading model ${mb(p.receivedBytes)}/${mb(p.totalBytes)}MB`
    : `downloading model ${mb(p.receivedBytes)}MB`;
}

export class DeskRagService {
  private store!: DualStore;
  private blobs!: BlobStore;
  private readonly settings: SettingsStore;
  private readonly dir: string;

  private session: CaptureSession | undefined;
  private state: RecordingStatus = { state: "idle", activeSignals: [] };

  private models!: ModelStore;
  /**
   * ONNX inference runs OUT OF PROCESS. One ColSmol frame peaks at 3-5GB, which
   * aborts the main process via V8's OOM handler when it lands next to
   * Chromium, LanceDB and libvips. See onnx-host.ts.
   */
  private onnx!: OnnxHost;
  /** The indexing stage currently running, so a weight download can label itself. */
  private downloading: IndexingProgress | undefined;
  private stateListeners = new Set<(s: RecordingStatus) => void>();
  private indexingListeners = new Set<(p: IndexingProgress) => void>();
  private modelListeners = new Set<(p: ModelDownloadProgress) => void>();
  /** Region highlights from the most recent search, for detail() to reuse. */
  private lastHighlights = new Map<string, HighlightDTO[]>();
  /**
   * Timeline rails, keyed by session id. A FINISHED session is immutable, so
   * this is correct by construction — see the guard in `sessionTracks`.
   */
  private readonly trackCache = new Map<string, SessionTracksDTO>();

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
        // Settings renders this channel directly, but indexing has its own
        // screen and its own progress bar — so while a stage is running, fold
        // the download into that stage's label rather than leaving it silent.
        const at = this.downloading;
        if (at && !p.done) {
          this.emitIndexing({ ...at, stage: `${at.stage} — ${downloadLabel(p)}` });
        }
      },
    });
    // 60s idle: back-to-back searches reuse a warm worker (a session costs
    // hundreds of ms to build), but the weights do not sit resident forever.
    this.onnx = new OnnxHost({ spawn: spawnOnnxWorker, idleMs: 60_000 });
  }

  close(): void {
    this.onnx?.shutdown();
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
        session: this.onnx.session(join(dir, "model_int8.onnx")),
      });
    }

    // --- visual path (exactly one, or neither) --------------------------------
    let imageEmbedder: ImageEmbeddingProvider | null = null;
    let patchEmbedder: MultiVectorProvider | null = null;
    if (p.imageProvider === "nomic") {
      const mod = await this.loadOnnx<typeof import("deskrag/embed/onnx/image")>(
        "deskrag/embed/onnx/image",
      );
      if (!mod) {
        throw new Error("Local image search is unavailable: onnxruntime-node failed to load.");
      }
      const dir = await this.models.ensure(MODELS.vision);
      imageEmbedder = new mod.OnnxImageEmbedding({
        modelPath: join(dir, "model_int8.onnx"),
        // Read input size + normalization from the model's own config rather
        // than assuming it, as the ColSmol branch does for tiling.
        preprocessorPath: join(dir, "preprocessor_config.json"),
        session: this.onnx.session(join(dir, "model_int8.onnx")),
      });
    } else if (p.imageProvider === "colsmol") {
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
        session: this.onnx.session(join(dir, "model.onnx")),
        // Read tiling from the model's own config rather than assuming it.
        tileConfig: await mod.readTileConfig(
          join(dir, "preprocessor_config.json"),
          join(dir, "config.json"),
        ),
      });
    }

    // --- captioner ------------------------------------------------------------
    let captioner: LibCaptionProvider | null = null;
    if (p.captionProvider === "ollama") {
      captioner = new OllamaCaptionProvider({
        host: p.ollamaHost,
        model: p.ollamaCaptionModel,
      });
    }

    // --- summarizer (composes and NAMES levels; absence costs prose, not shape)
    let summarizer: LibSummaryProvider | null = null;
    if (p.summaryProvider === "ollama") {
      summarizer = new OllamaSummaryProvider({
        host: p.ollamaHost,
        model: p.ollamaSummaryModel,
      });
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
            session: this.onnx.session(join(dir, "model_int8.onnx")),
          });
        } catch (err) {
          console.error("[deskrag] local reranker unavailable:", err);
        }
      }
    }

    return {
      textEmbedder,
      behavior,
      imageEmbedder,
      patchEmbedder,
      captioner,
      summarizer,
      reranker,
    };
  }

  /**
   * Built separately from the other providers, and only for the transcribe
   * stage: resolving the model may DOWNLOAD it, and buildProviders() also runs
   * on the search path, where a 57MB fetch would be a surprise.
   *
   * An explicit modelPath wins; otherwise the managed GGML file is ensured on
   * disk. `.en` models reject a language other than English, so the managed one
   * is pinned to "en" while a user-supplied (possibly multilingual) model keeps
   * whisper's auto-detect.
   */
  private async buildTranscriber(): Promise<WhisperCppTranscription> {
    const w = this.settings.view().providers.whisper;
    const binaryPath = resolveWhisperBinary(w.binaryPath);
    if (w.modelPath) {
      return new WhisperCppTranscription({
        binaryPath,
        modelPath: w.modelPath,
      });
    }
    const dir = await this.models.ensure(MODELS.whisper);
    return new WhisperCppTranscription({
      binaryPath,
      modelPath: join(dir, MODELS.whisper.files[0]!.path),
      language: "en",
    });
  }

  /**
   * Lazy import for modules that load native code. Returns null on failure so the
   * caller decides: refinements degrade, embedders throw.
   */
  private async loadOnnx<T>(path: string): Promise<T | null> {
    try {
      return (await import(/* @vite-ignore */ libUrl(path))) as T;
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
      // REQUIRED, and unlike axSource it is not gated on a setting: frames and
      // audio are timed by converting capture-device timestamps through this,
      // so without it a recording could only stamp arrival times — a whole
      // capture latency (~3s) away from the events beside them. `start()`
      // refuses if the sidecar cannot be read, which is why it ships in the
      // packaged bundle.
      deviceClockSource: new SwiftDeviceClockSource(),
      ...(axSource ? { axSource } : {}),
    });

    if (sig.screen.enabled) {
      // Frame space is SCREEN POINTS, not ffmpeg's pixel resolution (2x on
      // Retina) and not the downscaled JPEG's size — it has to match the space AX
      // bboxes and uiohook mouse points arrive in, which is what Electron's
      // display size reports. Omitting it leaves every frame row at 0x0, which
      // silently disables AX/grid/hotspot region proposal and all highlights.
      const display = screen.getPrimaryDisplay().size;
      session.addProducer(
        new FfmpegScreenProducer({
          fps: sig.screen.fps,
          imageMaxWidth: sig.screen.imageMaxWidth,
          storeImages: true,
          width: display.width,
          height: display.height,
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
        // Keystrokes are stored as raw keycodes; characters are resolved at lift
        // time against the layout in force. Without this producer there is no
        // layout, so every text gesture is dropped and no slot is ever filled.
        session.addProducer(new KeymapProducer(new SwiftKeymapSource()));
      }
    }
    if (sig.activeWin.enabled) {
      // The window producer owns display topology too: the re-query signal is a
      // focused window lying outside every known display, and it is the only
      // producer that sees bounds.
      const p = await this.loadNativeProducer(
        "deskrag/capture/producers/active-window",
        "ActiveWindowProducer",
        { displaySource: new SwiftDisplaySource() },
      );
      if (p) {
        session.addProducer(p);
        active.push("active-win");
      }
    }
    if (sig.audio.enabled) {
      // Prompt HERE, not only from the Settings screen: ffmpeg reads the mic in a
      // child process, and an ungranted device fails with a bare avfoundation
      // "Input/output error" that looks like a broken build. Requesting first
      // means the user sees the system dialog at the moment it makes sense, and a
      // refusal drops the signal instead of pretending it is recording.
      const mic = await requestPermission("microphone");
      if (mic.state === "granted" || mic.state === "unknown") {
        session.addProducer(
          new FfmpegAudioProducer({
            device: sig.audio.device,
            chunkSeconds: sig.audio.chunkSeconds,
            media: "mic",
            onError: (m) => console.error(`[deskrag] audio: ${m}`),
          }),
        );
        active.push("audio");
      } else {
        console.error(`[deskrag] microphone ${mic.state}: recording without audio`);
      }
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
    opts?: unknown,
  ): Promise<Producer | null> {
    try {
      const mod = (await import(/* @vite-ignore */ libUrl(modulePath))) as Record<
        string,
        new (opts?: unknown) => Producer
      >;
      const Ctor = mod[exportName];
      return Ctor ? new Ctor(opts) : null;
    } catch (err) {
      console.error(`[deskrag] native producer ${exportName} unavailable:`, err);
      return null;
    }
  }

  async stopRecording(): Promise<RecordingStatus> {
    if (this.state.state !== "recording" || !this.session) return this.state;
    const sessionId = this.state.sessionId!;
    const session = this.session;
    // Claim the transition SYNCHRONOUSLY, before the first await: a second
    // concurrent call racing in behind this one must see state !== "recording"
    // immediately, or it passes the guard above too and calls index() twice —
    // measured on a real recording as 28 segment rows (14 duplicated) from one
    // session, because Segmenter.segment() has no dedup and just re-inserts.
    this.session = undefined;
    this.state = { state: "indexing", sessionId, activeSignals: this.state.activeSignals };
    this.emitState();

    await session.stop();

    try {
      await this.index(sessionId);
    } catch (err) {
      console.error("[deskrag] indexing failed:", err);
      this.emitIndexing({ stage: "Indexing failed — see logs", done: 0, total: 0 });
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
      // ALWAYS on, and it has to be: text-only retrieval recalls frames purely
      // by segment membership, so without these links a default install (no
      // image provider) returns nothing for every query. It used to happen only
      // inside the image stages, which are gated on a provider that defaults to
      // "none" — measured on a real store, 2 of 4 recordings had zero links.
      // Pure SQLite over what Segmenting just wrote; no model involved.
      { name: "Linking frames", run: () => associateFrames(this.store, sessionId) },
      // AX walks post-date the pixels they describe by the capture latency, so
      // the frame that TRIGGERED a walk is not the frame it shows. Capture
      // writes no frame_id and this assigns one by content time. It MUST run
      // before Regions, which reads it through StoredAxProvider.
      { name: "Linking AX", run: () => associateFrameAx(this.store, sessionId) },
      // Regions run BEFORE the digest, and under every image configuration
      // including none. Proposal is geometry + the AX tree; only the crops need
      // a model. Two things downstream read what this writes: the digest names
      // what was clicked from these labels, and `Anchor.visual` in the trace
      // graph is built from these rows — gating the whole stage on
      // `imageEmbedder` once meant the late-interaction (patch) path wrote no
      // region rows at all and silently cost the executor its middle anchor rung.
      {
        name: prov.imageEmbedder ? "Regions" : "Regions (proposal only)",
        run: async () => {
          const cropper = prov.imageEmbedder ? await this.loadCropper() : undefined;
          return new RegionRepresenter(this.store, {
            // Without a cropper there is nothing to embed, so drop back to
            // proposal rather than skipping the stage.
            ...(prov.imageEmbedder && cropper
              ? { imageEmbedder: prov.imageEmbedder, blobStore: this.blobs, cropper }
              : {}),
            axProvider: new StoredAxProvider(this.store).provide,
          }).represent(sessionId);
        },
      },
      {
        name: "Digest + behavior",
        run: () =>
          new Representer(this.store, {
            digestEmbedder: prov.textEmbedder,
            behavior: prov.behavior,
            // Typed text and clicked labels — resolved against the session's own
            // keymap and the regions the stage above just wrote. Absent either,
            // the digest degrades to tallies rather than guessing.
            digestContext: digestContextFor(this.store, sessionId),
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
      stages.push({
        name: "App captions",
        // Needs a cropper too (sharp), unlike the whole-frame caption stage —
        // skip entirely rather than write nothing useful when it's unavailable.
        run: async () => {
          const cropper = await this.loadCropper();
          if (!cropper) return;
          await new AppCaptionRepresenter(this.store, {
            captioner: prov.captioner!,
            captionEmbedder: prov.textEmbedder,
            blobStore: this.blobs,
            cropper,
          }).represent(sessionId);
        },
      });
    }
    // Probed, not "configured": the model downloads itself, so the only thing
    // that can still be missing is the whisper.cpp binary — and skipping here is
    // what keeps a machine without it from fetching 57MB it cannot use.
    if (hasAudio && whisperAvailable(this.settings.view().providers.whisper.binaryPath)) {
      const at = stages.length; // this stage's own index, for the failure report
      stages.push({
        name: "Transcribing",
        // The ONLY stage that is allowed to fail without failing the run, and it
        // has to be: transcription is on by default now, so a download, a
        // checksum, or a binary that vanished between the probe and here would
        // otherwise abort indexing — and Trace, which runs AFTER this, would be
        // lost with it. A session with no transcript is still a session; a
        // session with no trace graph is a session the executor cannot use.
        run: async () => {
          try {
            await new TranscriptRepresenter(this.store, {
              transcriber: await this.buildTranscriber(),
              transcriptEmbedder: prov.textEmbedder,
              blobStore: this.blobs,
            }).represent(sessionId);
          } catch (err) {
            console.error("[deskrag] transcription failed:", err);
            this.emitIndexing({
              stage: `Transcribing skipped — ${transcribeFailure(err)}`,
              done: at,
              total: stages.length,
            });
          }
        },
      });
    }

    // Compose the hierarchy: actions -> tasks -> processes -> one root whose
    // summary is the session's purpose. AFTER Digest/Captions/Transcribing,
    // because it reads their text; BEFORE "Search index", so summaries reach the
    // lexical lane. Always on — the structural path needs no provider, and
    // composing can never fail the run.
    stages.push({
      name: "Composing",
      run: async () => {
        const r = await new ComposeRepresenter(this.store, {
          ...(prov.summarizer ? { summarizer: prov.summarizer } : {}),
          summaryEmbedder: prov.textEmbedder,
        }).represent(sessionId);
        if (r.nodes === 0) return;
        // Say WHICH path produced the tree: a structurally-composed hierarchy
        // must not read as a summarized one.
        const how = r.llmNodes === 0 ? "structural" : `${r.llmNodes} summarized`;
        return { stage: `Composing — ${r.levels} levels, ${r.nodes} nodes (${how})` };
      },
    });

    // After every text-writing stage, because it reads what they wrote: digest,
    // caption, app_caption, transcript and the composed summaries are produced
    // by five stages under five different provider configurations, and one
    // reader at the end sees whatever actually landed. Needs no provider, so it
    // always runs — on a default install this lane is the only route from a
    // query to an exact term.
    stages.push({
      name: "Search index",
      run: async () => indexSegmentText(this.store, sessionId),
    });

    // Last: the trace graph. It runs after Regions because `regionsAt` reads what
    // that stage wrote, and after Segmenting because boundaries define the nodes.
    stages.push({
      name: "Trace",
      run: async () => {
        const r = await indexTrace(this.store, sessionId);
        if (r === undefined) return;
        // The stage name is the only surface a trace has until the executor
        // exists, so it carries the counts rather than a bare "Trace". The
        // missing-keymap case is the one a user has to be told about: it means
        // every keystroke was discarded, and nothing else would say so.
        const summary = r.missingKeymap
          ? `Trace — ${r.actions} actions (no keyboard layout: typed text not captured)`
          : `Trace — ${r.actions} actions, graph ${r.nodes}/${r.edges}` +
            (r.variables > 0 ? `, ${r.variables} variables` : "");
        // Trace is always the last stage, so its index is stages.length - 1.
        // (`total` below is declared after this closure; referencing it here
        // would work only by virtue of when the closure runs.)
        this.emitIndexing({ stage: summary, done: stages.length - 1, total: stages.length });
        if (r.missingKeymap) {
          console.warn(
            "[deskrag] no keymap captured for this session — typed text was not lifted",
          );
        }
      },
    });

    const total = stages.length;
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i]!;
      // Named so a weight download that starts INSIDE this stage can rewrite the
      // label. Whisper's model is fetched lazily by Transcribing, and 57MB of
      // silence is indistinguishable from a hung stage.
      this.downloading = { stage: s.name, done: i, total };
      this.emitIndexing({ stage: s.name, done: i, total });
      try {
        await s.run();
      } finally {
        this.downloading = undefined;
      }
    }
    this.emitIndexing({ stage: "Done", done: total, total });
  }

  private async loadCropper(): Promise<import("deskrag").RegionCropper | null> {
    try {
      const mod = (await import(
        /* @vite-ignore */ libUrl("deskrag/represent/regions/sharp-cropper")
      )) as { SharpRegionCropper: new () => import("deskrag").RegionCropper };
      return new mod.SharpRegionCropper();
    } catch (err) {
      console.error("[deskrag] sharp cropper unavailable:", err);
      return null;
    }
  }

  // --- search ---------------------------------------------------------------

  /**
   * Walk UP from a segment to the nearest composed parent and take its summary.
   *
   * NEAREST, not the root: the root's summary is the whole session's purpose,
   * which is true of every hit in that recording and therefore tells a reader
   * nothing about this one. Null all the way up is the honest answer for a
   * recording indexed before composing existed.
   */
  private taskSummaryFor(segmentId: string | null): string | null {
    if (segmentId === null) return null;
    let cur = this.store.getSegmentParent(segmentId);
    const seen = new Set<string>([segmentId]);
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const summary = this.store.getSegmentSummary(cur);
      if (summary !== undefined) return summary.text;
      cur = this.store.getSegmentParent(cur);
    }
    return null;
  }

  private buildRetriever(prov: Providers): Retriever {
    // Only query text spaces that actually exist — searchSegments throws on an
    // unregistered namespace, and caption/transcript are absent by default.
    const registered = new Set(this.store.listVectorSpaces().map((s) => s.namespace));
    const searchers: ViewSearcher[] = [];
    // `summary` is the composed levels — a task or a process answering at its
    // own altitude, rather than a 900ms action standing in for one.
    for (const view of ["digest", "summary", "caption", "app_caption", "transcript"] as const) {
      const s = new TextViewSearcher(prov.textEmbedder, view);
      if (registered.has(s.namespace)) searchers.push(s);
    }
    // Behavior searcher is always safe: it returns null (and is skipped) unless
    // the query carries a behavior vector, so it never hits a missing table.
    searchers.push(new BehaviorViewSearcher(prov.behavior));
    // Exactly one visual path, or neither — Retriever rejects both at once.
    return new Retriever(this.store, {
      searchers,
      // Unconditional: FTS needs no provider and no vector space, so unlike
      // every searcher above it can never be missing. It is also the only way a
      // default install reaches an exact literal — a filename, an error string,
      // a URL — which is where the dense views are weakest.
      lexical: new LexicalSegmentSearcher(this.store),
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
    const hasCurrentTextSpace = (["digest", "caption", "app_caption", "transcript"] as const).some(
      (view) => registered.has(new TextViewSearcher(prov.textEmbedder, view).namespace),
    );
    const hasAnyTextSpace = this.store
      .listVectorSpaces()
      .some(
        (s) =>
          s.view === "digest" ||
          s.view === "caption" ||
          s.view === "app_caption" ||
          s.view === "transcript",
      );

    const retriever = this.buildRetriever(prov);
    const { frames, segments } = await retriever.retrieve({
      ...(input.text ? { text: input.text } : {}),
      ...(input.imageBytes ? { image: input.imageBytes } : {}),
    });

    this.lastHighlights.clear();
    // Hits span sessions, and each session's lane origin is its video's first
    // frame. One list pass and one blob read per DISTINCT session, memoized —
    // resolving per hit would rescan the session list for every result.
    const laneOrigins = new Map<string, number>();
    const originFor = (sessionId: string): number => {
      const cached = laneOrigins.get(sessionId);
      if (cached !== undefined) return cached;
      const origin = this.laneOriginFor(sessionId);
      laneOrigins.set(sessionId, origin);
      return origin;
    };
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
        sessionId: frame?.sessionId ?? "",
        tMono: frame?.tMono ?? 0,
        // No frame row means no recording to open — the hit degrades to the
        // same zeroed shape the other fields already take, and the renderer
        // withholds the jump rather than offering one that goes nowhere.
        offsetSec: frame ? laneSec(frame.tMono, originFor(frame.sessionId)) : 0,
        wallClock: session && frame ? session.startedAt + frame.tMono : 0,
        width: frame?.width ?? 0,
        height: frame?.height ?? 0,
        segmentDigest: seg?.digest ?? null,
        taskSummary: this.taskSummaryFor(seg?.id ?? null),
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
      // Segments matched but carried no frames: an index defect with a specific
      // remedy, not an empty result. Checked after the provider case above,
      // which is the more fundamental explanation when both could apply.
      ...(hits.length === 0 && hasCurrentTextSpace && segments.length > 0
        ? { segmentsMatchedButNoFrames: segments.length }
        : {}),
    };
  }

  /**
   * Where lane offset 0 sits for a session — the store reads behind
   * `laneOriginOf`, which is the rule itself.
   *
   * A session's screen video is written once, when recording stops, so this is
   * stable for anything searchable; it is deliberately not cached all the same,
   * since it is one list scan on a path that already does far more work.
   */
  private laneOriginFor(sessionId: string): number {
    const row = this.store.listSessions().find((s) => s.id === sessionId);
    const blob = row?.videoBlobId ? this.store.getBlob(row.videoBlobId) : undefined;
    return laneOriginOf(blob ?? null);
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
    // nestAxElements is a pass-through for anything the current sidecar captured
    // (it already emits parent links); it only does geometric work for frames
    // recorded before that, so the renderer can always just read parent/depth.
    const ax = nestAxElements(this.store.getFrameAx(frameId)).map((e) => ({
      role: e.role,
      ...(e.label !== undefined ? { label: e.label } : {}),
      x: e.x,
      y: e.y,
      w: e.w,
      h: e.h,
      ...(e.focused !== undefined ? { focused: e.focused } : {}),
      ...(e.parent !== undefined ? { parent: e.parent } : {}),
      ...(e.depth !== undefined ? { depth: e.depth } : {}),
    }));
    return {
      frameId,
      taskSummary: this.taskSummaryFor(seg?.id ?? null),
      imageUrl: frame.blobId ? `deskrag://frame/${frame.blobId}` : null,
      width: frame.width,
      height: frame.height,
      tMono: frame.tMono,
      offsetSec: laneSec(frame.tMono, this.laneOriginFor(frame.sessionId)),
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

    // One read for every segment of the session, rather than a getSegment() per
    // keyframe — a long recording has thousands of frames over a few segments.
    const segById = new Map(this.store.getSegmentsBySession(sessionId).map((seg) => [seg.id, seg]));

    // Frames come back ordered by t_mono, so markers are already in timeline order.
    const keyframes: KeyframeMarkerDTO[] = this.store.getFramesBySession(sessionId).map((f) => {
      // Most specific (shortest) segment is the best label, as in detail().
      const seg = f.segmentIds
        .map((segId) => segById.get(segId))
        .filter((x): x is NonNullable<typeof x> => Boolean(x))
        .sort((a, b) => a.tMonoEnd - a.tMonoStart - (b.tMonoEnd - b.tMonoStart))[0];
      return {
        frameId: f.id,
        tMono: f.tMono,
        offsetSec: laneSec(f.tMono, laneOriginOf(video)),
        thumbUrl: f.blobId ? `deskrag://frame/${f.blobId}` : null,
        segmentCaption: seg?.caption ?? null,
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

  /**
   * Every recorded signal, bucketed onto the session's own time axis.
   *
   * All the arithmetic lives in `session-tracks.ts`, which is pure and
   * root-tested; this method is only the reads and the cache.
   */
  async sessionTracks(sessionId: string): Promise<SessionTracksDTO | null> {
    const cached = this.trackCache.get(sessionId);
    if (cached) return cached;

    const detail = this.sessionDetail(sessionId);
    if (!detail) return null;

    // Offsets are measured from the video when there is one, so the rail and
    // the scrubber share an origin; from t_mono zero otherwise.
    const originMono = laneOriginOf(detail.video);
    const totalSec = detail.video
      ? (detail.video.tMonoEnd - detail.video.tMonoStart) / 1000
      : detail.durationMs / 1000;

    const frames = this.store.getFramesBySession(sessionId);
    const regionCounts = new Map<string, number>();
    for (const f of frames) {
      const n = this.store.getRegionsByFrame(f.id).length;
      if (n > 0) regionCounts.set(f.id, n);
    }

    const byMedia = new Map<string, AudioBlobPeaks[]>();
    for (const blob of this.store.getBlobsBySession(sessionId)) {
      if (blob.media !== "mic" && blob.media !== "desktop_audio") continue;
      let bytes: Uint8Array;
      try {
        bytes = await this.blobs.read(blob);
      } catch {
        // The row says the audio is there and the file is not. That stretch
        // stays uncovered, which is exactly what the rail should show — one
        // missing blob must not sink the whole thing.
        continue;
      }
      const declaredSec = (blob.tMonoEnd - blob.tMonoStart) / 1000;
      const peaks = wavPeaks(bytes, peakCountFor(declaredSec, totalSec, TRACK_BUCKETS));
      if (!peaks) continue;
      const list = byMedia.get(blob.media) ?? [];
      list.push({
        startSec: (blob.tMonoStart - originMono) / 1000,
        // The MEASURED duration, so a truncated blob reads as a gap for its
        // missing tail rather than as a stretched envelope.
        durationSec: peaks.durationSec,
        peaks: peaks.peaks,
      });
      byMedia.set(blob.media, list);
    }
    const audio: AudioLaneInput[] = [...byMedia.entries()].map(([media, blobs]) => ({
      media,
      blobs,
    }));

    const dto = buildSessionTracks({
      sessionId,
      originMono,
      totalSec,
      buckets: TRACK_BUCKETS,
      anchoredToVideo: detail.video !== null,
      // Absence of the row is the marker: a session recorded before the
      // device-clock bridge existed was timed by ARRIVAL, so its lanes sit
      // about a second from the video, and the difference is unrecoverable.
      clockCalibrated: this.store.getSessionClock(sessionId) !== undefined,
      events: this.store.getEventsBySession(sessionId),
      segments: this.store.getSegmentsBySession(sessionId),
      frames,
      axSnapshots: this.store.getAxSnapshotsBySession(sessionId),
      keyframes: detail.keyframes,
      regionCounts,
      audio,
      transcriptClips: this.store.getTranscriptClipsBySession(sessionId),
      // One read for the whole tree: every composed level's label, keyed by
      // segment id. Empty for a session indexed before composing existed, in
      // which case only the `action` lane appears.
      summaries: new Map(
        this.store
          .getSegmentSummariesBySession(sessionId)
          .map((s) => [s.segmentId, { text: s.text, source: s.source }]),
      ),
    });

    // Only a FINISHED session is immutable. Caching an open one would freeze
    // the rail at whatever the recording had reached when it was first opened.
    if (detail.endedAt !== null) this.trackCache.set(sessionId, dto);
    return dto;
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
    this.trackCache.delete(sessionId);
  }

  /**
   * Re-lift every recording into a fresh trace graph.
   *
   * Lifting reads `ax_snapshot` and the event stream, both already on disk, so
   * nothing is re-recorded — this is how a corrected predicate filter or lift
   * rule reaches recordings already taken. Indexing otherwise runs only when a
   * recording stops, which left existing graphs frozen under whatever rules were
   * in force the day they were made.
   *
   * Refused while recording: the session in flight is still writing the events
   * a lift would read, so it would be lifted half-formed and then merged again
   * when it stops.
   */
  /**
   * Re-run the search-side stages over every existing recording.
   *
   * Needed because the searchable text a recording carries is decided by the
   * code that indexed it, and existing installs were indexed by code that wrote
   * a tally-only digest, no lexical index, and — without an image provider — no
   * frame↔segment links at all, which made text search return nothing.
   *
   * Three stages, in the order the indexing path runs them, and DELIBERATELY NOT
   * `Segmenter`: re-segmenting would mint new segment ids and orphan every
   * caption, app_caption and transcript already attached to the old ones.
   * Everything here either rewrites a row in place or replaces a vector by id.
   *
   * Refused while recording, for the same reason a graph rebuild is: the session
   * in flight is still writing the events these stages read.
   */
  async reindexSearch(): Promise<{ sessions: number; segments: number }> {
    if (this.state.state !== "idle") {
      throw new Error("Stop the current recording before re-indexing.");
    }
    const prov = await this.buildProviders();
    const sessions = this.store.listSessions();
    let segments = 0;
    this.emitIndexing({ stage: "Re-indexing search", done: 0, total: sessions.length });
    try {
      for (let i = 0; i < sessions.length; i++) {
        const id = sessions[i]!.id;
        this.emitIndexing({
          stage: `Re-indexing recordings ${i + 1}/${sessions.length}`,
          done: i,
          total: sessions.length,
        });
        await associateFrames(this.store, id);
        await associateFrameAx(this.store, id);
        const r = await new Representer(this.store, {
          digestEmbedder: prov.textEmbedder,
          behavior: prov.behavior,
          digestContext: digestContextFor(this.store, id),
        }).represent(id);
        segments += r.segmentCount;
        // Compose BEFORE the lexical index, the same ordering the record path
        // uses: summaries are a segment_fts view, and re-indexing without this
        // would silently drop every one of them. It is also what lets an
        // existing recording gain a hierarchy at all.
        await new ComposeRepresenter(this.store, {
          ...(prov.summarizer ? { summarizer: prov.summarizer } : {}),
          summaryEmbedder: prov.textEmbedder,
        }).represent(id);
        indexSegmentText(this.store, id);
      }
      this.emitIndexing({
        stage:
          sessions.length === 0
            ? "Nothing to re-index — no recordings yet"
            : `Re-indexed ${sessions.length} recording${sessions.length === 1 ? "" : "s"}, ${segments} segments`,
        done: sessions.length,
        total: sessions.length,
      });
      return { sessions: sessions.length, segments };
    } catch (err) {
      this.emitIndexing({
        stage: "Re-index failed — see logs",
        done: 0,
        total: sessions.length,
      });
      throw err;
    }
  }

  async reindexTraces(): Promise<ReindexResultDTO> {
    if (this.state.state !== "idle") {
      throw new Error("Stop the current recording before rebuilding the graph.");
    }
    // The existing indexing channel, so the renderer's progress surface covers
    // this with no second mechanism.
    this.emitIndexing({ stage: "Rebuilding trace graph", done: 0, total: 1 });
    try {
      const r = await rebuildGraph(this.store, (done, total) => {
        this.emitIndexing({
          stage: `Re-lifting recordings ${Math.min(done + 1, total)}/${total}`,
          done,
          total,
        });
      });
      const summary =
        r.sessions === 0
          ? "Nothing to rebuild — no recording produced any events"
          : `Rebuilt from ${r.sessions} recording${r.sessions === 1 ? "" : "s"} — ` +
            `graph ${r.nodes}/${r.edges}, ${r.actions} actions` +
            (r.variables > 0 ? `, ${r.variables} variables` : "") +
            (r.missingKeymap ? " (a recording had no keyboard layout: typed text not captured)" : "");
      this.emitIndexing({ stage: summary, done: 1, total: 1 });
      return r;
    } catch (err) {
      this.emitIndexing({ stage: "Rebuild failed — see logs", done: 0, total: 1 });
      throw err;
    }
  }

  // --- blobs (served over the deskrag:// protocol) --------------------------

  getBlobRow(blobId: string): BlobRow | undefined {
    return this.store.getBlob(blobId);
  }
  async readBlob(blob: BlobRow): Promise<Uint8Array> {
    return this.blobs.read(blob);
  }

  /** The accreting trace graph every session merges into, or undefined before any. */
  traceGraph(): Graph | undefined {
    return this.store.getGraph(DEFAULT_GRAPH_ID);
  }

  /**
   * The blob holding a frame's bytes. `TraceNode.visual.frameBlobId` is named
   * for a blob but holds a FRAME id (`lift.ts` stores `snap.frameId`), and
   * `deskrag://frame/<id>` resolves against the blob table — so a trace's
   * keyframe has to be looked up rather than used directly.
   */
  frameBlobId(frameId: string): string | undefined {
    return this.store.getFrame(frameId)?.blobId ?? undefined;
  }

  /**
   * The whole Flows screen in one call: the graph, and the routes recorded
   * through it.
   *
   * READ ONLY BY CONSTRUCTION. Nothing here observes or touches the live
   * desktop — the projection is pure and its only inputs are rows already on
   * disk, which is what lets the app run without ever spawning `ax-exec`.
   */
  flows(): FlowsDTO | null {
    const graph = this.traceGraph();
    if (graph === undefined) return null;
    // One pass over the session list, not a lookup per source: a node observed
    // by three recordings would otherwise scan the list three times, and the
    // graph renders every node at once. The same pass carries the lane origin,
    // so a jump from this screen lands on the axis the rail is drawn in.
    const startedAt = new Map<string, number>();
    const origins = new Map<string, number>();
    for (const s of this.store.listSessions()) {
      startedAt.set(s.id, s.startedAt);
      const blob = s.videoBlobId ? this.store.getBlob(s.videoBlobId) : undefined;
      origins.set(s.id, laneOriginOf(blob ?? null));
    }
    return {
      graph: toGraphDTO(graph, {
        resolveFrameBlob: (frameId) => this.frameBlobId(frameId),
        sessionStart: (sessionId) => startedAt.get(sessionId),
        laneOrigin: (sessionId) => origins.get(sessionId) ?? 0,
      }),
      // The only I/O the routes need: which composed levels cover a walk, and
      // by how much. `graph-view.ts` stays a pure projection.
      routes: frequentRoutes(graph, (span) => {
        const summaries = new Map(
          this.store.getSegmentSummariesBySession(span.sessionId).map((s) => [s.segmentId, s]),
        );
        const out = [];
        for (const seg of this.store.getSegmentsBySession(span.sessionId)) {
          const summary = summaries.get(seg.id);
          if (summary === undefined) continue;
          const level = levelIndex(seg.granularity);
          if (level === null || level < 1) continue;
          const coveredMs =
            Math.min(seg.tMonoEnd, span.tMonoEnd) - Math.max(seg.tMonoStart, span.tMonoStart);
          if (coveredMs <= 0) continue;
          out.push({ text: summary.text, level, coveredMs });
        }
        return out;
      }),
    };
  }
}
