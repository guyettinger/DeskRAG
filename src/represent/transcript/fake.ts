/**
 * Deterministic transcription provider for tests — no whisper, no network. The
 * text is a stable function of the audio bytes, so different chunks transcribe to
 * different strings and a query can reproduce one exactly.
 */

import type { TranscriptionProvider, TranscriptionResult } from "../../embed/types.js";

export interface FakeTranscriptionOptions {
  /** When true, also emit synthetic per-segment timestamps splitting the flat
   *  text into two halves spanning the clip — for exercising timestamp-based
   *  slicing in TranscriptRepresenter without real whisper output. */
  withTimestamps?: boolean;
  /** Clip duration in ms used to synthesize offsets (default 10_000, matching
   *  FfmpegAudioProducer's default chunkSeconds). */
  clipDurationMs?: number;
}

export class FakeTranscription implements TranscriptionProvider {
  constructor(private readonly opts: FakeTranscriptionOptions = {}) {}

  async transcribe(audio: Uint8Array): Promise<TranscriptionResult> {
    const sig = audio.reduce((n, b) => (n + b) % 100003, 0);
    // NO BRACKETS, and that is load-bearing rather than cosmetic. This used to
    // be `speech[<len>:<sig>]`, whose SECOND HALF under the split below is
    // `[5:15]` — indistinguishable from the bracketed annotations whisper emits
    // when it heard no words (`[BLANK_AUDIO]`, `(soft music)`), which
    // `isNonSpeechText` drops at write time. The fixture would then transcribe
    // to nothing and the failure reads as a bug in the representer.
    const text = `speech ${audio.length} of ${sig}`;
    if (!this.opts.withTimestamps) return { text };

    const duration = this.opts.clipDurationMs ?? 10_000;
    const half = Math.max(1, Math.ceil(text.length / 2));
    return {
      text,
      segments: [
        { text: text.slice(0, half), startMs: 0, endMs: duration / 2 },
        { text: text.slice(half), startMs: duration / 2, endMs: duration },
      ],
    };
  }
}
