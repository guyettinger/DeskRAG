import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SwiftDisplaySource } from "../src/capture/env/swift-displays.js";

const here = dirname(fileURLToPath(import.meta.url));
const swiftSrc = join(here, "..", "native", "ax-dump.swift");
const hasSwiftc = (() => {
  try {
    return spawnSync("swiftc", ["--version"]).status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasSwiftc)("ax-dump --displays", () => {
  let dir: string;
  let bin: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "erag-envbin-"));
    bin = join(dir, "ax-dump");
    execFileSync("swiftc", ["-O", swiftSrc, "-o", bin]);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("emits the exact contract JSON (deterministic --self-test)", async () => {
    const got = await new SwiftDisplaySource({
      binaryPath: bin,
      args: ["--displays", "--self-test"],
    }).query();
    expect(got).toEqual([
      { id: "1", x: 0, y: 0, w: 2560, h: 1440, scale: 2, primary: true },
      { id: "2", x: 2560, y: 0, w: 1920, h: 1080, scale: 1, primary: false },
    ]);
  });

  it("queries the real screens, top-left origin, exactly one primary", async () => {
    const got = await new SwiftDisplaySource({ binaryPath: bin, args: ["--displays"] }).query();
    expect(got.length).toBeGreaterThan(0);
    expect(got.filter((d) => d.primary)).toHaveLength(1);
    // The primary display defines the origin of the top-left global space.
    const primary = got.find((d) => d.primary)!;
    expect(primary.x).toBe(0);
    expect(primary.y).toBe(0);
    for (const d of got) {
      expect(Number.isFinite(d.w) && d.w > 0).toBe(true);
      expect(d.scale).toBeGreaterThan(0);
    }
  });

  it("resolves to [] for a missing binary rather than throwing", async () => {
    const errs: string[] = [];
    const got = await new SwiftDisplaySource({
      binaryPath: join(dir, "does-not-exist"),
      onError: (m) => errs.push(m),
    }).query();
    expect(got).toEqual([]);
    expect(errs.length).toBeGreaterThan(0);
  });
});
