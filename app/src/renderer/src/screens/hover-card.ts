/**
 * Where a hover card sits, given where the cursor is and how big the card came
 * out.
 *
 * A `.ts` module, never `.tsx`: the root `tsconfig.json` sets no `jsx`, so this
 * is what the root suite can reach — the `track-view.ts` / `graph-layout.ts`
 * precedent. It is arithmetic and a viewport, nothing more.
 *
 * Extracted from `TrackRail`'s `ReadoutCard`, which had it inline, when the
 * recurrence ledger grew a card of its own. Two copies of one clamping rule is
 * the `ax-dump`/`ax-exec` drift hazard in miniature: they would agree until one
 * of them was tuned, and the difference would be a card half off the screen on
 * one surface and not the other.
 *
 * The size MUST be measured, never estimated. The rail's card flipped on a
 * 336x260 guess and the real thing is ~550px with sixteen lanes, so it ran off
 * the bottom of the window at exactly the moment the reader had asked for
 * everything — see docs/internals/app-ui.md.
 */

export interface TipPlacement {
  left: number;
  top: number;
}

export interface TipViewport {
  width: number;
  height: number;
}

export interface TipOptions {
  /** Distance from the cursor, so the card never sits under the pointer. */
  offset: number;
  /** Breathing room between the card and the window edge. */
  margin: number;
}

/**
 * FLIPPED horizontally, CLAMPED vertically — and the asymmetry is deliberate.
 *
 * Sideways there is a good answer: a card that would overflow the right edge
 * has the whole left of the cursor to live in, so it moves there whole.
 * Vertically a card taller than the space on either side has no good anchor at
 * all, so it is pinned inside the window rather than flipped into an equally
 * bad position.
 */
export function clampTip(
  cursor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: TipViewport,
  { offset, margin }: TipOptions,
): TipPlacement {
  const right = cursor.x + offset + size.width;
  return {
    left:
      right > viewport.width - margin
        ? Math.max(margin, cursor.x - offset - size.width)
        : cursor.x + offset,
    top: Math.max(
      margin,
      Math.min(cursor.y + offset, viewport.height - size.height - margin),
    ),
  };
}
