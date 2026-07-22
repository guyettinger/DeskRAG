/**
 * The monotonic session clock. EVERYTHING correlates on t_mono — a monotonic
 * elapsed-ms value measured from the session epoch, NEVER on wall-clock. Wall
 * time (started_at) is captured once, only so a human can read "last Tuesday".
 *
 * `performance.now()` is monotonic and unaffected by NTP steps or DST, which is
 * exactly why joins/segmentation/blob lookups use t_mono and not Date.now().
 * Both time sources are injectable so tests can drive them deterministically.
 */

import { performance } from "node:perf_hooks";

export type MonoSource = () => number; // monotonic ms (e.g. performance.now())
export type WallSource = () => number; // wall-clock ms (e.g. Date.now())

export class MonotonicClock {
  private constructor(
    /** Wall-clock ms at session start — DISPLAY ONLY. */
    readonly startedAt: number,
    /** The monotonic reading captured at session start; t_mono zero. */
    readonly epochMono: number,
    private readonly mono: MonoSource,
  ) {}

  static start(
    mono: MonoSource = () => performance.now(),
    wall: WallSource = () => Date.now(),
  ): MonotonicClock {
    return new MonotonicClock(wall(), mono(), mono);
  }

  /**
   * Reconstruct a clock for an already-started session (e.g. resuming capture),
   * so its t_mono stays continuous with the persisted epoch.
   */
  static resume(
    startedAt: number,
    epochMono: number,
    mono: MonoSource = () => performance.now(),
  ): MonotonicClock {
    return new MonotonicClock(startedAt, epochMono, mono);
  }

  /** Monotonic elapsed ms since the session epoch. This is t_mono. */
  now(): number {
    return this.mono() - this.epochMono;
  }

  /** Approx wall-clock ms for a t_mono value (display only; may drift). */
  wallAt(tMono: number): number {
    return this.startedAt + tMono;
  }

  /** Approx t_mono for a wall-clock ms value (display/import only). */
  toMono(wallMs: number): number {
    return wallMs - this.startedAt;
  }
}
