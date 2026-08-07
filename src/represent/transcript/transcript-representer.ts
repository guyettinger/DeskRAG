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
 * It ALSO persists utterance-level clips (transcript_clip) from the provider's
 * own timestamps. The segment-level text is what the Tier-1 vector view embeds
 * and is unchanged; the clips exist because a segment's span is not the span of
 * the speech inside it, and only the clips can say where a sentence actually
 * was. A provider that reports no timestamps writes no clips — never a guessed
 * interval spanning the whole blob.
 *
 * The transcript becomes a Tier-1 text view: TextViewSearcher(embedder,
 * "transcript") lets NL queries hit spoken content directly.
 */

import type {
  EmbeddingProvider,
  TranscriptionProvider,
  TranscriptionResult,
} from "../../embed/types.js";
import { namespaceFor } from "../../embed/types.js";
import { ulid } from "ulid";
import type { BlobStore } from "../../store/blob-store.js";
import type {
  BlobRow,
  SegmentVectorInsert,
  Store,
  TranscriptClipInsert,
} from "../../store/types.js";

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
  /** Utterance rows written. 0 when the provider reported no timestamps. */
  clipCount: number;
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
      return { segmentCount: 0, transcribedCount: 0, clipCount: 0, namespace: this.namespace };
    }

    const audioBlobs = this.store
      .getBlobsBySession(sessionId)
      .filter((b) => AUDIO_MEDIA.has(b.media));

    // Transcribe each audio blob once; cache the full result (text + optional
    // per-clip timestamps) by blob id.
    const resultByBlob = new Map<string, TranscriptionResult>();
    for (const b of audioBlobs) {
      const bytes = await this.blobStore.read(b);
      const r = await this.transcriber.transcribe(
        bytes,
        this.language !== undefined ? { language: this.language } : undefined,
      );
      const trimmed = r.text.trim();
      if (!trimmed) continue;
      resultByBlob.set(b.id, { text: trimmed, ...(r.segments ? { segments: r.segments } : {}) });
    }

    // Utterance extent, persisted. These are the same offsets the per-segment
    // slicing below uses — the difference is that a clip keeps them, so the
    // rail can draw the speech rather than the segment that contains it.
    const clips: TranscriptClipInsert[] = [];
    for (const b of audioBlobs) {
      const r = resultByBlob.get(b.id);
      if (!r?.segments) continue;
      for (const s of r.segments) {
        const text = s.text.trim();
        if (!text) continue;
        clips.push({
          id: ulid(),
          sessionId,
          tMonoStart: b.tMonoStart + s.startMs,
          tMonoEnd: b.tMonoStart + s.endMs,
          text,
        });
      }
    }
    await this.store.putTranscriptClips(clips);

    const transcripts: string[] = [];
    const segIds: string[] = [];
    for (const seg of segments) {
      const overlappingBlobs = audioBlobs
        .filter((b) => resultByBlob.has(b.id) && overlaps(b, seg.tMonoStart, seg.tMonoEnd))
        .sort((a, b) => a.tMonoStart - b.tMonoStart);

      const pieces: string[] = [];
      for (const b of overlappingBlobs) {
        const r = resultByBlob.get(b.id)!;
        if (r.segments && r.segments.length > 0) {
          // Slice by absolute time: only the words that actually fall in this
          // store segment's window, not the blob's whole text.
          for (const s of r.segments) {
            const absStart = b.tMonoStart + s.startMs;
            const absEnd = b.tMonoStart + s.endMs;
            if (absStart < seg.tMonoEnd && absEnd > seg.tMonoStart) {
              const piece = s.text.trim();
              if (piece) pieces.push(piece);
            }
          }
        } else {
          // No timestamps for this blob (fake transcriber, or a provider that
          // can't give them): fall back to attributing its whole text to every
          // segment it overlaps — today's behavior. Duplication can return in
          // this case, but a transcript is still better than none.
          pieces.push(r.text);
        }
      }

      const transcript = pieces.join(" ").trim();
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
      clipCount: clips.length,
      namespace: this.namespace,
    };
  }
}

/** A time range [start, end) overlaps the audio blob's [tMonoStart, tMonoEnd). */
function overlaps(blob: BlobRow, start: number, end: number): boolean {
  return blob.tMonoStart < end && blob.tMonoEnd > start;
}
