/**
 * The executor's vocabulary. Types plus the two tuning constants and the one
 * scoring function that belongs with them.
 *
 * `replay/` is a leaf: it imports `trace/` and `embed/types` and nothing else
 * from the library. Everything external — the live AX tree, actuation, the
 * keyboard layout — arrives through the interfaces declared here.
 */

import type { Keymap } from "../capture/env/types.js";
import type { UIElement } from "../embed/types.js";
import type {
  Action,
  Anchor,
  Graph,
  Predicate,
  Reach,
  Rect,
  Vec2,
  VisualMatcher,
} from "../trace/types.js";

export type { UIElement, Keymap };
export type { Predicate, Reach, Rect, Vec2, Anchor, Action, Graph, VisualMatcher };

/** The anchor ladder, best first. */
export type ResolvedLayer = "identifier" | "path" | "label" | "visual" | "point";

/**
 * The confidence a layer can reach before geometric disagreement reduces it.
 *
 * Ranked by RELIABILITY, not availability — availability turned out to be an
 * app-specific measurement and a bad guide. Across real recordings AXIdentifier
 * appears on 50-80% of AX anchors in TextEdit but only 9% in Chrome, where a
 * label is four times more common; ranking by "whichever we saw most" would have
 * encoded one app's AX implementation as a general rule.
 *
 * Identifier is first because it is app-assigned and survives sibling insertion.
 * **Label outranks path** because a positional path's reliability collapses with
 * depth: measured web-content paths run 11-17 levels deep (a Chrome TextField
 * averages 13) against 1-4 for native controls, and any sibling insertion at any
 * one of those levels shifts the ordinal. The accepted cost is native precision,
 * where a depth-3 path is likely steadier than a content-dependent label.
 *
 * `point` sits lowest because a coordinate click carries no evidence at all that
 * the thing under the cursor is the thing recorded.
 */
export const LAYER_CEILING: Readonly<Record<ResolvedLayer, number>> = {
  identifier: 1.0,
  label: 0.8,
  path: 0.6,
  visual: 0.5,
  point: 0.3,
};

/** Below this, a layer is rejected and the ladder falls through. */
export const DEFAULT_MIN_CONFIDENCE = 0.25;

/**
 * An edge whose targets resolve below the `visual` rung more often than not
 * cannot be armed without an explicit override. 0.5 is a starting point, not a
 * finding: the measured whole-graph rate is 55%, so this gates roughly half of
 * real edges — the intended aggressiveness for a system whose first act is
 * clicking a real desktop.
 */
export const BRITTLENESS_FLOOR = 0.5;

/** One rung's worth of AX descriptor — a projection of `Anchor["ax"]`. */
export interface AxDescriptor {
  identifier?: string;
  path?: string;
  role: string;
  label?: string;
}

/** Resolve a descriptor against the live tree. Returns null when it is gone. */
export type Locate = (d: AxDescriptor) => Promise<{ handle: number; bounds: Rect } | null>;

/**
 * Everything that touches the desktop. `execute.ts` depends only on this, which
 * is what makes the suite structurally incapable of posting a real event.
 */
export interface Actuator {
  /** Live AX tree of the frontmost app, for verification and resolution. */
  dump(): Promise<UIElement[]>;
  locate(d: AxDescriptor): Promise<{ handle: number; bounds: Rect } | null>;
  moveTo(p: Vec2): Promise<void>;
  click(p: Vec2, button: number, count: number): Promise<void>;
  dragPath(samples: readonly { p: Vec2; atMs: number }[], button: number): Promise<void>;
  scroll(p: Vec2, delta: Vec2, steps: number): Promise<void>;
  key(keycode: number, modifiers: readonly string[], down: boolean): Promise<void>;
}

export interface Resolution {
  layer: ResolvedLayer;
  /** Where the action will actually go. */
  point: Vec2;
  bounds?: Rect;
  /**
   * [0,1] — how much the resolved target AGREES with the recorded one. Starts at
   * the layer's ceiling and is reduced by geometric disagreement. It is NOT a
   * probability that the action will succeed; nothing here can know that.
   */
  confidence: number;
  /** Layers tried and why each was rejected — the brittleness record. */
  attempts: { layer: ResolvedLayer; rejected: string }[];
}

export interface PlannedAction {
  edgeId: string;
  action: Action;
  /** Absent for `chord`, `type`, and `wait`, which have no spatial target. */
  resolution?: Resolution;
  slotBinding?: { name: string; value: string };
}

/** An `assertable` predicate that does not hold, or an unusable `type` action. */
export interface Blocker {
  predicate?: Predicate;
  reason: string;
}

export interface EdgeBrittleness {
  edgeId: string;
  /** Share of this edge's targets that resolved to an AX rung. */
  axRate: number;
  belowFloor: boolean;
}

export interface Plan {
  id: string;
  graphId: string;
  /** Node id observed at plan time. */
  from: string;
  /** Goal node id. */
  to: string;
  steps: PlannedAction[];
  /** Non-empty means the plan cannot be armed. */
  blockers: Blocker[];
  brittleness: EdgeBrittleness[];
}

export interface ReplayInput {
  graph: Graph;
  actuator: Actuator;
  /**
   * The layout to type through, in reverse (char -> keycode). NOT optional and
   * NOT defaulted: the lift resolved keycode -> char against a captured keymap,
   * and typing through a different one is silently wrong text. A US-QWERTY
   * fallback is exactly what the capture spec rejected a static table to avoid.
   */
  keymap: Keymap;
  /** Optional visual corroboration for the `visual` rung. */
  visualMatcher?: VisualMatcher;
}

export interface ExecOutcome {
  planId: string;
  completed: boolean;
  stepsRun: number;
  failure?: { step: number; reason: string };
  telemetry: { edgeId: string; layer: ResolvedLayer; confidence: number }[];
}

const area = (r: Rect): number => Math.max(0, r.w) * Math.max(0, r.h);
const centre = (r: Rect): Vec2 => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * How much `actual` agrees with `recorded`, in [0,1] — the product of area
 * similarity and centre proximity. Proximity is normalized by the recorded box's
 * diagonal, so "far" means far RELATIVE TO THE TARGET: 40px is a different
 * distance for a menu item than for a window.
 */
export function agreement(recorded: Rect, actual: Rect): number {
  const aR = area(recorded);
  const aA = area(actual);
  const areaRatio = aR > 0 && aA > 0 ? Math.min(aR, aA) / Math.max(aR, aA) : 0;

  const cR = centre(recorded);
  const cA = centre(actual);
  const dist = Math.hypot(cA.x - cR.x, cA.y - cR.y);
  const diag = Math.hypot(recorded.w, recorded.h);
  // A degenerate recorded box has no scale to judge against, so proximity is
  // unknowable rather than perfect.
  const proximity = diag > 0 ? Math.max(0, 1 - dist / diag) : 0;

  const score = areaRatio * proximity;
  return Math.min(1, Math.max(0, score));
}
