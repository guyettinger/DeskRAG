import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SwiftAxSource } from "../src/capture/ax/swift-ax-source.js";
import { axFilter } from "../src/represent/regions/ax.js";

const here = dirname(fileURLToPath(import.meta.url));
const swiftSrc = join(here, "..", "native", "ax-dump.swift");
const hasSwiftc = (() => {
  try {
    return spawnSync("swiftc", ["--version"]).status === 0;
  } catch {
    return false;
  }
})();

/**
 * Real Swift sidecar (skipped when swiftc is absent). Compiles native/ax-dump.swift
 * and exercises the exact contract through SwiftAxSource. The `--self-test` path is
 * permission-independent (deterministic in CI); the live query is validated
 * tolerantly since it depends on the machine's Accessibility grant + frontmost app.
 */
describe.skipIf(!hasSwiftc)("ax-dump Swift sidecar", () => {
  let dir: string;
  let bin: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "erag-axbin-"));
    bin = join(dir, "ax-dump");
    execFileSync("swiftc", ["-O", swiftSrc, "-o", bin]); // throws if it won't compile
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("emits the exact contract JSON (deterministic --self-test)", async () => {
    const els = await new SwiftAxSource({ binaryPath: bin, args: ["--self-test"] }).query();
    expect(els).toEqual([
      { role: "Button", label: "Save", x: 100, y: 200, w: 80, h: 30, focused: true },
    ]);
  });

  it("its output flows through axFilter into a labeled AX region", async () => {
    const els = await new SwiftAxSource({ binaryPath: bin, args: ["--self-test"] }).query();
    const regions = axFilter(els, { frameW: 1000, frameH: 1000 });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.source).toBe("ax");
    expect(regions[0]!.label).toBe("Save");
    expect(regions[0]!.priority).toBe(5); // base 2 + label 1 + focused 2
  });

  it("a live query returns a valid element array (empty if no AX permission)", async () => {
    const els = await new SwiftAxSource({ binaryPath: bin }).query();
    expect(Array.isArray(els)).toBe(true);
    for (const e of els) {
      expect(typeof e.role).toBe("string");
      expect(e.role.length).toBeGreaterThan(0);
      for (const v of [e.x, e.y, e.w, e.h]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("exits 0 and prints a JSON array when run directly", () => {
    const out = execFileSync(bin, [], { encoding: "utf8" });
    expect(Array.isArray(JSON.parse(out))).toBe(true);
  });
});
