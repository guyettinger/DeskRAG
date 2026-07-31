/**
 * Parse/validate the sidecar's JSON output into UIElement[]. Pure and defensive:
 * malformed JSON or elements missing a role/bbox are dropped rather than trusted,
 * so a flaky sidecar degrades to fewer (or zero) AX regions, never a crash.
 *
 * Expected element shape: { role: string, label?: string, x,y,w,h: number,
 * focused?: boolean, parent?: number } — bboxes in global screen coordinates
 * (top-left origin), the same space as mouse-hotspot points.
 *
 * `parent` is an index into the *input* array, and dropping an invalid element
 * shifts every index after it, so parents are remapped onto output positions as
 * we go. That works in a single pass because the sidecar emits pre-order: a
 * parent always precedes its children. `depth` is derived here rather than read
 * off the wire, so it can never disagree with `parent` after a drop. An element
 * with no (surviving) parent carries neither field — a payload without hierarchy
 * round-trips unchanged.
 */

import type { UIElement } from "../../embed/types.js";

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const index = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;

export function coerceAxElements(data: unknown): UIElement[] {
  if (!Array.isArray(data)) return [];
  const out: UIElement[] = [];
  /** Input index -> output index, or -1 when that element was dropped. */
  const srcToOut: number[] = [];
  for (let i = 0; i < data.length; i++) {
    srcToOut.push(-1);
    const raw: unknown = data[i];
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
    if (typeof o.identifier === "string" && o.identifier.length > 0) el.identifier = o.identifier;
    if (o.focused === true) el.focused = true;
    // A parent must be an EARLIER element — that rejects forward references and
    // self-links, so the result cannot contain a cycle. A parent that was itself
    // dropped leaves this element as a root rather than dangling.
    const parent = index(o.parent);
    if (parent !== undefined && parent < i) {
      const mapped = srcToOut[parent]!;
      if (mapped >= 0) {
        el.parent = mapped;
        el.depth = (out[mapped]!.depth ?? 0) + 1;
      }
    }
    srcToOut[i] = out.length;
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
