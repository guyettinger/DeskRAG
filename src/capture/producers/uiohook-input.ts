/**
 * UiohookInputProducer — global mouse/keyboard capture via uiohook-napi (an
 * optionalDependency; install it and grant macOS Accessibility permission). Not
 * imported by the package barrel, so consumers that don't capture input never
 * load the native module.
 *
 * mouse_move is ADAPTIVE: `dragSampleMs` (12) while any button is held, because
 * `Path` fitting cannot recover a drag curve from 100ms samples, and
 * `mouseMoveThrottleMs` (100) otherwise so the firehose stays bounded.
 *
 * Key events carry `modifiers` alongside the raw `keycode`. Characters are NOT
 * resolved here — that needs the keyboard layout and happens at lift time
 * (`resolveKeys`), so the raw keystroke stays re-interpretable.
 */

import {
  uIOhook,
  type UiohookKeyboardEvent,
  type UiohookMouseEvent,
  type UiohookWheelEvent,
} from "uiohook-napi";
import type { CaptureContext, Producer } from "../types.js";
import {
  DEFAULT_SAMPLE_OPTIONS,
  modifiersOf,
  shouldSampleMove,
  type SampleOptions,
} from "./sampling.js";

export interface UiohookInputOptions {
  /** Minimum ms between emitted mouse_move events with no button held (default 100). */
  mouseMoveThrottleMs?: number;
  /** Minimum ms between emitted mouse_move events during a drag (default 12). */
  dragSampleMs?: number;
}

export class UiohookInputProducer implements Producer {
  readonly id = "input";
  private ctx: CaptureContext | undefined;
  private lastMoveTMono = -Infinity;
  private buttonsDown = 0;
  private readonly sample: SampleOptions;
  private bound = false;

  constructor(opts: UiohookInputOptions = {}) {
    this.sample = {
      mouseMoveThrottleMs: opts.mouseMoveThrottleMs ?? DEFAULT_SAMPLE_OPTIONS.mouseMoveThrottleMs,
      dragSampleMs: opts.dragSampleMs ?? DEFAULT_SAMPLE_OPTIONS.dragSampleMs,
    };
  }

  private readonly onKeyDown = (e: UiohookKeyboardEvent) =>
    this.ctx?.emitEvent({
      kind: "key_down",
      data: { keycode: e.keycode, modifiers: modifiersOf(e) },
    });
  private readonly onKeyUp = (e: UiohookKeyboardEvent) =>
    this.ctx?.emitEvent({
      kind: "key_up",
      data: { keycode: e.keycode, modifiers: modifiersOf(e) },
    });

  private readonly onMouseDown = (e: UiohookMouseEvent) => {
    this.buttonsDown += 1;
    this.ctx?.emitEvent({ kind: "mouse_down", x: e.x, y: e.y, data: { button: e.button } });
  };
  private readonly onMouseUp = (e: UiohookMouseEvent) => {
    this.buttonsDown = Math.max(0, this.buttonsDown - 1);
    this.ctx?.emitEvent({ kind: "mouse_up", x: e.x, y: e.y, data: { button: e.button } });
  };
  private readonly onWheel = (e: UiohookWheelEvent) =>
    this.ctx?.emitEvent({
      kind: "scroll",
      x: e.x,
      y: e.y,
      data: { rotation: e.rotation, direction: e.direction },
    });
  private readonly onMouseMove = (e: UiohookMouseEvent) => {
    const t = this.ctx?.clock.now() ?? 0;
    const state = { lastMoveTMono: this.lastMoveTMono, buttonsDown: this.buttonsDown };
    if (!shouldSampleMove(state, t, this.sample)) return;
    this.lastMoveTMono = t;
    this.ctx?.emitEvent({ kind: "mouse_move", x: e.x, y: e.y });
  };

  start(ctx: CaptureContext): void {
    this.ctx = ctx;
    uIOhook.on("keydown", this.onKeyDown);
    uIOhook.on("keyup", this.onKeyUp);
    uIOhook.on("mousedown", this.onMouseDown);
    uIOhook.on("mouseup", this.onMouseUp);
    uIOhook.on("wheel", this.onWheel);
    uIOhook.on("mousemove", this.onMouseMove);
    this.bound = true;
    uIOhook.start();
  }

  stop(): void {
    if (!this.bound) return;
    uIOhook.off("keydown", this.onKeyDown);
    uIOhook.off("keyup", this.onKeyUp);
    uIOhook.off("mousedown", this.onMouseDown);
    uIOhook.off("mouseup", this.onMouseUp);
    uIOhook.off("wheel", this.onWheel);
    uIOhook.off("mousemove", this.onMouseMove);
    this.bound = false;
    this.buttonsDown = 0;
    try {
      uIOhook.stop();
    } catch {
      // hook may already be stopped; ignore
    }
  }
}
