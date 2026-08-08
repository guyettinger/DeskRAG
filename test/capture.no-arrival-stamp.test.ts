import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A producer that samples through a device clock must time its SAMPLES from
 * `ctx.deviceClock`, never from `ctx.clock.now()`. Arrival time carries the
 * whole capture latency — measured 3.05s on a real avfoundation device — and
 * stamping it puts a recording's frames on a different clock from its events.
 *
 * Structural, like `test/replay.barrel.test.ts`'s `spawn` guard: every
 * arrival-time fallback in this area has silently produced a second time
 * convention that nobody noticed for weeks, so the suite is made incapable of
 * regressing rather than merely watchful.
 *
 * A blanket ban would be wrong — a few timestamps genuinely ARE arrival times
 * (when recording stopped, say). Those carry an inline `arrival-ok:` note
 * saying why, which is the point: the exception has to be argued in the code
 * rather than assumed by a reader.
 *
 * Producers that emit EVENTS (uiohook, active-win, keymap) legitimately call
 * `clock.now()` throughout — an event has no device timestamp and is stamped
 * in-process — so they are deliberately not listed here.
 */
describe("no producer stamps a sample from arrival time", () => {
  for (const file of [
    "src/capture/producers/ffmpeg-screen.ts",
    "src/capture/producers/ffmpeg-audio.ts",
  ]) {
    it(`${file} reads a wall clock only where it says why`, () => {
      const lines = readFileSync(file, "utf8").split("\n");
      // The note may sit on the line itself or in the comment block just above
      // it, because the reason rarely fits on one line.
      const justified = (i: number): boolean =>
        lines.slice(Math.max(0, i - 5), i + 1).some((l) => l.includes("arrival-ok:"));
      const offending = lines
        .map((line, i) => [i, line] as const)
        .filter(([i, line]) => line.includes("clock.now()") && !justified(i))
        .map(([i, line]) => `${i + 1}: ${line.trim()}`);
      expect(offending).toEqual([]);
    });
  }
});
