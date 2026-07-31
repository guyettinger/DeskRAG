/**
 * Raw events -> typed gestures. Split out of `lift.ts` because grouping is pure
 * and exhaustively testable against plain arrays, while resolving anchors
 * against AX trees is neither.
 *
 * KNOWN DEGRADED: key events carry `{ keycode }` today. Layout-resolved
 * characters and modifier state are capture requirement #2 in the design spec
 * and are not emitted yet. A key without `data.char` produces a warning and no
 * text gesture — deliberately, because fabricating typed content from a keycode
 * table would be worse than omitting it, and the omission is what keeps the
 * missing capture requirement visible.
 */

import type { PathSample } from "./paths.js";
import type { TraceEvent, Vec2 } from "./types.js";

interface GestureBase {
  tMonoStart: number;
  tMonoEnd: number;
}

export type Gesture =
  | (GestureBase & { type: "click"; point: Vec2; button: number; count: number })
  | (GestureBase & { type: "drag"; from: Vec2; to: Vec2; samples: PathSample[]; button: number })
  | (GestureBase & { type: "hover"; point: Vec2; dwellMs: number })
  | (GestureBase & { type: "scroll"; point: Vec2; delta: Vec2; steps: number })
  | (GestureBase & { type: "text"; text: string })
  | (GestureBase & { type: "chord"; keys: string[] })
  | (GestureBase & { type: "idle"; durationMs: number });

export interface GestureOptions {
  /** Movement beyond this during a button-down makes it a drag, not a click. */
  dragThresholdPx?: number;
  doubleClickMs?: number;
  doubleClickPx?: number;
  hoverDwellMs?: number;
  idleGapMs?: number;
  scrollCoalesceMs?: number;
}

export const DEFAULT_GESTURE_OPTIONS: Required<GestureOptions> = {
  dragThresholdPx: 4,
  doubleClickMs: 400,
  doubleClickPx: 6,
  hoverDwellMs: 800,
  idleGapMs: 1500,
  scrollCoalesceMs: 250,
};

interface KeyData {
  keycode?: number;
  char?: string;
  modifiers?: string[];
}

const asRecord = (d: unknown): Record<string, unknown> =>
  d !== null && typeof d === "object" ? (d as Record<string, unknown>) : {};

const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);

export function groupGestures(
  events: readonly TraceEvent[],
  opts: GestureOptions = {},
): { gestures: Gesture[]; warnings: string[] } {
  const o = { ...DEFAULT_GESTURE_OPTIONS, ...opts };
  const gestures: Gesture[] = [];
  const warnings: string[] = [];
  if (events.length === 0) return { gestures, warnings };

  const sorted = [...events].sort((a, b) => a.tMono - b.tMono);

  // Pointer state
  let downAt: { tMono: number; point: Vec2; button: number } | undefined;
  let dragSamples: PathSample[] = [];
  let lastMove: { tMono: number; point: Vec2 } | undefined;
  let lastMoveStart: { tMono: number; point: Vec2 } | undefined;

  // Keyboard state
  let textRun: { text: string; tMonoStart: number; tMonoEnd: number } | undefined;

  // Scroll state
  let scrollRun:
    | { point: Vec2; delta: Vec2; steps: number; tMonoStart: number; tMonoEnd: number }
    | undefined;

  const flushText = (): void => {
    if (textRun === undefined) return;
    gestures.push({
      type: "text",
      text: textRun.text,
      tMonoStart: textRun.tMonoStart,
      tMonoEnd: textRun.tMonoEnd,
    });
    textRun = undefined;
  };

  const flushScroll = (): void => {
    if (scrollRun === undefined) return;
    gestures.push({
      type: "scroll",
      point: scrollRun.point,
      delta: scrollRun.delta,
      steps: scrollRun.steps,
      tMonoStart: scrollRun.tMonoStart,
      tMonoEnd: scrollRun.tMonoEnd,
    });
    scrollRun = undefined;
  };

  const flushHover = (upTo: number): void => {
    if (lastMoveStart === undefined || lastMove === undefined) return;
    const dwell = Math.min(upTo, lastMove.tMono) - lastMoveStart.tMono;
    if (dwell >= o.hoverDwellMs) {
      gestures.push({
        type: "hover",
        point: lastMoveStart.point,
        dwellMs: dwell,
        tMonoStart: lastMoveStart.tMono,
        tMonoEnd: lastMoveStart.tMono + dwell,
      });
    }
    lastMoveStart = undefined;
    lastMove = undefined;
  };

  for (const e of sorted) {
    const d = asRecord(e.data);

    if (e.kind !== "scroll") flushScroll();
    if (e.kind !== "key_down" && e.kind !== "key_up") flushText();

    switch (e.kind) {
      case "mouse_down": {
        flushHover(e.tMono);
        if (downAt !== undefined) warnings.push(`mouse_down at ${downAt.tMono} had no matching mouse_up`);
        const point = { x: num(e.x, 0), y: num(e.y, 0) };
        downAt = { tMono: e.tMono, point, button: num(d.button, 1) };
        dragSamples = [{ ...point, tMono: e.tMono }];
        break;
      }

      case "mouse_move": {
        const point = { x: num(e.x, 0), y: num(e.y, 0) };
        if (downAt !== undefined) {
          dragSamples.push({ ...point, tMono: e.tMono });
        } else {
          // Track dwell: a run of near-stationary moves is a hover.
          if (
            lastMoveStart === undefined ||
            Math.hypot(point.x - lastMoveStart.point.x, point.y - lastMoveStart.point.y) > o.doubleClickPx
          ) {
            lastMoveStart = { tMono: e.tMono, point };
          }
          lastMove = { tMono: e.tMono, point };
        }
        break;
      }

      case "mouse_up": {
        if (downAt === undefined) {
          warnings.push(`mouse_up at ${e.tMono} had no matching mouse_down`);
          break;
        }
        const point = { x: num(e.x, 0), y: num(e.y, 0) };
        dragSamples.push({ ...point, tMono: e.tMono });
        const travel = Math.hypot(point.x - downAt.point.x, point.y - downAt.point.y);
        if (travel > o.dragThresholdPx) {
          gestures.push({
            type: "drag",
            from: downAt.point,
            to: point,
            samples: dragSamples,
            button: downAt.button,
            tMonoStart: downAt.tMono,
            tMonoEnd: e.tMono,
          });
        } else {
          const prev = gestures[gestures.length - 1];
          const isRepeat =
            prev !== undefined &&
            prev.type === "click" &&
            prev.button === downAt.button &&
            downAt.tMono - prev.tMonoEnd <= o.doubleClickMs &&
            Math.hypot(prev.point.x - downAt.point.x, prev.point.y - downAt.point.y) <= o.doubleClickPx;
          if (isRepeat && prev.type === "click") {
            prev.count += 1;
            prev.tMonoEnd = e.tMono;
          } else {
            gestures.push({
              type: "click",
              point: downAt.point,
              button: downAt.button,
              count: 1,
              tMonoStart: downAt.tMono,
              tMonoEnd: e.tMono,
            });
          }
        }
        downAt = undefined;
        dragSamples = [];
        break;
      }

      case "scroll": {
        flushHover(e.tMono);
        const point = { x: num(e.x, 0), y: num(e.y, 0) };
        // uiohook reports wheel rotation; direction 3 is vertical.
        const rotation = num(d.rotation, 0);
        const vertical = num(d.direction, 3) === 3;
        const step = { x: vertical ? 0 : rotation, y: vertical ? rotation : 0 };
        if (scrollRun !== undefined && e.tMono - scrollRun.tMonoEnd <= o.scrollCoalesceMs) {
          scrollRun.delta = { x: scrollRun.delta.x + step.x, y: scrollRun.delta.y + step.y };
          scrollRun.steps += 1;
          scrollRun.tMonoEnd = e.tMono;
        } else {
          flushScroll();
          scrollRun = { point, delta: step, steps: 1, tMonoStart: e.tMono, tMonoEnd: e.tMono };
        }
        break;
      }

      case "key_down": {
        const k = d as KeyData;
        const mods = Array.isArray(k.modifiers) ? k.modifiers.filter((m) => typeof m === "string") : [];
        if (k.char === undefined || k.char.length === 0) {
          warnings.push(
            `key event at ${e.tMono} has no resolved char (keycode ${String(k.keycode ?? "?")}); no text gesture emitted`,
          );
          break;
        }
        if (mods.length > 0) {
          flushText();
          gestures.push({
            type: "chord",
            keys: [...mods, k.char],
            tMonoStart: e.tMono,
            tMonoEnd: e.tMono,
          });
          break;
        }
        if (textRun === undefined) {
          textRun = { text: k.char, tMonoStart: e.tMono, tMonoEnd: e.tMono };
        } else {
          textRun.text += k.char;
          textRun.tMonoEnd = e.tMono;
        }
        break;
      }

      case "key_up": {
        // Extends the run's end stamp; the character was recorded on key_down.
        const prevChord = gestures[gestures.length - 1];
        if (textRun !== undefined) textRun.tMonoEnd = e.tMono;
        else if (prevChord !== undefined && prevChord.type === "chord") prevChord.tMonoEnd = e.tMono;
        break;
      }

      default:
        // focus_change, bookmark and anything else: a boundary for runs, but not
        // itself a gesture. Lifting reads these separately for node context.
        flushHover(e.tMono);
        break;
    }
  }

  flushText();
  flushScroll();
  flushHover(sorted[sorted.length - 1]!.tMono);
  if (downAt !== undefined) {
    warnings.push(`mouse_down at ${downAt.tMono} had no matching mouse_up`);
  }

  // Idle gaps, inserted between the gestures that survived.
  const withIdle: Gesture[] = [];
  for (const g of gestures) {
    const prev = withIdle[withIdle.length - 1];
    if (prev !== undefined) {
      const gap = g.tMonoStart - prev.tMonoEnd;
      if (gap >= o.idleGapMs) {
        withIdle.push({
          type: "idle",
          durationMs: gap,
          tMonoStart: prev.tMonoEnd,
          tMonoEnd: g.tMonoStart,
        });
      }
    }
    withIdle.push(g);
  }

  return { gestures: withIdle, warnings };
}
