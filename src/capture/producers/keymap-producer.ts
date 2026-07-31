/**
 * KeymapProducer — emits `keymap_change` at session start and whenever the
 * keyboard layout changes, so `resolveKeys` can resolve characters against the
 * layout that was actually active at each t_mono.
 *
 * It polls, unlike display tracking, and the asymmetry is deliberate: a display
 * change has a free observable signal in data already collected (a window off
 * every known display), while a layout change has no side effect on anything
 * recorded. Watching kTISNotifySelectedKeyboardInputSourceChanged properly would
 * need a long-running sidecar instead of one-shot execFile — a larger change
 * than this work should make. One spawn per minute is cheap enough.
 */

import type { CaptureContext, Producer } from "../types.js";
import type { KeymapSource } from "../env/types.js";

export interface KeymapProducerOptions {
  /** Poll interval in ms (default 60_000). */
  pollMs?: number;
}

export class KeymapProducer implements Producer {
  readonly id = "keymap";
  private timer: NodeJS.Timeout | undefined;
  private lastLayoutId: string | undefined;
  private polling = false;
  private readonly pollMs: number;

  constructor(
    private readonly source: KeymapSource,
    opts: KeymapProducerOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 60_000;
  }

  /** One poll cycle. Exposed for tests; `start()` schedules it. */
  async pollOnce(ctx: CaptureContext): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const km = await this.source.query();
      // No layout is not a layout CHANGE — stay silent and try again next tick.
      if (km === undefined) return;
      if (km.layoutId === this.lastLayoutId) return;
      this.lastLayoutId = km.layoutId;
      ctx.emitEvent({ kind: "keymap_change", data: km });
    } catch {
      // best-effort: a failed probe must never sink the recording
    } finally {
      this.polling = false;
    }
  }

  start(ctx: CaptureContext): void {
    void this.pollOnce(ctx);
    this.timer = setInterval(() => void this.pollOnce(ctx), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.source.close?.();
  }
}
