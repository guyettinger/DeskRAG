/**
 * SwiftKeymapSource — runs `ax-dump --keymap` and parses the result.
 *
 * Best-effort by contract: any failure resolves to `undefined`, which the lift
 * pre-pass treats as "cannot resolve characters" — text gestures are then dropped
 * with a warning rather than fabricated.
 *
 * NOT re-exported from src/index.ts — it spawns a subprocess.
 */

import { execFile } from "node:child_process";
import { coerceKeymap } from "./parse.js";
import type { Keymap, KeymapSource } from "./types.js";

export interface SwiftKeymapSourceOptions {
  /** Path to the ax-dump binary (default: ERAG_AX_BIN or "ax-dump" on PATH). */
  binaryPath?: string;
  args?: string[];
  /** Kill + return undefined after this many ms (default 1500). */
  timeoutMs?: number;
  onError?: (msg: string) => void;
}

export class SwiftKeymapSource implements KeymapSource {
  private readonly binaryPath: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly onError: (msg: string) => void;

  constructor(opts: SwiftKeymapSourceOptions = {}) {
    this.binaryPath = opts.binaryPath ?? process.env.ERAG_AX_BIN ?? "ax-dump";
    this.args = opts.args ?? ["--keymap"];
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.onError = opts.onError ?? ((m) => console.error(`[keymap] ${m}`));
  }

  query(): Promise<Keymap | undefined> {
    return new Promise((resolve) => {
      execFile(
        this.binaryPath,
        this.args,
        { timeout: this.timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
        (err, stdout) => {
          if (err) {
            this.onError(err.message);
            resolve(undefined); // best-effort: never throw
            return;
          }
          try {
            resolve(coerceKeymap(JSON.parse(stdout) as unknown));
          } catch (e) {
            this.onError(e instanceof Error ? e.message : "bad JSON");
            resolve(undefined);
          }
        },
      );
    });
  }
}
