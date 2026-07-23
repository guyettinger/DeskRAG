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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  type Producer,
  type ImageEmbeddingProvider,
  type CaptionProvider as LibCaptionProvider,
  type BlobRow,
  type ViewSearcher,
} from "deskrag";
import type { SettingsStore } from "./settings.js";
import type {
  Capabilities,
  FrameHitDTO,
  HighlightDTO,
  IndexingProgress,
  RecordingStatus,
  ResultDetailDTO,
  SearchInput,
  SessionSummaryDTO,
  SignalKind,
} from "@shared/types";

/** Placeholder image embedder for when no image provider is configured. Text and
 *  behavioral queries never invoke it; image search is gated off in that case. */
class NullImageEmbedder implements ImageEmbeddingProvider {
  readonly id = "none";
  readonly model = "none";
  readonly dimensions = 1;
  readonly sharedTextSpace = false;
  async embedImages(): Promise<Float32Array[]> {
    throw new Error("no image embedding provider configured");
  }
}

interface Providers {
  ollama: OllamaTextEmbedding;
  behavior: BehaviorFeatureExtractor;
  imageEmbedder: ImageEmbeddingProvider | null;
  captioner: LibCaptionProvider | null;
  reranker: LLMReranker | null;
  transcriber: WhisperCppTranscription;
}

export class DeskRagService {
  private store!: DualStore;
  private blobs!: BlobStore;
  private readonly settings: SettingsStore;
  private readonly dir: string;

  private session: CaptureSession | undefined;
  private state: RecordingStatus = { state: "idle", activeSignals: [] };

  private stateListeners = new Set<(s: RecordingStatus) => void>();
  private indexingListeners = new Set<(p: IndexingProgress) => void>();
  /** Region highlights from the most recent search, for detail() to reuse. */
  private lastHighlights = new Map<string, HighlightDTO[]>();
  /** App-maintained log of recorded sessions (the library has no list-all read). */
  private sessionLog: SessionSummaryDTO[] = [];

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
    this.sessionLog = this.loadSessionLog();
  }

  private get sessionLogPath(): string {
    return join(this.dir, "sessions.json");
  }
  private loadSessionLog(): SessionSummaryDTO[] {
    if (!existsSync(this.sessionLogPath)) return [];
    try {
      return JSON.parse(readFileSync(this.sessionLogPath, "utf8")) as SessionSummaryDTO[];
    } catch {
      return [];
    }
  }
  private recordSession(entry: SessionSummaryDTO): void {
    this.sessionLog = [entry, ...this.sessionLog.filter((s) => s.id !== entry.id)];
    writeFileSync(this.sessionLogPath, JSON.stringify(this.sessionLog, null, 2), "utf8");
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

  private buildProviders(): Providers {
    const v = this.settings.view();
    const p = v.providers;
    const ollama = new OllamaTextEmbedding({ host: p.ollamaHost, model: p.ollamaModel });
    const behavior = new BehaviorFeatureExtractor();

    let imageEmbedder: ImageEmbeddingProvider | null = null;
    if (p.imageProvider === "voyage" && this.settings.key("voyage")) {
      imageEmbedder = new VoyageImageEmbedding({ apiKey: this.settings.key("voyage")! });
    } else if (p.imageProvider === "gemini" && this.settings.key("gemini")) {
      imageEmbedder = new GeminiEmbedding({ apiKey: this.settings.key("gemini")! });
    }

    let captioner: LibCaptionProvider | null = null;
    if (p.captionProvider === "anthropic" && this.settings.key("anthropic")) {
      captioner = new AnthropicCaptionProvider({ apiKey: this.settings.key("anthropic")! });
    } else if (p.captionProvider === "gemini" && this.settings.key("gemini")) {
      captioner = new GeminiCaptionProvider({ apiKey: this.settings.key("gemini")! });
    }

    const reranker =
      p.rerank && this.settings.key("anthropic")
        ? new LLMReranker({ apiKey: this.settings.key("anthropic")! })
        : null;

    const transcriber = new WhisperCppTranscription({
      binaryPath: p.whisper.binaryPath,
      ...(p.whisper.modelPath ? { modelPath: p.whisper.modelPath } : {}),
    });

    return { ollama, behavior, imageEmbedder, captioner, reranker, transcriber };
  }

  capabilities(): Capabilities {
    const v = this.settings.view();
    const p = v.providers;
    return {
      imageSearch:
        (p.imageProvider === "voyage" && p.keys.voyage) ||
        (p.imageProvider === "gemini" && p.keys.gemini),
      caption:
        (p.captionProvider === "anthropic" && p.keys.anthropic) ||
        (p.captionProvider === "gemini" && p.keys.gemini),
      rerank: p.rerank && p.keys.anthropic,
      transcript: Boolean(p.whisper.modelPath),
    };
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
    }
    const sess = this.store.getSession(sessionId);
    this.recordSession({
      id: sessionId,
      startedAt: sess?.startedAt ?? Date.now(),
      endedAt: sess?.endedAt ?? null,
      frameCount: this.store.getFramesBySession(sessionId).length,
      segmentCount: this.store.getSegmentsBySession(sessionId).length,
    });
    this.state = { state: "idle", activeSignals: [] };
    this.emitState();
    return this.state;
  }

  /** segment -> represent, gated on configured providers, with progress. */
  private async index(sessionId: string): Promise<void> {
    const prov = this.buildProviders();
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
            digestEmbedder: prov.ollama,
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
    if (prov.captioner) {
      stages.push({
        name: "Captions",
        run: () =>
          new CaptionRepresenter(this.store, {
            captioner: prov.captioner!,
            captionEmbedder: prov.ollama,
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
            transcriptEmbedder: prov.ollama,
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
      const s = new TextViewSearcher(prov.ollama, view);
      if (registered.has(s.namespace)) searchers.push(s);
    }
    // Behavior searcher is always safe: it returns null (and is skipped) unless
    // the query carries a behavior vector, so it never hits a missing table.
    searchers.push(new BehaviorViewSearcher(prov.behavior));
    return new Retriever(this.store, {
      searchers,
      imageEmbedder: prov.imageEmbedder ?? new NullImageEmbedder(),
      ...(prov.reranker ? { reranker: prov.reranker } : {}),
    });
  }

  async search(input: SearchInput): Promise<FrameHitDTO[]> {
    const prov = this.buildProviders();
    if (input.imageBytes) {
      if (!prov.imageEmbedder) {
        throw new Error("Image search requires a configured image provider (Settings).");
      }
      const hasFrameSpace = this.store.listVectorSpaces().some((s) => s.view === "frame_image");
      if (!hasFrameSpace) {
        throw new Error(
          "No image-indexed frames yet. Record a session with an image provider set, then try again.",
        );
      }
    }
    const retriever = this.buildRetriever(prov);
    const { frames } = await retriever.retrieve({
      ...(input.text ? { text: input.text } : {}),
      ...(input.imageBytes ? { image: input.imageBytes } : {}),
    });

    this.lastHighlights.clear();
    return frames.map((fr) => {
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
    // The library has no "list all sessions" read, so the app keeps its own log,
    // appended after each recording is indexed.
    return this.sessionLog;
  }

  // --- blobs (served over the deskrag:// protocol) --------------------------

  getBlobRow(blobId: string): BlobRow | undefined {
    return this.store.getBlob(blobId);
  }
  async readBlob(blob: BlobRow): Promise<Uint8Array> {
    return this.blobs.read(blob);
  }
}
