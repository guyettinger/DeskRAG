/**
 * TranscriptRepresenter (transcript view) — the spoken-word summary. Reads the
 * session's raw audio blobs (mic / desktop_audio), transcribes each ONCE with an
 * STT provider, then assigns the text to every segment whose time window the
 * audio overlaps (segments are multi-granularity and overlapping, so blobs are
 * shared — transcribing per-segment would repeat expensive work). Mirrors the
 * caption/digest Representer ordering: updateSegment (text -> SQLite) BEFORE
 * putSegmentVectors (vector -> Lance), so reconcile can re-embed a transcript
 * from the persisted text after a crash.
 *
 * The transcript becomes a Tier-1 text view: TextViewSearcher(embedder,
 * "transcript") lets NL queries hit spoken content directly.
 */

import type { EmbeddingProvider, TranscriptionProvider } from "../../embed/types.js";
import { namespaceFor } from "../../embed/types.js";
import type { BlobStore } from "../../store/blob-store.js";
import type { BlobRow, SegmentVectorInsert, Store } from "../../store/types.js";

export interface TranscriptRepresenterOptions {
  transcriber: TranscriptionProvider;
  transcriptEmbedder: EmbeddingProvider;
  blobStore: BlobStore;
  /** Language hint passed to the STT provider (default: provider's own default). */
  language?: string;
}

export interface TranscriptRepresentResult {
  segmentCount: number;
  transcribedCount: number;
  namespace: string;
}

const AUDIO_MEDIA = new Set(["mic", "desktop_audio"]);

export class TranscriptRepresenter {
  private readonly transcriber: TranscriptionProvider;
  private readonly embedder: EmbeddingProvider;
  private readonly blobStore: BlobStore;
  private readonly language: string | undefined;
  readonly namespace: string;
  private spaceReady = false;

  constructor(
    private readonly store: Store,
    opts: TranscriptRepresenterOptions,
  ) {
    this.transcriber = opts.transcriber;
    this.embedder = opts.transcriptEmbedder;
    this.blobStore = opts.blobStore;
    this.language = opts.language;
    this.namespace = namespaceFor("transcript", this.embedder);
  }

  async ensureSpace(): Promise<void> {
    if (this.spaceReady) return;
    await this.store.registerVectorSpace({
      namespace: this.namespace,
      view: "transcript",
      providerId: this.embedder.id,
      model: this.embedder.model,
      dimensions: this.embedder.dimensions,
      sharedTextSpace: false,
    });
    this.spaceReady = true;
  }

  async represent(sessionId: string): Promise<TranscriptRepresentResult> {
    await this.ensureSpace();
    const segments = this.store.getSegmentsBySession(sessionId);
    if (segments.length === 0) {
      return { segmentCount: 0, transcribedCount: 0, namespace: this.namespace };
    }

    const audioBlobs = this.store
      .getBlobsBySession(sessionId)
      .filter((b) => AUDIO_MEDIA.has(b.media));

    // Transcribe each audio blob once; cache text by blob id.
    const textByBlob = new Map<string, string>();
    for (const b of audioBlobs) {
      const bytes = await this.blobStore.read(b);
      const { text } = await this.transcriber.transcribe(
        bytes,
        this.language !== undefined ? { language: this.language } : undefined,
      );
      const trimmed = text.trim();
      if (trimmed) textByBlob.set(b.id, trimmed);
    }

    const transcripts: string[] = [];
    const segIds: string[] = [];
    for (const seg of segments) {
      const overlapping = audioBlobs
        .filter(
          (b) =>
            textByBlob.has(b.id) &&
            overlaps(b, seg.tMonoStart, seg.tMonoEnd),
        )
        .sort((a, b) => a.tMonoStart - b.tMonoStart);
      if (overlapping.length === 0) continue;

      const transcript = overlapping.map((b) => textByBlob.get(b.id)!).join(" ").trim();
      if (!transcript) continue;

      await this.store.updateSegment(seg.id, { transcript }); // SQLite text first
      transcripts.push(transcript);
      segIds.push(seg.id);
    }

    if (transcripts.length > 0) {
      const vecs = await this.embedder.embed(transcripts);
      const rows: SegmentVectorInsert[] = segIds.map((id, i) => ({
        segmentId: id,
        sessionId,
        namespace: this.namespace,
        vector: vecs[i]!,
      }));
      await this.store.putSegmentVectors(rows);
    }

    return {
      segmentCount: segments.length,
      transcribedCount: segIds.length,
      namespace: this.namespace,
    };
  }
}

/** A time range [start, end) overlaps the audio blob's [tMonoStart, tMonoEnd). */
function overlaps(blob: BlobRow, start: number, end: number): boolean {
  return blob.tMonoStart < end && blob.tMonoEnd > start;
}
