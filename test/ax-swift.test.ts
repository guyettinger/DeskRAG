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
    // The root omits `parent` entirely (encodeIfPresent), and the child's depth is
    // derived from the link by coerceAxElements rather than read off the wire.
    expect(els).toEqual([
      { role: "Window", x: 0, y: 0, w: 1000, h: 1000 },
      { role: "Button", label: "Save", identifier: "save-btn", x: 100, y: 200, w: 80, h: 30, focused: true, parent: 0, depth: 1 },
    ]);
  });

  it("its output flows through axFilter into a labeled AX region", async () => {
    const els = await new SwiftAxSource({ binaryPath: bin, args: ["--self-test"] }).query();
    // The Window is the whole frame, so axFilter drops it as a container — the
    // hierarchy fields ride along without changing what becomes a region.
    const regions = axFilter(els, { frameW: 1000, frameH: 1000 });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.source).toBe("ax");
    expect(regions[0]!.label).toBe("Save");
    expect(regions[0]!.priority).toBe(5); // base 2 + label 1 + focused 2
  });

  it("a live walk emits parent links that resolve to earlier elements", async () => {
    const els = await new SwiftAxSource({ binaryPath: bin }).query();
    for (const [i, e] of els.entries()) {
      if (e.parent === undefined) continue;
      expect(e.parent).toBeLessThan(i); // pre-order: no forward refs, no cycles
      expect(e.depth).toBe((els[e.parent]!.depth ?? 0) + 1);
    }
    // Without AX permission the walk yields [], which is a valid (vacuous) pass.
    if (els.length > 1) expect(els.some((e) => e.parent !== undefined)).toBe(true);
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

  /**
   * The regression guard for the intermittent 30s hang: the walk is bounded by
   * wall-clock time, not just node count. maxNodes alone doesn't bound runtime —
   * per-call AX latency belongs to the target app (~0.5ms Finder, ~8ms Mail), so
   * 4000 nodes ran anywhere from 2s to indefinitely and the suite passed or failed
   * on whichever app happened to be frontmost.
   */
  it("bounds a live walk by wall-clock time regardless of the frontmost app", () => {
    const t0 = performance.now();
    const out = execFileSync(bin, [], { encoding: "utf8", timeout: 15_000 });
    const elapsed = performance.now() - t0;
    expect(Array.isArray(JSON.parse(out))).toBe(true);
    // Default budget is 800ms; allow generous headroom for spawn + one in-flight
    // AX call, while still failing loudly on the unbounded walk (which ran >20s).
    expect(elapsed).toBeLessThan(5000);
  });

  it("honors an explicit --budget-ms and still emits a valid array", () => {
    const t0 = performance.now();
    const out = execFileSync(bin, ["--budget-ms", "1"], { encoding: "utf8", timeout: 15_000 });
    const elapsed = performance.now() - t0;
    expect(Array.isArray(JSON.parse(out))).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it("exits 0 and prints a JSON array when run directly", () => {
    // timeout: the sidecar now bounds its own walk, but a direct exec has no other
    // backstop — never let a stall become a 30s suite-wide vitest timeout again.
    const out = execFileSync(bin, [], { encoding: "utf8", timeout: 5000 });
    expect(Array.isArray(JSON.parse(out))).toBe(true);
  });
});
