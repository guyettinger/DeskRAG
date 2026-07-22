/**
 * UiohookInputProducer — global mouse/keyboard capture via uiohook-napi (an
 * optionalDependency; install it and grant macOS Accessibility permission). Not
 * imported by the package barrel, so consumers that don't capture input never
 * load the native module.
 *
 * mouse_move is very high-rate; it's throttled to `mouseMoveThrottleMs` (the
 * batcher then coalesces the writes).
 */

import {
  uIOhook,
  type UiohookKeyboardEvent,
  type UiohookMouseEvent,
  type UiohookWheelEvent,
} from "uiohook-napi";
import type { CaptureContext, Producer } from "../types.js";

export interface UiohookInputOptions {
  /** Minimum ms between emitted mouse_move events (default 100). */
  mouseMoveThrottleMs?: number;
}

export class UiohookInputProducer implements Producer {
  readonly id = "input";
  private ctx: CaptureContext | undefined;
  private lastMoveTMono = -Infinity;
  private readonly moveThrottle: number;
  private bound = false;

  constructor(opts: UiohookInputOptions = {}) {
    this.moveThrottle = opts.mouseMoveThrottleMs ?? 100;
  }

  private readonly onKeyDown = (e: UiohookKeyboardEvent) =>
    this.ctx?.emitEvent({ kind: "key_down", data: { keycode: e.keycode } });
  private readonly onKeyUp = (e: UiohookKeyboardEvent) =>
    this.ctx?.emitEvent({ kind: "key_up", data: { keycode: e.keycode } });
  private readonly onMouseDown = (e: UiohookMouseEvent) =>
    this.ctx?.emitEvent({ kind: "mouse_down", x: e.x, y: e.y, data: { button: e.button } });
  private readonly onMouseUp = (e: UiohookMouseEvent) =>
    this.ctx?.emitEvent({ kind: "mouse_up", x: e.x, y: e.y, data: { button: e.button } });
  private readonly onWheel = (e: UiohookWheelEvent) =>
    this.ctx?.emitEvent({ kind: "scroll", x: e.x, y: e.y, data: { rotation: e.rotation, direction: e.direction } });
  private readonly onMouseMove = (e: UiohookMouseEvent) => {
    const t = this.ctx?.clock.now() ?? 0;
    if (t - this.lastMoveTMono < this.moveThrottle) return;
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
    try {
      uIOhook.stop();
    } catch {
      // hook may already be stopped; ignore
    }
  }
}
