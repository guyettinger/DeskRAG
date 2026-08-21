/**
 * The anchor ladder. `identifier` is always first and `point` always last; the
 * middle is ORDERED BY TRUST rather than fixed, because a path's reliability
 * depends on its depth and the applications measured disagree about whether a
 * label or a path is the better anchor — they disagree because their depths
 * differ. See `pathCeiling`.
 *
 * Each rung is tried against the AX tree AS IT IS NOW, and a rung that resolves
 * to a box wildly unlike the recorded one is rejected rather than trusted —
 * silently clicking a plausible wrong element is the failure worth preventing.
 *
 * Layers are NEVER derived from one another. An anchor with no `ax` layer does
 * not get one invented from its coordinates at replay time; that derivation is
 * exactly the drift the IR forbids.
 *
 * Pure: no subprocess, no clock, no I/O of its own. `locate` is injected.
 */

import type { Anchor, Rect, Vec2 } from "../trace/types.js";
import {
  agreement,
  ceilingFor,
  DEFAULT_MIN_CONFIDENCE,
  LAYER_CEILING,
  pathDepth,
  type AxDescriptor,
  type Locate,
  type Resolution,
  type ResolvedLayer,
} from "./types.js";

export interface ResolveOptions {
  /** Below this a rung is rejected and the ladder falls through. */
  minConfidence?: number;
  /**
   * Origin of the window the live element sits in. Supplying it makes geometric
   * agreement WINDOW-RELATIVE instead of absolute, which is what stops a moved
   * window from vetoing a correctly-identified element.
   *
   * Measured live: TextEdit's text view resolved by identifier to bounds of
   * exactly the recorded size, 2310px right of where it was recorded because the
   * window had moved. Compared absolutely, agreement was 0.0000 and the rung was
   * rejected — dropping the ladder to `point`, which clicks where the element is
   * NOT. The fallback was strictly worse than the rung it rejected. In window
   * space the same measurement is 1.0000.
   */
  windowOrigin?: Vec2;
}

/**
 * The window origin at RECORD time, derived from the anchor: the point is
 * global and `windowRelative` is its offset within the window, so their
 * difference is where the window was. Undefined when the anchor recorded no
 * window-relative offset, in which case comparison stays absolute.
 */
function recordedWindowOrigin(anchor: Anchor): Vec2 | undefined {
  const wr = anchor.point.windowRelative;
  if (wr === undefined) return undefined;
  return { x: anchor.point.x - wr.x, y: anchor.point.y - wr.y };
}

const relativeTo = (r: Rect, origin: Vec2): Rect => ({
  x: r.x - origin.x,
  y: r.y - origin.y,
  w: r.w,
  h: r.h,
});

/** The AX rungs and the descriptor each one keys on. Order is computed below. */
const AX_RUNGS: {
  layer: ResolvedLayer;
  descriptor: (ax: NonNullable<Anchor["ax"]>) => AxDescriptor | undefined;
}[] = [
  {
    layer: "identifier",
    descriptor: (ax) =>
      ax.identifier !== undefined && ax.identifier.length > 0
        ? { identifier: ax.identifier, role: ax.role }
        : undefined,
  },
  {
    layer: "label",
    descriptor: (ax) =>
      ax.label !== undefined && ax.label.length > 0
        ? { label: ax.label, role: ax.role }
        : undefined,
  },
  {
    layer: "path",
    descriptor: (ax) => (ax.path.length > 0 ? { path: ax.path, role: ax.role } : undefined),
  },
];

/**
 * The rungs this anchor actually carries, most-trusted first. Sorting by ceiling
 * is what makes the order depth-sensitive: a shallow path outranks a label, a
 * deep one falls behind it. Ties keep the declared order, so the ranking is
 * deterministic — two resolutions of one anchor must try rungs identically.
 */
function rungsFor(
  ax: NonNullable<Anchor["ax"]>,
): { layer: ResolvedLayer; descriptor: AxDescriptor; ceiling: number }[] {
  const depth = pathDepth(ax.path);
  return AX_RUNGS.flatMap((rung, declared) => {
    const descriptor = rung.descriptor(ax);
    if (descriptor === undefined) return []; // not recorded — not a rung
    return [{ layer: rung.layer, descriptor, ceiling: ceilingFor(rung.layer, depth), declared }];
  })
    .sort((a, b) => b.ceiling - a.ceiling || a.declared - b.declared)
    .map(({ layer, descriptor, ceiling }) => ({ layer, descriptor, ceiling }));
}

/**
 * Keep the recorded point's OFFSET within its box, so a moved element is still
 * clicked in the same spot — the centre is not always the right target (think of
 * a disclosure triangle at the left edge of a wide row).
 */
function reproject(point: Vec2, recorded: Rect | undefined, actual: Rect): Vec2 {
  if (recorded === undefined || recorded.w <= 0 || recorded.h <= 0) {
    return { x: actual.x + actual.w / 2, y: actual.y + actual.h / 2 };
  }
  const fx = (point.x - recorded.x) / recorded.w;
  const fy = (point.y - recorded.y) / recorded.h;
  return { x: actual.x + fx * actual.w, y: actual.y + fy * actual.h };
}

export async function resolveAnchor(
  anchor: Anchor,
  locate: Locate,
  opts: ResolveOptions = {},
): Promise<Resolution> {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const attempts: { layer: ResolvedLayer; rejected: string }[] = [];
  const point: Vec2 = { x: anchor.point.x, y: anchor.point.y };
  // The recorded box, used to judge agreement. Only the visual layer records one.
  const recordedBox = anchor.visual?.bbox;

  // Compare in window space when BOTH origins are known — a window that merely
  // moved then agrees perfectly, and only a real layout change reduces trust.
  const recOrigin = recordedWindowOrigin(anchor);
  /**
   * The hit's own surface WINS over the caller's window origin.
   *
   * The caller supplies one origin for the whole observation, chosen before
   * anything has been located — so it cannot know that a rung is about to land
   * inside a menu, which the OS called a window when the anchor was recorded.
   * Only the hit knows what it is in. `opts.windowOrigin` remains the answer
   * for every resolver that cannot see an ancestor chain.
   */
  const judge = (live: Rect, hitOrigin: Vec2 | undefined): number | undefined => {
    if (recordedBox === undefined) return undefined; // nothing to disagree with
    const liveOrigin = hitOrigin ?? opts.windowOrigin;
    return recOrigin !== undefined && liveOrigin !== undefined
      ? agreement(relativeTo(recordedBox, recOrigin), relativeTo(live, liveOrigin))
      : agreement(recordedBox, live);
  };

  if (anchor.ax !== undefined) {
    for (const rung of rungsFor(anchor.ax)) {
      const hit = await locate(rung.descriptor);
      if (hit === null) {
        attempts.push({ layer: rung.layer, rejected: "not found in the live AX tree" });
        continue;
      }
      // With no recorded box there is nothing to disagree with, so the rung
      // keeps its ceiling: absence of evidence is not evidence of mismatch.
      const agreed = judge(hit.bounds, hit.surfaceOrigin);
      const confidence = agreed !== undefined ? rung.ceiling * agreed : rung.ceiling;
      if (confidence < minConfidence) {
        attempts.push({
          layer: rung.layer,
          rejected: `resolved, but confidence ${confidence.toFixed(2)} is below ${minConfidence}`,
        });
        continue;
      }
      return {
        layer: rung.layer,
        point: reproject(point, recordedBox, hit.bounds),
        bounds: hit.bounds,
        confidence,
        attempts,
      };
    }
  }

  // The visual rung is recorded but cannot be corroborated without a matcher and
  // a live frame; it is attempted so the ladder's shape is honest in telemetry.
  if (anchor.visual !== undefined) {
    attempts.push({ layer: "visual", rejected: "no live frame to corroborate against" });
  }

  return { layer: "point", point, confidence: LAYER_CEILING.point, attempts };
}
