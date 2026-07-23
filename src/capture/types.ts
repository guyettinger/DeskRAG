/**
 * Capture contracts. A Producer is one signal source (screen, desktop audio,
 * mic, input, active-window). It receives a {@link CaptureContext} on start and
 * emits timestamped events / registers blobs through it; the CaptureSession owns
 * the clock, id minting, batching, and the store. Producers never touch the
 * store or the clock epoch directly — they just emit.
 */

import type { MonotonicClock } from "../timeline/clock.js";
import type { SampledFrame, IngestResult } from "./frame-ingest.js";

/** Canonical input/signal event kinds (event.kind is free-form TEXT in SQLite). */
export type EventKind =
  | "mouse_move"
  | "mouse_down"
  | "mouse_up"
  | "scroll"
  | "key_down"
  | "key_up"
  | "focus_change" // active-window/app changed
  | "bookmark"; // explicit user hotkey marker

/** What a producer emits; the session fills in id/sessionId and stamps t_mono. */
export interface EmittedEvent {
  kind: EventKind | string;
  x?: number;
  y?: number;
  data?: unknown;
  /** Override the stamp (defaults to clock.now() at emit time). */
  tMono?: number;
}

/**
 * A self-contained chunk of raw audio (e.g. one ~10s window of mic PCM wrapped in
 * a WAV container), stamped on the monotonic clock. Persisted verbatim as a blob
 * so the transcript view can be (re-)generated from the raw audio later.
 */
export interface AudioChunk {
  bytes: Uint8Array;
  tMonoStart: number;
  tMonoEnd: number;
  /** Microphone vs. desktop/system audio loopback. */
  media: "mic" | "desktop_audio";
  /** Container/codec, e.g. "wav" | "aac". */
  codec: string;
}

export interface CaptureContext {
  readonly sessionId: string;
  readonly clock: MonotonicClock;
  /** Buffer an event for batched persistence. Non-blocking. */
  emitEvent(ev: EmittedEvent): void;
  /** Run a sampled frame through keyframe gating + persistence (frame producers). */
  ingestFrame(frame: SampledFrame): Promise<IngestResult>;
  /** Persist a raw audio chunk as a blob (audio producers). No-op without a blob store. */
  ingestAudio(chunk: AudioChunk): Promise<void>;
}

export interface Producer {
  readonly id: string;
  start(ctx: CaptureContext): void | Promise<void>;
  stop(): void | Promise<void>;
}
