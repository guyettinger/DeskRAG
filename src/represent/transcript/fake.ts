/**
 * Deterministic transcription provider for tests — no whisper, no network. The
 * text is a stable function of the audio bytes, so different chunks transcribe to
 * different strings and a query can reproduce one exactly.
 */

import type { TranscriptionProvider, TranscriptionResult } from "../../embed/types.js";

export class FakeTranscription implements TranscriptionProvider {
  async transcribe(audio: Uint8Array): Promise<TranscriptionResult> {
    const sig = audio.reduce((n, b) => (n + b) % 100003, 0);
    return { text: `speech[${audio.length}:${sig}]` };
  }
}
