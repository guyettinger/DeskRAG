/**
 * Defensive coercion of the sidecar's environment payloads. Pure. Malformed
 * entries are dropped rather than trusted, so a flaky sidecar degrades to fewer
 * (or zero) facts, never a crash — the same discipline as `ax/parse.ts`.
 */

import type { DisplayInfo, Keymap } from "./types.js";

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export function coerceDisplays(data: unknown): DisplayInfo[] {
  if (!Array.isArray(data)) return [];
  const out: DisplayInfo[] = [];
  for (const raw of data) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id.length > 0 ? o.id : undefined;
    const x = finite(o.x);
    const y = finite(o.y);
    const w = finite(o.w);
    const h = finite(o.h);
    const scale = finite(o.scale);
    if (id === undefined || x === undefined || y === undefined) continue;
    if (w === undefined || h === undefined || scale === undefined) continue;
    out.push({ id, x, y, w, h, scale, primary: o.primary === true });
  }
  return out;
}

/**
 * `undefined` (not an empty map) when the payload is unusable — an absent keymap
 * must stay distinguishable from a layout that resolved zero keys, because the
 * first warns and the second is a real answer.
 */
export function coerceKeymap(data: unknown): Keymap | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const o = data as Record<string, unknown>;
  const layoutId = typeof o.layoutId === "string" && o.layoutId.length > 0 ? o.layoutId : undefined;
  if (layoutId === undefined) return undefined;
  if (o.entries === null || typeof o.entries !== "object") return undefined;

  const entries: Keymap["entries"] = {};
  for (const [k, v] of Object.entries(o.entries as Record<string, unknown>)) {
    const code = Number(k);
    if (!Number.isInteger(code) || code < 0) continue;
    if (!Array.isArray(v) || v.length !== 4) continue;
    if (!v.every((s) => typeof s === "string")) continue;
    entries[code] = [v[0] as string, v[1] as string, v[2] as string, v[3] as string];
  }
  return { layoutId, entries };
}
