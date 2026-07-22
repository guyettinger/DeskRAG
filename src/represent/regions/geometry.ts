/** Box geometry shared by the region sources and fusion. */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function area(b: Box): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

export function intersectionArea(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

/** Intersection-over-union in [0, 1]. */
export function iou(a: Box, b: Box): number {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Clamp a box to the frame bounds (drops any part outside [0,w]x[0,h]). */
export function clampToFrame(b: Box, frameW: number, frameH: number): Box {
  const x = Math.max(0, Math.min(b.x, frameW));
  const y = Math.max(0, Math.min(b.y, frameH));
  return {
    x,
    y,
    w: Math.max(0, Math.min(b.x + b.w, frameW) - x),
    h: Math.max(0, Math.min(b.y + b.h, frameH) - y),
  };
}
