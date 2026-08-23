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
import { app, screen } from "electron";
import { ulid } from "ulid";
import {
  DualStore,
  BlobStore,
  BehaviorFeatureExtractor,
  CaptureSession,
  FfmpegScreenProducer,
  FfmpegAudioProducer,
  SystemAudioProducer,
  SwiftAxSource,
  SwiftDeviceClockSource,
  SwiftDisplaySource,
  SwiftKeymapSource,
  KeymapProducer,
  LexicalSegmentSearcher,
  ROOT_GRANULARITY,
  LEAF_GRANULARITY,
  OllamaSummaryProvider,
  WhisperCppTranscription,
  Retriever,
  TextViewSearcher,
  BehaviorViewSearcher,
  OllamaCaptionProvider,
  nestAxElements,
  textProfile,
  wavPeaks,
  type Producer,
  type EmbeddingProvider,
  type MultiVectorProvider,
  type CaptionProvider as LibCaptionProvider,
  type SummaryProvider as LibSummaryProvider,
  type BlobRow,
  type ReflectionProvider,
  type Reranker,
  type ViewSearcher,
  type Graph,
} from "deskrag";
import type { SettingsStore } from "./settings.js";
import { MODELS, TEXT_MODEL_SPECS } from "./models.js";
import { libUrl } from "./lib-resolve.js";
import { DEFAULT_GRAPH_ID, latestAt, rebuildGraph } from "./trace-index.js";
import type { StageFacts, StageId } from "./index-plan.js";
import type { Providers, StageWorld } from "./index-run.js";
import {
  decodePayload,
  decodeStages,
  encodePayload,
  initialStages,
  holdMessage,
  isIndexJobKind,
  jobProgress,
  nextRunnable,
  type IndexJobKind,
} from "./index-queue.js";
import { buildStageGraph } from "./index-graph.js";
import { SignalTally } from "./recording-activity.js";
import { IndexWorker } from "./index-worker.js";
import { frequentRoutes, toGraphDTO } from "./graph-view.js";
import { flowApps } from "./flow-steps.js";
import { droppedEarlyOf, habitFork, habitWays, walkFits } from "./habit-marks.js";
import {
  bindHabit,
  duplicateHabits,
  unclaimedRoutes,
  walkMarks,
  type HabitBindingDoc,
} from "./habit-bind.js";
import {
  INITIAL_VERSION,
  bumpVersion,
  type HabitRevision,
} from "./habit-version.js";
import {
  briefFor,
  mergedBody,
  recordedBlocks,
  renderHabitMarkdown,
  slugify,
  templateBody,
} from "./habit-doc.js";
import { OllamaReflectionProvider, OllamaHabitProseProvider } from "deskrag";
import { ModelStore, type ModelDownloadProgress } from "./model-store.js";
import { OnnxHost } from "./onnx-host.js";
import { spawnOnnxWorker } from "./onnx-spawn.js";
import { TRACK_BUCKETS } from "@shared/types";
import { routeStepSummary, routeWayLengths } from "@shared/route-ways";
import type { IndexJobRow, SegmentRow, SegmentSummaryRow, HabitRow } from "deskrag";
import type {
  Capabilities,
  FlowsDTO,
  HighlightDTO,
  IndexJobDTO,
  IndexQueueDTO,
  IndexTickDTO,
  KeyframeMarkerDTO,
  ProviderSettingsView,
  RecordingStatus,
  RecordingTickDTO,
  ResultDetailDTO,
  SearchInput,
  SearchResultDTO,
  SessionDetailDTO,
  SessionSummaryDTO,
  SessionTracksDTO,
  SessionVideoDTO,
  SignalKind,
  HabitBindingDTO,
  HabitDTO,
  HabitPatch,
  HabitProposalDTO,
  HabitState,
  HabitsDTO,
} from "@shared/types";
import { request as requestPermission } from "./permissions.js";
import { resolveWhisperBinary, whisperAvailable } from "./whisper.js";
import {
  appTimeline,
  appTone,
  buildSessionTracks,
  laneOriginOf,
  laneSec,
  laneTotalSec,
  levelIndex,
  type AudioLaneInput,
} from "./session-tracks.js";
import { peakCountFor, type AudioBlobPeaks } from "./track-buckets.js";


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
  /** In-flight `stopRecording` tail — see `pendingStop`. */
  private stopping: Promise<void> | undefined;
  /** Live per-signal counters for the running capture, and the interval that
   *  publishes them. Both undefined whenever nothing is recording. */
  private tally: SignalTally | undefined;
  private tallyTimer: NodeJS.Timeout | undefined;

  private models!: ModelStore;
  /**
   * ONNX inference runs OUT OF PROCESS. One ColSmol frame peaks at 3-5GB, which
   * aborts the main process via V8's OOM handler when it lands next to
   * Chromium, LanceDB and libvips. See onnx-host.ts.
   */
  private onnx!: OnnxHost;
  /**
   * The indexing queue's drain loop. Constructed in `open()`, because every one
   * of its dependencies is.
   */
  private worker!: IndexWorker;
  /**
   * The stage currently running, so a weight download can label itself.
   *
   * Scoped to the WORKER now. It used to be plain service state that any caller
   * could set, and `search()` builds providers too — so a download started from
   * a search could rewrite the label of a stage it had nothing to do with.
   */
  private runningStage: { jobId: string; stageId: StageId; label: string } | null = null;
  private stateListeners = new Set<(s: RecordingStatus) => void>();
  private queueListeners = new Set<(q: IndexQueueDTO) => void>();
  private tickListeners = new Set<(t: IndexTickDTO) => void>();
  private recordingTickListeners = new Set<(t: RecordingTickDTO) => void>();
  private modelListeners = new Set<(p: ModelDownloadProgress) => void>();
  /**
   * Region highlights from the most recent search, for detail() to reuse.
   *
   * This is RENDERER state: it belongs to the window's current result list. Only
   * `search()` writes it, and `searchDetached()` exists so a second reader — the
   * MCP endpoint — can run a query without wiping the highlights out from under
   * whatever the user has open.
   */
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
    // `store/` prints nothing, so the drop is reported here. Not a warning: it
    // is the expected consequence of a removed provider, and Settings carries
    // the actionable half (`EnvInfo.migratedImageProvider`, "re-index").
    if (this.store.retiredSpacesPurged.length > 0) {
      console.info(
        `[deskrag] dropped ${this.store.retiredSpacesPurged.length} retired vector space(s): ` +
          this.store.retiredSpacesPurged.join(", "),
      );
    }
    this.blobs = new BlobStore(join(this.dir, "blobs"));
    this.models = new ModelStore(join(this.dir, "models"), {
      overrideDir: this.settings.view().providers.localModels.dir,
      onProgress: (p) => {
        for (const cb of this.modelListeners) cb(p);
        // Settings renders this channel directly, but indexing has its own
        // screen — so while a stage is running, fold the download into that
        // stage's detail rather than leaving it silent. 57MB fetched inside
        // Transcribing is otherwise indistinguishable from a hang.
        const at = this.runningStage;
        if (at && !p.done) {
          // Detail, deliberately NOT progress: a download is not the stage's own
          // units. Transcribing's meter counts audio clips, and letting 57MB of
          // weights drive the same bar would make the stage appear to advance
          // through work it has not started.
          this.emitTick({
            jobId: at.jobId,
            stageId: at.stageId,
            detail: downloadLabel(p),
            progress: null,
          });
        }
      },
    });
    // 60s idle: back-to-back searches reuse a warm worker (a session costs
    // hundreds of ms to build), but the weights do not sit resident forever.
    this.onnx = new OnnxHost({ spawn: spawnOnnxWorker, idleMs: 60_000 });

    this.worker = new IndexWorker({
      store: this.store,
      // Read through a closure rather than captured once: capture can start at
      // any point during a drain, and the gate has to see that.
      isRecording: () => this.state.state === "recording",
      buildProviders: () => this.buildProviders(),
      stageWorld: async (sessionId, providers) => this.stageWorld(sessionId, providers),
      setRunningStage: (at) => {
        this.runningStage = at;
      },
      // A finished session is immutable, which is what the rail's memo assumes —
      // and a re-index is the one thing that makes it false. The highlights go
      // for a related reason: they name REGION ids from the last search, and
      // `putRegions` mints fresh ULIDs, so every one of them now points at a row
      // that no longer exists. This used to live inside `reindexAll`; it has to
      // live here now, because a background job can land while the Library is
      // open on the very session it rebuilt.
      onJobSettled: (job) => {
        this.lastHighlights.clear();
        if (job.sessionId) this.trackCache.delete(job.sessionId);
        else this.trackCache.clear();
      },
      emitQueue: () => this.emitQueue(),
      emitTick: (tick) => this.emitTick(tick),
    });

    // Anything left `running` is a job a previous process died inside — nothing
    // else writes that state and then stops. Recover BEFORE the first kick, or
    // the drain would step over it and it would sit there forever.
    await this.worker.recover();
    await this.adoptUnclosedSessions();
    this.worker.kick();
  }

  /**
   * Close and enqueue any recording the last process left open.
   *
   * A session with no `ended_at` at STARTUP cannot be recording — this process
   * has only just begun — so it is one a previous process died inside, between
   * `session.stop()` and the enqueue. Found by driving the app: quitting during
   * that window left a real 6-frame recording on disk with no end stamp and no
   * job, and nothing would ever have looked at it again.
   *
   * This is recovery of a specific, identified failure, NOT general backlog
   * repair: it adopts only sessions whose end stamp is missing, and it never
   * goes looking for recordings that merely lack derived rows.
   *
   * The end time is taken from the last thing actually captured rather than
   * from `Date.now()`, which would claim the recording ran until the app next
   * launched — days, in the case this recovers from.
   */
  private async adoptUnclosedSessions(): Promise<void> {
    const open = this.store.listSessions().filter((s) => s.endedAt === null);
    for (const s of open) {
      const events = this.store.getEventsBySession(s.id);
      const lastMono = events.length > 0 ? events[events.length - 1]!.tMono : 0;
      await this.store.endSession(s.id, s.startedAt + lastMono);
      await this.enqueueJob("record", s.id, null);
      console.info(`[deskrag] adopted an unclosed recording: ${s.id}`);
    }
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
  /** Full queue snapshots, on transitions. */
  onIndexQueue(cb: (q: IndexQueueDTO) => void): () => void {
    this.queueListeners.add(cb);
    return () => this.queueListeners.delete(cb);
  }
  /**
   * The running stage's detail line — its own channel because the patch stage
   * reports per frame, and re-serialising the whole queue at that rate is waste.
   */
  onIndexTick(cb: (t: IndexTickDTO) => void): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }
  /**
   * Per-signal counters while capturing.
   *
   * Its own channel, and a POLLED one rather than a pushed one, for the reason
   * `onIndexTick` is separate: activity arrives per event and `mouse_move` alone
   * is throttled to 12ms during a drag, so forwarding each one would put
   * thousands of messages a second behind a readout that changes once.
   */
  onRecordingTick(cb: (t: RecordingTickDTO) => void): () => void {
    this.recordingTickListeners.add(cb);
    return () => this.recordingTickListeners.delete(cb);
  }
  /** Weight downloads can start from search(), not just index(), so this is its
   *  own channel rather than a stage of IndexingProgress. */
  onModelDownload(cb: (p: ModelDownloadProgress) => void): () => void {
    this.modelListeners.add(cb);
    return () => this.modelListeners.delete(cb);
  }
  /**
   * A recording-state change is ALSO a queue change, and they are emitted
   * together so they cannot disagree.
   *
   * `IndexQueueDTO.held` is a function of whether capture is running, so
   * starting a recording changes the queue's answer without touching a single
   * job row. Emitting only the recording state left the renderer holding a
   * snapshot that still said `held: null` — measured by driving the app, a
   * second recording ran with the queue correctly reporting a hold over IPC and
   * the SCREEN showing no banner at all, because nothing had pushed it one.
   */
  private emitState(): void {
    for (const cb of this.stateListeners) cb(this.state);
    this.emitQueue();
  }
  private emitQueue(): void {
    if (this.queueListeners.size === 0) return;
    const q = this.indexQueue();
    for (const cb of this.queueListeners) cb(q);
  }
  private emitTick(t: IndexTickDTO): void {
    for (const cb of this.tickListeners) cb(t);
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
    // One lane, always in-process. Text embedding used to default to Ollama,
    // which put a daemon between a query and every text result on a default
    // install; the model is now a pinned ONNX export chosen from a fixed menu.
    const mod = await this.loadOnnx<typeof import("deskrag/embed/onnx/text")>(
      "deskrag/embed/onnx/text",
    );
    if (!mod) {
      throw new Error("Local text embedding is unavailable: onnxruntime-node failed to load.");
    }
    const spec = TEXT_MODEL_SPECS[p.textModel];
    const dir = await this.models.ensure(spec);
    const weights = join(dir, spec.weights ?? "model_int8.onnx");
    const textEmbedder: EmbeddingProvider = new mod.OnnxTextEmbedding({
      modelPath: weights,
      tokenizerPath: join(dir, "tokenizer.json"),
      // The profile carries the prefixes, the pooling and the dimensions. Passing
      // the model id alone would silently run this export on nomic's contract.
      profile: textProfile(p.textModel),
      session: this.onnx.session(weights),
    });

    // --- visual path (ColModernVBERT, or nothing) -----------------------------
    let patchEmbedder: MultiVectorProvider | null = null;
    if (p.imageProvider === "colmodernvbert") {
      const mod = await this.loadOnnx<typeof import("deskrag/embed/onnx/colmodernvbert")>(
        "deskrag/embed/onnx/colmodernvbert",
      );
      if (!mod) {
        throw new Error("Local image search is unavailable: onnxruntime-node failed to load.");
      }
      const dir = await this.models.ensure(MODELS.colmodernvbert);
      patchEmbedder = new mod.ColModernVBertMultiVector({
        modelPath: join(dir, "model.onnx"),
        tokenizerPath: join(dir, "tokenizer.json"),
        session: this.onnx.session(join(dir, "model.onnx")),
        // Read tiling from the model's OWN config rather than assuming it. This
        // config puts pixel_shuffle_factor at the top level, and the value it
        // finds there also travels to the highlighter as `provider.tileConfig`
        // — agreeing with DEFAULT_TILE_CONFIG is a coincidence to be checked,
        // never a fact to rely on.
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
    // --- reflector (writes the per-session note; absence costs the whole note)
    //
    // ONE switch, two objects: the two take different briefs and return
    // different shapes, so they cannot be one provider, but they must be null
    // together or `StageFacts.summarizer` would be answering about the wrong
    // one. Built here rather than lazily because it is a plain `fetch` wrapper
    // — no weights, no session, nothing to defer.
    let reflector: ReflectionProvider | null = null;
    if (p.summaryProvider === "ollama") {
      summarizer = new OllamaSummaryProvider({
        host: p.ollamaHost,
        model: p.ollamaSummaryModel,
      });
      reflector = new OllamaReflectionProvider({
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
      patchEmbedder,
      captioner,
      summarizer,
      reflector,
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

  /**
   * Called at the top of `startRecording`, BEFORE any producer starts.
   *
   * The app hides its window here. Before rather than after, and a hook rather
   * than an `onState` listener, because `onState` fires once the device clock
   * and every producer are up — by which point the window producer's first
   * 500ms poll has almost certainly already recorded the recorder as frontmost.
   * Both the IPC path and the tray menu go through `startRecording`, so one hook
   * covers both.
   *
   * This is a convenience, never the mechanism: what actually keeps the recorder
   * out of the graph is the lift-time filter, which also repairs recordings
   * already taken. Wrapped and swallowed for the reason `onActivity` is — a
   * recording is real-time and unrepeatable, and a window that failed to hide
   * must not be able to stop one.
   */
  onRecordingWillStart?: () => void;

  async startRecording(): Promise<RecordingStatus> {
    if (this.state.state !== "idle") return this.state;
    try {
      this.onRecordingWillStart?.();
    } catch (err) {
      console.error("[deskrag] could not hide the window before recording:", err);
    }
    const v = this.settings.view();
    const sig = v.signals;
    const active: SignalKind[] = [];

    const axSource = sig.ax.enabled ? new SwiftAxSource() : undefined;
    // The tally cannot be built yet — it takes the set of signals that actually
    // ATTACHED, and that is not known until every producer below has been tried.
    // Nothing is lost by deferring it: no activity can occur before
    // `session.start()`, which is what starts the producers.
    let tally: SignalTally | undefined;
    const session = new CaptureSession(this.store, {
      blobStore: this.blobs,
      // A TEE, never a second write path. Wrapped by the session too, because a
      // recording is real-time and cannot be taken again.
      onActivity: (a) => tally?.observe(a),
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
        // `selfPid` is what lets a `focus_change` say the RECORDER was frontmost,
        // which is exact where a name is a guess: the same build reports
        // `Electron` from a dev checkout and its product name from a signed
        // bundle. This is the main process, and an Electron app's frontmost
        // window belongs to it.
        { displaySource: new SwiftDisplaySource(), selfPid: process.pid },
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
    if (sig.desktopAudio.enabled) {
      // NO requestPermission() — deliberately. Electron's systemPreferences has
      // no member for the System Audio Recording grant, and macOS exposes no
      // way to query it, so there is nothing honest to ask. The tap's own first
      // attempt IS the request: macOS shows its dialog when the sidecar creates
      // the tap. A refusal then reads as a signal that attached and produced
      // nothing, which is exactly what the card's well says.
      session.addProducer(
        new SystemAudioProducer({
          chunkSeconds: sig.desktopAudio.chunkSeconds,
          // A SNAPSHOT, not a rule: CATapDescription resolves pids once, at tap
          // creation. Electron plays audio from RENDERER and helper processes,
          // never the main one, so passing process.pid alone would exclude
          // nothing that can make a sound — and a helper that starts playing
          // later cannot be excluded at all. The Library player is the concrete
          // hazard: playing a past recording during a capture would feed
          // DeskRAG's own output back into the new one.
          excludePids: app.getAppMetrics().map((m) => m.pid),
          onError: (m) => console.error(`[deskrag] computer audio: ${m}`),
        }),
      );
      active.push("desktop-audio");
    }
    if (sig.ax.enabled) active.push("ax");

    tally = new SignalTally(active);
    this.tally = tally;
    const sessionId = await session.start();
    this.session = session;
    this.state = { state: "recording", sessionId, startedAt: Date.now(), activeSignals: active };
    this.emitState();
    this.startTicking(sessionId);
    return this.state;
  }

  /**
   * Publish the tally once a second for as long as capture runs.
   *
   * One interval, cleared on stop — the Indexing screen's rule that a running
   * clock belongs to the renderer applies here too, so this carries no elapsed
   * time and nothing derived from wall clock beyond the stamp itself. The first
   * snapshot goes out immediately so the wells are never blank for a second
   * after the button is pressed.
   */
  private startTicking(sessionId: string): void {
    this.stopTicking();
    const emit = (): void => {
      if (!this.tally || this.state.state !== "recording") return;
      const t = this.tally.snapshot(sessionId, Date.now());
      for (const cb of this.recordingTickListeners) cb(t);
    };
    emit();
    this.tallyTimer = setInterval(emit, 1000);
    this.tallyTimer.unref?.();
  }

  private stopTicking(): void {
    if (this.tallyTimer) clearInterval(this.tallyTimer);
    this.tallyTimer = undefined;
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

  /**
   * Stop capture and HAND THE RECORDING TO THE QUEUE.
   *
   * This used to `await this.index(sessionId)` inline, which is why the record
   * button was dead for as long as indexing took — measured at about ten minutes
   * over 546 frames with an image provider configured. It now returns as soon as
   * the producers are down, and the state goes straight back to `idle`, so the
   * next recording can start immediately.
   *
   * The synchronous state claim survives that change and must: a second
   * concurrent call racing in behind this one has to see `state !== "recording"`
   * BEFORE the first await, or it passes the guard above too. It used to double-
   * index — measured on a real recording as 28 segment rows, 14 duplicated,
   * because `Segmenter.segment()` has no dedup and just re-inserts. The queue
   * now backs that up with a second guarantee of its own (enqueue is idempotent
   * per kind+session while a job is live), but belt and braces on the one race
   * that has actually happened here is not excessive.
   */
  async stopRecording(): Promise<RecordingStatus> {
    if (this.state.state !== "recording" || !this.session) return this.state;
    const sessionId = this.state.sessionId!;
    const session = this.session;
    this.session = undefined;
    // The tally goes with the state, not with the tail below: the screen reads
    // idle from this instant, and a well reporting counts for a recording that
    // has stopped would be the two-clocks defect in another place.
    this.stopTicking();
    this.tally = undefined;
    this.state = { state: "idle", activeSignals: [] };
    this.emitState();

    // Published so the QUIT PATH can wait for it. Everything after this point —
    // shutting the producers down, stamping `ended_at`, enqueueing the job — is
    // still in flight while the UI already reads idle, which is the point. But
    // `before-quit` used to close the store straight through that window:
    // measured by driving the app, quitting ~150ms after pressing stop left a
    // session with `ended_at` NULL and NO job, so the recording existed on disk
    // and nothing would ever index it.
    this.stopping = (async () => {
      await session.stop();
      await this.enqueueJob("record", sessionId, null);
    })().finally(() => {
      this.stopping = undefined;
    });

    await this.stopping;
    return this.state;
  }

  /**
   * The in-flight `stopRecording`, or undefined when nothing is stopping.
   *
   * Exists for the quit path alone. `before-quit` is synchronous and closing the
   * store mid-stop loses the recording's end stamp and its indexing job.
   */
  pendingStop(): Promise<void> | undefined {
    return this.stopping;
  }

  /**
   * Everything the stages need from the service, gathered once per run.
   *
   * `hasAudio` is a fact about the RECORDING and `whisper` a fact about the
   * MACHINE — probed rather than configured, because the model downloads itself
   * and only the binary can still be missing. Both are here rather than in
   * `capabilities()` for that reason: neither is a setting.
   *
   * `providers` is passed in rather than built here because a re-index calls
   * this once per recording, and `buildProviders` resolves weights and opens
   * inference sessions — doing that thirteen times over a library would be
   * thirteen ONNX sessions for one run.
   */
  private stageWorld(sessionId: string, providers: Providers): StageWorld {
    const facts: StageFacts = {
      patchEmbedder: providers.patchEmbedder !== null,
      captioner: providers.captioner !== null,
      hasAudio: this.store
        .getBlobsBySession(sessionId)
        .some((b) => b.media === "mic" || b.media === "desktop_audio"),
      whisper: whisperAvailable(this.settings.view().providers.whisper.binaryPath),
      // The REFLECTOR, not the summarizer, even though the fact is named for the
      // setting they share. This gates one stage and that stage uses this
      // object; a gate that passes on a different object's presence is how a
      // stage runs with a null provider and writes nothing at all.
      summarizer: providers.reflector !== null,
    };
    return {
      sessionId,
      facts,
      providers,
      // Read per run, like `providers`: the list can change between recordings,
      // and a run must use the list as it stands now rather than one captured
      // when the service was constructed.
      excludeApps: this.settings.view().flows.excludeApps,
      store: this.store,
      blobs: this.blobs,
      loadCropper: () => this.loadCropper(),
      buildTranscriber: () => this.buildTranscriber(),
    };
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
    return new Retriever(this.store, {
      searchers,
      // Unconditional: FTS needs no provider and no vector space, so unlike
      // every searcher above it can never be missing. It is also the only way a
      // default install reaches an exact literal — a filename, an error string,
      // a URL — which is where the dense views are weakest.
      lexical: new LexicalSegmentSearcher(this.store),
      ...(prov.patchEmbedder ? { patchEmbedder: prov.patchEmbedder } : {}),
      ...(prov.reranker ? { reranker: prov.reranker } : {}),
    });
  }

  /**
   * The renderer's search: identical to `searchDetached`, plus it commits the
   * highlights `detail()` serves back to the window.
   */
  async search(input: SearchInput): Promise<SearchResultDTO> {
    const { result, highlights } = await this.searchDetached(input);
    this.lastHighlights = highlights;
    return result;
  }

  /**
   * A search that touches no shared state, for callers that are not the window.
   *
   * The highlights come back in hand rather than being stashed, because there is
   * more than one reader now: a query arriving over MCP used to clear
   * `lastHighlights` and repopulate it from its OWN results, so an agent
   * searching in the background silently changed what the user was looking at.
   */
  async searchDetached(
    input: SearchInput,
  ): Promise<{ result: SearchResultDTO; highlights: Map<string, HighlightDTO[]> }> {
    const prov = await this.buildProviders();
    if (input.imageBytes) {
      if (!prov.patchEmbedder) {
        throw new Error("Image search requires a configured image provider (Settings).");
      }
      if (!this.store.listVectorSpaces().some((s) => s.view === "frame_patches")) {
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

    const highlightsByFrame = new Map<string, HighlightDTO[]>();
    // Hits span sessions, and each session's lane axis is its video's — origin
    // at the first frame, length the video's own span. One list pass and one
    // blob read per DISTINCT session, memoized; resolving per hit would rescan
    // the session list for every result.
    const axes = new Map<string, { originMono: number; totalSec: number }>();
    const axisFor = (sessionId: string): { originMono: number; totalSec: number } => {
      const cached = axes.get(sessionId);
      if (cached !== undefined) return cached;
      const axis = this.laneAxisFor(sessionId);
      axes.set(sessionId, axis);
      return axis;
    };
    // The focused-app timeline, memoized the same way. `getEventsBySession`
    // returns the whole firehose, so this must be per session and not per hit.
    const appTimelines = new Map<string, { tMono: number; value: string }[]>();
    const appAt = (sessionId: string, tMono: number): string | null => {
      let timeline = appTimelines.get(sessionId);
      if (timeline === undefined) {
        timeline = appTimeline(this.store.getEventsBySession(sessionId));
        appTimelines.set(sessionId, timeline);
      }
      return latestAt(timeline, tMono) ?? null;
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
        strength: h.strength,
      }));
      highlightsByFrame.set(fr.frameId, highlights);
      const axis = frame ? axisFor(frame.sessionId) : null;
      const app = frame ? appAt(frame.sessionId, frame.tMono) : null;
      return {
        frameId: fr.frameId,
        score: fr.score,
        sessionId: frame?.sessionId ?? "",
        tMono: frame?.tMono ?? 0,
        // No frame row means no recording to open — the hit degrades to the
        // same zeroed shape the other fields already take, and the renderer
        // withholds the jump rather than offering one that goes nowhere.
        offsetSec: frame && axis ? laneSec(frame.tMono, axis.originMono) : 0,
        sessionSpanSec: axis?.totalSec ?? 0,
        wallClock: session && frame ? session.startedAt + frame.tMono : 0,
        width: frame?.width ?? 0,
        height: frame?.height ?? 0,
        // Caption and transcript cost nothing: `seg` is the whole row, and both
        // were already read from disk to get the digest beside them.
        segmentDigest: seg?.digest ?? null,
        segmentCaption: seg?.caption ?? null,
        segmentTranscript: seg?.transcript ?? null,
        taskSummary: this.taskSummaryFor(seg?.id ?? null),
        app,
        appTone: app === null ? null : appTone(app),
        evidence: {
          frame: fr.evidence.frame,
          region: fr.evidence.region,
          segment: fr.evidence.segment,
          lanes: fr.evidence.lanes.map((l) => ({
            key: l.key,
            rank: l.rank,
            ...(l.count !== undefined ? { count: l.count } : {}),
          })),
        },
        thumbUrl: frame?.blobId ? `deskrag://frame/${frame.blobId}` : null,
        highlightCount: highlights.length,
      };
    });

    return {
      result: {
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
      },
      highlights: highlightsByFrame,
    };
  }

  /**
   * A session's lane axis — where offset 0 sits and how long it runs. The store
   * reads behind `laneOriginOf`/`laneTotalSec`, which are the rules themselves.
   *
   * Both come back together because both need the same video blob: fetching the
   * origin and the length separately meant two list scans and two blob reads for
   * one axis.
   *
   * A session's screen video is written once, when recording stops, so this is
   * stable for anything searchable; it is deliberately not cached on the service
   * all the same, since it is one list scan on paths that already do far more
   * work — `searchDetached` memoizes it per query instead.
   */
  private laneAxisFor(sessionId: string): { originMono: number; totalSec: number } {
    const row = this.store.listSessions().find((s) => s.id === sessionId);
    const blob = row?.videoBlobId ? this.store.getBlob(row.videoBlobId) : undefined;
    const durationMs = row?.endedAt ? Math.max(0, row.endedAt - row.startedAt) : 0;
    return {
      originMono: laneOriginOf(blob ?? null),
      totalSec: laneTotalSec(blob ?? null, durationMs),
    };
  }

  detail(frameId: string): ResultDetailDTO | null {
    return this.detailWith(frameId, this.lastHighlights.get(frameId) ?? []);
  }

  /**
   * `detail()` for a caller that is not the window.
   *
   * Highlights are QUERY-relative — they are the regions that matched, and
   * `matchedBy` says how — so they are passed in rather than read from
   * `lastHighlights`. Reading that map here would answer an MCP request with
   * whatever the user's last search happened to highlight, which is not an
   * answer to the question that was asked.
   */
  detailWith(frameId: string, highlights: HighlightDTO[]): ResultDetailDTO | null {
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
    // One axis read serves both the jump target and the locator; `laneAxisFor`
    // is a list scan plus a blob read, so asking it twice for one frame is the
    // shape `searchDetached` memoizes precisely to avoid.
    const axis = this.laneAxisFor(frame.sessionId);
    // Frame-intrinsic, so it is resolved here rather than passed down from a
    // result list: the Library opens this view with no query and still deserves
    // to be told which application was in front.
    const app = latestAt(appTimeline(this.store.getEventsBySession(frame.sessionId)), frame.tMono) ?? null;
    return {
      frameId,
      taskSummary: this.taskSummaryFor(seg?.id ?? null),
      imageUrl: frame.blobId ? `deskrag://frame/${frame.blobId}` : null,
      width: frame.width,
      height: frame.height,
      tMono: frame.tMono,
      offsetSec: laneSec(frame.tMono, axis.originMono),
      app,
      appTone: app === null ? null : appTone(app),
      sessionSpanSec: axis.totalSec,
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
      highlights,
    };
  }

  listSessions(): SessionSummaryDTO[] {
    return this.store.listSessions().map((s) => {
      const firstKeyframe = this.store.getFramesBySession(s.id).find((f) => f.blobId);
      // One node per recording, so this is one row — not a scan. `getSegment`
      // per keyframe is the shape `sessionDetail` deliberately avoids, and the
      // same reasoning applies here.
      const root = this.store
        .getSegmentsBySession(s.id)
        .find((seg) => seg.granularity === ROOT_GRANULARITY);
      const purpose = root === undefined ? undefined : this.store.getSegmentSummary(root.id);
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
        purpose: purpose?.text ?? null,
        purposeSource: purpose?.source ?? null,
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
    const totalSec = laneTotalSec(detail.video, detail.durationMs);

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
      // segment id. Empty for a session indexed before composing existed —
      // see `LaneInput.summaries` in session-tracks.ts for what that does to
      // the rail's lanes.
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
    // AND not while it is being indexed. `index_job` cascades on session delete,
    // so the row would vanish out from under the worker mid-stage while it went
    // on writing derived rows for a session that no longer exists. That guard
    // used to come for free: "indexing" was a value of the recording state, so
    // the check above covered both. Splitting them is what opened this.
    const running = this.store
      .listIndexJobs(["running"])
      .find((j) => j.sessionId === sessionId);
    if (running) {
      throw new Error("That recording is being indexed — wait for the current stage to finish.");
    }
    // Rows first: a row pointing at a deleted file is a broken read, whereas a
    // file with no row is just reclaimable disk.
    await this.store.deleteSession(sessionId);
    await this.blobs.removeSession(sessionId);
    this.lastHighlights.clear();
    this.trackCache.delete(sessionId);
  }

  // --- the indexing queue ----------------------------------------------------
  //
  // EVERY method below ENQUEUES AND RETURNS. None of them runs the pipeline
  // inline, and none of them refuses because a recording is in progress — the
  // worker yields to capture on its own, between stages.
  //
  // That is a deliberate reversal. `reindexAll` and `reindexTraces` used to run
  // a whole library rebuild inside their IPC handler, guarded by
  // `state !== "idle"` — and then never SET the state, so `startRecording`
  // succeeded mid-rebuild and capture wrote into sessions the loop was purging,
  // with no indication anywhere in the UI. The guard was doing nothing it
  // appeared to do.

  /**
   * Re-index one recording from raw capture.
   *
   * A separate KIND from the record job rather than a flag on it, because jobs
   * deduplicate by (kind, session): a manual re-index must be able to queue
   * behind the automatic job for the same recording, not be folded into it and
   * silently do nothing.
   */
  async reindexSession(sessionId: string): Promise<void> {
    await this.enqueueJob("reindex", sessionId, null);
  }

  /**
   * Re-index the whole library: one job per recording, plus the graph rebuild.
   *
   * NOT a subset of the record path, which is the point. It used to be one — the
   * text-side stages, hand-written a second time — and it went stale: composing
   * was added to the record path and not to this one, so a rebuild produced an
   * FTS index missing every summary and an existing recording could never gain a
   * hierarchy at all. Both paths now select from `INDEX_STAGES`, so there is no
   * second list to keep in step.
   *
   * Re-segmenting is safe, and it was not before. The old worry was that new
   * segment ids would orphan every caption, app_caption and transcript attached
   * to the old ones — true, and the reason `Segmenter` was excluded.
   * `purgeDerived` removes those rows first and the stages rewrite them.
   *
   * WHAT THIS COSTS, and why the UI confirms first: a recording is rebuilt with
   * the providers configured NOW. Re-indexing with no captioner permanently
   * discards every caption; with no whisper binary, every transcript. Both are
   * recomputable from blobs still on disk, but only by a run that has the
   * provider. It also runs the model stages, so a library takes minutes to hours.
   *
   * **Oldest recording first**, which is the order `rebuildGraph` replays in, so
   * the rebuilt graph accretes the way the incremental path produced it. That
   * order survives the queue because jobs are claimed by INSERTION order rather
   * than by id — every job in this fan-out lands in the same millisecond, so the
   * tiebreak is the ordering, and a ULID tiebreak would have shuffled it.
   *
   * The trace graph is one job at the END rather than one per recording: a graph
   * accretes, so re-lifting a session into a graph that still contains it
   * double-counts the observations `edgeCost` uses.
   */
  async reindexAll(): Promise<void> {
    const batchId = ulid();
    const sessions = [...this.store.listSessions()].sort((a, b) => a.startedAt - b.startedAt);
    for (const s of sessions) await this.enqueueJob("reindex", s.id, batchId);
    await this.enqueueJob("trace-rebuild", null, batchId);
  }

  /**
   * Re-lift every recording into a fresh trace graph, as one library-scoped job.
   *
   * Lifting reads `ax_snapshot` and the event stream, both already on disk, so
   * nothing is re-recorded — this is how a corrected predicate filter or lift
   * rule reaches recordings already taken. Indexing otherwise runs only when a
   * recording stops, which left existing graphs frozen under whatever rules were
   * in force the day they were made.
   */
  async rebuildTraces(): Promise<void> {
    await this.enqueueJob("trace-rebuild", null, null);
  }

  private async enqueueJob(
    kind: IndexJobKind,
    sessionId: string | null,
    batchId: string | null,
  ): Promise<void> {
    await this.store.enqueueIndexJob({
      id: ulid(),
      sessionId,
      kind,
      payload: encodePayload({ batchId }),
    });
    this.emitQueue();
    this.worker.kick();
  }

  /**
   * What the gates will decide, predicted from SETTINGS rather than from built
   * providers.
   *
   * The real run derives its facts from the provider objects it actually
   * constructed (`stageWorld`), because that is the only thing that can be
   * trusted at the moment of running. Here nothing is constructed yet — the
   * point is to answer before paying for an ONNX session — so the two agree by
   * reading the same settings `buildProviders` reads. A disagreement is possible
   * if settings change between enqueue and claim, and it resolves itself: the
   * run overwrites this with what really happened.
   */
  private plannedFacts(sessionId: string | null): StageFacts {
    const providers = this.settings.view().providers;
    return {
      patchEmbedder: providers.imageProvider !== "none",
      captioner: providers.captionProvider !== "none",
      hasAudio:
        sessionId !== null &&
        this.store
          .getBlobsBySession(sessionId)
          .some((b) => b.media === "mic" || b.media === "desktop_audio"),
      whisper: whisperAvailable(providers.whisper.binaryPath),
      summarizer: providers.summaryProvider !== "none",
    };
  }

  /**
   * Drop a queued job.
   *
   * A RUNNING job is REFUSED rather than silently ignored. Stopping mid-stage is
   * the one thing this whole design avoids: every stage appends, so a job cut in
   * half leaves derived rows the next pass would double. Waiting out one stage
   * is the price, and saying so is better than a button that does nothing.
   */
  async cancelIndexJob(jobId: string): Promise<void> {
    const job = this.store.getIndexJob(jobId);
    if (!job) return;
    if (job.state === "running") {
      throw new Error("That job is running — it will finish the stage it is on.");
    }
    if (job.state !== "queued") return;
    await this.store.finishIndexJob(jobId, "cancelled");
    this.emitQueue();
  }

  /**
   * Re-queue a failed or cancelled job, as a new job carrying the same payload.
   *
   * A NEW row rather than a state flip, so the failure that prompted the retry
   * stays on the screen next to it. The retry purges before it runs — not
   * because of a flag, but because `mustPurge` reads the kind, and a `record`
   * job that failed part-way is re-enqueued as one whose first claim finds
   * derived rows already there.
   */
  async retryIndexJob(jobId: string): Promise<void> {
    const job = this.store.getIndexJob(jobId);
    if (!job || job.state === "queued" || job.state === "running") return;
    await this.store.enqueueIndexJob({
      id: ulid(),
      // A retry always purges, whatever failed the first time — so it goes back
      // as a `reindex`, which is exactly what "run this again over a recording
      // that may already have half its derived rows" means.
      sessionId: job.sessionId,
      kind: job.sessionId ? "reindex" : "trace-rebuild",
      payload: job.payload,
    });
    this.emitQueue();
    this.worker.kick();
  }

  /** Forget every terminal job. Queued and running ones are never touched. */
  async clearFinishedIndexJobs(): Promise<void> {
    await this.store.pruneIndexJobs(0);
    this.emitQueue();
  }

  /**
   * The whole queue as the renderer sees it.
   *
   * Session labels are resolved HERE rather than in the renderer because the
   * store is private and this is the only place that can join a job to the
   * recording it is about — the same reason `listSessions` resolves a purpose.
   */
  indexQueue(): IndexQueueDTO {
    const rows = this.store.listIndexJobs();
    const running = rows.find((j) => j.state === "running");
    const recording = this.state.state === "recording";
    const queued = rows.some((j) => j.state === "queued");

    /*
     * A RECORDING IS A HOLD EVEN WHILE A STAGE IS STILL RUNNING, and getting
     * that wrong is what the running app caught. The gate is checked between
     * stages, and the slowest stage measured 14m 16s — so reporting `held: null`
     * whenever a job happened to be mid-flight meant that during a second
     * recording the screen showed a job running and said nothing at all about
     * yielding to it. The state was correct; the disclosure was missing.
     *
     * `holdMessage` carries the distinction instead: pausing-shortly versus
     * paused. With nothing queued and nothing running there is no hold to
     * report — a queue that said "paused" while empty would read as broken.
     */
    const held = recording
      ? running || queued
        ? ("recording" as const)
        : ("empty" as const)
      : running
        ? null
        : // The WORKER's own hold beats a recomputed one: it is the thing
          // actually waiting on the poll.
          this.worker.holding
          ? ("recording" as const)
          : nextRunnable(rows, { recording }).held;

    const labels = new Map(
      rows
        .map((j) => j.sessionId)
        .filter((id): id is string => id !== null)
        .map((id) => [id, this.jobSessionLabel(id)] as const),
    );

    return {
      jobs: rows.map((j) => this.indexJobDto(j, labels)),
      runningJobId: running?.id ?? null,
      held,
      heldMessage: held ? holdMessage(held, running !== undefined) : null,
    };
  }

  /**
   * What to call the recording a job is about.
   *
   * The composed root's summary if it has one — the same rule the Library list
   * uses, so a recording is named identically on both screens. Null while a
   * recording has never been indexed, which is the common case for the job
   * queued the moment it stopped: the screen falls back to its wall clock rather
   * than inventing a name.
   */
  private jobSessionLabel(sessionId: string): { purpose: string | null; poster: string | null } {
    const root = this.store
      .getSegmentsBySession(sessionId)
      .find((seg) => seg.granularity === ROOT_GRANULARITY);
    const purpose = root === undefined ? undefined : this.store.getSegmentSummary(root.id);
    const frame = this.store.getFramesBySession(sessionId).find((f) => f.blobId);
    return {
      purpose: purpose?.text ?? null,
      poster: frame?.blobId ? `deskrag://frame/${frame.blobId}` : null,
    };
  }

  private indexJobDto(
    job: IndexJobRow,
    labels: Map<string, { purpose: string | null; poster: string | null }>,
  ): IndexJobDTO {
    // An unrecognised kind reads as a plain record job rather than throwing: a
    // row written by a newer build must still be describable by an older one.
    const kind: IndexJobKind = isIndexJobKind(job.kind) ? job.kind : "record";
    // A job that has not run yet has no ladder ON DISK, and must still show one.
    // PREDICTING it here rather than writing it at enqueue keeps the stored
    // progress meaning exactly one thing — what actually happened — and covers
    // rows enqueued by an older build for free. Measured before this: five jobs
    // queued behind one running job all read "0/0 stages" beside an empty
    // diagram, which is the question a reader has *while they wait*.
    const stages = job.progress === null ? initialStages(kind, this.plannedFacts(job.sessionId)) : decodeStages(job.progress);
    const { done, total } = jobProgress(stages);
    const at = job.sessionId ? labels.get(job.sessionId) : undefined;

    return {
      id: job.id,
      kind,
      sessionId: job.sessionId,
      sessionLabel: at?.purpose ?? null,
      posterUrl: at?.poster ?? null,
      state: job.state,
      enqueuedAt: job.enqueuedAt,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      error: job.error,
      batchId: decodePayload(job.payload).batchId,
      stages: buildStageGraph(stages),
      done,
      total,
    };
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
   * Everything needed to render one recording's composed hierarchy, in one read.
   *
   * The store stays private — this returns rows, not a handle — and the shaping
   * happens in the caller, which is what keeps `buildOutline` pure and in the
   * root suite. `null` means no such recording, which is a different answer from
   * a recording that was never composed.
   */
  sessionComposition(sessionId: string): {
    segments: SegmentRow[];
    summaries: SegmentSummaryRow[];
    children: [string, string[]][];
    laneOrigin: number;
  } | null {
    const session = this.store.listSessions().find((s) => s.id === sessionId);
    if (session === undefined) return null;
    const segments = this.store.getSegmentsBySession(sessionId);
    // Edges are STORED, never derived from spans: a parent's span is exactly its
    // children's union, so containment cannot say which of two identical spans
    // is the parent.
    const children: [string, string[]][] = [];
    for (const s of segments) {
      if (s.granularity === LEAF_GRANULARITY) continue;
      const kids = this.store.getSegmentChildren(s.id);
      if (kids.length > 0) children.push([s.id, kids]);
    }
    const blob = session.videoBlobId ? this.store.getBlob(session.videoBlobId) : undefined;
    return {
      segments,
      summaries: this.store.getSegmentSummariesBySession(sessionId),
      children,
      laneOrigin: laneOriginOf(blob ?? null),
    };
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
      },
      // The default rule. Named rather than passed as `undefined`, because the
      // next argument is the one that matters here: a walk's `atSec` is on the
      // SAME lane axis the graph's sources are, so a jump from a habit's ledger
      // and a jump from a node's drawer land on one clock.
      undefined,
      (sessionId) => origins.get(sessionId) ?? 0),
      // The list as it stands NOW, which is not necessarily what the graph on
      // disk was built with — it only takes effect on a rebuild. The screen says
      // which applications are meant to be missing; a reader who finds their own
      // app gone is entitled to that answer without opening Settings.
      excludedApps: [...this.settings.view().flows.excludeApps],
    };
  }

  // --- habits ---------------------------------------------------------------
  //
  // The first surface in this app whose writes are the user's own text rather
  // than something derived from a recording. That is why the table is AUTHORED
  // and why none of this is reachable from `mcp/`: the reader port declares only
  // the read half, so a tool structurally cannot accept, edit or forget a habit.

  /**
   * The prose writer alone, and deliberately NOT `buildProviders()`.
   *
   * `buildProviders` resolves ONNX weights, opens the out-of-process host and
   * can download half a gigabyte — for a call that needs a chat endpoint and
   * nothing else. It also reuses the SUMMARY model rather than adding a second
   * picker: naming a composed level and naming a recorded flow are the same act
   * at two altitudes, and two model settings is two things to keep in step.
   */
  private buildProseWriter(): OllamaHabitProseProvider | null {
    const p = this.settings.view().providers;
    if (p.summaryProvider !== "ollama") return null;
    return new OllamaHabitProseProvider({ host: p.ollamaHost, model: p.ollamaSummaryModel });
  }

  private proseStatus(): { available: boolean; model: string | null } {
    const p = this.settings.view().providers;
    return p.summaryProvider === "ollama"
      ? { available: true, model: `ollama ${p.ollamaSummaryModel}` }
      : { available: false, model: null };
  }

  private habitDocOf(row: HabitRow): StoredHabitDoc {
    const doc = JSON.parse(row.doc) as StoredHabitDoc;
    // A doc written before versioning has neither field, and it is given the
    // INITIAL version rather than a fabricated history: it has changed zero
    // times as far as anything can know, and inventing revisions for edits
    // nobody recorded would make the history lie on its first line.
    return {
      ...doc,
      version: doc.version ?? INITIAL_VERSION,
      history: doc.history ?? [],
    };
  }

  /** Apply a version bump to a doc about to be written. Never on a read. */
  private versioned(doc: StoredHabitDoc, what: string): StoredHabitDoc {
    const next = bumpVersion(doc.version, doc.history, what, Date.now());
    return { ...doc, version: next.version, history: next.history };
  }

  /**
   * One habit as the screen and the MCP tools see it: bound against the routes
   * the graph has NOW, and rendered.
   *
   * The markdown is built HERE rather than in the renderer, so the clipboard
   * button and `get_habit` hand out the same string. Two renderers of one file
   * is the drift hazard `flow-steps.ts` exists to avoid one level down.
   */
  private toHabitDTO(
    row: HabitRow,
    flows: FlowsDTO | null,
    startedAt: ReadonlyMap<string, number>,
  ): HabitDTO {
    const doc = this.habitDocOf(row);
    const routes = flows?.routes ?? [];
    const bound = bindHabit(doc.binding, routes);

    // The LIVE route's recordings, because that is what the habit reads from
    // now. With no live route the bind-time ones stand in: an orphaned habit
    // still came from somewhere, and an empty ledger would say it came from
    // nowhere. A recording whose row is gone has no wall clock and is dropped
    // rather than placed at the epoch.
    const walkIds = bound.route?.sessionIds ?? doc.binding.sessionIds;
    const gained = new Set(bound.gainedSessionIds);
    // The live route's walks carry WHERE inside each recording it was walked.
    // With no live route there are none, and every mark is drawn without a
    // moment to open rather than with an invented one.
    // The fits come from the LIVE route, because that is what the ledger is
    // drawn against. With no live route there is nothing to compare and every
    // mark carries `fit: null` — which the screen draws as "no standard", never
    // as "conformant".
    const fits =
      flows !== null && bound.route !== null ? walkFits(flows, bound.route) : new Map();
    const walks = walkMarks(
      walkIds,
      startedAt,
      gained,
      bound.route?.walks ?? [],
      fits,
    );

    const binding: HabitBindingDTO = {
      state: bound.state,
      routeKey: doc.binding.routeKey,
      liveRouteKey: bound.route?.id ?? null,
      routeLabel: doc.binding.routeLabel,
      boundAt: doc.binding.boundAt,
      boundSessionIds: [...doc.binding.sessionIds],
      overlap: bound.overlap,
      lostSessionIds: bound.lostSessionIds,
      gainedSessionIds: bound.gainedSessionIds,
      // The LIVE count, from the route. Never derived from boundSessionIds.
      recordings: bound.route?.count ?? 0,
      candidates: bound.candidates,
      note: bound.note,
      walks,
    };

    const markdown =
      flows !== null && bound.route !== null
        ? renderHabitMarkdown({
            flows,
            route: bound.route,
            slug: doc.slug,
            title: doc.title,
            description: doc.description,
            body: doc.body,
            bodySource: doc.bodySource,
            bodyModel: doc.bodyModel,
            showSamples: doc.showSamples,
            habitId: row.id,
            version: doc.version ?? INITIAL_VERSION,
          })
        : // ORPHANED (or ambiguous): the live route is gone, so the record cannot
          // be re-rendered. The snapshot taken when the habit was last written is
          // printed instead, under a dated header saying it has not been
          // re-checked. A habit whose whole body read "route unavailable" would
          // be a broken artifact, and orphaning is routine rather than exotic.
          renderOrphanedHabit(doc, row.id, bound.note);

    return {
      id: row.id,
      state: row.state as HabitState,
      pinned: row.pinned,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      slug: doc.slug,
      title: doc.title,
      description: doc.description,
      body: doc.body,
      bodySource: doc.bodySource,
      bodyModel: doc.bodyModel,
      edited: doc.edited,
      showSamples: doc.showSamples,
      generateNote: doc.generateNote,
      version: doc.version ?? INITIAL_VERSION,
      history: [...(doc.history ?? [])],
      // Filled by `habits()`, which is the only caller that sees the whole set.
      // A duplicate is a relation between two habits and cannot be computed
      // from one, so this is empty here rather than guessed.
      duplicates: [],
      apps: flows !== null && bound.route !== null ? flowApps(flows, bound.route) : [],
      ways: flows !== null && bound.route !== null ? habitWays(flows, bound.route) : [],
      fork: flows !== null && bound.route !== null ? habitFork(flows, bound.route) : null,
      droppedEarly:
        flows !== null && bound.route !== null ? droppedEarlyOf(flows, bound.route) : [],
      markdown,
      binding,
    };
  }

  habits(): HabitsDTO {
    const flows = this.flows();
    const rows = this.store.listHabits();

    // One pass for the whole screen. `flows()` builds the same map for its own
    // reasons; this is deliberately a second local one rather than a field,
    // because a cached session clock would go stale the moment a recording is
    // deleted and nothing here would notice.
    const startedAt = new Map<string, number>();
    for (const s of this.store.listSessions()) startedAt.set(s.id, s.startedAt);

    const rendered = rows.map((r) => this.toHabitDTO(r, flows, startedAt));

    // Duplicates are a relation over the whole set, so they are resolved here
    // and disclosed on both members. ACTIVE only: an archived habit is already
    // the losing half of a merge somebody performed, and reporting it as a
    // duplicate forever would make the disclosure permanent noise.
    const dupes = duplicateHabits(
      rendered
        .filter((s) => s.state === "active")
        .map((s) => ({ id: s.id, liveRouteKey: s.binding.liveRouteKey })),
    );
    const habits = rendered.map((s) => ({ ...s, duplicates: dupes.get(s.id) ?? [] }));

    // A dismissal is a real row carrying only its binding: a rejected proposal
    // that is not persisted comes back on every load.
    //
    // BOTH KEYS CLAIM, and the live one is the half that matters. A route's key
    // is its place-label sequence, so any change to what a place is called
    // re-keys every route on the next rebuild — and a habit whose STORED key
    // went stale would have its own route offered straight back as something to
    // keep, which is how a person ends up with two habits for one flow. That is
    // exactly what `binding.liveRouteKey` is for, and `duplicateHabits` above
    // already reads it. Measured on the real store while removing the recorder
    // from the graph: one kept habit, correctly rebound to `Calculator →
    // TextEdit`, and that same route sitting in the proposals list beneath it.
    //
    // The stored key keeps claiming too, because it is still right whenever the
    // graph has not moved, and an unbindable habit has no live key at all.
    const claimed = rendered.flatMap((s) =>
      s.binding.liveRouteKey === null
        ? [s.binding.routeKey]
        : [s.binding.routeKey, s.binding.liveRouteKey],
    );
    const proposals: HabitProposalDTO[] = unclaimedRoutes(flows?.routes ?? [], claimed).map(
      (route) => ({
        routeKey: route.id,
        name: route.name,
        label: route.label,
        count: route.count,
        // NOT `edgeIds.length` — that is the union of every recording's walk,
        // and numbering it publishes a path nobody took. Same function the
        // route list uses, so the two surfaces cannot disagree.
        steps: routeWayLengths(route)[0] ?? 0,
        stepSummary: routeStepSummary(route),
        variants: route.variants.length,
        nameObservations: route.nameObservations,
        sessionIds: [...route.sessionIds],
        // Never `gained`: nobody has kept this, so there is no keeping act for a
        // recording to have arrived after.
        // Never `gained`: nobody has kept this, so there is no keeping act for
        // a recording to have arrived after. The fits are real either way — a
        // proposal's recordings diverged or they did not.
        walks: walkMarks(
          route.sessionIds,
          startedAt,
          new Set(),
          route.walks,
          flows === null ? new Map() : walkFits(flows, route),
        ),
        apps: flows === null ? [] : flowApps(flows, route),
        // The record it WOULD produce, so Accept is never a blind act.
        preview:
          flows === null ? "" : recordedBlocks({ flows, route, showSamples: false }),
      }),
    );

    // The domain spans EVERY walk on the screen, kept habits and proposals
    // alike, so one row's ledger can be read against another's.
    const every = [
      ...habits.flatMap((h) => h.binding.walks),
      ...proposals.flatMap((p) => p.walks),
    ].map((w) => w.at);

    return {
      habits,
      proposals,
      graphPresent: flows !== null,
      prose: this.proseStatus(),
      domain:
        every.length === 0
          ? null
          : { from: Math.min(...every), to: Math.max(...every) },
    };
  }

  /**
   * Keep a proposal.
   *
   * Deliberately does NOT call the model: accepting must be instant, and a
   * template body is a usable habit on its own. `generateHabit` is a separate,
   * explicit act.
   */
  async acceptHabit(routeKey: string): Promise<void> {
    const flows = this.flows();
    const route = flows?.routes.find((r) => r.id === routeKey);
    if (flows === null || route === undefined) return;

    const prose = templateBody(flows, route);
    const doc: StoredHabitDoc = {
      binding: {
        routeKey: route.id,
        routeLabel: route.label,
        sessionIds: [...route.sessionIds],
        boundAt: Date.now(),
      },
      slug: slugify(prose.title),
      title: prose.title,
      description: prose.description,
      body: `${prose.overview}\n\n## When to use\n\n${prose.whenToUse}`,
      bodySource: "template",
      bodyModel: null,
      edited: false,
      showSamples: false,
      generateNote: null,
      stepsSnapshot: recordedBlocks({ flows, route, showSamples: false }),
      snapshotAt: Date.now(),
    };
    await this.store.putHabit({
      id: ulid(),
      state: "active",
      pinned: false,
      doc: JSON.stringify(doc),
    });
  }

  /** Suppress a proposal, durably. */
  async dismissHabit(routeKey: string): Promise<void> {
    const flows = this.flows();
    const route = flows?.routes.find((r) => r.id === routeKey);
    if (route === undefined) return;
    const doc: StoredHabitDoc = {
      binding: {
        routeKey: route.id,
        routeLabel: route.label,
        sessionIds: [...route.sessionIds],
        boundAt: Date.now(),
      },
      slug: "",
      title: route.name ?? route.label,
      description: "",
      body: "",
      bodySource: "template",
      bodyModel: null,
      edited: false,
      showSamples: false,
      generateNote: null,
      stepsSnapshot: "",
      snapshotAt: Date.now(),
    };
    await this.store.putHabit({
      id: ulid(),
      state: "dismissed",
      pinned: false,
      doc: JSON.stringify(doc),
    });
  }

  async updateHabit(id: string, patch: HabitPatch): Promise<void> {
    const row = this.store.getHabit(id);
    if (row === undefined) return;
    const doc = this.habitDocOf(row);

    // `edited` is what makes Regenerate ask before overwriting. Only the three
    // prose fields set it — flipping a toggle or pinning is not writing.
    const touchedProse =
      (patch.title !== undefined && patch.title !== doc.title) ||
      (patch.description !== undefined && patch.description !== doc.description) ||
      (patch.body !== undefined && patch.body !== doc.body);

    const next: StoredHabitDoc = {
      ...doc,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.slug !== undefined ? { slug: slugify(patch.slug) } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.showSamples !== undefined ? { showSamples: patch.showSamples } : {}),
      edited: doc.edited || touchedProse,
    };
    const moved = this.refreshSnapshot(next);

    // Only what changes the FILE. Pinning and archiving change how the app
    // lists a habit and not a byte of what it hands an agent, so versioning
    // them would make the number stop meaning "this artifact moved".
    const rewritten =
      patch.title !== undefined ||
      patch.description !== undefined ||
      patch.slug !== undefined ||
      patch.body !== undefined ||
      patch.showSamples !== undefined;
    const written = rewritten
      ? this.versioned(next, "edited by hand")
      : moved
        ? this.versioned(next, "the recorded steps changed")
        : next;

    await this.store.putHabit({
      id: row.id,
      state: patch.state ?? row.state,
      pinned: patch.pinned ?? row.pinned,
      doc: JSON.stringify(written),
    });
  }

  /**
   * Re-render the steps snapshot, at every moment the habit is written anyway.
   *
   * Never on a read: a snapshot that refreshed itself when looked at would be
   * indistinguishable from a live render, which is exactly the distinction an
   * orphaned habit has to make.
   */
  private refreshSnapshot(doc: StoredHabitDoc): boolean {
    const flows = this.flows();
    const bound = bindHabit(doc.binding, flows?.routes ?? []);
    if (flows === null || bound.route === null) return false;
    const next = recordedBlocks({
      flows,
      route: bound.route,
      showSamples: doc.showSamples,
    });
    // Whether the RECORD moved, which is the one change a person did not make.
    // A re-index can rewrite the steps under a kept habit, and that is worth a
    // version of its own — an agent holding last week's file has no other way
    // to notice it now describes something else.
    const moved = next !== doc.stepsSnapshot;
    doc.stepsSnapshot = next;
    doc.snapshotAt = Date.now();
    return moved;
  }

  /**
   * The reflections written after the recordings a route was built from.
   *
   * Ordered by recording so a reader of the prompt sees them chronologically,
   * and SILENTLY short: a session with no reflection contributes nothing rather
   * than a placeholder saying so, because "no note was written" is a fact about
   * the indexing configuration and telling a model about it invites prose about
   * the tool instead of about the work.
   *
   * Keyed through the composed root, which is where a reflection hangs. A
   * recording that has not been composed has none, by construction.
   */
  private reflectionsFor(sessionIds: readonly string[]): string[] {
    const out: { at: number; text: string }[] = [];
    for (const id of sessionIds) {
      const session = this.store.getSession(id);
      if (session === undefined) continue;
      for (const r of this.store.getSessionReflectionsBySession(id)) {
        out.push({ at: session.startedAt, text: r.text });
      }
    }
    return out.sort((a, b) => a.at - b.at).map((r) => r.text);
  }

  /**
   * Ask the model for prose. ONE call, seconds — not an indexing stage and not
   * the durable queue, which exists for hundreds-of-units work.
   *
   * It can never fail: an unreachable daemon degrades to the template body and
   * SAYS SO in `generateNote`, the compose precedent.
   */
  async generateHabit(id: string): Promise<void> {
    const row = this.store.getHabit(id);
    if (row === undefined) return;
    const doc = this.habitDocOf(row);
    const flows = this.flows();
    const bound = bindHabit(doc.binding, flows?.routes ?? []);
    if (flows === null || bound.route === null) return;

    const writer = this.buildProseWriter();
    let prose = templateBody(flows, bound.route);
    let source: "llm" | "template" = "template";
    let model: string | null = null;
    let note: string | null =
      "No summary model is configured, so the template wrote this. Settings → Providers.";

    if (writer !== null) {
      try {
        prose = await writer.write(
          briefFor(flows, bound.route, bound, this.reflectionsFor(bound.route.sessionIds)),
        );
        source = "llm";
        model = `${writer.id} ${writer.model}`;
        note = null;
      } catch (err) {
        note = `${writer.model} could not be reached, so the template wrote this — ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }

    const next: StoredHabitDoc = {
      ...doc,
      slug: doc.edited ? doc.slug : slugify(prose.title),
      title: prose.title,
      description: prose.description,
      body: `${prose.overview}\n\n## When to use\n\n${prose.whenToUse}`,
      bodySource: source,
      bodyModel: model,
      edited: false,
      generateNote: note,
    };
    this.refreshSnapshot(next);
    const written = this.versioned(
      next,
      source === "llm" ? `prose regenerated by ${model}` : "prose regenerated from the template",
    );

    await this.store.putHabit({
      id: row.id,
      state: row.state,
      pinned: row.pinned,
      doc: JSON.stringify(written),
    });
  }

  /**
   * Confirm a DISCLOSED re-bind. The only thing that rewrites `routeKey`.
   *
   * `bindHabit` never does it, so a habit that moved says so until a person
   * agrees — the record of where it came from stays falsifiable.
   */
  async rebindHabit(id: string, routeKey: string): Promise<void> {
    const row = this.store.getHabit(id);
    if (row === undefined) return;
    const flows = this.flows();
    const route = flows?.routes.find((r) => r.id === routeKey);
    if (flows === null || route === undefined) return;

    const doc = this.habitDocOf(row);
    const next: StoredHabitDoc = {
      ...doc,
      binding: {
        routeKey: route.id,
        routeLabel: route.label,
        sessionIds: [...route.sessionIds],
        boundAt: Date.now(),
      },
    };
    this.refreshSnapshot(next);
    const written = this.versioned(
      next,
      `re-bound from ${JSON.stringify(doc.binding.routeKey)} to ${JSON.stringify(route.id)}`,
    );

    await this.store.putHabit({
      id: row.id,
      state: row.state,
      pinned: row.pinned,
      doc: JSON.stringify(written),
    });
  }

  /**
   * Merge two habits that answer to the same live route. A HUMAN act.
   *
   * Nothing auto-merges: `duplicateHabits` only discloses, because choosing
   * which of two descriptions of one procedure to keep is a judgement about
   * prose. This is the confirmation of that judgement.
   *
   * The loser is ARCHIVED, never deleted, and its prose is carried into the
   * keeper first — two independent guarantees that the merge destroys no
   * writing. It refuses unless both are active and both bind to the same live
   * route: merging habits about different work would be a data loss the app
   * performed on its own reading of a screen.
   */
  async mergeHabits(keepId: string, mergeId: string): Promise<void> {
    if (keepId === mergeId) return;
    const keepRow = this.store.getHabit(keepId);
    const otherRow = this.store.getHabit(mergeId);
    if (keepRow === undefined || otherRow === undefined) return;
    if (keepRow.state !== "active" || otherRow.state !== "active") return;

    const flows = this.flows();
    const routes = flows?.routes ?? [];
    const keepDoc = this.habitDocOf(keepRow);
    const otherDoc = this.habitDocOf(otherRow);
    // The LIVE route, the same key `duplicateHabits` groups on. Comparing the
    // STORED routeKey would refuse exactly the interesting case: two habits
    // bound at different times to keys that have since merged.
    const keepLive = bindHabit(keepDoc.binding, routes).route?.id ?? null;
    const otherLive = bindHabit(otherDoc.binding, routes).route?.id ?? null;
    if (keepLive === null || keepLive !== otherLive) return;

    const merged: StoredHabitDoc = {
      ...keepDoc,
      body: mergedBody(keepDoc, otherDoc),
      // A merge is prose a person decided on, so the keeper is edited from here
      // — regenerating it would silently discard what was just carried over,
      // and `edited` is what makes that warn.
      edited: true,
    };
    this.refreshSnapshot(merged);
    await this.store.putHabit({
      id: keepRow.id,
      state: keepRow.state,
      pinned: keepRow.pinned,
      doc: JSON.stringify(
        this.versioned(merged, `merged ${JSON.stringify(otherDoc.title)} (${otherRow.id}) in`),
      ),
    });

    await this.store.putHabit({
      id: otherRow.id,
      state: "archived",
      pinned: false,
      doc: JSON.stringify(
        this.versioned(otherDoc, `merged into ${JSON.stringify(keepDoc.title)} (${keepRow.id})`),
      ),
    });
  }

  async removeHabit(id: string): Promise<void> {
    await this.store.deleteHabit(id);
  }
}

/**
 * What a habit row's opaque `doc` column holds. App-side by construction — the
 * store deliberately does not know any of this.
 */
export interface StoredHabitDoc {
  binding: HabitBindingDoc;
  slug: string;
  title: string;
  description: string;
  body: string;
  bodySource: "llm" | "template";
  bodyModel: string | null;
  edited: boolean;
  showSamples: boolean;
  generateNote: string | null;
  /** The record as it last rendered. Printed when the live route is gone. */
  stepsSnapshot: string;
  snapshotAt: number;
  /**
   * `0.1.N`. Absent on a doc written before versioning — see `habitDocOf`.
   *
   * In the JSON rather than a column because `schema.ts` has no migration step.
   */
  version?: string;
  /** What moved it, newest last, bounded by `MAX_HISTORY`. */
  history?: HabitRevision[];
}

/**
 * A habit whose route is no longer in the graph.
 *
 * It still produces a usable file: the snapshot, under a header dating it and
 * saying it has not been re-checked. Never blended with a live render — the
 * whole point is that a reader can tell which one they are holding.
 */
function renderOrphanedHabit(doc: StoredHabitDoc, id: string, note: string | null): string {
  const when = new Date(doc.snapshotAt).toISOString().slice(0, 10);
  return [
    "---",
    `name: ${doc.slug}`,
    `description: ${JSON.stringify(doc.description.replace(/\r?\n/g, " ").trim())}`,
    "metadata:",
    "  source: deskrag",
    `  habit_id: ${id}`,
    `  version: ${doc.version ?? INITIAL_VERSION}`,
    `  binding: orphaned`,
    `  recorded_snapshot: ${when}`,
    `  prose: ${doc.bodySource === "llm" ? `llm (${doc.bodyModel ?? "unknown model"})` : "template"}`,
    "  steps: template",
    `  route: ${JSON.stringify(doc.binding.routeKey)}`,
    "---",
    "",
    `# ${doc.title}`,
    "",
    doc.body.trim(),
    "",
    `> The route this was written from is no longer in the trace graph. The steps below`,
    `> are the copy taken on ${when} and have not been re-checked against it.`,
    note === null ? "" : `> ${note}`,
    "",
    doc.stepsSnapshot,
    "",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
