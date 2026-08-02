/**
 * AxCapturer — snapshots the live accessibility tree and persists it to
 * `ax_snapshot`, so `RegionRepresenter` (by frame) and node predicates (by
 * t_mono) can both read it back later. Pure orchestration over an injected
 * AxSource.
 *
 * An EMPTY result is still written. `if (elements.length > 0)` — the previous
 * behaviour — made an AX-blind app indistinguishable from a capture that never
 * ran, which is exactly the distinction `reason` exists to measure.
 */

import { ulid } from "ulid";
import type { AxSnapshotReason, Store } from "../../store/types.js";
import type { AxSource } from "./types.js";

export class AxCapturer {
  /** Last URL reported, so only CHANGES are announced. */
  private lastUrl: string | undefined;

  constructor(
    private readonly store: Pick<Store, "putAxSnapshot">,
    private readonly source: AxSource,
    private readonly sessionId: string,
    private readonly now: () => number,
    /**
     * Called when the walk reports a page URL different from the previous one.
     *
     * A URL is an ENVIRONMENT FACT, like display topology and keyboard layout:
     * it changes mid-session and fails silently when it does. It therefore
     * travels as an event resolved latest-at-or-before, not as a column —
     * `ax_snapshot` has no room for one and the repo has no migration mechanism.
     *
     * It rides the boundary walk rather than its own poller: a spawn every 500ms
     * to learn something that only matters at a boundary is not worth the cost.
     */
    private readonly onUrlChange?: (url: string, tMono: number) => void,
  ) {}

  /**
   * Snapshot the tree and store it. Returns the element count.
   *
   * `boundaryTMono` is the boundary this walk was taken FOR. It is NOT the same
   * as `tMono` below and cannot be derived from it: the walk starts after the
   * trigger's settle delay, so the snapshot always post-dates its own boundary.
   * Recording it is what lets lift match a boundary to its tree exactly rather
   * than looking backwards and finding the state that was on screen before.
   */
  async capture(
    reason: AxSnapshotReason,
    frameId?: string,
    boundaryTMono?: number,
  ): Promise<number> {
    // Stamp at the START of the walk: that is the moment closest to the settled
    // state the snapshot claims to describe.
    const tMono = this.now();
    const started = Date.now();
    const walk = this.source.walk !== undefined
      ? await this.source.walk()
      : { elements: await this.source.query() };
    const elements = walk.elements;
    if (walk.url !== undefined && walk.url !== this.lastUrl) {
      this.lastUrl = walk.url;
      // Stamped with the BOUNDARY, not the walk. The settle delay puts the walk
      // ~250ms AFTER the boundary it describes, so a walk-stamped event sits
      // just past the boundary and lift's latest-at-or-before lookup hands it to
      // the NEXT node instead. Measured exactly that way on a real recording:
      // the Chrome node was bare `app` and the URL landed one node later.
      //
      // The identical off-by-one is why `boundaryTMono` exists for the snapshot
      // itself (`getAxForBoundary`), which measured 54% of nodes incoherent
      // before it was added. Same delay, same fix.
      this.onUrlChange?.(walk.url, boundaryTMono ?? tMono);
    }
    await this.store.putAxSnapshot({
      id: ulid(),
      sessionId: this.sessionId,
      tMono,
      frameId: frameId ?? null,
      reason,
      walkMs: Date.now() - started,
      elements,
      ...(boundaryTMono !== undefined ? { boundaryTMono } : {}),
    });
    return elements.length;
  }

  close(): void {
    this.source.close?.();
  }
}
