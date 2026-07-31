/**
 * The layered anchor: up to three independent descriptions of one target,
 * resolved `ax -> visual -> point` at replay.
 *
 * All three are recorded here, at lift time, from the AX tree and regions
 * captured at that moment — never re-derived from one another later. A layer is
 * either fully populated or absent; a half-populated layer would resolve to
 * something plausible and wrong.
 *
 * Pure: no store, no clock, no I/O.
 */

import { nestAxElements } from "../capture/ax/tree.js";
import type { Anchor, AnchorRegion, Rect, UIElement, Vec2 } from "./types.js";

/** Grid used to key a point-only anchor, in px. */
const POINT_KEY_QUANTUM = 16;

const containsPoint = (e: { x: number; y: number; w: number; h: number }, p: Vec2): boolean =>
  p.x >= e.x && p.x <= e.x + e.w && p.y >= e.y && p.y <= e.y + e.h;

const area = (e: { w: number; h: number }): number => Math.max(0, e.w) * Math.max(0, e.h);

/**
 * `AXWindow[0]>AXGroup[0]>AXButton[1]` — the ancestor chain, with each step's
 * ordinal among siblings *of the same role*. Role+label alone is not unique
 * within a window, which is why the anchor stores a path.
 */
export function axPathOf(elements: readonly UIElement[], index: number): string {
  const nested = nestAxElements(elements);
  const chain: number[] = [];
  for (let i: number | undefined = index; i !== undefined; i = nested[i]?.parent) {
    chain.push(i);
    if (chain.length > 128) break; // defensive: a malformed parent cycle
  }
  chain.reverse();

  return chain
    .map((i) => {
      const el = nested[i]!;
      const siblings = nested
        .map((e, j) => ({ e, j }))
        .filter(({ e }) => e.parent === el.parent && e.role === el.role)
        .map(({ j }) => j);
      return `${el.role}[${siblings.indexOf(i)}]`;
    })
    .join(">");
}

/**
 * The deepest element containing `p`. Ties break to the smaller box, then to the
 * lower index — deterministic, because two captures of one screen must resolve a
 * click identically.
 */
export function hitTest(elements: readonly UIElement[], p: Vec2): number | undefined {
  if (elements.length === 0) return undefined;
  const nested = nestAxElements(elements);
  let best: number | undefined;
  for (let i = 0; i < nested.length; i++) {
    const e = nested[i]!;
    if (!containsPoint(e, p)) continue;
    if (best === undefined) {
      best = i;
      continue;
    }
    const cur = nested[best]!;
    const dDepth = (e.depth ?? 0) - (cur.depth ?? 0);
    if (dDepth > 0 || (dDepth === 0 && area(e) < area(cur))) best = i;
  }
  return best;
}

export interface AnchorInput {
  point: Vec2;
  displayId: string;
  /** Global bounds of the focused window, for `windowRelative`. */
  windowBounds?: Rect;
  ax?: readonly UIElement[];
  /** pHash of the frame the regions were proposed from. */
  framePhash?: string;
  regions?: readonly AnchorRegion[];
}

export function buildAnchor(input: AnchorInput): Anchor {
  const anchor: Anchor = {
    point: {
      x: input.point.x,
      y: input.point.y,
      displayId: input.displayId,
      ...(input.windowBounds !== undefined
        ? {
            windowRelative: {
              x: input.point.x - input.windowBounds.x,
              y: input.point.y - input.windowBounds.y,
            },
          }
        : {}),
    },
  };

  if (input.ax !== undefined && input.ax.length > 0) {
    const hit = hitTest(input.ax, input.point);
    if (hit !== undefined) {
      const el = nestAxElements(input.ax)[hit]!;
      anchor.ax = {
        role: el.role,
        ...(el.label !== undefined && el.label.length > 0 ? { label: el.label } : {}),
        path: axPathOf(input.ax, hit),
      };
    }
  }

  // The visual layer needs both a region and the pHash of the frame it came
  // from; without the pHash there is nothing for corroboration to key on, so the
  // layer is omitted rather than half-filled.
  if (input.framePhash !== undefined && input.regions !== undefined) {
    let tightest: AnchorRegion | undefined;
    for (const r of input.regions) {
      if (!containsPoint(r, input.point)) continue;
      if (tightest === undefined || area(r) < area(tightest)) tightest = r;
    }
    if (tightest !== undefined) {
      anchor.visual = {
        regionId: tightest.id,
        framePhash: input.framePhash,
        bbox: { x: tightest.x, y: tightest.y, w: tightest.w, h: tightest.h },
      };
    }
  }

  return anchor;
}

/**
 * Stable key for edge equivalence in `merge.ts`. Prefers the AX layer so two
 * recordings of the same click key identically despite a few px of drift; falls
 * back to a quantized point, which is coarse on purpose for the same reason.
 */
export function anchorKey(a: Anchor): string {
  if (a.ax !== undefined) return `ax:${a.ax.path}:${a.ax.label ?? ""}`;
  const qx = Math.round(a.point.x / POINT_KEY_QUANTUM);
  const qy = Math.round(a.point.y / POINT_KEY_QUANTUM);
  return `pt:${a.point.displayId}:${qx},${qy}`;
}
