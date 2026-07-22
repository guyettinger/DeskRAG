/**
 * CaptureSession — orchestrates a recording. It owns the monotonic clock, mints
 * the session + event ids, batches the event firehose, and drives producer
 * lifecycle. Producers are wired to a CaptureContext and never see the store.
 *
 * Lifecycle: start() persists the session row (with the clock's epoch), starts
 * the batcher, then starts every producer. stop() stops producers (reverse
 * order), drains the batcher, and records ended_at.
 */

import { ulid } from "ulid";
import { MonotonicClock } from "../timeline/clock.js";
import type { Store, EventInsert } from "../store/types.js";
import { EventBatcher, type BatcherOptions } from "./batcher.js";
import { FrameIngestor } from "./frame-ingest.js";
import { KeyframeGate } from "./keyframe.js";
import { AxCapturer } from "./ax/ax-capturer.js";
import type { AxSource } from "./ax/types.js";
import type { BlobStore } from "../store/blob-store.js";
import type { CaptureContext, Producer } from "./types.js";

export interface CaptureSessionOptions extends BatcherOptions {
  deviceId?: string;
  meta?: unknown;
  /** Inject a clock (defaults to a fresh MonotonicClock.start()). */
  clock?: MonotonicClock;
  /** Keyframe gate for frame producers (defaults to a fresh KeyframeGate). */
  keyframeGate?: KeyframeGate;
  /** Blob store for persisting keyframe images (frame producers with images). */
  blobStore?: BlobStore;
  /** Accessibility source; when set, the AX tree is captured per kept keyframe. */
  axSource?: AxSource;
}

export class CaptureSession {
  readonly clock: MonotonicClock;
  private readonly producers: Producer[] = [];
  private readonly batcher: EventBatcher;
  private sessionId: string | undefined;
  private ingestor: FrameIngestor | undefined;
  private axCapturer: AxCapturer | undefined;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly opts: CaptureSessionOptions = {},
  ) {
    this.clock = opts.clock ?? MonotonicClock.start();
    this.batcher = new EventBatcher((rows) => this.store.putEvents(rows), opts);
  }

  /** The session id (available after start()). */
  get id(): string {
    if (!this.sessionId) throw new Error("CaptureSession not started");
    return this.sessionId;
  }

  addProducer(p: Producer): this {
    if (this.running) throw new Error("cannot add producers after start()");
    this.producers.push(p);
    return this;
  }

  async start(): Promise<string> {
    if (this.running) throw new Error("CaptureSession already started");
    this.running = true;
    this.sessionId = ulid();
    await this.store.putSession({
      id: this.sessionId,
      startedAt: this.clock.startedAt,
      epochMono: this.clock.epochMono,
      ...(this.opts.deviceId !== undefined ? { deviceId: this.opts.deviceId } : {}),
      ...(this.opts.meta !== undefined ? { meta: this.opts.meta } : {}),
    });
    this.batcher.start();
    this.ingestor = new FrameIngestor(
      this.store,
      this.sessionId,
      this.opts.keyframeGate ?? new KeyframeGate(),
      this.opts.blobStore,
    );
    this.axCapturer = this.opts.axSource
      ? new AxCapturer(this.store, this.opts.axSource)
      : undefined;

    const ctx: CaptureContext = {
      sessionId: this.sessionId,
      clock: this.clock,
      // On a kept keyframe, snapshot the live AX tree alongside it.
      ingestFrame: async (frame) => {
        const res = await this.ingestor!.ingest(frame);
        if (res.kept && res.frameId && this.axCapturer) {
          await this.axCapturer.capture(res.frameId);
        }
        return res;
      },
      emitEvent: (ev) => {
        const row: EventInsert = {
          id: ulid(),
          sessionId: this.sessionId!,
          tMono: ev.tMono ?? this.clock.now(),
          kind: ev.kind,
          ...(ev.x !== undefined ? { x: ev.x } : {}),
          ...(ev.y !== undefined ? { y: ev.y } : {}),
          ...(ev.data !== undefined ? { data: ev.data } : {}),
        };
        this.batcher.add(row);
      },
    };
    for (const p of this.producers) await p.start(ctx);
    return this.sessionId;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    // Stop producers newest-first so late emits still get batched.
    for (let i = this.producers.length - 1; i >= 0; i--) {
      await this.producers[i]!.stop();
    }
    await this.batcher.stop();
    this.axCapturer?.close();
    await this.store.endSession(this.id, this.clock.wallAt(this.clock.now()));
    this.running = false;
  }
}
