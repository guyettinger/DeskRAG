import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDeviceClock } from "../src/capture/env/clock.js";
import { SwiftDeviceClockSource } from "../src/capture/env/swift-clock.js";

const here = dirname(fileURLToPath(import.meta.url));
const swiftSrc = join(here, "..", "native", "ax-dump.swift");
const hasSwiftc = (() => {
  try {
    return spawnSync("swiftc", ["--version"]).status === 0;
  } catch {
    return false;
  }
})();

describe("parseDeviceClock", () => {
  it("reads the device reading in milliseconds", () => {
    expect(parseDeviceClock('{"deviceMs":3477946316.602}\n')).toBe(3477946316.602);
  });

  it("tolerates surrounding whitespace and trailing output", () => {
    expect(parseDeviceClock('\n  {"deviceMs":12345.5}  \n')).toBe(12345.5);
  });

  it("throws on anything that is not a clock reading", () => {
    // A stale binary predating --clock prints usage, or nothing. Guessing a
    // number here would silently mis-time an entire recording, which is the
    // exact failure this whole design exists to remove.
    expect(() => parseDeviceClock("")).toThrow(/clock/i);
    expect(() => parseDeviceClock("usage: ax-dump [--displays]")).toThrow(/clock/i);
    expect(() => parseDeviceClock('{"deviceMs":"soon"}')).toThrow(/clock/i);
  });
});

/**
 * Compiled from the real .swift, because the TS parser and the Swift emitter
 * are two readers of one contract — the standing drift hazard that already bit
 * ax-dump/ax-exec, and which no hand-written fixture can catch.
 */
describe.skipIf(!hasSwiftc)("ax-dump --clock", () => {
  let dir: string;
  let bin: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "erag-clockbin-"));
    bin = join(dir, "ax-dump");
    execFileSync("swiftc", ["-O", swiftSrc, "-o", bin]);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("emits the exact contract JSON (deterministic --self-test)", () => {
    const out = execFileSync(bin, ["--clock", "--self-test"]).toString();
    expect(parseDeviceClock(out)).toBe(1234.5);
  });

  it("reads a real, advancing clock through the source", async () => {
    const src = new SwiftDeviceClockSource({ binaryPath: bin });
    const a = await src.read();
    const b = await src.read();
    expect(a).toBeGreaterThan(0);
    // Monotonic and moving: two spawns cannot report the same instant.
    expect(b).toBeGreaterThan(a);
    // Sane rate — two spawns are milliseconds apart, not hours.
    expect(b - a).toBeLessThan(5000);
  });

  it("rejects for a missing binary instead of inventing a reading", async () => {
    // Deliberately unlike its best-effort neighbours: a missing clock costs the
    // meaning of every timestamp in the session, so the session must refuse.
    const src = new SwiftDeviceClockSource({ binaryPath: join(dir, "does-not-exist") });
    await expect(src.read()).rejects.toThrow();
  });
});
