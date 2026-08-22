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
  Media,
} from "../../store/types.js";

export interface TranscriptRepresenterOptions {
  transcriber: TranscriptionProvider;
  transcriptEmbedder: EmbeddingProvider;
  blobStore: BlobStore;
  /** Language hint passed to the STT provider (default: provider's own default). */
  language?: string;
  /**
   * Called with the audio BLOBS finished so far, never the segments.
   *
   * Transcription is the expensive half and it happens once per blob; the
   * per-segment pass below is string slicing over a cache and completes in
   * milliseconds. Counting segments would show a bar that sat at zero for the
   * whole whisper run and then filled instantly — a meter measuring the wrong
   * loop is worse than none, because it looks like a stall.
   */
  onProgress?: (done: number, total: number) => void;
}

export interface TranscriptRepresentResult {
  segmentCount: number;
  transcribedCount: number;
  /** Utterance rows written. 0 when the provider reported no timestamps. */
  clipCount: number;
  namespace: string;
}

const AUDIO_MEDIA = new Set(["mic", "desktop_audio"]);

/**
 * WHAT WHISPER WRITES WHEN IT HEARD NO WORDS.
 *
 * whisper.cpp brackets everything it could not hear as speech — `(soft music)`,
 * `[BLANK_AUDIO]`, `*sighs*` — and those strings are indistinguishable from
 * speech to everything downstream: they land in `transcript_clip`, in
 * `segment.transcript`, in the transcript VECTOR SPACE, and in the digest
 * corpus. Nobody searches "soft music", so they add nothing retrievable while
 * making a segment look like it had speech in it.
 *
 * MEASURED on the real store rather than assumed: of 24 clips, **22** were
 * bracketed annotations and 0 were plausible speech — a desktop is a
 * music-and-silence corpus far more often than a spoken one, and computer audio
 * roughly doubled the count. Before this, 22 segments carried
 * `"(soft music) (dramatic music)"` as their searchable speech.
 *
 * A TEXT RULE, DELIBERATELY NOT AN ENERGY GATE. This form is whisper's own and
 * needs no threshold; a level floor would be a number nobody has swept, and set
 * a shade too high it silently drops quiet speech — which is the failure this
 * pipeline is least able to notice. What it therefore does NOT catch is a
 * hallucinated WORD: the same measurement found `"You"` transcribed from a
 * chunk that was digitally silent at −91 dB, and no text rule can tell that
 * from someone actually saying "you".
 */
const NON_SPEECH = /^\s*[([*][^)\]*]*[)\]*]\s*$/;

/** True when whisper bracketed this instead of hearing words. */
export function isNonSpeechText(text: string): boolean {
  return NON_SPEECH.test(text);
}

export class TranscriptRepresenter {
  private readonly transcriber: TranscriptionProvider;
  private readonly embedder: EmbeddingProvider;
  private readonly blobStore: BlobStore;
  private readonly language: string | undefined;
  private readonly onProgress: ((done: number, total: number) => void) | undefined;
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
    this.onProgress = opts.onProgress;
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
    for (const [i, b] of audioBlobs.entries()) {
      this.onProgress?.(i, audioBlobs.length);
      const bytes = await this.blobStore.read(b);
      const r = await this.transcriber.transcribe(
        bytes,
        this.language !== undefined ? { language: this.language } : undefined,
      );
      const trimmed = r.text.trim();
      if (!trimmed) continue;
      resultByBlob.set(b.id, { text: trimmed, ...(r.segments ? { segments: r.segments } : {}) });
    }
    this.onProgress?.(audioBlobs.length, audioBlobs.length);

    // Utterance extent, persisted. These are the same offsets the per-segment
    // slicing below uses — the difference is that a clip keeps them, so the
    // rail can draw the speech rather than the segment that contains it.
    const clips: TranscriptClipInsert[] = [];
    for (const b of audioBlobs) {
      const r = resultByBlob.get(b.id);
      if (!r?.segments) continue;
      for (const s of r.segments) {
        const text = s.text.trim();
        if (!text || isNonSpeechText(text)) continue;
        clips.push({
          id: ulid(),
          sessionId,
          tMonoStart: b.tMonoStart + s.startMs,
          tMonoEnd: b.tMonoStart + s.endMs,
          text,
          // The loop is already per BLOB, so the source is free here and
          // unrecoverable later: with both audio sources recording, the blob
          // windows overlap, so nothing downstream could work out which one a
          // sentence came from.
          media: b.media as Media,
          blobId: b.id,
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
              if (piece && !isNonSpeechText(piece)) pieces.push(piece);
            }
          }
        } else {
          // No timestamps for this blob (fake transcriber, or a provider that
          // can't give them): fall back to attributing its whole text to every
          // segment it overlaps — today's behavior. Duplication can return in
          // this case, but a transcript is still better than none.
          if (!isNonSpeechText(r.text.trim())) pieces.push(r.text);
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
