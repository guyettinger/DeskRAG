/**
 * Where the `ax-dump` sidecar lives, in both shapes the app runs in.
 *
 * This is pure so the PACKAGED branch can be tested at all. It cannot be
 * exercised from a dev run — a dev run always finds the repo copy first — and
 * driving a real bundle to check it needs a debugger port that a packaged
 * Electron app does not open. So the candidate list is the thing under test,
 * and `existsSync` is injected.
 *
 * The sidecar is REQUIRED for capture, not merely for accessibility: the device
 * timebase comes from `ax-dump --clock`, and without it a frame can only be
 * stamped with its arrival time — measured 3.05s later than its capture time on
 * a real screen device.
 *
 * Note the dev candidate cannot accidentally satisfy a packaged run: there
 * `__dirname` is inside `app.asar`, so `../../../native/ax-dump` resolves to
 * `Contents/Resources/native/ax-dump`, which is not where extraResources puts
 * it (`Contents/Resources/ax-dump`).
 */

import { join } from "node:path";

/**
 * The paths to try for one sidecar, in order. `resourcesPath` is undefined
 * outside a bundle.
 *
 * Named rather than hardcoded because there are now three Swift sidecars and
 * two of them ship: `ax-dump` (the capture clock) and `audio-tap` (computer
 * audio). `ax-exec` deliberately does not — see index.ts.
 */
export function sidecarCandidates(
  name: string,
  resourcesPath: string | undefined,
  mainDir: string,
): string[] {
  const out: string[] = [];
  if (typeof resourcesPath === "string" && resourcesPath !== "") {
    out.push(join(resourcesPath, name)); // packaged: extraResources
  }
  out.push(join(mainDir, `../../../native/${name}`)); // dev: npm run build:ax
  return out;
}

/** The paths to try, in order. `resourcesPath` is undefined outside a bundle. */
export function axBinCandidates(resourcesPath: string | undefined, mainDir: string): string[] {
  return sidecarCandidates("ax-dump", resourcesPath, mainDir);
}

/** As `resolveAxBin`, for any named sidecar. */
export function resolveSidecar(
  name: string,
  resourcesPath: string | undefined,
  mainDir: string,
  exists: (p: string) => boolean,
): string | undefined {
  return sidecarCandidates(name, resourcesPath, mainDir).find(exists);
}

/**
 * The first candidate that exists, or undefined. Undefined is a real outcome:
 * the caller leaves `ERAG_AX_BIN` unset and capture refuses to start, which is
 * the honest failure — recording without a clock would store timestamps meaning
 * something different from every calibrated session.
 */
export function resolveAxBin(
  resourcesPath: string | undefined,
  mainDir: string,
  exists: (p: string) => boolean,
): string | undefined {
  return axBinCandidates(resourcesPath, mainDir).find(exists);
}
