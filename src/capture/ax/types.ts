/**
 * AxSource — the seam the native accessibility reader plugs into. `query()`
 * returns the current window's UI elements, best-effort: it MUST resolve to []
 * (never throw) when the AX tree is unavailable — no permission, an app that
 * exposes nothing (Electron/games/remote desktop), or the sidecar is missing.
 * So hotspots + grid always stand alone.
 */

import type { UIElement } from "../../embed/types.js";

export interface AxSource {
  query(): Promise<UIElement[]>;
  close?(): void;
}
