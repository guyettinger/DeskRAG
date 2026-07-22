/**
 * StoredAxProvider — feeds RegionRepresenter's `axProvider` seam from the AX tree
 * captured live and persisted at capture time (frame_ax). `provide` is a bound
 * arrow so it drops straight into `axProvider: new StoredAxProvider(store).provide`.
 * Returns [] for frames with no captured AX (best-effort, as designed).
 */

import type { UIElement } from "../../embed/types.js";
import type { FrameRow, Store } from "../../store/types.js";

export class StoredAxProvider {
  constructor(private readonly store: Pick<Store, "getFrameAx">) {}

  readonly provide = (frame: FrameRow): UIElement[] => this.store.getFrameAx(frame.id);
}
