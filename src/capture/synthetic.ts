/**
 * SyntheticInputProducer — a deterministic producer for tests and for replaying
 * recorded scripts. It emits a fixed list of events on start (no wall-clock
 * timing), so orchestration, batching, ordering, and t_mono stamping can be
 * verified without real OS hooks. Real native producers (uiohook, active-win,
 * ScreenCaptureKit, etc.) implement the same Producer interface.
 */

import type { CaptureContext, EmittedEvent, Producer } from "./types.js";

export class SyntheticInputProducer implements Producer {
  constructor(
    readonly id: string,
    private readonly script: EmittedEvent[],
  ) {}

  start(ctx: CaptureContext): void {
    for (const ev of this.script) ctx.emitEvent(ev);
  }

  stop(): void {
    // nothing to tear down
  }
}
