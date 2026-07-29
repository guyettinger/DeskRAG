/**
 * nestAxElements — make a flat AX element list navigable as a tree.
 *
 * The sidecar emits `parent` back-references (native/ax-dump.swift), so for
 * anything captured by a current build this is a pass-through: real hierarchy is
 * never second-guessed by geometry. Elements captured before the sidecar learned
 * to emit them have no structure left except their bboxes, and a UI tree is laid
 * out as nested boxes, so those are nested by containment instead — approximate,
 * but far more useful than a flat list of a few thousand tags.
 *
 * Pure (no store, no native code), which is what makes it barrel-safe and lets
 * the app's main process fill the links before the DTO crosses IPC — the
 * renderer then only ever consumes `parent`/`depth`.
 */

import type { UIElement } from "../../embed/types.js";

const area = (e: UIElement): number => Math.max(0, e.w) * Math.max(0, e.h);

/** Does `outer` fully contain `inner`? `tol` absorbs sub-pixel AX rounding. */
function contains(outer: UIElement, inner: UIElement, tol = 1): boolean {
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    inner.x + inner.w <= outer.x + outer.w + tol &&
    inner.y + inner.h <= outer.y + outer.h + tol
  );
}

export function nestAxElements(elements: readonly UIElement[]): UIElement[] {
  if (elements.some((e) => e.parent !== undefined)) return elements.map((e) => ({ ...e }));

  const out = elements.map((e) => ({ ...e }));
  // Largest box first, so every candidate ancestor is placed before its
  // descendants. Ties keep input order (Array#sort is stable), which makes the
  // identical-bbox wrappers AX loves to emit nest deterministically.
  const order = out.map((_, i) => i).sort((a, b) => area(out[b]!) - area(out[a]!));
  const placed: number[] = [];
  for (const i of order) {
    const el = out[i]!;
    // Scan placed boxes smallest-first: the first container found is the
    // tightest one, i.e. the true parent. (A pop-as-you-go ancestor stack is
    // tempting and wrong — area order is not a DFS order, so it discards
    // ancestors a later sibling subtree still needs.) O(n^2) worst case, but n is
    // capped by the sidecar's 4000-node walk and this only runs for legacy data.
    for (let k = placed.length - 1; k >= 0; k--) {
      const cand = placed[k]!;
      if (contains(out[cand]!, el)) {
        el.parent = cand;
        el.depth = (out[cand]!.depth ?? 0) + 1;
        break;
      }
    }
    placed.push(i);
  }
  return out;
}
