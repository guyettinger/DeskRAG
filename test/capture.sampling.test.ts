import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAMPLE_OPTIONS,
  modifiersOf,
  shouldSampleMove,
  type SampleState,
} from "../src/capture/producers/sampling.js";

const o = DEFAULT_SAMPLE_OPTIONS;

describe("shouldSampleMove", () => {
  it("throttles to 100ms when no button is down", () => {
    const s: SampleState = { lastMoveTMono: 1000, buttonsDown: 0 };
    expect(shouldSampleMove(s, 1050, o)).toBe(false);
    expect(shouldSampleMove(s, 1100, o)).toBe(true);
  });

  it("samples at 12ms while a button is down — a drag curve needs the density", () => {
    const s: SampleState = { lastMoveTMono: 1000, buttonsDown: 1 };
    expect(shouldSampleMove(s, 1005, o)).toBe(false);
    expect(shouldSampleMove(s, 1012, o)).toBe(true);
  });

  it("stays at the drag rate while more than one button is held", () => {
    expect(shouldSampleMove({ lastMoveTMono: 1000, buttonsDown: 2 }, 1012, o)).toBe(true);
  });

  it("always samples the first move of a session", () => {
    expect(shouldSampleMove({ lastMoveTMono: -Infinity, buttonsDown: 0 }, 0, o)).toBe(true);
  });

  it("never blocks on a non-monotonic stamp", () => {
    expect(shouldSampleMove({ lastMoveTMono: 5000, buttonsDown: 0 }, 1000, o)).toBe(true);
  });

  it("honours overridden rates", () => {
    const s: SampleState = { lastMoveTMono: 0, buttonsDown: 1 };
    expect(shouldSampleMove(s, 5, { mouseMoveThrottleMs: 100, dragSampleMs: 1 })).toBe(true);
  });
});

describe("modifiersOf", () => {
  it("maps uiohook booleans to canonical sorted names", () => {
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: true, shiftKey: true })).toEqual([
      "cmd",
      "shift",
    ]);
  });

  it("returns [] when nothing is held", () => {
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toEqual([]);
  });

  it("sorts, so one chord keys identically however the flags arrive", () => {
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toEqual([
      "alt",
      "cmd",
      "ctrl",
      "shift",
    ]);
  });
});
