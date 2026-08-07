/**
 * Binds the digest's two injected callbacks to the store, the same way
 * `trace-index.ts` binds `liftTrace`'s — which is precisely why
 * `src/represent/digest.ts` can stay pure and know nothing about SQLite.
 *
 * Both resolve **latest at-or-before the t_mono** against the session's own
 * recorded stream, the one rule every environment fact in this repo follows.
 * A keyboard layout and the pixels on screen both change mid-session, and
 * resolving either against the wrong moment is a silent corruption: text decoded
 * with the wrong layout, a click attributed to a button that was not there yet.
 */

import type { DigestContext, DualStore, RegionRow, TraceEvent } from "deskrag";
import { environmentOf, latestAt, type Timeline } from "./trace-index.js";

/**
 * The smallest region containing the point wins. Regions come from three fused
 * sources at several scales — a grid tile and an AX button can both contain one
 * click — and the smallest is the most specific thing named at that spot, the
 * same "most specific wins" rule `bestSegment` and `detail()` use for segments.
 *
 * Unlabelled regions (grid tiles, hotspots) are skipped rather than returned
 * empty: the digest wants a NAME, and absence is meaningful.
 */
function labelInRegions(
  regions: readonly RegionRow[],
  point: { x: number; y: number },
): string | undefined {
  let best: RegionRow | undefined;
  for (const r of regions) {
    if (r.label === null || r.label.length === 0) continue;
    if (point.x < r.x || point.x > r.x + r.w) continue;
    if (point.y < r.y || point.y > r.y + r.h) continue;
    if (best === undefined || r.w * r.h < best.w * best.h) best = r;
  }
  return best?.label ?? undefined;
}

/**
 * The digest context for one session. Both callbacks degrade to `undefined`
 * rather than guessing: no `keymap_change` event means NO typed text is
 * recovered (never a US-QWERTY fallback), and no keyframe or no labelled region
 * under a click means no label.
 *
 * AX bboxes and mouse coordinates are both global SCREEN coordinates, so the
 * containment test needs no frame-space mapping — unlike the stored JPEG, which
 * may be downscaled.
 */
export function digestContextFor(store: DualStore, sessionId: string): DigestContext {
  const events = store.getEventsBySession(sessionId) as unknown as TraceEvent[];
  const { keymaps } = environmentOf(events);

  // The focus timeline, built here rather than in environmentOf because that one
  // keeps only `bounds` (what the trace lift needs) and drops app/title.
  //
  // The two event kinds compose differently, and conflating them is a real
  // error: a `focus_change` REPLACES the whole state (switching to TextEdit must
  // not leave Chrome's URL attached), while a `url_change` carries only a URL
  // and must not erase the app and title the focus before it established.
  type Focus = { app?: string; title?: string; url?: string };
  const focus: Timeline<Focus>[] = [];
  for (const e of events) {
    if (e.kind !== "focus_change" && e.kind !== "url_change") continue;
    const d = e.data !== null && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {};
    const str = (k: string): string | undefined => {
      const v = d[k];
      return typeof v === "string" && v.length > 0 ? v : undefined;
    };
    const prev: Focus = focus[focus.length - 1]?.value ?? {};
    const value: Focus =
      e.kind === "focus_change"
        ? {
            ...(str("app") !== undefined ? { app: str("app")! } : {}),
            ...(str("title") !== undefined ? { title: str("title")! } : {}),
            ...(str("url") !== undefined ? { url: str("url")! } : {}),
          }
        : {
            ...prev,
            ...(str("url") !== undefined ? { url: str("url")! } : {}),
          };
    focus.push({ tMono: e.tMono, value });
  }

  // Frames in t_mono order, so a click can find the keyframe that was current.
  const frames = store.getFramesBySession(sessionId);
  const regionCache = new Map<string, RegionRow[]>();

  return {
    keymapAt: (tMono) => latestAt(keymaps, tMono),
    focusAt: (tMono) => latestAt(focus, tMono),
    labelAt: (point, tMono) => {
      let frameId: string | undefined;
      for (const f of frames) {
        if (f.tMono > tMono) break;
        frameId = f.id;
      }
      if (frameId === undefined) return undefined;
      const cached = regionCache.get(frameId);
      const regions = cached ?? store.getRegionsByFrame(frameId);
      if (cached === undefined) regionCache.set(frameId, regions);
      return labelInRegions(regions, point);
    },
  };
}
