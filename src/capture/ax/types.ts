/**
 * AxSource — the seam the native accessibility reader plugs into. `query()`
 * returns the current window's UI elements, best-effort: it MUST resolve to []
 * (never throw) when the AX tree is unavailable — no permission, an app that
 * exposes nothing (Electron/games/remote desktop), or the sidecar is missing.
 * So hotspots + grid always stand alone.
 */

import type { UIElement } from "../../embed/types.js";

/** A walk, plus facts about the window that are not elements of its tree. */
export interface AxWalk {
  elements: UIElement[];
  /** Raw page URL from the focused window's web area. Absent for native apps. */
  url?: string;
}

export interface AxSource {
  query(): Promise<UIElement[]>;
  /**
   * The tree AND the page URL from ONE read. Optional, so a source that cannot
   * report a URL (the fake, the no-op) needs no change and callers fall back to
   * `query`.
   *
   * One call rather than two on purpose: reading the tree and the URL separately
   * lets a navigation land between them, leaving a URL that describes a
   * different page than the elements — the two-halves-of-one-observation hazard
   * that made boundary snapshots describe the previous application.
   */
  walk?(): Promise<AxWalk>;
  close?(): void;
}
