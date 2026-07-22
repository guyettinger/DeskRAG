/**
 * Source A — Accessibility tree. The OS hands us real, labeled bboxes for free;
 * this is our biggest edge over pure-pixel video RAG. But the raw tree is mostly
 * noise (whole-window containers, tiny slivers, deeply nested duplicates), so we
 * filter HARD:
 *   - drop slivers below minArea,
 *   - drop whole-window containers above maxAreaFraction of the frame,
 *   - keep only useful roles (and never keepable "structural" roles),
 *   - collapse near-identical nested boxes (keep the higher-priority one).
 *
 * Priority rewards a real label and the focused element, so budgeting later keeps
 * the things the user is actually looking at.
 *
 * Capturing the AX tree itself needs a native macOS addon (deferred); this pure
 * function operates on whatever UIElement[] a source provides.
 */

import type { Region, UIElement } from "../../embed/types.js";
import { area, iou } from "./geometry.js";

/** Roles that are almost always pure structure, never worth a region on their own. */
const DEFAULT_DROP_ROLES = new Set([
  "window", "application", "group", "unknown", "layout-area", "splitter", "scrollarea",
]);

export interface AxFilterOptions {
  frameW: number;
  frameH: number;
  minArea?: number;
  maxAreaFraction?: number;
  keepRoles?: Set<string>;
  dropRoles?: Set<string>;
  collapseIoU?: number;
}

function priorityFor(el: UIElement): number {
  let p = 2; // AX base — above hotspots(≈1-2) and grid(0.5)
  if (el.label && el.label.length > 0) p += 1;
  if (el.focused) p += 2;
  return p;
}

export function axFilter(elements: readonly UIElement[], opts: AxFilterOptions): Region[] {
  const frameArea = Math.max(1, opts.frameW * opts.frameH);
  const minArea = opts.minArea ?? 64; // ~8x8 px
  const maxAreaFraction = opts.maxAreaFraction ?? 0.5;
  const collapseIoU = opts.collapseIoU ?? 0.7;
  // Role matching is case-insensitive and "AX"-prefix agnostic, so the same sets
  // work whether roles arrive as "button" (tests) or "AXButton" (macOS AX API).
  const norm = (r: string) => r.replace(/^AX/i, "").toLowerCase();
  const dropRoles = new Set([...(opts.dropRoles ?? DEFAULT_DROP_ROLES)].map(norm));
  const keepRoles = opts.keepRoles ? new Set([...opts.keepRoles].map(norm)) : undefined;

  const candidates: Region[] = [];
  for (const el of elements) {
    const a = area(el);
    if (a < minArea) continue; // sliver
    if (a > maxAreaFraction * frameArea) continue; // whole-window container
    const roleKey = norm(el.role);
    if (dropRoles.has(roleKey)) continue;
    if (keepRoles && !keepRoles.has(roleKey)) continue;
    candidates.push({
      x: el.x, y: el.y, w: el.w, h: el.h,
      source: "ax",
      priority: priorityFor(el),
      ...(el.role ? { role: el.role } : {}),
      ...(el.label ? { label: el.label } : {}),
    });
  }

  // Collapse near-identical nested boxes: keep higher priority, then smaller
  // (more specific) box, dropping others that overlap it heavily.
  candidates.sort((r1, r2) => r2.priority - r1.priority || area(r1) - area(r2));
  const kept: Region[] = [];
  for (const c of candidates) {
    if (kept.some((k) => iou(k, c) > collapseIoU)) continue;
    kept.push(c);
  }
  return kept;
}
