/**
 * The anchor ladder: `identifier -> label -> path -> visual -> point`.
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
  DEFAULT_MIN_CONFIDENCE,
  LAYER_CEILING,
  type AxDescriptor,
  type Locate,
  type Resolution,
  type ResolvedLayer,
} from "./types.js";

export interface ResolveOptions {
  /** Below this a rung is rejected and the ladder falls through. */
  minConfidence?: number;
}

/** The AX rungs, in order, with the descriptor each one keys on. */
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
  // Path is LAST: it is the only rung always available, but a positional ordinal
  // chain 11-17 levels deep (measured in web content) breaks on any sibling
  // insertion anywhere along it. It is the fallback, not the preference.
  {
    layer: "path",
    descriptor: (ax) => (ax.path.length > 0 ? { path: ax.path, role: ax.role } : undefined),
  },
];

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

  if (anchor.ax !== undefined) {
    const ax = anchor.ax;
    for (const rung of AX_RUNGS) {
      const descriptor = rung.descriptor(ax);
      if (descriptor === undefined) continue; // not recorded — not an attempt
      const hit = await locate(descriptor);
      if (hit === null) {
        attempts.push({ layer: rung.layer, rejected: "not found in the live AX tree" });
        continue;
      }
      const ceiling = LAYER_CEILING[rung.layer];
      // With no recorded box there is nothing to disagree with, so the rung
      // keeps its ceiling: absence of evidence is not evidence of mismatch.
      const confidence =
        recordedBox !== undefined ? ceiling * agreement(recordedBox, hit.bounds) : ceiling;
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
