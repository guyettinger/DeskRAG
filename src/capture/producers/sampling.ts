/**
 * The mouse-move throttle decision and modifier normalization, extracted from
 * `uiohook-input.ts` for one reason: `uiohook-napi` is a native module, so the
 * producer cannot be unit-tested, but these rules can.
 *
 * Pure: no store, no clock, no I/O.
 */

export interface SampleState {
  lastMoveTMono: number;
  /** How many mouse buttons are currently held. */
  buttonsDown: number;
}

export interface SampleOptions {
  mouseMoveThrottleMs: number;
  dragSampleMs: number;
}

/**
 * 12ms during a drag: `Path` fitting cannot recover a curve from 100ms samples,
 * and on a drag the path IS the payload. 100ms otherwise keeps the firehose
 * bounded — this is not a global rate increase.
 */
export const DEFAULT_SAMPLE_OPTIONS: SampleOptions = {
  mouseMoveThrottleMs: 100,
  dragSampleMs: 12,
};

export function shouldSampleMove(
  state: SampleState,
  tMono: number,
  opts: SampleOptions = DEFAULT_SAMPLE_OPTIONS,
): boolean {
  const interval = state.buttonsDown > 0 ? opts.dragSampleMs : opts.mouseMoveThrottleMs;
  const elapsed = tMono - state.lastMoveTMono;
  // A non-monotonic stamp must not wedge sampling shut until the clock catches up.
  if (!(elapsed >= 0)) return true;
  return elapsed >= interval;
}

/** uiohook's modifier booleans -> canonical sorted names. */
export function modifiersOf(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): string[] {
  const out: string[] = [];
  if (e.altKey) out.push("alt");
  if (e.metaKey) out.push("cmd");
  if (e.ctrlKey) out.push("ctrl");
  if (e.shiftKey) out.push("shift");
  return out.sort();
}
