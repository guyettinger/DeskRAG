/**
 * SwiftAxSource — runs the `ax-dump` Swift sidecar (a small `swiftc`-built binary
 * that walks the focused window's AXUIElement tree and prints JSON) as a
 * subprocess and parses its output. Uses only node:child_process — no native
 * node addon, no node-gyp. The Swift binary is the only missing piece; drop it in
 * at `binaryPath` (or set ERAG_AX_BIN).
 *
 * Best-effort by contract: a missing binary, non-zero exit, timeout, or bad
 * output all resolve to [] (logged via onError), so AX capture never breaks the
 * pipeline. The pure output-parsing lives in ./parse.ts (unit-tested); the spawn
 * itself is the only untested-in-CI part.
 *
 * Contract for `ax-dump`:
 *   - argv: an optional target (e.g. "--pid <n>" or "--frontmost"); default =
 *     frontmost app.
 *   - stdout: JSON array of { role, label?, x, y, w, h, focused? } in global
 *     screen coordinates (top-left origin), pre-flattened (no nesting).
 *   - exit 0 with `[]` when Accessibility permission is absent or the app exposes
 *     nothing; non-zero only on hard failure.
 */

import { execFile } from "node:child_process";
import type { UIElement } from "../../embed/types.js";
import type { AxSource } from "./types.js";
import { parseAxElements } from "./parse.js";

export interface SwiftAxSourceOptions {
  /** Path to the ax-dump binary (default: ERAG_AX_BIN or "ax-dump" on PATH). */
  binaryPath?: string;
  /** Extra args passed to the binary (e.g. ["--frontmost"]). */
  args?: string[];
  /** Kill + return [] after this many ms (default 1500). */
  timeoutMs?: number;
  onError?: (msg: string) => void;
}

export class SwiftAxSource implements AxSource {
  private readonly binaryPath: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly onError: (msg: string) => void;

  constructor(opts: SwiftAxSourceOptions = {}) {
    this.binaryPath = opts.binaryPath ?? process.env.ERAG_AX_BIN ?? "ax-dump";
    this.args = opts.args ?? [];
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.onError = opts.onError ?? ((m) => console.error(`[ax] ${m}`));
  }

  query(): Promise<UIElement[]> {
    return new Promise((resolve) => {
      execFile(
        this.binaryPath,
        this.args,
        { timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
        (err, stdout) => {
          if (err) {
            this.onError(err.message);
            resolve([]); // best-effort: never throw
            return;
          }
          resolve(parseAxElements(stdout));
        },
      );
    });
  }
}
