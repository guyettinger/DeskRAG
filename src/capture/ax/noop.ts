/**
 * NoopAxSource — the default/fallback AX source. Always returns no elements, so
 * capture runs unchanged when no accessibility reader is configured. Also the
 * stand-in used in tests that don't exercise a real AX tree.
 */

import type { UIElement } from "../../embed/types.js";
import type { AxSource } from "./types.js";

export class NoopAxSource implements AxSource {
  async query(): Promise<UIElement[]> {
    return [];
  }
}
