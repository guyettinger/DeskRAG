/**
 * EventBatcher — the event firehose write strategy. Input events arrive at high
 * rate; per-event SQLite writes would stall capture (better-sqlite3 is
 * synchronous). So events accumulate here and flush in one transaction when the
 * buffer hits `maxBatch` OR every `maxIntervalMs`, whichever comes first. Flushes
 * are serialized through a promise chain so `stop()` can await a clean drain.
 */

import type { EventInsert } from "../store/types.js";

export interface BatcherOptions {
  maxBatch?: number; // flush when this many events are buffered
  maxIntervalMs?: number; // flush at least this often
}

export class EventBatcher {
  private readonly maxBatch: number;
  private readonly maxIntervalMs: number;
  private buffer: EventInsert[] = [];
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly flushFn: (rows: EventInsert[]) => Promise<void>,
    opts: BatcherOptions = {},
  ) {
    this.maxBatch = opts.maxBatch ?? 256;
    this.maxIntervalMs = opts.maxIntervalMs ?? 250;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.enqueueFlush(), this.maxIntervalMs);
    // Don't keep the process alive just for the flush cadence.
    this.timer.unref?.();
  }

  add(row: EventInsert): void {
    this.buffer.push(row);
    if (this.buffer.length >= this.maxBatch) this.enqueueFlush();
  }

  /** Take whatever is buffered and append its persistence to the flush chain. */
  private enqueueFlush(): void {
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    this.chain = this.chain.then(() => this.flushFn(rows));
  }

  /** Flush the current buffer and await everything in flight. */
  async flushNow(): Promise<void> {
    this.enqueueFlush();
    await this.chain;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flushNow();
  }
}
