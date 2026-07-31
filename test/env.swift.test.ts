import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SwiftDisplaySource } from "../src/capture/env/swift-displays.js";
import { SwiftKeymapSource } from "../src/capture/env/swift-keymap.js";

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

  it("emits the exact keymap contract (deterministic --self-test)", async () => {
    const km = await new SwiftKeymapSource({
      binaryPath: bin,
      args: ["--keymap", "--self-test"],
    }).query();
    expect(km).toEqual({
      layoutId: "com.apple.keylayout.SelfTest",
      entries: { 0: ["a", "A", "å", "Å"], 49: [" ", " ", " ", " "] },
    });
  });

  it("dumps the machine's real layout with plausible entries", async () => {
    const km = await new SwiftKeymapSource({ binaryPath: bin, args: ["--keymap"] }).query();
    expect(km).toBeDefined();
    expect(km!.layoutId.length).toBeGreaterThan(0);
    // Space (vk 49) is a space on every Latin layout; asserting more would bind
    // the test to the developer's keyboard.
    expect(km!.entries[49]?.[0]).toBe(" ");
    for (const cols of Object.values(km!.entries)) {
      expect(cols).toHaveLength(4);
    }
  });

  it("resolves to undefined for a missing binary rather than throwing", async () => {
    const km = await new SwiftKeymapSource({
      binaryPath: join(dir, "does-not-exist"),
      onError: () => {},
    }).query();
    expect(km).toBeUndefined();
  });

  it("EXCLUDES command keys, which UCKeyTranslate maps to control characters", async () => {
    const km = await new SwiftKeymapSource({ binaryPath: bin, args: ["--keymap"] }).query();
    expect(km).toBeDefined();
    // Escape (53), Tab (48) and the arrows (123-126) translate to U+001B, U+0009
    // and U+001E/001F. Letting those through would make groupGestures coalesce a
    // press of Escape INTO a text run.
    for (const vk of [48, 53, 123, 124, 125, 126]) {
      expect(km!.entries[vk], `vk ${vk} should not be text-bearing`).toBeUndefined();
    }
    // No control character survives anywhere in the table, except the newline
    // pair, which is genuine content in a text area.
    for (const [vk, cols] of Object.entries(km!.entries)) {
      for (const c of cols) {
        if (c.length !== 1) continue;
        const code = c.codePointAt(0)!;
        if (c === "\r" || c === "\n") continue;
        expect(code >= 0x20 && code !== 0x7f, `vk ${vk} yielded U+${code.toString(16)}`).toBe(true);
      }
    }
    // Return survives: a newline in a text area is content, not a command.
    expect(km!.entries[36]?.[0]).toBe("\r");
  });
});
