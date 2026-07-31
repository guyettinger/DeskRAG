/**
 * SwiftDisplaySource — runs `ax-dump --displays` and parses the result. Uses only
 * node:child_process, no native addon. Best-effort by contract: any failure
 * resolves to [] (reported via onError), so a missing sidecar costs the display
 * layer of an anchor, never the recording.
 *
 * NOT re-exported from src/index.ts — it spawns a subprocess.
 */

import { execFile } from "node:child_process";
import { coerceDisplays } from "./parse.js";
import type { DisplayInfo, DisplaySource } from "./types.js";

export interface SwiftDisplaySourceOptions {
  /** Path to the ax-dump binary (default: ERAG_AX_BIN or "ax-dump" on PATH). */
  binaryPath?: string;
  args?: string[];
  /** Kill + return [] after this many ms (default 1500). */
  timeoutMs?: number;
  onError?: (msg: string) => void;
}

export class SwiftDisplaySource implements DisplaySource {
  private readonly binaryPath: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly onError: (msg: string) => void;

  constructor(opts: SwiftDisplaySourceOptions = {}) {
    this.binaryPath = opts.binaryPath ?? process.env.ERAG_AX_BIN ?? "ax-dump";
    this.args = opts.args ?? ["--displays"];
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.onError = opts.onError ?? ((m) => console.error(`[displays] ${m}`));
  }

  query(): Promise<DisplayInfo[]> {
    return new Promise((resolve) => {
      execFile(
        this.binaryPath,
        this.args,
        { timeout: this.timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" },
        (err, stdout) => {
          if (err) {
            this.onError(err.message);
            resolve([]); // best-effort: never throw
            return;
          }
          try {
            resolve(coerceDisplays(JSON.parse(stdout) as unknown));
          } catch (e) {
            this.onError(e instanceof Error ? e.message : "bad JSON");
            resolve([]);
          }
        },
      );
    });
  }
}
