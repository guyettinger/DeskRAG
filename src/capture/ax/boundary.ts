/**
 * BoundaryAxTrigger — decides WHEN to snapshot the AX tree at a boundary.
 *
 * The three boundary reasons `computeBoundaries` detects post-hoc are all
 * detectable live: focus_change and bookmark arrive as events, and a dwell gap
 * shows up as the first input AFTER the gap — which is the right instant anyway,
 * because the tree wanted is the settled one after the pause, not before it.
 *
 * Two behaviours, both cost-driven. The walk is budgeted at 800ms and measured
 * 0.5ms/node (Finder) to 8ms/node (Mail):
 *   - SETTLE DELAY: fire a few hundred ms after the trigger so the UI has
 *     painted, rather than catching it mid-transition.
 *   - COALESCING: one walk in flight; triggers arriving during the delay or the
 *     walk collapse into the pending one. A flurry of app switches would
 *     otherwise queue walks faster than they complete.
 *
 * Pure orchestration: it owns no store and no source, only a callback.
 */

import type { AxSnapshotReason } from "../../store/types.js";

export interface BoundaryAxTriggerOptions {
  /** Delay before the walk, letting the UI paint (default 250). */
  settleMs?: number;
  /** Input-idle gap that counts as a dwell (default 3000, matching the Segmenter). */
  dwellGapMs?: number;
}

/** Event kinds that are themselves boundaries. */
const BOUNDARY_KINDS: ReadonlySet<string> = new Set(["focus_change", "bookmark"]);

/** Kinds that count as user input for dwell detection. */
const INPUT_KINDS: ReadonlySet<string> = new Set([
  "mouse_move",
  "mouse_down",
  "mouse_up",
  "scroll",
  "key_down",
  "key_up",
]);

export class BoundaryAxTrigger {
  private timer: NodeJS.Timeout | undefined;
  private pending: AxSnapshotReason | undefined;
  private inFlight = false;
  private lastInputTMono: number | undefined;
  private stopped = false;
  private readonly settleMs: number;
  private readonly dwellGapMs: number;

  constructor(
    private readonly capture: (reason: AxSnapshotReason) => Promise<void>,
    opts: BoundaryAxTriggerOptions = {},
  ) {
    this.settleMs = opts.settleMs ?? 250;
    this.dwellGapMs = opts.dwellGapMs ?? 3000;
  }

  onEvent(kind: string, tMono: number): void {
    if (this.stopped) return;

    if (INPUT_KINDS.has(kind)) {
      const last = this.lastInputTMono;
      this.lastInputTMono = tMono;
      if (last !== undefined && tMono - last >= this.dwellGapMs) {
        this.arm("dwell_resume");
      }
      return;
    }

    if (BOUNDARY_KINDS.has(kind)) {
      this.arm(kind === "bookmark" ? "bookmark" : "focus_change");
    }
  }

  private arm(reason: AxSnapshotReason): void {
    // Coalesce: the first reason in a burst wins, and the timer is NOT restarted,
    // so a stream of triggers cannot postpone the walk indefinitely.
    if (this.pending !== undefined) return;
    this.pending = reason;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => void this.fire(), this.settleMs);
    this.timer.unref?.();
  }

  private async fire(): Promise<void> {
    this.timer = undefined;
    const reason = this.pending;
    this.pending = undefined;
    if (reason === undefined || this.stopped) return;
    if (this.inFlight) return; // a walk is already running; this trigger folds into it
    this.inFlight = true;
    try {
      await this.capture(reason);
    } catch {
      // best-effort: a failed walk must never sink the recording
    } finally {
      this.inFlight = false;
    }
  }

  /** Run any pending walk now. Called by `CaptureSession.stop()`. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.fire();
  }

  stop(): void {
    this.stopped = true;
    this.pending = undefined;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
