/**
 * CaptureSession — orchestrates a recording. It owns the monotonic clock, mints
 * the session + event ids, batches the event firehose, and drives producer
 * lifecycle. Producers are wired to a CaptureContext and never see the store.
 *
 * Lifecycle: start() persists the session row (with the clock's epoch), starts
 * the batcher, then starts every producer. stop() stops producers (reverse
 * order), drains the batcher, and records ended_at.
 */

import { stat } from "node:fs/promises";
import { ulid } from "ulid";
import { MonotonicClock } from "../timeline/clock.js";
import { DeviceClock } from "../timeline/device-clock.js";
import type { DeviceClockSource } from "./env/types.js";
import type { Store, EventInsert, Media } from "../store/types.js";
import { EventBatcher, type BatcherOptions } from "./batcher.js";
import { FrameIngestor } from "./frame-ingest.js";
import { KeyframeBudget } from "./keyframe-budget.js";
import { AxCapturer } from "./ax/ax-capturer.js";
import { BoundaryAxTrigger } from "./ax/boundary.js";
import type { AxSource } from "./ax/types.js";
import type { BlobStore } from "../store/blob-store.js";
import type { CaptureContext, Producer } from "./types.js";

/** What the session injects into producers, and how it batches their events. */
export interface CaptureSessionOptions extends BatcherOptions {
  deviceId?: string;
  meta?: unknown;
  /** Inject a clock (defaults to a fresh MonotonicClock.start()). */
  clock?: MonotonicClock;
  /** Keyframe rate limit for frame producers (defaults to a fresh KeyframeBudget). */
  keyframeBudget?: KeyframeBudget;
  /** Blob store for persisting keyframe images (frame producers with images). */
  blobStore?: BlobStore;
  /**
   * Accessibility source. When set, the AX tree is captured per kept keyframe
   * AND at boundaries (focus change, bookmark, dwell resume) — a settled screen
   * produces no keyframes, and settled is exactly when a boundary fires, so
   * keyframe-only AX has nothing to offer where it matters most.
   */
  axSource?: AxSource;
  /**
   * Reads the capture device's timebase (`ax-dump --clock`). REQUIRED, and
   * deliberately not optional: a session that could not calibrate would store
   * frame and audio timestamps meaning something different from every other
   * session, and an optional bridge is exactly the silent second convention
   * this exists to remove. Tests pass a `FakeDeviceClockSource`.
   */
  deviceClockSource: DeviceClockSource;
  /** Settle delay before a boundary-triggered AX walk (default 250ms). */
  axSettleMs?: number;
  /** Input-idle gap that counts as a dwell for AX triggering (default 3000ms). */
  axDwellGapMs?: number;
}

/**
 * Orchestrates producers over one recording: mints the session id, owns the
 * monotonic clock and the event batcher, and brokers blob reservation so producers
 * stay ignorant of the store.
 */
export class CaptureSession {
  readonly clock: MonotonicClock;
  /** Set in start(), before anything can observe it. See the refusal there. */
  private deviceClock: DeviceClock | undefined;
  private readonly producers: Producer[] = [];
  private readonly batcher: EventBatcher;
  private sessionId: string | undefined;
  private ingestor: FrameIngestor | undefined;
  private axCapturer: AxCapturer | undefined;
  /** Set once the context exists; the AX capturer may report a URL before then. */
  private emitUrl: ((url: string, tMono: number) => void) | undefined;
  private boundaryAx: BoundaryAxTrigger | undefined;
  private running = false;
  /** Paths + media for blobs reserved by producers, pending commit. */
  private readonly reserved = new Map<string, { path: string; media: Media; codec: string }>();

  constructor(
    private readonly store: Store,
    // No default: `deviceClockSource` is required, and a defaulted `{}` would
    // silently reintroduce the optional bridge.
    private readonly opts: CaptureSessionOptions,
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

    // Calibrate FIRST, before `running` is set and before any row exists. A
    // session that cannot read the device timebase can only stamp frames and
    // audio with their ARRIVAL times, which carry the whole capture latency
    // (measured 3.05s on a real screen device) and would sit on a different
    // clock from every event in the same recording. Refusing loudly beats
    // storing a second, silent convention — and refusing before the session row
    // exists keeps a failed start from looking like a recording that captured
    // nothing.
    let deviceClock: DeviceClock;
    let calibration: { deviceEpochMs: number; monoEpochMs: number };
    try {
      const deviceMs = await this.opts.deviceClockSource.read();
      // ONE reading of each clock: taking `now()` twice would put whatever the
      // sidecar spawn cost between the stored pair and the one actually used.
      const monoEpochMs = this.clock.now();
      deviceClock = DeviceClock.calibrate(deviceMs, monoEpochMs);
      calibration = { deviceEpochMs: deviceMs, monoEpochMs };
    } catch (err) {
      throw new Error(
        `cannot read the capture clock (ax-dump --clock): ${(err as Error).message}. ` +
          "Build the sidecar with `npm run build:ax`, or set ERAG_AX_BIN.",
      );
    }
    this.deviceClock = deviceClock;

    this.running = true;
    this.sessionId = ulid();
    await this.store.putSession({
      id: this.sessionId,
      startedAt: this.clock.startedAt,
      epochMono: this.clock.epochMono,
      ...(this.opts.deviceId !== undefined ? { deviceId: this.opts.deviceId } : {}),
      ...(this.opts.meta !== undefined ? { meta: this.opts.meta } : {}),
    });
    // Persisted so a reader can tell a calibrated recording from one made
    // before the bridge existed — absence is the marker.
    await this.store.putSessionClock({ sessionId: this.sessionId, ...calibration });
    this.batcher.start();
    this.ingestor = new FrameIngestor(
      this.store,
      this.sessionId,
      this.opts.keyframeBudget ?? new KeyframeBudget(),
      this.opts.blobStore,
    );
    this.axCapturer = this.opts.axSource
      ? new AxCapturer(
          this.store,
          this.opts.axSource,
          this.sessionId,
          () => this.clock.now(),
          // Same treatment as `display_change` and `keymap_change`: an
          // environment fact that changes mid-session and fails silently when it
          // does, so it is an event resolved latest-at-or-before rather than
          // configuration. Routed through the same batcher every producer uses.
          (url, tMono) => this.emitUrlChange(url, tMono),
        )
      : undefined;
    this.boundaryAx =
      this.axCapturer !== undefined
        ? new BoundaryAxTrigger(
            async (reason, boundaryTMono) => {
              // A boundary walk has no frame (the screen is settled, so the
              // keyframe gate emitted nothing); it is keyed by its boundary.
              await this.axCapturer!.capture(reason, undefined, boundaryTMono);
            },
            {
              ...(this.opts.axSettleMs !== undefined ? { settleMs: this.opts.axSettleMs } : {}),
              ...(this.opts.axDwellGapMs !== undefined
                ? { dwellGapMs: this.opts.axDwellGapMs }
                : {}),
            },
          )
        : undefined;

    const ctx: CaptureContext = {
      deviceClock: this.deviceClock!,
      sessionId: this.sessionId,
      clock: this.clock,
      // On a kept keyframe, snapshot the live AX tree alongside it.
      ingestFrame: async (frame) => {
        const res = await this.ingestor!.ingest(frame);
        // NO frameId. The walk starts now, but `frame` shows the screen a whole
        // capture latency ago (~2.2s measured), so this is not the frame the
        // walk describes. `associateFrameAx` assigns it at represent time, when
        // the neighbouring frames' capture times are known.
        if (res.kept && res.frameId && this.axCapturer) {
          await this.axCapturer.capture("keyframe");
        }
        return res;
      },
      // Persist a raw audio chunk as a blob (mic/desktop_audio). Best-effort:
      // without a blob store there is nowhere to keep the bytes, so drop it.
      ingestAudio: async (chunk) => {
        if (!this.opts.blobStore) return;
        const insert = await this.opts.blobStore.write(
          this.sessionId!,
          chunk.media,
          chunk.bytes,
          {
            tMonoStart: chunk.tMonoStart,
            tMonoEnd: chunk.tMonoEnd,
            codec: chunk.codec,
          },
        );
        await this.store.putBlobs([insert]);
      },
      // Reserve a path for a file the producer writes itself; without a blob
      // store there is nowhere to keep it, so the producer skips that output.
      reserveBlob: async (media, codec) => {
        if (!this.opts.blobStore) return null;
        const { id, path } = await this.opts.blobStore.reserve(this.sessionId!, media, codec);
        this.reserved.set(id, { path, media, codec });
        return { blobId: id, path };
      },
      // Register the finished file. A missing/empty file means the producer
      // never got going — skip it rather than writing a broken blob row.
      commitBlob: async (blobId, meta) => {
        const entry = this.reserved.get(blobId);
        if (!entry) return;
        let byteLength = 0;
        try {
          byteLength = (await stat(entry.path)).size;
        } catch {
          return; // never written
        }
        if (byteLength === 0) return;
        this.reserved.delete(blobId);
        await this.store.putBlobs([
          {
            id: blobId,
            sessionId: this.sessionId!,
            media: entry.media,
            path: entry.path,
            byteOffset: 0,
            byteLength,
            tMonoStart: meta.tMonoStart,
            tMonoEnd: meta.tMonoEnd,
            codec: entry.codec,
          },
        ]);
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
        // The session is the only component that sees EVERY producer's events, so
        // cross-signal triggering belongs here — producers stay store-free.
        this.boundaryAx?.onEvent(row.kind, row.tMono);
      },
    };
    this.emitUrl = (url, tMono) => ctx.emitEvent({ kind: "url_change", tMono, data: { url } });
    for (const p of this.producers) await p.start(ctx);
    return this.sessionId;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    // Stop producers newest-first so late emits still get batched.
    for (let i = this.producers.length - 1; i >= 0; i--) {
      await this.producers[i]!.stop();
    }
    // Run any pending boundary walk before tearing the source down.
    await this.boundaryAx?.flush();
    this.boundaryAx?.stop();
    await this.batcher.stop();
    this.axCapturer?.close();
    await this.store.endSession(this.id, this.clock.wallAt(this.clock.now()));
    this.running = false;
  }

  /** Buffered until the capture context exists, then routed through it. */
  private emitUrlChange(url: string, tMono: number): void {
    this.emitUrl?.(url, tMono);
  }
}
