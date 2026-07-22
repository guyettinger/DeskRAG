/**
 * Parse/validate the sidecar's JSON output into UIElement[]. Pure and defensive:
 * malformed JSON or elements missing a role/bbox are dropped rather than trusted,
 * so a flaky sidecar degrades to fewer (or zero) AX regions, never a crash.
 *
 * Expected element shape: { role: string, label?: string, x,y,w,h: number,
 * focused?: boolean } — bboxes in global screen coordinates (top-left origin),
 * the same space as mouse-hotspot points.
 */

import type { UIElement } from "../../embed/types.js";

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export function coerceAxElements(data: unknown): UIElement[] {
  if (!Array.isArray(data)) return [];
  const out: UIElement[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const x = finite(o.x);
    const y = finite(o.y);
    const w = finite(o.w);
    const h = finite(o.h);
    const role = typeof o.role === "string" && o.role.length > 0 ? o.role : undefined;
    if (x === undefined || y === undefined || w === undefined || h === undefined || role === undefined) {
      continue;
    }
    const el: UIElement = { role, x, y, w, h };
    if (typeof o.label === "string" && o.label.length > 0) el.label = o.label;
    if (o.focused === true) el.focused = true;
    out.push(el);
  }
  return out;
}

export function parseAxElements(text: string): UIElement[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  return coerceAxElements(data);
}
