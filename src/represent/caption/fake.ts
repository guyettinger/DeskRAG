/**
 * Deterministic caption provider for tests — no VLM, no network. The caption is
 * a stable function of the frame bytes and the context (a segment's digest), so
 * captions differ per segment and a query can reproduce one exactly.
 */

import type { CaptionProvider } from "../../embed/types.js";

export class FakeCaptionProvider implements CaptionProvider {
  async caption(frames: Uint8Array[], context?: string): Promise<string> {
    const sig = frames.reduce((n, f) => n + f.length, 0);
    return `screen[${frames.length}:${sig}] ${context ?? "desktop activity"}`.trim();
  }
}
