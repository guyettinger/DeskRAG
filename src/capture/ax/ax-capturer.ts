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
  constructor(
    private readonly store: Pick<Store, "putAxSnapshot">,
    private readonly source: AxSource,
    private readonly sessionId: string,
    private readonly now: () => number,
  ) {}

  /** Snapshot the tree and store it. Returns the element count. */
  async capture(reason: AxSnapshotReason, frameId?: string): Promise<number> {
    // Stamp at the START of the walk: that is the moment closest to the settled
    // state the snapshot claims to describe.
    const tMono = this.now();
    const started = Date.now();
    const elements = await this.source.query();
    await this.store.putAxSnapshot({
      id: ulid(),
      sessionId: this.sessionId,
      tMono,
      frameId: frameId ?? null,
      reason,
      walkMs: Date.now() - started,
      elements,
    });
    return elements.length;
  }

  close(): void {
    this.source.close?.();
  }
}
