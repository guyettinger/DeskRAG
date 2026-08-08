/**
 * SwiftDeviceClockSource — runs `ax-dump --clock` and parses the result.
 *
 * DELIBERATELY NOT BEST-EFFORT, unlike its neighbours. `SwiftKeymapSource` and
 * `SwiftDisplaySource` resolve to `undefined` on failure because a missing
 * layout or topology costs one signal. A missing clock costs the MEANING of
 * every timestamp in the session: without it a frame can only be stamped with
 * its arrival time, which measured 3.05s later than its capture time on a real
 * device. So this rejects, and `CaptureSession` refuses to start.
 *
 * `--clock` needs no Accessibility permission — it exits above the
 * `AXIsProcessTrusted()` gate, like `--displays` and `--keymap` — so it runs on
 * a machine that has never granted anything.
 *
 * In the barrel: it spawns a binary but loads no native module.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseDeviceClock } from "./clock.js";
import type { DeviceClockSource } from "./types.js";

const run = promisify(execFile);

export interface SwiftDeviceClockSourceOptions {
  /** Path to the ax-dump binary (default: ERAG_AX_BIN or "ax-dump" on PATH). */
  binaryPath?: string;
  /** Kill and reject after this many ms (default 5000). */
  timeoutMs?: number;
}

export class SwiftDeviceClockSource implements DeviceClockSource {
  private readonly binaryPath: string;
  private readonly timeoutMs: number;

  constructor(opts: SwiftDeviceClockSourceOptions = {}) {
    this.binaryPath = opts.binaryPath ?? process.env["ERAG_AX_BIN"] ?? "ax-dump";
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async read(): Promise<number> {
    const { stdout } = await run(this.binaryPath, ["--clock"], { timeout: this.timeoutMs });
    return parseDeviceClock(stdout);
  }
}
