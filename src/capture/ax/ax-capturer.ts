/**
 * AxCapturer — captures the live accessibility tree alongside a kept keyframe and
 * persists it (frame_ax), so RegionRepresenter can read it back at represent time
 * via StoredAxProvider. CaptureSession calls capture(frameId) whenever a frame is
 * kept. Pure orchestration over an injected AxSource (real or no-op).
 */

import type { Store } from "../../store/types.js";
import type { AxSource } from "./types.js";

export class AxCapturer {
  constructor(
    private readonly store: Pick<Store, "putFrameAx">,
    private readonly source: AxSource,
  ) {}

  /** Snapshot the AX tree and store it for `frameId`. Returns the element count. */
  async capture(frameId: string): Promise<number> {
    const elements = await this.source.query();
    if (elements.length > 0) await this.store.putFrameAx(frameId, elements);
    return elements.length;
  }

  close(): void {
    this.source.close?.();
  }
}
