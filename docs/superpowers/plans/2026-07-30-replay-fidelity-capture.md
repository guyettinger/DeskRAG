# Replay-Fidelity Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the trace IR's inputs real — capture modifiers, layout-resolved characters, display topology, window bounds, app identity, drag-rate mouse sampling, and AX at boundaries.

**Architecture:** Two new one-shot modes on the existing Swift sidecar feed a new `src/capture/env/` module (interface + subprocess impl + fake, mirroring `capture/ax/`). Environment facts that can change mid-session are emitted as `t_mono`-stamped events, never configuration. AX gains a second trigger — boundaries, driven by `CaptureSession`, the only component that sees every producer's events — and lands in one new `ax_snapshot` table. Characters resolve at lift time from a stored keymap, so capture keeps storing raw keycodes.

**Tech Stack:** TypeScript (strict, ESM), Swift (Carbon `UCKeyTranslate`, AppKit `NSScreen`), better-sqlite3, vitest. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-30-replay-fidelity-capture-design.md` (commit `571b5f9`)

## Global Constraints

- **This plan requires `src/trace/` to exist.** It modifies `src/trace/lift.ts` (Task 11) and `src/trace/anchors.ts` (Task 3). `src/trace/` currently lives only on branch `feat/trace-ir` (open PR #17), **not** on `main`. Execute this plan on a branch that contains it — either after PR #17 merges, or branched from `feat/trace-ir`. Verify with `ls src/trace/lift.ts` before starting.
- **`exactOptionalPropertyTypes: true`.** An absent optional must be *omitted*, never set to `undefined`. Build objects with conditional spreads: `...(v !== undefined ? { k: v } : {})`.
- **Strict TS, ESM.** All relative imports carry the `.js` extension.
- **`src/capture/env/` is not re-exported from `src/index.ts`.** It spawns a subprocess, so it follows the same rule as `capture/ax/swift-ax-source.ts` — importing the package must never force-load a subprocess adapter. Only the pure helpers (`keymap.ts`, `displays.ts`) and the types may be exported.
- **Best-effort contract for both new sources**, identical to `AxSource`: a missing binary, non-zero exit, timeout, or malformed output resolves to empty/undefined and **never throws**.
- **Tests live in `test/`**, named `env.<module>.test.ts` / `capture.<module>.test.ts`, importing from `../src/...js`.
- **Swift tests skip when `swiftc` is absent**, using the `describe.skipIf(!hasSwiftc)` pattern from `test/ax-swift.test.ts`.
- **`npm run typecheck` is the primary gate.** Run it after every task; `npm test` must stay green.
- **macOS only.** Both new sidecar modes are Carbon/AppKit. The interfaces admit other implementations; none are planned.
- **Do not change the existing `--self-test` output.** `test/ax-swift.test.ts` asserts it exactly. New modes get their own self-test payloads, selected by combining flags.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `native/ax-dump.swift` | *(modify)* `--displays`, `--keymap`, `AXIdentifier` in the walk |
| `src/capture/env/types.ts` | `DisplayInfo`, `Keymap`, `DisplaySource`, `KeymapSource` |
| `src/capture/env/parse.ts` | Defensive coercion of both sidecar payloads |
| `src/capture/env/swift-displays.ts` | `SwiftDisplaySource` — spawns `ax-dump --displays` |
| `src/capture/env/swift-keymap.ts` | `SwiftKeymapSource` — spawns `ax-dump --keymap` |
| `src/capture/env/fake.ts` | `FakeDisplaySource`, `FakeKeymapSource` for tests |
| `src/capture/env/displays.ts` | Pure: `displayIdAt`, `outsideKnownDisplays` |
| `src/capture/env/keymap.ts` | Pure: `macKeycodeFor`, `resolveChar` |
| `src/capture/producers/sampling.ts` | Pure: `shouldSampleMove` (extracted so it is testable without the native hook) |
| `src/capture/producers/uiohook-input.ts` | *(modify)* modifiers + adaptive sampling |
| `src/capture/producers/active-window.ts` | *(modify)* bounds/bundleId/url + `display_change` |
| `src/capture/producers/keymap-producer.ts` | `KeymapProducer` — session start + 60s poll |
| `src/capture/ax/boundary.ts` | `BoundaryAxTrigger` — settle delay + coalescing |
| `src/capture/session.ts` | *(modify)* drive boundary AX from the event stream |
| `src/capture/types.ts` | *(modify)* two new `EventKind`s |
| `src/store/sqlite/schema.ts` | *(modify)* `ax_snapshot` table |
| `src/store/types.ts` | *(modify)* `AxSnapshotRow` + three store methods |
| `src/store/store.ts` | *(modify)* `putAxSnapshot`, `getAxAt`, `getFrameAx` fallback |
| `src/embed/types.ts` | *(modify)* `UIElement.identifier?` |
| `src/capture/ax/parse.ts` | *(modify)* carry `identifier` through coercion |
| `src/trace/anchors.ts` | *(modify)* record `identifier` on `Anchor.ax` |
| `src/trace/lift.ts` | *(modify)* `resolveKeys` pre-pass; optional `AxSnapshot.frameId` |

---

## Task 1: Sidecar `--displays` mode and `DisplaySource`

**Files:**
- Modify: `native/ax-dump.swift`
- Create: `src/capture/env/types.ts`, `src/capture/env/parse.ts`, `src/capture/env/swift-displays.ts`, `src/capture/env/fake.ts`
- Test: `test/env.parse.test.ts`, `test/env.swift.test.ts`

**Interfaces:**
- Produces:
  - `interface DisplayInfo { id: string; x: number; y: number; w: number; h: number; scale: number; primary: boolean }`
  - `interface DisplaySource { query(): Promise<DisplayInfo[]>; close?(): void }`
  - `coerceDisplays(data: unknown): DisplayInfo[]`
  - `class SwiftDisplaySource implements DisplaySource` — options `{ binaryPath?, args?, timeoutMs?, onError? }`
  - `class FakeDisplaySource implements DisplaySource` — constructor takes `DisplayInfo[]`

**Background — the coordinate flip.** `NSScreen.frame` is **bottom-left origin**; AX bboxes and uiohook mouse coordinates are **top-left origin**. The sidecar must flip, or every display's `y` is wrong and `displayIdAt` silently misattributes points on secondary monitors. The flip is against the *primary* screen's height, because that is what defines the global coordinate space.

- [ ] **Step 1: Write the failing tests**

```ts
// test/env.parse.test.ts
import { describe, expect, it } from "vitest";
import { coerceDisplays } from "../src/capture/env/parse.js";

describe("coerceDisplays", () => {
  it("accepts a well-formed payload", () => {
    expect(
      coerceDisplays([
        { id: "1", x: 0, y: 0, w: 2560, h: 1440, scale: 2, primary: true },
        { id: "2", x: 2560, y: 100, w: 1920, h: 1080, scale: 1, primary: false },
      ]),
    ).toEqual([
      { id: "1", x: 0, y: 0, w: 2560, h: 1440, scale: 2, primary: true },
      { id: "2", x: 2560, y: 100, w: 1920, h: 1080, scale: 1, primary: false },
    ]);
  });

  it("drops entries missing a field rather than trusting them", () => {
    expect(coerceDisplays([{ id: "1", x: 0, y: 0, w: 100 }])).toEqual([]);
    expect(coerceDisplays([{ x: 0, y: 0, w: 1, h: 1, scale: 1, primary: true }])).toEqual([]);
  });

  it("drops non-finite numbers", () => {
    expect(
      coerceDisplays([{ id: "1", x: 0, y: 0, w: Infinity, h: 1, scale: 1, primary: true }]),
    ).toEqual([]);
  });

  it("returns [] for non-arrays and junk", () => {
    for (const junk of [null, undefined, {}, "nope", 42]) {
      expect(coerceDisplays(junk)).toEqual([]);
    }
  });

  it("defaults primary to false when absent but keeps the entry", () => {
    expect(coerceDisplays([{ id: "1", x: 0, y: 0, w: 10, h: 10, scale: 1 }])).toEqual([
      { id: "1", x: 0, y: 0, w: 10, h: 10, scale: 1, primary: false },
    ]);
  });
});
```

```ts
// test/env.swift.test.ts
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
  });
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/env.parse.test.ts test/env.swift.test.ts`
Expected: FAIL — `Cannot find module '../src/capture/env/parse.js'`

- [ ] **Step 3: Add the Swift mode**

Insert **immediately after** the existing `--self-test` block in `native/ax-dump.swift` (before the `AXIsProcessTrusted()` check — neither new mode needs Accessibility permission):

```swift
// MARK: - Display topology (--displays)
//
// NSScreen.frame is BOTTOM-left origin; AX bboxes and uiohook mouse coordinates
// are TOP-left. Without the flip every secondary display's y is wrong and points
// get misattributed. The flip is against the PRIMARY screen's height, because
// that is what defines the global coordinate space.

struct DisplayOut: Codable {
    let id: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let scale: Double
    let primary: Bool
}

func emitJSON<T: Encodable>(_ value: T) {
    let enc = JSONEncoder()
    guard let data = try? enc.encode(value), let s = String(data: data, encoding: .utf8) else {
        print("[]")
        return
    }
    print(s)
}

if args.contains("--displays") {
    if args.contains("--self-test") {
        emitJSON([
            DisplayOut(id: "1", x: 0, y: 0, w: 2560, h: 1440, scale: 2, primary: true),
            DisplayOut(id: "2", x: 2560, y: 0, w: 1920, h: 1080, scale: 1, primary: false),
        ])
        exit(0)
    }
    let screens = NSScreen.screens
    guard let primary = screens.first else {
        print("[]")
        exit(0)
    }
    let flipH = primary.frame.height
    var out: [DisplayOut] = []
    for s in screens {
        let f = s.frame
        let num = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        out.append(DisplayOut(
            id: num.map { String($0.uint32Value) } ?? "unknown",
            x: f.origin.x,
            y: flipH - f.origin.y - f.height,
            w: f.width,
            h: f.height,
            scale: s.backingScaleFactor,
            primary: s == primary
        ))
    }
    emitJSON(out)
    exit(0)
}
```

- [ ] **Step 4: Write the TypeScript side**

```ts
// src/capture/env/types.ts
/**
 * Environment capture contracts — display topology and keyboard layout.
 *
 * Both are facts that can change mid-session and both fail SILENTLY when they do
 * (a coordinate attributed to the wrong display, text resolved against the wrong
 * layout), so both are emitted as t_mono-stamped events rather than stored as
 * session configuration.
 *
 * Both sources are best-effort by contract, exactly like `AxSource`: a missing
 * binary, non-zero exit, timeout, or malformed output resolves to empty/undefined
 * and never throws.
 */

export interface DisplayInfo {
  /** Stable for the boot; the NSScreen display id as a string. */
  id: string;
  /** Global screen coordinates, TOP-left origin — the same space as AX and mouse. */
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  primary: boolean;
}

export interface Keymap {
  /** e.g. "com.apple.keylayout.US" */
  layoutId: string;
  /** macOS virtual keycode -> [plain, shift, alt, altShift]. */
  entries: Record<number, [string, string, string, string]>;
}

export interface DisplaySource {
  query(): Promise<DisplayInfo[]>;
  close?(): void;
}

export interface KeymapSource {
  query(): Promise<Keymap | undefined>;
  close?(): void;
}
```

```ts
// src/capture/env/parse.ts
/**
 * Defensive coercion of the sidecar's environment payloads. Pure. Malformed
 * entries are dropped rather than trusted, so a flaky sidecar degrades to fewer
 * (or zero) facts, never a crash — the same discipline as `ax/parse.ts`.
 */

import type { DisplayInfo, Keymap } from "./types.js";

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export function coerceDisplays(data: unknown): DisplayInfo[] {
  if (!Array.isArray(data)) return [];
  const out: DisplayInfo[] = [];
  for (const raw of data) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id.length > 0 ? o.id : undefined;
    const x = finite(o.x);
    const y = finite(o.y);
    const w = finite(o.w);
    const h = finite(o.h);
    const scale = finite(o.scale);
    if (id === undefined || x === undefined || y === undefined) continue;
    if (w === undefined || h === undefined || scale === undefined) continue;
    out.push({ id, x, y, w, h, scale, primary: o.primary === true });
  }
  return out;
}

/** `undefined` (not an empty map) when the payload is unusable — an absent keymap
 *  must be distinguishable from a layout that resolved zero keys. */
export function coerceKeymap(data: unknown): Keymap | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const o = data as Record<string, unknown>;
  const layoutId = typeof o.layoutId === "string" && o.layoutId.length > 0 ? o.layoutId : undefined;
  if (layoutId === undefined) return undefined;
  if (o.entries === null || typeof o.entries !== "object") return undefined;

  const entries: Keymap["entries"] = {};
  for (const [k, v] of Object.entries(o.entries as Record<string, unknown>)) {
    const code = Number(k);
    if (!Number.isInteger(code) || code < 0) continue;
    if (!Array.isArray(v) || v.length !== 4) continue;
    if (!v.every((s) => typeof s === "string")) continue;
    entries[code] = [v[0] as string, v[1] as string, v[2] as string, v[3] as string];
  }
  return { layoutId, entries };
}
```

```ts
// src/capture/env/swift-displays.ts
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
  binaryPath?: string;
  args?: string[];
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
            resolve([]);
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
```

```ts
// src/capture/env/fake.ts
/**
 * Deterministic fakes. The seam that keeps the suite offline: every environment
 * consumer can be exercised without a sidecar, a display, or a keyboard layout.
 */

import type { DisplayInfo, DisplaySource, Keymap, KeymapSource } from "./types.js";

export class FakeDisplaySource implements DisplaySource {
  /** Incremented on each query, so tests can assert re-query behavior. */
  queries = 0;

  constructor(private displays: DisplayInfo[] = []) {}

  /** Swap the topology mid-test, simulating a monitor being plugged in. */
  set(displays: DisplayInfo[]): void {
    this.displays = displays;
  }

  async query(): Promise<DisplayInfo[]> {
    this.queries += 1;
    return this.displays.map((d) => ({ ...d }));
  }
}

export class FakeKeymapSource implements KeymapSource {
  queries = 0;

  constructor(private keymap: Keymap | undefined = undefined) {}

  set(keymap: Keymap | undefined): void {
    this.keymap = keymap;
  }

  async query(): Promise<Keymap | undefined> {
    this.queries += 1;
    return this.keymap === undefined
      ? undefined
      : { layoutId: this.keymap.layoutId, entries: { ...this.keymap.entries } };
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/env.parse.test.ts test/env.swift.test.ts && npm run typecheck`
Expected: PASS (the Swift block skips if `swiftc` is absent).

- [ ] **Step 6: Commit**

```bash
git add native/ax-dump.swift src/capture/env/ test/env.parse.test.ts test/env.swift.test.ts
git commit -m "feat(capture): ax-dump --displays and DisplaySource

NSScreen.frame is bottom-left origin while AX and mouse coordinates are
top-left, so the sidecar flips against the primary screen's height. Without
it every secondary display's y is wrong and points silently misattribute."
```

---

## Task 2: Sidecar `--keymap` mode and `KeymapSource`

**Files:**
- Modify: `native/ax-dump.swift`
- Create: `src/capture/env/swift-keymap.ts`
- Test: `test/env.parse.test.ts` *(extend)*, `test/env.swift.test.ts` *(extend)*

**Interfaces:**
- Consumes: `Keymap`, `KeymapSource` from Task 1's `types.ts`; `coerceKeymap` from Task 1's `parse.ts`.
- Produces: `class SwiftKeymapSource implements KeymapSource` — options `{ binaryPath?, args?, timeoutMs?, onError? }`.

**Background.** `UCKeyTranslate` needs the current layout's `UCKeyboardLayout` data, obtained via `TISCopyCurrentKeyboardInputSource` + `kTISPropertyUnicodeKeyLayoutData`. Its `modifierKeyState` argument is the Carbon modifier mask **shifted right by 8**, so plain = `0`, shift = `0x02`, option = `0x08`, shift+option = `0x0A`. Virtual keycodes `0…127` cover the whole keyboard.

- [ ] **Step 1: Write the failing tests**

Append to `test/env.parse.test.ts`:

```ts
import { coerceKeymap } from "../src/capture/env/parse.js";

describe("coerceKeymap", () => {
  it("accepts a well-formed payload", () => {
    expect(
      coerceKeymap({ layoutId: "com.apple.keylayout.US", entries: { "0": ["a", "A", "å", "Å"] } }),
    ).toEqual({ layoutId: "com.apple.keylayout.US", entries: { 0: ["a", "A", "å", "Å"] } });
  });

  it("returns undefined — not an empty map — for an unusable payload", () => {
    // An absent keymap must be distinguishable from a layout that resolved
    // nothing, because the first warns and the second is a real answer.
    for (const junk of [null, undefined, [], "nope", {}, { entries: {} }]) {
      expect(coerceKeymap(junk)).toBeUndefined();
    }
  });

  it("keeps a valid layoutId with zero usable entries", () => {
    expect(coerceKeymap({ layoutId: "x", entries: {} })).toEqual({ layoutId: "x", entries: {} });
  });

  it("drops malformed entries but keeps the rest", () => {
    const km = coerceKeymap({
      layoutId: "x",
      entries: { "0": ["a", "A", "å", "Å"], "1": ["s", "S"], bad: ["a", "b", "c", "d"], "2": [1, 2, 3, 4] },
    });
    expect(km?.entries).toEqual({ 0: ["a", "A", "å", "Å"] });
  });
});
```

Append to `test/env.swift.test.ts` (inside the `describe.skipIf` block, and add the import):

```ts
import { SwiftKeymapSource } from "../src/capture/env/swift-keymap.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/env.parse.test.ts test/env.swift.test.ts`
Expected: FAIL — `coerceKeymap` is not exported / `swift-keymap.js` not found.

- [ ] **Step 3: Add the Swift mode**

Add `import Carbon` to the sidecar's imports, then insert after the `--displays` block:

```swift
// MARK: - Keyboard layout (--keymap)
//
// UCKeyTranslate needs the current layout's UCKeyboardLayout data. Its
// modifierKeyState argument is the Carbon modifier mask shifted RIGHT by 8:
// plain = 0, shift = 0x02, option = 0x08, shift+option = 0x0A.
//
// This is the layout-DEPENDENT half of character resolution. The
// scancode -> virtual-keycode half is layout-independent and lives in TypeScript.

struct KeymapOut: Codable {
    let layoutId: String
    let entries: [String: [String]]
}

if args.contains("--keymap") {
    if args.contains("--self-test") {
        emitJSON(KeymapOut(
            layoutId: "com.apple.keylayout.SelfTest",
            entries: ["0": ["a", "A", "å", "Å"], "49": [" ", " ", " ", " "]]
        ))
        exit(0)
    }

    guard let src = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
          let layoutPtr = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else {
        print("null")
        exit(0)
    }
    let layoutData = Unmanaged<CFData>.fromOpaque(layoutPtr).takeUnretainedValue() as Data
    let layoutId: String = {
        guard let p = TISGetInputSourceProperty(src, kTISPropertyInputSourceID) else { return "unknown" }
        return Unmanaged<CFString>.fromOpaque(p).takeUnretainedValue() as String
    }()

    let kbdType = UInt32(LMGetKbdType())
    var entries: [String: [String]] = [:]

    layoutData.withUnsafeBytes { (rawBuf: UnsafeRawBufferPointer) in
        guard let base = rawBuf.baseAddress else { return }
        let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)

        func translate(_ vk: UInt16, _ modState: UInt32) -> String {
            var dead: UInt32 = 0
            var chars = [UniChar](repeating: 0, count: 8)
            var length = 0
            let status = UCKeyTranslate(
                layout, vk, UInt16(kUCKeyActionDown), modState, kbdType,
                OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &length, &chars
            )
            guard status == noErr, length > 0 else { return "" }
            return String(utf16CodeUnits: chars, count: length)
        }

        for vk in UInt16(0)...UInt16(127) {
            let cols = [translate(vk, 0), translate(vk, 0x02), translate(vk, 0x08), translate(vk, 0x0A)]
            // Skip keys that produce nothing under every modifier state — arrows,
            // function keys, modifiers themselves. They are chords, not text.
            if cols.allSatisfy({ $0.isEmpty }) { continue }
            entries[String(vk)] = cols
        }
    }

    emitJSON(KeymapOut(layoutId: layoutId, entries: entries))
    exit(0)
}
```

- [ ] **Step 4: Write `SwiftKeymapSource`**

```ts
// src/capture/env/swift-keymap.ts
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
  binaryPath?: string;
  args?: string[];
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
            resolve(undefined);
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
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/env.parse.test.ts test/env.swift.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add native/ax-dump.swift src/capture/env/swift-keymap.ts test/env.parse.test.ts test/env.swift.test.ts
git commit -m "feat(capture): ax-dump --keymap and KeymapSource

UCKeyTranslate over the current layout, dumping vk -> [plain, shift, alt,
altShift] for keycodes 0..127. This is the layout-DEPENDENT half of
character resolution; the scancode->virtual-keycode half is layout
independent and lives in TypeScript. An unusable payload coerces to
undefined, not an empty map, so 'no keymap' stays distinguishable from
'a layout that resolved nothing'."
```

---

## Task 3: `AXIdentifier` through the pipeline

**Files:**
- Modify: `native/ax-dump.swift`, `src/embed/types.ts`, `src/capture/ax/parse.ts`, `src/trace/anchors.ts`
- Test: `test/ax.test.ts` *(extend)*, `test/ax-swift.test.ts` *(extend)*, `test/trace.anchors.test.ts` *(extend)*

**Interfaces:**
- Produces: `UIElement.identifier?: string`; `Anchor.ax.identifier?: string`.

**Background.** `AXIdentifier` is an app-assigned stable id. Where it exists it is a far better anchor than a positional path, which shifts whenever the UI gains or loses a sibling. Purely additive — how the executor ranks identifier-versus-path is that spec's concern.

- [ ] **Step 1: Write the failing tests**

Append to `test/ax.test.ts`:

```ts
import { coerceAxElements } from "../src/capture/ax/parse.js";

describe("coerceAxElements — identifier", () => {
  it("carries a non-empty identifier through", () => {
    expect(
      coerceAxElements([{ role: "AXButton", x: 0, y: 0, w: 1, h: 1, identifier: "send-btn" }]),
    ).toEqual([{ role: "AXButton", x: 0, y: 0, w: 1, h: 1, identifier: "send-btn" }]);
  });

  it("omits the key entirely when absent or empty", () => {
    const [a] = coerceAxElements([{ role: "AXButton", x: 0, y: 0, w: 1, h: 1 }]);
    expect("identifier" in a!).toBe(false);
    const [b] = coerceAxElements([{ role: "AXButton", x: 0, y: 0, w: 1, h: 1, identifier: "" }]);
    expect("identifier" in b!).toBe(false);
  });

  it("ignores a non-string identifier", () => {
    const [a] = coerceAxElements([{ role: "AXButton", x: 0, y: 0, w: 1, h: 1, identifier: 42 }]);
    expect("identifier" in a!).toBe(false);
  });
});
```

Append to `test/trace.anchors.test.ts`:

```ts
describe("buildAnchor — identifier", () => {
  it("records the AX identifier when the hit element has one", () => {
    const withId: UIElement[] = [
      { role: "AXWindow", x: 0, y: 0, w: 800, h: 600 },
      { role: "AXButton", label: "Send", identifier: "send-btn", x: 700, y: 20, w: 80, h: 32, parent: 0 },
    ];
    const a = buildAnchor({ point: { x: 720, y: 30 }, displayId: "D1", ax: withId });
    expect(a.ax).toMatchObject({ role: "AXButton", label: "Send", identifier: "send-btn" });
  });

  it("omits identifier when the element has none", () => {
    const a = buildAnchor({ point: { x: 720, y: 30 }, displayId: "D1", ax: tree });
    expect("identifier" in (a.ax ?? {})).toBe(false);
  });
});
```

Update the existing `--self-test` assertion in `test/ax-swift.test.ts` to include the identifier on the Button element:

```ts
    expect(els).toEqual([
      { role: "Window", x: 0, y: 0, w: 1000, h: 1000 },
      { role: "Button", label: "Save", identifier: "save-btn", x: 100, y: 200, w: 80, h: 30, focused: true, parent: 0, depth: 1 },
    ]);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ax.test.ts test/trace.anchors.test.ts`
Expected: FAIL — `identifier` is not carried.

- [ ] **Step 3: Implement**

In `native/ax-dump.swift`, add `let identifier: String?` to `AXElem` (after `label`), read it in the walk alongside the label with `str(el, kAXIdentifierAttribute as String)`, pass it to every `AXElem(...)` construction, and update the `--self-test` payload's Button to `identifier: "save-btn"` (the Window keeps `identifier: nil`).

In `src/embed/types.ts`, add to `UIElement` after `label`:

```ts
  /** App-assigned stable id (AXIdentifier). Where present, a far better anchor
   *  than a positional path, which shifts when the UI gains or loses a sibling. */
  identifier?: string;
```

In `src/capture/ax/parse.ts`, after the label line:

```ts
    if (typeof o.identifier === "string" && o.identifier.length > 0) el.identifier = o.identifier;
```

In `src/trace/types.ts`, extend the anchor's ax layer:

```ts
  ax?: { role: string; label?: string; identifier?: string; path: string };
```

In `src/trace/anchors.ts`, inside `buildAnchor` where `anchor.ax` is built:

```ts
      anchor.ax = {
        role: el.role,
        ...(el.label !== undefined && el.label.length > 0 ? { label: el.label } : {}),
        ...(el.identifier !== undefined && el.identifier.length > 0
          ? { identifier: el.identifier }
          : {}),
        path: axPathOf(input.ax, hit),
      };
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/ax.test.ts test/ax-swift.test.ts test/trace.anchors.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/ax-dump.swift src/embed/types.ts src/capture/ax/parse.ts src/trace/types.ts src/trace/anchors.ts test/ax.test.ts test/ax-swift.test.ts test/trace.anchors.test.ts
git commit -m "feat(capture): read AXIdentifier and record it on anchors

An app-assigned stable id beats a positional path, which shifts whenever
the UI gains or loses a sibling. Purely additive; how the executor ranks
identifier-versus-path is that spec's concern."
```

---

## Task 4: Pure keymap resolution

**Files:**
- Create: `src/capture/env/keymap.ts`
- Test: `test/env.keymap.test.ts`

**Interfaces:**
- Consumes: `Keymap` from `./types.js`.
- Produces:
  - `macKeycodeFor(uiohookKeycode: number): number | undefined`
  - `resolveChar(km: Keymap, uiohookKeycode: number, mods: readonly string[]): { char?: string; modifiers: string[] }`

**Background — the two halves.** uiohook keycodes are PC set-1 scancodes (`Space: 57`); macOS virtual keycodes are different (`Space: 49`). A translation table is unavoidable. It is *not* the "static table" rejected during design: **it maps physical keys, which are layout-independent.** A US user and a Dvorak user have identical scancode↔virtual-keycode mappings and completely different characters. Only the character half comes from the sidecar.

**The modifier rule** — this is the load-bearing part:
- **cmd or ctrl present** → a command, not text. No character; all modifiers kept.
- **otherwise** → resolve the character, **consuming** shift/alt into the column choice and stripping them from `modifiers`.

Without consume-and-strip, `gestures.ts`'s existing `if (mods.length > 0) → chord` turns every capital letter into a chord.

- [ ] **Step 1: Write the failing test**

```ts
// test/env.keymap.test.ts
import { describe, expect, it } from "vitest";
import { macKeycodeFor, resolveChar } from "../src/capture/env/keymap.js";
import type { Keymap } from "../src/capture/env/types.js";

/** vk -> [plain, shift, alt, altShift]. 0 = A, 1 = S, 49 = Space, 18 = "1". */
const us: Keymap = {
  layoutId: "com.apple.keylayout.US",
  entries: {
    0: ["a", "A", "å", "Å"],
    1: ["s", "S", "ß", "Í"],
    18: ["1", "!", "¡", "⁄"],
    49: [" ", " ", " ", " "],
  },
};

/** Dvorak: the same physical keys, different characters. */
const dvorak: Keymap = {
  layoutId: "com.apple.keylayout.Dvorak",
  entries: { 0: ["a", "A", "å", "Å"], 1: ["o", "O", "ø", "Ø"] },
};

describe("macKeycodeFor", () => {
  it("maps the text-entry core from scancode to virtual keycode", () => {
    expect(macKeycodeFor(30)).toBe(0); // A
    expect(macKeycodeFor(31)).toBe(1); // S
    expect(macKeycodeFor(57)).toBe(49); // Space
    expect(macKeycodeFor(2)).toBe(18); // 1
  });

  it("returns undefined for keys outside the table", () => {
    expect(macKeycodeFor(99999)).toBeUndefined();
  });

  it("is injective — two scancodes must never share a virtual keycode", () => {
    const seen = new Map<number, number>();
    for (let sc = 0; sc < 4096; sc++) {
      const vk = macKeycodeFor(sc);
      if (vk === undefined) continue;
      expect(seen.has(vk), `vk ${vk} claimed by ${seen.get(vk)} and ${sc}`).toBe(false);
      seen.set(vk, sc);
    }
  });
});

describe("resolveChar", () => {
  it("resolves an unmodified key", () => {
    expect(resolveChar(us, 30, [])).toEqual({ char: "a", modifiers: [] });
  });

  it("CONSUMES shift into the character — a capital is text, not a chord", () => {
    expect(resolveChar(us, 30, ["shift"])).toEqual({ char: "A", modifiers: [] });
    expect(resolveChar(us, 2, ["shift"])).toEqual({ char: "!", modifiers: [] });
  });

  it("consumes alt, and shift+alt together", () => {
    expect(resolveChar(us, 30, ["alt"])).toEqual({ char: "å", modifiers: [] });
    expect(resolveChar(us, 30, ["alt", "shift"])).toEqual({ char: "Å", modifiers: [] });
  });

  it("produces NO character and keeps every modifier when cmd is held", () => {
    expect(resolveChar(us, 31, ["cmd"])).toEqual({ modifiers: ["cmd"] });
    expect(resolveChar(us, 31, ["cmd", "shift"])).toEqual({ modifiers: ["cmd", "shift"] });
  });

  it("keeps alt alongside cmd — alt was never consumed", () => {
    expect(resolveChar(us, 31, ["alt", "cmd"])).toEqual({ modifiers: ["alt", "cmd"] });
  });

  it("treats ctrl like cmd", () => {
    expect(resolveChar(us, 30, ["ctrl"])).toEqual({ modifiers: ["ctrl"] });
  });

  it("returns modifiers sorted, so a chord keys identically however it arrived", () => {
    expect(resolveChar(us, 31, ["shift", "cmd"]).modifiers).toEqual(["cmd", "shift"]);
  });

  it("resolves the same physical key differently per layout", () => {
    expect(resolveChar(us, 31, []).char).toBe("s");
    expect(resolveChar(dvorak, 31, []).char).toBe("o");
  });

  it("yields no character for an unmapped scancode", () => {
    expect(resolveChar(us, 99999, [])).toEqual({ modifiers: [] });
  });

  it("yields no character when the layout has no entry for the key", () => {
    expect(resolveChar(dvorak, 57, [])).toEqual({ modifiers: [] });
  });

  it("yields no character when the column is empty (a non-text key)", () => {
    const km: Keymap = { layoutId: "x", entries: { 0: ["", "", "", ""] } };
    expect(resolveChar(km, 30, [])).toEqual({ modifiers: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/env.keymap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/capture/env/keymap.ts
/**
 * Character resolution, in two halves.
 *
 * SCANCODE -> VIRTUAL KEYCODE is layout-INDEPENDENT: it identifies a physical
 * key. uiohook reports PC set-1 scancodes (Space = 57); macOS wants virtual
 * keycodes (Space = 49). A US user and a Dvorak user share this table exactly.
 *
 * VIRTUAL KEYCODE -> CHARACTER is layout-DEPENDENT and comes from the sidecar's
 * UCKeyTranslate dump. That split is why the fixed table below is not the "static
 * keymap" rejected during design.
 *
 * Pure: no store, no clock, no I/O.
 */

import type { Keymap } from "./types.js";

/**
 * uiohook scancode -> macOS virtual keycode, for the text-entry core: letters,
 * the digit row, punctuation, space. Keys outside it (arrows, function keys,
 * modifiers) produce no character by definition and resolve to undefined, which
 * the caller reports as "no char" rather than guessing.
 */
const SCANCODE_TO_VK: Readonly<Record<number, number>> = {
  // letters
  30: 0, 48: 11, 46: 8, 32: 2, 18: 14, 33: 3, 34: 5, 35: 4, 23: 34, 36: 38,
  37: 40, 38: 37, 50: 46, 49: 45, 24: 31, 25: 35, 16: 12, 19: 15, 31: 1, 20: 17,
  22: 32, 47: 9, 17: 13, 45: 7, 21: 16, 44: 6,
  // digit row
  2: 18, 3: 19, 4: 20, 5: 21, 6: 23, 7: 22, 8: 26, 9: 28, 10: 25, 11: 29,
  // punctuation + space
  12: 27, 13: 24, 26: 33, 27: 30, 43: 42, 39: 41, 40: 39, 41: 50, 51: 43,
  52: 47, 53: 44, 57: 49,
};

export function macKeycodeFor(uiohookKeycode: number): number | undefined {
  return SCANCODE_TO_VK[uiohookKeycode];
}

/** Column index into a keymap entry: [plain, shift, alt, altShift]. */
function columnFor(shift: boolean, alt: boolean): 0 | 1 | 2 | 3 {
  if (shift && alt) return 3;
  if (alt) return 2;
  if (shift) return 1;
  return 0;
}

/**
 * Resolve a keystroke to a character, or to a chord.
 *
 * cmd or ctrl present -> a command: no character, every modifier kept.
 * Otherwise -> resolve the character, CONSUMING shift/alt into the column choice
 * and stripping them from the returned modifiers.
 *
 * The consume-and-strip half is load-bearing. `gestures.ts` treats any surviving
 * modifier as chord-forming, so leaving shift on a capital letter would lift
 * "A" as the chord shift+A instead of the text "A" — every capital, every
 * shifted symbol.
 */
export function resolveChar(
  km: Keymap,
  uiohookKeycode: number,
  mods: readonly string[],
): { char?: string; modifiers: string[] } {
  const sorted = [...mods].sort();
  const isCommand = sorted.includes("cmd") || sorted.includes("ctrl");
  if (isCommand) return { modifiers: sorted };

  const vk = macKeycodeFor(uiohookKeycode);
  if (vk === undefined) return { modifiers: sorted };

  const entry = km.entries[vk];
  if (entry === undefined) return { modifiers: sorted };

  const char = entry[columnFor(sorted.includes("shift"), sorted.includes("alt"))];
  if (char === undefined || char.length === 0) return { modifiers: sorted };

  // shift/alt were consumed selecting the column; anything else was never here,
  // because cmd/ctrl already returned above.
  return { char, modifiers: [] };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/env.keymap.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capture/env/keymap.ts test/env.keymap.test.ts
git commit -m "feat(capture): pure keymap resolution, consume-and-strip modifiers

Two halves: scancode->virtual-keycode is layout-independent (a fixed table
identifying physical keys, shared by US and Dvorak alike); virtual-keycode->
character is layout-dependent and comes from the sidecar.

cmd/ctrl means a command - no character, all modifiers kept. Otherwise the
character resolves and shift/alt are CONSUMED into the column choice. That
is load-bearing: gestures.ts treats any surviving modifier as chord-forming,
so leaving shift on would lift every capital letter as a chord."
```

---

## Task 5: Pure display helpers

**Files:**
- Create: `src/capture/env/displays.ts`
- Test: `test/env.displays.test.ts`

**Interfaces:**
- Consumes: `DisplayInfo` from `./types.js`; `Vec2`, `Rect` — declare locally (see below), since `capture/` must not depend on `trace/`.
- Produces:
  - `displayIdAt(displays: readonly DisplayInfo[], p: Point2): string`
  - `outsideKnownDisplays(displays: readonly DisplayInfo[], bounds: Bounds): boolean`
  - `interface Point2 { x: number; y: number }`, `interface Bounds { x: number; y: number; w: number; h: number }`

**Note on types.** `trace/` imports from `capture/`, never the reverse, so these two shapes are declared here rather than imported from `trace/types.js`. They are structurally identical to `Vec2`/`Rect` — the same "minimal local shape" pattern `segment/types.ts` uses for `SegEvent`.

- [ ] **Step 1: Write the failing test**

```ts
// test/env.displays.test.ts
import { describe, expect, it } from "vitest";
import { displayIdAt, outsideKnownDisplays } from "../src/capture/env/displays.js";
import type { DisplayInfo } from "../src/capture/env/types.js";

const primary: DisplayInfo = { id: "1", x: 0, y: 0, w: 2560, h: 1440, scale: 2, primary: true };
const right: DisplayInfo = { id: "2", x: 2560, y: 0, w: 1920, h: 1080, scale: 1, primary: false };
const both = [primary, right];

describe("displayIdAt", () => {
  it("finds the containing display", () => {
    expect(displayIdAt(both, { x: 100, y: 100 })).toBe("1");
    expect(displayIdAt(both, { x: 3000, y: 500 })).toBe("2");
  });

  it("treats the left/top edge as inside and the right/bottom edge as the next display", () => {
    // Half-open intervals, or the seam between adjacent displays is ambiguous.
    expect(displayIdAt(both, { x: 2560, y: 0 })).toBe("2");
    expect(displayIdAt(both, { x: 2559, y: 0 })).toBe("1");
  });

  it("falls back to the primary display for a point on no display", () => {
    expect(displayIdAt(both, { x: -500, y: -500 })).toBe("1");
    expect(displayIdAt(both, { x: 9999, y: 9999 })).toBe("1");
  });

  it("falls back to the first display when none is flagged primary", () => {
    expect(displayIdAt([{ ...right, primary: false }], { x: -1, y: -1 })).toBe("2");
  });

  it("returns D0 with no displays at all — the same default lift already uses", () => {
    expect(displayIdAt([], { x: 0, y: 0 })).toBe("D0");
  });
});

describe("outsideKnownDisplays", () => {
  it("is false for a window on a known display", () => {
    expect(outsideKnownDisplays(both, { x: 100, y: 100, w: 800, h: 600 })).toBe(false);
    expect(outsideKnownDisplays(both, { x: 2600, y: 50, w: 400, h: 300 })).toBe(false);
  });

  it("is false for a window straddling two displays", () => {
    expect(outsideKnownDisplays(both, { x: 2400, y: 100, w: 400, h: 300 })).toBe(false);
  });

  it("is TRUE for a window wholly outside every display — the re-query signal", () => {
    expect(outsideKnownDisplays(both, { x: 6000, y: 0, w: 800, h: 600 })).toBe(true);
    expect(outsideKnownDisplays(both, { x: 0, y: -2000, w: 800, h: 600 })).toBe(true);
  });

  it("is false with no known displays — nothing to contradict, so do not thrash", () => {
    expect(outsideKnownDisplays([], { x: 0, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it("ignores a degenerate window rather than treating it as a signal", () => {
    expect(outsideKnownDisplays(both, { x: 9999, y: 9999, w: 0, h: 0 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/env.displays.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/capture/env/displays.ts
/**
 * Pure geometry over a display topology. No store, no clock, no I/O.
 *
 * `Point2`/`Bounds` are declared here rather than imported from `trace/`:
 * `trace/` depends on `capture/`, never the reverse. Same "minimal local shape"
 * pattern `segment/types.ts` uses for `SegEvent`.
 */

import type { DisplayInfo } from "./types.js";

export interface Point2 {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The default `lift` already uses when no display is known. */
const NO_DISPLAY = "D0";

/**
 * Half-open containment: `[x, x+w)`. Closed intervals would make the seam
 * between adjacent displays ambiguous, so a point on the boundary would resolve
 * to whichever display happened to be listed first.
 */
const contains = (d: DisplayInfo, p: Point2): boolean =>
  p.x >= d.x && p.x < d.x + d.w && p.y >= d.y && p.y < d.y + d.h;

const overlaps = (d: DisplayInfo, b: Bounds): boolean =>
  b.x < d.x + d.w && b.x + b.w > d.x && b.y < d.y + d.h && b.y + b.h > d.y;

export function displayIdAt(displays: readonly DisplayInfo[], p: Point2): string {
  if (displays.length === 0) return NO_DISPLAY;
  const hit = displays.find((d) => contains(d, p));
  if (hit !== undefined) return hit.id;
  // A point off every display still has to land somewhere deterministic.
  return (displays.find((d) => d.primary) ?? displays[0]!).id;
}

/**
 * True when `bounds` lies wholly outside every known display — the signal that
 * topology changed and must be re-queried.
 *
 * Returns false with no known displays (nothing to contradict, and re-querying
 * on every poll would thrash) and false for a degenerate zero-area window, which
 * some apps report transiently while opening.
 */
export function outsideKnownDisplays(displays: readonly DisplayInfo[], bounds: Bounds): boolean {
  if (displays.length === 0) return false;
  if (bounds.w <= 0 || bounds.h <= 0) return false;
  return !displays.some((d) => overlaps(d, bounds));
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/env.displays.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capture/env/displays.ts test/env.displays.test.ts
git commit -m "feat(capture): pure display geometry

Half-open containment so the seam between adjacent displays is
unambiguous. outsideKnownDisplays is the re-query signal and stays false
with no known displays (nothing to contradict) and for degenerate windows
some apps report transiently while opening."
```

---

## Task 6: uiohook input — modifiers and adaptive sampling

**Files:**
- Create: `src/capture/producers/sampling.ts`
- Modify: `src/capture/producers/uiohook-input.ts`
- Test: `test/capture.sampling.test.ts`

**Interfaces:**
- Produces:
  - `interface SampleState { lastMoveTMono: number; buttonsDown: number }`
  - `interface SampleOptions { mouseMoveThrottleMs: number; dragSampleMs: number }`
  - `shouldSampleMove(state: SampleState, tMono: number, opts: SampleOptions): boolean`
  - `const DEFAULT_SAMPLE_OPTIONS: SampleOptions` — `{ mouseMoveThrottleMs: 100, dragSampleMs: 12 }`
  - `modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): string[]`

**Background.** The throttle decision is extracted into its own module for exactly one reason: `uiohook-napi` is a native module, so the producer itself cannot be unit-tested, but the rule can be. `Path` fitting cannot recover a drag curve from 100ms samples, hence 12ms while a button is down.

- [ ] **Step 1: Write the failing test**

```ts
// test/capture.sampling.test.ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAMPLE_OPTIONS,
  modifiersOf,
  shouldSampleMove,
  type SampleState,
} from "../src/capture/producers/sampling.js";

const o = DEFAULT_SAMPLE_OPTIONS;

describe("shouldSampleMove", () => {
  it("throttles to 100ms when no button is down", () => {
    const s: SampleState = { lastMoveTMono: 1000, buttonsDown: 0 };
    expect(shouldSampleMove(s, 1050, o)).toBe(false);
    expect(shouldSampleMove(s, 1100, o)).toBe(true);
  });

  it("samples at 12ms while a button is down — a drag curve needs the density", () => {
    const s: SampleState = { lastMoveTMono: 1000, buttonsDown: 1 };
    expect(shouldSampleMove(s, 1005, o)).toBe(false);
    expect(shouldSampleMove(s, 1012, o)).toBe(true);
  });

  it("stays at the drag rate while more than one button is held", () => {
    expect(shouldSampleMove({ lastMoveTMono: 1000, buttonsDown: 2 }, 1012, o)).toBe(true);
  });

  it("always samples the first move of a session", () => {
    expect(shouldSampleMove({ lastMoveTMono: -Infinity, buttonsDown: 0 }, 0, o)).toBe(true);
  });

  it("never blocks on a non-monotonic stamp", () => {
    expect(shouldSampleMove({ lastMoveTMono: 5000, buttonsDown: 0 }, 1000, o)).toBe(true);
  });

  it("honours overridden rates", () => {
    const s: SampleState = { lastMoveTMono: 0, buttonsDown: 1 };
    expect(shouldSampleMove(s, 5, { mouseMoveThrottleMs: 100, dragSampleMs: 1 })).toBe(true);
  });
});

describe("modifiersOf", () => {
  it("maps uiohook booleans to canonical sorted names", () => {
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: true, shiftKey: true })).toEqual([
      "cmd",
      "shift",
    ]);
  });

  it("returns [] when nothing is held", () => {
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toEqual([]);
  });

  it("sorts, so one chord keys identically however the flags arrive", () => {
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toEqual([
      "alt",
      "cmd",
      "ctrl",
      "shift",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/capture.sampling.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `sampling.ts`**

```ts
// src/capture/producers/sampling.ts
/**
 * The mouse-move throttle decision and modifier normalization, extracted from
 * `uiohook-input.ts` for one reason: `uiohook-napi` is a native module, so the
 * producer cannot be unit-tested, but these rules can.
 *
 * Pure: no store, no clock, no I/O.
 */

export interface SampleState {
  lastMoveTMono: number;
  /** How many mouse buttons are currently held. */
  buttonsDown: number;
}

export interface SampleOptions {
  mouseMoveThrottleMs: number;
  dragSampleMs: number;
}

/**
 * 12ms during a drag: `Path` fitting cannot recover a curve from 100ms samples,
 * and on a drag the path IS the payload. 100ms otherwise keeps the firehose
 * bounded — this is not a global rate increase.
 */
export const DEFAULT_SAMPLE_OPTIONS: SampleOptions = {
  mouseMoveThrottleMs: 100,
  dragSampleMs: 12,
};

export function shouldSampleMove(
  state: SampleState,
  tMono: number,
  opts: SampleOptions = DEFAULT_SAMPLE_OPTIONS,
): boolean {
  const interval = state.buttonsDown > 0 ? opts.dragSampleMs : opts.mouseMoveThrottleMs;
  const elapsed = tMono - state.lastMoveTMono;
  // A non-monotonic stamp must not wedge sampling shut until the clock catches up.
  if (!(elapsed >= 0)) return true;
  return elapsed >= interval;
}

/** uiohook's modifier booleans -> canonical sorted names. */
export function modifiersOf(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): string[] {
  const out: string[] = [];
  if (e.altKey) out.push("alt");
  if (e.metaKey) out.push("cmd");
  if (e.ctrlKey) out.push("ctrl");
  if (e.shiftKey) out.push("shift");
  return out.sort();
}
```

- [ ] **Step 4: Rewrite the producer to use it**

Replace the body of `src/capture/producers/uiohook-input.ts` with:

```ts
/**
 * UiohookInputProducer — global mouse/keyboard capture via uiohook-napi (an
 * optionalDependency; install it and grant macOS Accessibility permission). Not
 * imported by the package barrel, so consumers that don't capture input never
 * load the native module.
 *
 * mouse_move is ADAPTIVE: `dragSampleMs` (12) while any button is held, because
 * `Path` fitting cannot recover a drag curve from 100ms samples, and
 * `mouseMoveThrottleMs` (100) otherwise so the firehose stays bounded.
 *
 * Key events carry `modifiers` alongside the raw `keycode`. Characters are NOT
 * resolved here — that needs the keyboard layout and happens at lift time
 * (`resolveKeys`), so the raw keystroke stays re-interpretable.
 */

import {
  uIOhook,
  type UiohookKeyboardEvent,
  type UiohookMouseEvent,
  type UiohookWheelEvent,
} from "uiohook-napi";
import type { CaptureContext, Producer } from "../types.js";
import {
  DEFAULT_SAMPLE_OPTIONS,
  modifiersOf,
  shouldSampleMove,
  type SampleOptions,
} from "./sampling.js";

export interface UiohookInputOptions {
  /** Minimum ms between emitted mouse_move events with no button held (default 100). */
  mouseMoveThrottleMs?: number;
  /** Minimum ms between emitted mouse_move events during a drag (default 12). */
  dragSampleMs?: number;
}

export class UiohookInputProducer implements Producer {
  readonly id = "input";
  private ctx: CaptureContext | undefined;
  private lastMoveTMono = -Infinity;
  private buttonsDown = 0;
  private readonly sample: SampleOptions;
  private bound = false;

  constructor(opts: UiohookInputOptions = {}) {
    this.sample = {
      mouseMoveThrottleMs: opts.mouseMoveThrottleMs ?? DEFAULT_SAMPLE_OPTIONS.mouseMoveThrottleMs,
      dragSampleMs: opts.dragSampleMs ?? DEFAULT_SAMPLE_OPTIONS.dragSampleMs,
    };
  }

  private readonly onKeyDown = (e: UiohookKeyboardEvent) =>
    this.ctx?.emitEvent({ kind: "key_down", data: { keycode: e.keycode, modifiers: modifiersOf(e) } });
  private readonly onKeyUp = (e: UiohookKeyboardEvent) =>
    this.ctx?.emitEvent({ kind: "key_up", data: { keycode: e.keycode, modifiers: modifiersOf(e) } });

  private readonly onMouseDown = (e: UiohookMouseEvent) => {
    this.buttonsDown += 1;
    this.ctx?.emitEvent({ kind: "mouse_down", x: e.x, y: e.y, data: { button: e.button } });
  };
  private readonly onMouseUp = (e: UiohookMouseEvent) => {
    this.buttonsDown = Math.max(0, this.buttonsDown - 1);
    this.ctx?.emitEvent({ kind: "mouse_up", x: e.x, y: e.y, data: { button: e.button } });
  };
  private readonly onWheel = (e: UiohookWheelEvent) =>
    this.ctx?.emitEvent({
      kind: "scroll",
      x: e.x,
      y: e.y,
      data: { rotation: e.rotation, direction: e.direction },
    });
  private readonly onMouseMove = (e: UiohookMouseEvent) => {
    const t = this.ctx?.clock.now() ?? 0;
    if (!shouldSampleMove({ lastMoveTMono: this.lastMoveTMono, buttonsDown: this.buttonsDown }, t, this.sample)) {
      return;
    }
    this.lastMoveTMono = t;
    this.ctx?.emitEvent({ kind: "mouse_move", x: e.x, y: e.y });
  };

  start(ctx: CaptureContext): void {
    this.ctx = ctx;
    uIOhook.on("keydown", this.onKeyDown);
    uIOhook.on("keyup", this.onKeyUp);
    uIOhook.on("mousedown", this.onMouseDown);
    uIOhook.on("mouseup", this.onMouseUp);
    uIOhook.on("wheel", this.onWheel);
    uIOhook.on("mousemove", this.onMouseMove);
    this.bound = true;
    uIOhook.start();
  }

  stop(): void {
    if (!this.bound) return;
    uIOhook.off("keydown", this.onKeyDown);
    uIOhook.off("keyup", this.onKeyUp);
    uIOhook.off("mousedown", this.onMouseDown);
    uIOhook.off("mouseup", this.onMouseUp);
    uIOhook.off("wheel", this.onWheel);
    uIOhook.off("mousemove", this.onMouseMove);
    this.bound = false;
    this.buttonsDown = 0;
    try {
      uIOhook.stop();
    } catch {
      // hook may already be stopped; ignore
    }
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/capture.sampling.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/capture/producers/sampling.ts src/capture/producers/uiohook-input.ts test/capture.sampling.test.ts
git commit -m "feat(capture): modifiers and adaptive mouse sampling

12ms while a button is held, 100ms otherwise: Path fitting cannot recover a
drag curve from 100ms samples, and on a drag the path IS the payload. Not a
global rate increase - the firehose stays bounded outside drags.

The throttle rule and modifier normalization live in their own module
because uiohook-napi is native and the producer cannot be unit-tested,
but the rules can."
```

---

## Task 7: active-window enrichment and `display_change`

**Files:**
- Modify: `src/capture/types.ts`, `src/capture/producers/active-window.ts`
- Test: `test/capture.active-window.test.ts`

**Interfaces:**
- Consumes: `DisplaySource`, `DisplayInfo` from `../env/types.js`; `outsideKnownDisplays` from `../env/displays.js`.
- Produces: `ActiveWindowOptions` gains `displaySource?: DisplaySource`; `EventKind` gains `"display_change"` and `"keymap_change"`.

**Background — why this producer owns displays.** The re-query signal is "a focused window whose bounds lie outside every known display," and this producer is the only thing that sees window bounds. Producers cannot observe each other's events (`CaptureContext` is emit-only), so putting the check anywhere else would need a second poller. It emits both `focus_change` and `display_change`.

**Testability.** `active-win` is a native module imported at the top of the file. To keep the test offline, extract the query into an injectable seam: add a protected `queryWindow()` method the test can override by subclassing.

- [ ] **Step 1: Write the failing test**

```ts
// test/capture.active-window.test.ts
import { describe, expect, it } from "vitest";
import { ActiveWindowProducer, type WindowSnapshot } from "../src/capture/producers/active-window.js";
import { FakeDisplaySource } from "../src/capture/env/fake.js";
import type { DisplayInfo } from "../src/capture/env/types.js";
import type { CaptureContext, EmittedEvent } from "../src/capture/types.js";
import { MonotonicClock } from "../src/timeline/clock.js";

const primary: DisplayInfo = { id: "1", x: 0, y: 0, w: 2560, h: 1440, scale: 2, primary: true };
const right: DisplayInfo = { id: "2", x: 2560, y: 0, w: 1920, h: 1080, scale: 1, primary: false };

/** A producer whose window query is scripted rather than native. */
class ScriptedProducer extends ActiveWindowProducer {
  constructor(
    private readonly script: (WindowSnapshot | undefined)[],
    opts: ConstructorParameters<typeof ActiveWindowProducer>[0] = {},
  ) {
    super(opts);
  }
  private i = 0;
  protected override async queryWindow(): Promise<WindowSnapshot | undefined> {
    return this.script[Math.min(this.i++, this.script.length - 1)];
  }
}

function harness(): { ctx: CaptureContext; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  const ctx = {
    sessionId: "s1",
    clock: MonotonicClock.start(),
    emitEvent: (ev: EmittedEvent) => void events.push(ev),
    ingestFrame: async () => ({ kept: false }),
    ingestAudio: async () => {},
    reserveBlob: async () => null,
    commitBlob: async () => {},
  } as unknown as CaptureContext;
  return { ctx, events };
}

const win = (app: string, title: string, bounds: WindowSnapshot["bounds"]): WindowSnapshot => ({
  app,
  title,
  windowId: 1,
  bundleId: `com.example.${app}`,
  bounds,
});

describe("ActiveWindowProducer", () => {
  it("emits the enriched focus_change payload", async () => {
    const { ctx, events } = harness();
    const p = new ScriptedProducer([win("Mail", "Inbox", { x: 10, y: 20, w: 800, h: 600 })]);
    await p.pollOnce(ctx);
    const focus = events.find((e) => e.kind === "focus_change");
    expect(focus?.data).toMatchObject({
      app: "Mail",
      title: "Inbox",
      bundleId: "com.example.Mail",
      bounds: { x: 10, y: 20, w: 800, h: 600 },
    });
  });

  it("emits display_change once at first poll, before any focus_change", async () => {
    const { ctx, events } = harness();
    const displays = new FakeDisplaySource([primary]);
    const p = new ScriptedProducer([win("Mail", "Inbox", { x: 10, y: 20, w: 800, h: 600 })], {
      displaySource: displays,
    });
    await p.pollOnce(ctx);
    expect(events[0]?.kind).toBe("display_change");
    expect(events[0]?.data).toEqual({ displays: [primary] });
    expect(displays.queries).toBe(1);
  });

  it("does not re-emit display_change while the topology is unchanged", async () => {
    const { ctx, events } = harness();
    const displays = new FakeDisplaySource([primary]);
    const p = new ScriptedProducer(
      [win("Mail", "A", { x: 0, y: 0, w: 100, h: 100 }), win("Mail", "B", { x: 5, y: 5, w: 100, h: 100 })],
      { displaySource: displays },
    );
    await p.pollOnce(ctx);
    await p.pollOnce(ctx);
    expect(events.filter((e) => e.kind === "display_change")).toHaveLength(1);
    expect(displays.queries).toBe(1);
  });

  it("RE-QUERIES when a window lands outside every known display", async () => {
    const { ctx, events } = harness();
    const displays = new FakeDisplaySource([primary]);
    const p = new ScriptedProducer(
      [
        win("Mail", "A", { x: 0, y: 0, w: 100, h: 100 }),
        win("Mail", "B", { x: 3000, y: 100, w: 400, h: 300 }), // off the known display
      ],
      { displaySource: displays },
    );
    await p.pollOnce(ctx);
    displays.set([primary, right]); // a monitor was plugged in
    await p.pollOnce(ctx);

    const changes = events.filter((e) => e.kind === "display_change");
    expect(changes).toHaveLength(2);
    expect(changes[1]!.data).toEqual({ displays: [primary, right] });
    expect(displays.queries).toBe(2);
  });

  it("keeps the previous topology when a re-query returns nothing", async () => {
    const { ctx, events } = harness();
    const displays = new FakeDisplaySource([primary]);
    const p = new ScriptedProducer(
      [
        win("Mail", "A", { x: 0, y: 0, w: 100, h: 100 }),
        win("Mail", "B", { x: 3000, y: 100, w: 400, h: 300 }),
      ],
      { displaySource: displays },
    );
    await p.pollOnce(ctx);
    displays.set([]); // the sidecar failed
    await p.pollOnce(ctx);
    // Stale beats empty: no second display_change, and no wiping of what we knew.
    expect(events.filter((e) => e.kind === "display_change")).toHaveLength(1);
  });

  it("works with no display source at all", async () => {
    const { ctx, events } = harness();
    const p = new ScriptedProducer([win("Mail", "Inbox", { x: 0, y: 0, w: 10, h: 10 })]);
    await p.pollOnce(ctx);
    expect(events.filter((e) => e.kind === "display_change")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "focus_change")).toHaveLength(1);
  });

  it("does not re-emit focus_change for an unchanged window", async () => {
    const { ctx, events } = harness();
    const p = new ScriptedProducer([win("Mail", "Inbox", { x: 0, y: 0, w: 10, h: 10 })]);
    await p.pollOnce(ctx);
    await p.pollOnce(ctx);
    expect(events.filter((e) => e.kind === "focus_change")).toHaveLength(1);
  });

  it("survives a query that yields nothing", async () => {
    const { ctx, events } = harness();
    const p = new ScriptedProducer([undefined]);
    await p.pollOnce(ctx);
    expect(events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/capture.active-window.test.ts`
Expected: FAIL — `pollOnce` / `WindowSnapshot` are not exported.

- [ ] **Step 3: Add the new event kinds**

In `src/capture/types.ts`:

```ts
export type EventKind =
  | "mouse_move"
  | "mouse_down"
  | "mouse_up"
  | "scroll"
  | "key_down"
  | "key_up"
  | "focus_change" // active-window/app changed
  | "display_change" // display topology at/after this t_mono
  | "keymap_change" // keyboard layout at/after this t_mono
  | "bookmark"; // explicit user hotkey marker
```

- [ ] **Step 4: Rewrite the producer**

```ts
// src/capture/producers/active-window.ts
/**
 * ActiveWindowProducer — polls the focused window via active-win (an
 * optionalDependency) and emits `focus_change` whenever the app/window changes.
 * These are exactly the boundaries the Segmenter, the digest, and the trace IR
 * consume. Not imported by the package barrel.
 *
 * It also owns DISPLAY TOPOLOGY, because the re-query signal is "a focused window
 * whose bounds lie outside every known display" and this is the only producer
 * that sees window bounds. `CaptureContext` is emit-only, so a check anywhere
 * else would need a second poller.
 */

import activeWindow from "active-win";
import type { CaptureContext, Producer } from "../types.js";
import { outsideKnownDisplays } from "../env/displays.js";
import type { DisplayInfo, DisplaySource } from "../env/types.js";

export interface WindowSnapshot {
  app: string;
  title: string;
  windowId: number;
  bundleId?: string;
  url?: string;
  bounds?: { x: number; y: number; w: number; h: number };
}

export interface ActiveWindowOptions {
  /** Poll interval in ms (default 500). */
  pollMs?: number;
  /** When set, the producer also tracks display topology. */
  displaySource?: DisplaySource;
}

export class ActiveWindowProducer implements Producer {
  readonly id = "active-win";
  private ctx: CaptureContext | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastKey: string | undefined;
  private polling = false;
  private displays: DisplayInfo[] = [];
  private readonly pollMs: number;
  private readonly displaySource: DisplaySource | undefined;

  constructor(opts: ActiveWindowOptions = {}) {
    this.pollMs = opts.pollMs ?? 500;
    this.displaySource = opts.displaySource;
  }

  /** The native query, isolated so tests can subclass and script it. */
  protected async queryWindow(): Promise<WindowSnapshot | undefined> {
    const win = await activeWindow();
    if (!win) return undefined;
    const owner = win.owner as { name?: string; bundleId?: string } | undefined;
    return {
      app: owner?.name ?? "unknown",
      title: win.title,
      windowId: win.id,
      ...(typeof owner?.bundleId === "string" ? { bundleId: owner.bundleId } : {}),
      ...(typeof (win as { url?: unknown }).url === "string"
        ? { url: (win as { url: string }).url }
        : {}),
      ...(win.bounds !== undefined
        ? { bounds: { x: win.bounds.x, y: win.bounds.y, w: win.bounds.width, h: win.bounds.height } }
        : {}),
    };
  }

  /** One poll cycle. Exposed for tests; `start()` schedules it. */
  async pollOnce(ctx: CaptureContext): Promise<void> {
    if (this.polling) return; // don't overlap slow queries
    this.polling = true;
    try {
      // Topology first, so a display_change always precedes the focus_change
      // whose coordinates it explains.
      if (this.displaySource !== undefined && this.displays.length === 0) {
        await this.refreshDisplays(ctx);
      }

      const win = await this.queryWindow();
      if (win === undefined) return;

      if (
        this.displaySource !== undefined &&
        win.bounds !== undefined &&
        outsideKnownDisplays(this.displays, win.bounds)
      ) {
        await this.refreshDisplays(ctx);
      }

      const key = `${win.app} ${win.title}`;
      if (key === this.lastKey) return;
      this.lastKey = key;
      ctx.emitEvent({
        kind: "focus_change",
        data: {
          app: win.app,
          title: win.title,
          windowId: win.windowId,
          ...(win.bundleId !== undefined ? { bundleId: win.bundleId } : {}),
          ...(win.url !== undefined ? { url: win.url } : {}),
          ...(win.bounds !== undefined ? { bounds: win.bounds } : {}),
        },
      });
    } catch {
      // permission denied / transient: skip this tick
    } finally {
      this.polling = false;
    }
  }

  /** Re-query topology; an empty result keeps what we knew. Stale beats empty. */
  private async refreshDisplays(ctx: CaptureContext): Promise<void> {
    const next = await this.displaySource!.query();
    if (next.length === 0) return;
    this.displays = next;
    ctx.emitEvent({ kind: "display_change", data: { displays: next } });
  }

  start(ctx: CaptureContext): void {
    this.ctx = ctx;
    void this.pollOnce(ctx);
    this.timer = setInterval(() => void this.pollOnce(ctx), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.displaySource?.close?.();
    this.ctx = undefined;
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/capture.active-window.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/capture/types.ts src/capture/producers/active-window.ts test/capture.active-window.test.ts
git commit -m "feat(capture): window bounds, app identity, and display topology

active-win already returned bounds, bundleId and url; the producer was
discarding them. It now also owns display topology, because the re-query
signal is a focused window lying outside every known display and this is
the only producer that sees bounds - CaptureContext is emit-only, so the
check anywhere else would need a second poller. A failed re-query keeps
the previous topology: stale beats empty."
```

---

## Task 8: `KeymapProducer`

**Files:**
- Create: `src/capture/producers/keymap-producer.ts`
- Test: `test/capture.keymap-producer.test.ts`

**Interfaces:**
- Consumes: `KeymapSource`, `Keymap` from `../env/types.js`; `FakeKeymapSource` from `../env/fake.js`.
- Produces: `class KeymapProducer implements Producer` — `constructor(source: KeymapSource, opts?: { pollMs?: number })`, plus `pollOnce(ctx)` for tests.

**Background — why a poll here but not for displays.** A display change has a free observable signal in data already collected; a layout change has no side effect on anything recorded. Watching `kTISNotifySelectedKeyboardInputSourceChanged` properly would need a long-running sidecar instead of one-shot `execFile` — a larger architectural change than this work should make. One spawn per minute is the cheap correct-enough answer.

- [ ] **Step 1: Write the failing test**

```ts
// test/capture.keymap-producer.test.ts
import { describe, expect, it } from "vitest";
import { KeymapProducer } from "../src/capture/producers/keymap-producer.js";
import { FakeKeymapSource } from "../src/capture/env/fake.js";
import type { Keymap } from "../src/capture/env/types.js";
import type { CaptureContext, EmittedEvent } from "../src/capture/types.js";
import { MonotonicClock } from "../src/timeline/clock.js";

const us: Keymap = { layoutId: "com.apple.keylayout.US", entries: { 0: ["a", "A", "å", "Å"] } };
const dvorak: Keymap = { layoutId: "com.apple.keylayout.Dvorak", entries: { 0: ["a", "A", "å", "Å"] } };

function harness(): { ctx: CaptureContext; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  const ctx = {
    sessionId: "s1",
    clock: MonotonicClock.start(),
    emitEvent: (ev: EmittedEvent) => void events.push(ev),
    ingestFrame: async () => ({ kept: false }),
    ingestAudio: async () => {},
    reserveBlob: async () => null,
    commitBlob: async () => {},
  } as unknown as CaptureContext;
  return { ctx, events };
}

describe("KeymapProducer", () => {
  it("emits the layout once on the first poll", async () => {
    const { ctx, events } = harness();
    await new KeymapProducer(new FakeKeymapSource(us)).pollOnce(ctx);
    expect(events).toEqual([{ kind: "keymap_change", data: us }]);
  });

  it("does not re-emit while the layout is unchanged", async () => {
    const { ctx, events } = harness();
    const p = new KeymapProducer(new FakeKeymapSource(us));
    await p.pollOnce(ctx);
    await p.pollOnce(ctx);
    expect(events).toHaveLength(1);
  });

  it("emits again when the layout changes mid-session", async () => {
    const { ctx, events } = harness();
    const src = new FakeKeymapSource(us);
    const p = new KeymapProducer(src);
    await p.pollOnce(ctx);
    src.set(dvorak);
    await p.pollOnce(ctx);
    expect(events.map((e) => (e.data as Keymap).layoutId)).toEqual([
      "com.apple.keylayout.US",
      "com.apple.keylayout.Dvorak",
    ]);
  });

  it("emits nothing when the source yields nothing, and recovers later", async () => {
    const { ctx, events } = harness();
    const src = new FakeKeymapSource(undefined);
    const p = new KeymapProducer(src);
    await p.pollOnce(ctx);
    expect(events).toHaveLength(0);
    src.set(us);
    await p.pollOnce(ctx);
    expect(events).toHaveLength(1);
  });

  it("does not overlap slow queries", async () => {
    const { ctx } = harness();
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = {
      query: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return us;
      },
    };
    const p = new KeymapProducer(slow);
    await Promise.all([p.pollOnce(ctx), p.pollOnce(ctx), p.pollOnce(ctx)]);
    expect(maxInFlight).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/capture.keymap-producer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/capture/producers/keymap-producer.ts
/**
 * KeymapProducer — emits `keymap_change` at session start and whenever the
 * keyboard layout changes, so `resolveKeys` can resolve characters against the
 * layout that was actually active at each t_mono.
 *
 * It polls, unlike display tracking, and the asymmetry is deliberate: a display
 * change has a free observable signal in data already collected (a window off
 * every known display), while a layout change has no side effect on anything
 * recorded. Watching kTISNotifySelectedKeyboardInputSourceChanged properly would
 * need a long-running sidecar instead of one-shot execFile — a larger change
 * than this work should make. One spawn per minute is cheap enough.
 */

import type { CaptureContext, Producer } from "../types.js";
import type { KeymapSource } from "../env/types.js";

export interface KeymapProducerOptions {
  /** Poll interval in ms (default 60_000). */
  pollMs?: number;
}

export class KeymapProducer implements Producer {
  readonly id = "keymap";
  private timer: NodeJS.Timeout | undefined;
  private lastLayoutId: string | undefined;
  private polling = false;
  private readonly pollMs: number;

  constructor(
    private readonly source: KeymapSource,
    opts: KeymapProducerOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 60_000;
  }

  /** One poll cycle. Exposed for tests; `start()` schedules it. */
  async pollOnce(ctx: CaptureContext): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const km = await this.source.query();
      // No layout is not a layout change — stay silent and try again next tick.
      if (km === undefined) return;
      if (km.layoutId === this.lastLayoutId) return;
      this.lastLayoutId = km.layoutId;
      ctx.emitEvent({ kind: "keymap_change", data: km });
    } catch {
      // best-effort: a failed probe must never sink the recording
    } finally {
      this.polling = false;
    }
  }

  start(ctx: CaptureContext): void {
    void this.pollOnce(ctx);
    this.timer = setInterval(() => void this.pollOnce(ctx), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.source.close?.();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/capture.keymap-producer.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capture/producers/keymap-producer.ts test/capture.keymap-producer.test.ts
git commit -m "feat(capture): KeymapProducer emits keymap_change

Session start plus a 60s poll, emitting only when layoutId differs. It polls
where display tracking does not, because a layout change has no observable
side effect in anything we record - the alternative is a long-running
sidecar watching a Darwin notification, which is a bigger architectural
change than this work should make."
```

---

## Task 9: `ax_snapshot` storage

**Files:**
- Modify: `src/store/sqlite/schema.ts`, `src/store/types.ts`, `src/store/store.ts`
- Test: `test/ax-snapshot.store.test.ts`

**Interfaces:**
- Produces, on `DualStore`:
  - `interface AxSnapshotRow { id, sessionId, tMono, frameId: string | null, reason, walkMs, elements: UIElement[] }`
  - `type AxSnapshotReason = "keyframe" | "focus_change" | "bookmark" | "dwell_resume"`
  - `putAxSnapshot(row: AxSnapshotRow): Promise<void>`
  - `getAxAt(sessionId: string, tMono: number): AxSnapshotRow | undefined` — nearest at-or-before
  - `getFrameAx(frameId: string): UIElement[]` — now reads `ax_snapshot` first, falls back to `frame_ax`

**Background.** No migration mechanism exists (`CREATE TABLE IF NOT EXISTS` on every open), so `frame_ax` can never change shape. New writes all go to `ax_snapshot`; `frame_ax` survives read-only for sessions recorded before this change. The cascade is from `session`, not `frame` — a boundary snapshot has no frame to inherit a delete path from.

- [ ] **Step 1: Write the failing test**

```ts
// test/ax-snapshot.store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import type { UIElement } from "../src/embed/types.js";

let dir: string;
let store: DualStore;
let sessionId: string;

const els = (role: string): UIElement[] => [{ role, x: 0, y: 0, w: 10, h: 10 }];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "deskrag-axsnap-"));
  store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  sessionId = ulid();
  await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ax_snapshot", () => {
  it("round-trips a boundary snapshot with no frame", async () => {
    const row = {
      id: ulid(),
      sessionId,
      tMono: 1000,
      frameId: null,
      reason: "focus_change" as const,
      walkMs: 42.5,
      elements: els("AXWindow"),
    };
    await store.putAxSnapshot(row);
    expect(store.getAxAt(sessionId, 1000)).toEqual(row);
  });

  it("returns the nearest snapshot AT OR BEFORE the requested t_mono", async () => {
    for (const t of [100, 500, 900]) {
      await store.putAxSnapshot({
        id: ulid(), sessionId, tMono: t, frameId: null,
        reason: "focus_change", walkMs: 1, elements: els(`R${t}`),
      });
    }
    expect(store.getAxAt(sessionId, 700)?.tMono).toBe(500);
    expect(store.getAxAt(sessionId, 900)?.tMono).toBe(900);
    expect(store.getAxAt(sessionId, 5000)?.tMono).toBe(900);
  });

  it("returns undefined when nothing precedes the requested t_mono", async () => {
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 500, frameId: null,
      reason: "bookmark", walkMs: 1, elements: els("AXWindow"),
    });
    expect(store.getAxAt(sessionId, 100)).toBeUndefined();
  });

  it("does not leak snapshots across sessions", async () => {
    const other = ulid();
    await store.putSession({ id: other, startedAt: Date.now(), epochMono: 0 });
    await store.putAxSnapshot({
      id: ulid(), sessionId: other, tMono: 100, frameId: null,
      reason: "bookmark", walkMs: 1, elements: els("Other"),
    });
    expect(store.getAxAt(sessionId, 5000)).toBeUndefined();
  });

  it("STORES AN EMPTY RESULT — 'captured nothing' must differ from 'never captured'", async () => {
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 100, frameId: null,
      reason: "focus_change", walkMs: 3, elements: [],
    });
    const got = store.getAxAt(sessionId, 100);
    expect(got).toBeDefined();
    expect(got!.elements).toEqual([]);
    expect(got!.reason).toBe("focus_change");
  });

  it("serves getFrameAx from ax_snapshot when a frame is attached", async () => {
    const frameId = ulid();
    await store.putFrames([{
      id: frameId, sessionId, tMono: 10, width: 100, height: 100,
      phash: 0n, frameOffset: 0, segmentIds: [],
    }]);
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 10, frameId,
      reason: "keyframe", walkMs: 2, elements: els("AXButton"),
    });
    expect(store.getFrameAx(frameId)).toEqual(els("AXButton"));
  });

  it("falls back to legacy frame_ax for sessions recorded before this change", async () => {
    const frameId = ulid();
    await store.putFrames([{
      id: frameId, sessionId, tMono: 10, width: 100, height: 100,
      phash: 0n, frameOffset: 0, segmentIds: [],
    }]);
    await store.putFrameAx(frameId, els("AXLegacy"));
    expect(store.getFrameAx(frameId)).toEqual(els("AXLegacy"));
  });

  it("prefers ax_snapshot over legacy frame_ax for the same frame", async () => {
    const frameId = ulid();
    await store.putFrames([{
      id: frameId, sessionId, tMono: 10, width: 100, height: 100,
      phash: 0n, frameOffset: 0, segmentIds: [],
    }]);
    await store.putFrameAx(frameId, els("AXLegacy"));
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 10, frameId,
      reason: "keyframe", walkMs: 2, elements: els("AXNew"),
    });
    expect(store.getFrameAx(frameId)).toEqual(els("AXNew"));
  });

  it("cascades on session delete", async () => {
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 100, frameId: null,
      reason: "bookmark", walkMs: 1, elements: els("AXWindow"),
    });
    await store.deleteSession(sessionId);
    expect(store.getAxAt(sessionId, 5000)).toBeUndefined();
  });

  it("registers NO vector space", async () => {
    const before = store.listVectorSpaces();
    await store.putAxSnapshot({
      id: ulid(), sessionId, tMono: 1, frameId: null,
      reason: "bookmark", walkMs: 1, elements: els("AXWindow"),
    });
    expect(store.listVectorSpaces()).toEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ax-snapshot.store.test.ts`
Expected: FAIL — `store.putAxSnapshot is not a function`.

- [ ] **Step 3: Add the schema**

Append to `SCHEMA_SQL` in `src/store/sqlite/schema.ts`, before the closing backtick:

```sql
-- AX snapshots. Supersedes frame_ax, which stays readable for sessions recorded
-- before this table existed (there is no migration mechanism: every table is
-- CREATE TABLE IF NOT EXISTS, so an existing table's shape can never change).
--
-- Cascades from SESSION, not frame: a boundary-triggered snapshot has no frame
-- and so cannot inherit frame_ax's delete path. An empty elements array is a
-- real row - "captured nothing" must stay distinguishable from "never captured",
-- which is what `reason` exists to measure.
CREATE TABLE IF NOT EXISTS ax_snapshot (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  t_mono      REAL NOT NULL,
  frame_id    TEXT REFERENCES frame(id) ON DELETE CASCADE,  -- NULL for boundary captures
  reason      TEXT NOT NULL,        -- keyframe | focus_change | bookmark | dwell_resume
  walk_ms     REAL NOT NULL,
  elements    TEXT NOT NULL         -- JSON-encoded UIElement[]
);
CREATE INDEX IF NOT EXISTS idx_ax_snapshot_session ON ax_snapshot(session_id, t_mono);
CREATE INDEX IF NOT EXISTS idx_ax_snapshot_frame ON ax_snapshot(frame_id);
```

- [ ] **Step 4: Add the types**

In `src/store/types.ts`, after the `frame_ax` section of the interface add the row types near the other retained rows:

```ts
export type AxSnapshotReason = "keyframe" | "focus_change" | "bookmark" | "dwell_resume";

/**
 * One AX tree snapshot. `frameId` is null for boundary-triggered captures, which
 * have no keyframe to attach to. `walkMs` makes staleness measurable rather than
 * assumed.
 */
export interface AxSnapshotRow {
  id: string;
  sessionId: string;
  tMono: number;
  frameId: string | null;
  reason: AxSnapshotReason;
  walkMs: number;
  elements: UIElement[];
}
```

and inside the `Store` interface, next to `putFrameAx`/`getFrameAx`:

```ts
  /** Persist one AX snapshot. An empty `elements` array is still written — the
   *  distinction between "captured nothing" and "never captured" is what
   *  `reason` exists to record. */
  putAxSnapshot(row: AxSnapshotRow): Promise<void>;
  /** The snapshot nearest at-or-before `tMono`, or undefined if none precedes it.
   *  Backs `liftTrace`'s `axAt` callback. */
  getAxAt(sessionId: string, tMono: number): AxSnapshotRow | undefined;
```

- [ ] **Step 5: Implement on `DualStore`**

Add to the `prepare()` return object:

```ts
      insertAxSnapshot: db.prepare(
        `INSERT INTO ax_snapshot(id, session_id, t_mono, frame_id, reason, walk_ms, elements)
         VALUES (@id, @sessionId, @tMono, @frameId, @reason, @walkMs, @elements)`,
      ),
      selectAxAt: db.prepare(
        `SELECT * FROM ax_snapshot
          WHERE session_id = ? AND t_mono <= ?
          ORDER BY t_mono DESC LIMIT 1`,
      ),
      selectAxByFrame: db.prepare(
        "SELECT elements FROM ax_snapshot WHERE frame_id = ? ORDER BY t_mono DESC LIMIT 1",
      ),
```

Add the methods (place them next to `putFrameAx`/`getFrameAx`):

```ts
  async putAxSnapshot(row: AxSnapshotRow): Promise<void> {
    await this.mutex.run(async () => {
      this.stmts.insertAxSnapshot.run({
        id: row.id,
        sessionId: row.sessionId,
        tMono: row.tMono,
        frameId: row.frameId,
        reason: row.reason,
        walkMs: row.walkMs,
        elements: JSON.stringify(row.elements),
      });
    });
  }

  getAxAt(sessionId: string, tMono: number): AxSnapshotRow | undefined {
    const r = this.stmts.selectAxAt.get(sessionId, tMono) as
      | {
          id: string;
          session_id: string;
          t_mono: number;
          frame_id: string | null;
          reason: string;
          walk_ms: number;
          elements: string;
        }
      | undefined;
    if (r === undefined) return undefined;
    return {
      id: r.id,
      sessionId: r.session_id,
      tMono: r.t_mono,
      frameId: r.frame_id,
      reason: r.reason as AxSnapshotReason,
      walkMs: r.walk_ms,
      elements: parseElements(r.elements),
    };
  }
```

Replace `getFrameAx` with:

```ts
  getFrameAx(frameId: string): UIElement[] {
    // ax_snapshot supersedes frame_ax; the legacy table is read only for
    // sessions recorded before it existed.
    const fresh = this.stmts.selectAxByFrame.get(frameId) as { elements: string } | undefined;
    if (fresh !== undefined) return parseElements(fresh.elements);
    const legacy = this.stmts.selectFrameAx.get(frameId) as { elements: string } | undefined;
    return legacy === undefined ? [] : parseElements(legacy.elements);
  }
```

Add the shared helper next to `jsonOrNull` at the bottom of the file:

```ts
function parseElements(json: string): UIElement[] {
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed) ? (parsed as UIElement[]) : [];
}
```

Import `AxSnapshotRow` and `AxSnapshotReason` in `store.ts`'s type import block.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/ax-snapshot.store.test.ts test/ax.test.ts && npm run typecheck`
Expected: PASS — `ax.test.ts` too, since `getFrameAx` changed.

- [ ] **Step 7: Commit**

```bash
git add src/store/sqlite/schema.ts src/store/types.ts src/store/store.ts test/ax-snapshot.store.test.ts
git commit -m "feat(store): ax_snapshot table with getAxAt

Supersedes frame_ax, which stays readable for older sessions - the repo has
no migration mechanism, so an existing table's shape can never change.
Cascades from session rather than frame, because a boundary-triggered
snapshot has no frame to inherit a delete path from.

An empty elements array is written as a real row: 'captured nothing' has to
stay distinguishable from 'never captured', which is what reason measures."
```

---

## Task 10: Boundary-triggered AX capture

**Files:**
- Create: `src/capture/ax/boundary.ts`
- Modify: `src/capture/ax/ax-capturer.ts`, `src/capture/session.ts`
- Test: `test/capture.ax-cadence.test.ts`

**Interfaces:**
- Consumes: `AxSource`, `AxSnapshotRow`, `AxSnapshotReason`.
- Produces:
  - `AxCapturer.capture(reason, frameId?): Promise<number>` — now writes `ax_snapshot`, always, even when empty
  - `class BoundaryAxTrigger` — `constructor(capture: (reason: AxSnapshotReason) => Promise<void>, opts?: { settleMs?: number; dwellGapMs?: number })`, methods `onEvent(kind: string, tMono: number): void`, `flush(): Promise<void>`, `stop(): void`

**Background.** `CaptureSession` is the only component that sees every producer's events (`emitEvent` funnels through it), so cross-signal triggering belongs there and producers still never touch the store. The trigger **coalesces** — one walk in flight, later triggers collapse into the pending one — and fires after a **settle delay** so the UI has painted. Costs justify both: the walk is budgeted at 800ms and measured 0.5ms/node (Finder) to 8ms/node (Mail).

**Dwell resume** is detected on the *next input event after a gap*, which is the right instant: the tree wanted is the settled one after the pause.

- [ ] **Step 1: Write the failing test**

```ts
// test/capture.ax-cadence.test.ts
import { describe, expect, it, vi } from "vitest";
import { BoundaryAxTrigger } from "../src/capture/ax/boundary.js";
import type { AxSnapshotReason } from "../src/store/types.js";

const flushTimers = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("BoundaryAxTrigger", () => {
  it("fires after the settle delay, not at the instant of the trigger", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), { settleMs: 200 });

    t.onEvent("focus_change", 1000);
    expect(fired).toEqual([]);
    await flushTimers(199);
    expect(fired).toEqual([]);
    await flushTimers(2);
    expect(fired).toEqual(["focus_change"]);
    t.stop();
    vi.useRealTimers();
  });

  it("COALESCES a burst into one walk", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), { settleMs: 200 });

    for (let i = 0; i < 10; i++) t.onEvent("focus_change", 1000 + i * 10);
    await flushTimers(500);
    expect(fired).toHaveLength(1);
    t.stop();
    vi.useRealTimers();
  });

  it("does not start a second walk while one is in flight", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const t = new BoundaryAxTrigger(
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 300));
        inFlight -= 1;
      },
      { settleMs: 50 },
    );

    t.onEvent("focus_change", 0);
    await flushTimers(60);
    t.onEvent("bookmark", 100); // arrives mid-walk
    await flushTimers(400);
    expect(maxInFlight).toBe(1);
    t.stop();
    vi.useRealTimers();
  });

  it("triggers on bookmark", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), { settleMs: 10 });
    t.onEvent("bookmark", 500);
    await flushTimers(50);
    expect(fired).toEqual(["bookmark"]);
    t.stop();
    vi.useRealTimers();
  });

  it("triggers dwell_resume on the first input AFTER a gap, not on the gap itself", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), {
      settleMs: 10,
      dwellGapMs: 3000,
    });

    t.onEvent("mouse_down", 0);
    await flushTimers(50);
    expect(fired).toEqual([]); // ordinary input triggers nothing

    t.onEvent("mouse_down", 5000); // resumed after a 5s gap
    await flushTimers(50);
    expect(fired).toEqual(["dwell_resume"]);
    t.stop();
    vi.useRealTimers();
  });

  it("does not trigger dwell_resume for a gap below the threshold", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), {
      settleMs: 10,
      dwellGapMs: 3000,
    });
    t.onEvent("mouse_down", 0);
    t.onEvent("mouse_down", 1000);
    await flushTimers(50);
    expect(fired).toEqual([]);
    t.stop();
    vi.useRealTimers();
  });

  it("ignores non-boundary event kinds", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), { settleMs: 10 });
    t.onEvent("mouse_move", 0);
    t.onEvent("scroll", 10);
    t.onEvent("display_change", 20);
    await flushTimers(50);
    expect(fired).toEqual([]);
    t.stop();
    vi.useRealTimers();
  });

  it("stop() cancels a pending walk", async () => {
    vi.useFakeTimers();
    const fired: AxSnapshotReason[] = [];
    const t = new BoundaryAxTrigger(async (r) => void fired.push(r), { settleMs: 200 });
    t.onEvent("focus_change", 0);
    t.stop();
    await flushTimers(500);
    expect(fired).toEqual([]);
    vi.useRealTimers();
  });

  it("swallows a failing capture rather than sinking the session", async () => {
    vi.useFakeTimers();
    const t = new BoundaryAxTrigger(async () => {
      throw new Error("sidecar exploded");
    }, { settleMs: 10 });
    t.onEvent("focus_change", 0);
    await expect(flushTimers(50)).resolves.toBeUndefined();
    t.stop();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/capture.ax-cadence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `BoundaryAxTrigger`**

```ts
// src/capture/ax/boundary.ts
/**
 * BoundaryAxTrigger — decides WHEN to snapshot the AX tree at a boundary.
 *
 * The three boundary reasons `computeBoundaries` detects post-hoc are all
 * detectable live: focus_change and bookmark arrive as events, and a dwell gap
 * shows up as the first input AFTER the gap — which is the right instant anyway,
 * because the tree wanted is the settled one after the pause, not before it.
 *
 * Two behaviours, both cost-driven. The walk is budgeted at 800ms and measured
 * 0.5ms/node (Finder) to 8ms/node (Mail):
 *   - SETTLE DELAY: fire a few hundred ms after the trigger so the UI has
 *     painted, rather than catching it mid-transition.
 *   - COALESCING: one walk in flight; triggers arriving during the delay or the
 *     walk collapse into the pending one. A flurry of app switches would
 *     otherwise queue walks faster than they complete.
 *
 * Pure orchestration: it owns no store and no source, only a callback.
 */

import type { AxSnapshotReason } from "../../store/types.js";

export interface BoundaryAxTriggerOptions {
  /** Delay before the walk, letting the UI paint (default 250). */
  settleMs?: number;
  /** Input-idle gap that counts as a dwell (default 3000, matching the Segmenter). */
  dwellGapMs?: number;
}

/** Event kinds that are themselves boundaries. */
const BOUNDARY_KINDS: ReadonlySet<string> = new Set(["focus_change", "bookmark"]);

/** Kinds that count as user input for dwell detection. */
const INPUT_KINDS: ReadonlySet<string> = new Set([
  "mouse_move",
  "mouse_down",
  "mouse_up",
  "scroll",
  "key_down",
  "key_up",
]);

export class BoundaryAxTrigger {
  private timer: NodeJS.Timeout | undefined;
  private pending: AxSnapshotReason | undefined;
  private inFlight = false;
  private lastInputTMono: number | undefined;
  private stopped = false;
  private readonly settleMs: number;
  private readonly dwellGapMs: number;

  constructor(
    private readonly capture: (reason: AxSnapshotReason) => Promise<void>,
    opts: BoundaryAxTriggerOptions = {},
  ) {
    this.settleMs = opts.settleMs ?? 250;
    this.dwellGapMs = opts.dwellGapMs ?? 3000;
  }

  onEvent(kind: string, tMono: number): void {
    if (this.stopped) return;

    if (INPUT_KINDS.has(kind)) {
      const last = this.lastInputTMono;
      this.lastInputTMono = tMono;
      if (last !== undefined && tMono - last >= this.dwellGapMs) {
        this.arm("dwell_resume");
      }
      return;
    }

    if (BOUNDARY_KINDS.has(kind)) {
      this.arm(kind === "bookmark" ? "bookmark" : "focus_change");
    }
  }

  private arm(reason: AxSnapshotReason): void {
    // Coalesce: the first reason in a burst wins, and the timer is not restarted,
    // so a stream of triggers cannot postpone the walk indefinitely.
    if (this.pending !== undefined) return;
    this.pending = reason;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => void this.fire(), this.settleMs);
    this.timer.unref?.();
  }

  private async fire(): Promise<void> {
    this.timer = undefined;
    const reason = this.pending;
    this.pending = undefined;
    if (reason === undefined || this.stopped) return;
    if (this.inFlight) return; // a walk is already running; this trigger folds into it
    this.inFlight = true;
    try {
      await this.capture(reason);
    } catch {
      // best-effort: a failed walk must never sink the recording
    } finally {
      this.inFlight = false;
    }
  }

  /** Run any pending walk now. Called by `CaptureSession.stop()`. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.fire();
  }

  stop(): void {
    this.stopped = true;
    this.pending = undefined;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
```

- [ ] **Step 4: Rewrite `AxCapturer` to write `ax_snapshot`**

```ts
// src/capture/ax/ax-capturer.ts
/**
 * AxCapturer — snapshots the live accessibility tree and persists it to
 * `ax_snapshot`, so `RegionRepresenter` (by frame) and node predicates (by
 * t_mono) can both read it back later. Pure orchestration over an injected
 * AxSource.
 *
 * An EMPTY result is still written. `if (elements.length > 0)` — the previous
 * behaviour — made an AX-blind app indistinguishable from a capture that never
 * ran, which is exactly the distinction `reason` exists to measure.
 */

import { ulid } from "ulid";
import type { AxSnapshotReason, Store } from "../../store/types.js";
import type { AxSource } from "./types.js";

export class AxCapturer {
  constructor(
    private readonly store: Pick<Store, "putAxSnapshot">,
    private readonly source: AxSource,
    private readonly sessionId: string,
    private readonly now: () => number,
  ) {}

  /** Snapshot the tree and store it. Returns the element count. */
  async capture(reason: AxSnapshotReason, frameId?: string): Promise<number> {
    // Stamp at the START of the walk: that is the moment closest to the settled
    // state the snapshot claims to describe.
    const tMono = this.now();
    const started = Date.now();
    const elements = await this.source.query();
    await this.store.putAxSnapshot({
      id: ulid(),
      sessionId: this.sessionId,
      tMono,
      frameId: frameId ?? null,
      reason,
      walkMs: Date.now() - started,
      elements,
    });
    return elements.length;
  }

  close(): void {
    this.source.close?.();
  }
}
```

- [ ] **Step 5: Wire it into `CaptureSession`**

In `src/capture/session.ts`:

1. Import `BoundaryAxTrigger` and add `private boundaryAx: BoundaryAxTrigger | undefined;`
2. Add to `CaptureSessionOptions`:

```ts
  /** Settle delay before a boundary-triggered AX walk (default 250ms). */
  axSettleMs?: number;
  /** Input-idle gap that counts as a dwell for AX triggering (default 3000ms). */
  axDwellGapMs?: number;
```

3. Replace the `axCapturer` construction with:

```ts
    this.axCapturer = this.opts.axSource
      ? new AxCapturer(this.store, this.opts.axSource, this.sessionId, () => this.clock.now())
      : undefined;
    this.boundaryAx =
      this.axCapturer !== undefined
        ? new BoundaryAxTrigger(
            (reason) => this.axCapturer!.capture(reason).then(() => undefined),
            {
              ...(this.opts.axSettleMs !== undefined ? { settleMs: this.opts.axSettleMs } : {}),
              ...(this.opts.axDwellGapMs !== undefined ? { dwellGapMs: this.opts.axDwellGapMs } : {}),
            },
          )
        : undefined;
```

4. In `ingestFrame`, pass the reason:

```ts
        if (res.kept && res.frameId && this.axCapturer) {
          await this.axCapturer.capture("keyframe", res.frameId);
        }
```

5. In `emitEvent`, tap the stream **after** batching so the row is never delayed by the trigger:

```ts
      emitEvent: (ev) => {
        const row: EventInsert = { /* unchanged */ };
        this.batcher.add(row);
        // The session is the only component that sees every producer's events,
        // so cross-signal triggering belongs here — producers stay store-free.
        this.boundaryAx?.onEvent(row.kind, row.tMono);
      },
```

6. In `stop()`, flush before closing:

```ts
    await this.boundaryAx?.flush();
    this.boundaryAx?.stop();
    await this.batcher.stop();
    this.axCapturer?.close();
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/capture.ax-cadence.test.ts test/capture-session.test.ts test/ax.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/capture/ax/boundary.ts src/capture/ax/ax-capturer.ts src/capture/session.ts test/capture.ax-cadence.test.ts
git commit -m "feat(capture): boundary-triggered AX capture

Keyframe AX serves region proposal; boundary AX serves node predicates.
Both are needed - pHash gating means a settled screen produces no keyframes,
and settled is exactly when a boundary fires, so keyframe-only AX has
nothing to offer at the moments that matter most.

Driven by CaptureSession because emitEvent funnels through it, making it the
only component that sees every producer's events; producers stay store-free.
Coalesced with a settle delay, since the walk is budgeted at 800ms and a
flurry of app switches would queue walks faster than they complete.

An empty result now writes a row. The old skip made an AX-blind app
indistinguishable from a capture that never ran."
```

---

## Task 11: `resolveKeys` pre-pass in lift

**Files:**
- Modify: `src/trace/lift.ts`
- Test: `test/trace.lift.test.ts` *(extend)*

**Interfaces:**
- Consumes: `resolveChar` from `../capture/env/keymap.js`; `Keymap` from `../capture/env/types.js`.
- Produces:
  - `resolveKeys(events: readonly TraceEvent[], keymapAt: (tMono: number) => Keymap | undefined): TraceEvent[]`
  - `LiftInput` gains `keymapAt?(tMono: number): Keymap | undefined`
  - `AxSnapshot.frameId` and `.framePhash` become optional

**Background.** `trace/` already imports `capture/ax/tree.js`, so `trace/ → capture/` is established. The pre-pass rewrites `data.char`/`data.modifiers` before `groupGestures` runs, leaving gesture grouping untouched.

**The `AxSnapshot` change.** Boundary snapshots have no frame, so `frameId`/`framePhash` become optional and `buildNode` sets `visual` only when both are present. Consequence: nodes built from a boundary snapshot have no visual corroboration. That degrades gracefully — node identity is predicate-primary by design.

- [ ] **Step 1: Write the failing test**

Append to `test/trace.lift.test.ts`:

```ts
import { resolveKeys } from "../src/trace/lift.js";
import type { Keymap } from "../src/capture/env/types.js";

const us: Keymap = {
  layoutId: "com.apple.keylayout.US",
  entries: { 0: ["a", "A", "å", "Å"], 1: ["s", "S", "ß", "Í"] },
};

describe("resolveKeys", () => {
  it("fills char on key events from the layout in force", () => {
    const out = resolveKeys(
      [ev(100, "key_down", undefined, undefined, { keycode: 30, modifiers: [] })],
      () => us,
    );
    expect(out[0]!.data).toEqual({ keycode: 30, modifiers: [], char: "a" });
  });

  it("CONSUMES shift, so a capital lifts as text and not a chord", () => {
    const out = resolveKeys(
      [ev(100, "key_down", undefined, undefined, { keycode: 30, modifiers: ["shift"] })],
      () => us,
    );
    expect(out[0]!.data).toEqual({ keycode: 30, modifiers: [], char: "A" });
  });

  it("keeps modifiers and adds no char for a command chord", () => {
    const out = resolveKeys(
      [ev(100, "key_down", undefined, undefined, { keycode: 31, modifiers: ["cmd"] })],
      () => us,
    );
    expect(out[0]!.data).toEqual({ keycode: 31, modifiers: ["cmd"] });
  });

  it("leaves non-key events untouched", () => {
    const move = ev(100, "mouse_move", 5, 6);
    expect(resolveKeys([move], () => us)[0]).toEqual(move);
  });

  it("leaves key events untouched when no keymap covers that t_mono", () => {
    const k = ev(100, "key_down", undefined, undefined, { keycode: 30, modifiers: [] });
    expect(resolveKeys([k], () => undefined)[0]).toEqual(k);
  });

  it("applies the layout in force at each event's t_mono", () => {
    const dvorak: Keymap = { layoutId: "dv", entries: { 1: ["o", "O", "ø", "Ø"] } };
    const out = resolveKeys(
      [
        ev(100, "key_down", undefined, undefined, { keycode: 31, modifiers: [] }),
        ev(9000, "key_down", undefined, undefined, { keycode: 31, modifiers: [] }),
      ],
      (t) => (t < 5000 ? us : dvorak),
    );
    expect((out[0]!.data as { char?: string }).char).toBe("s");
    expect((out[1]!.data as { char?: string }).char).toBe("o");
  });
});

describe("liftTrace — typed text end to end", () => {
  it("REGRESSION: a capital letter lifts as text, not a chord", () => {
    const t = liftTrace({
      sessionId: "cap",
      endTMono: 1000,
      keymapAt: () => us,
      events: [
        ev(100, "key_down", undefined, undefined, { keycode: 30, modifiers: ["shift"] }),
        ev(110, "key_up", undefined, undefined, { keycode: 30, modifiers: ["shift"] }),
      ],
    });
    const actions = t.edges.flatMap((e) => e.actions);
    expect(actions.map((a) => a.kind)).toEqual(["type"]);
    const typed = actions[0];
    if (typed?.kind !== "type") throw new Error("expected type");
    expect(typed.recorded).toBe("A");
  });

  it("still lifts a real chord as a chord", () => {
    const t = liftTrace({
      sessionId: "chord",
      endTMono: 1000,
      keymapAt: () => us,
      events: [
        ev(100, "key_down", undefined, undefined, { keycode: 31, modifiers: ["cmd"] }),
        ev(110, "key_up", undefined, undefined, { keycode: 31, modifiers: ["cmd"] }),
      ],
    });
    const actions = t.edges.flatMap((e) => e.actions);
    expect(actions).toEqual([{ kind: "chord", keys: ["cmd", "s"] }]);
  });

  it("drops text with no keymap, exactly as before", () => {
    const t = liftTrace({
      sessionId: "nokm",
      endTMono: 1000,
      events: [
        ev(100, "key_down", undefined, undefined, { keycode: 30, modifiers: [] }),
        ev(110, "key_up", undefined, undefined, { keycode: 30, modifiers: [] }),
      ],
    });
    expect(t.edges.flatMap((e) => e.actions)).toHaveLength(0);
    expect(t.edges.some((e) => (e.liftWarnings ?? []).some((w) => /char/.test(w)))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.lift.test.ts`
Expected: FAIL — `resolveKeys` is not exported.

- [ ] **Step 3: Implement**

In `src/trace/lift.ts`, add the imports:

```ts
import { resolveChar } from "../capture/env/keymap.js";
import type { Keymap } from "../capture/env/types.js";
```

Make `AxSnapshot`'s frame fields optional:

```ts
export interface AxSnapshot {
  elements: readonly UIElement[];
  /** Absent for a boundary-triggered snapshot, which has no keyframe. */
  frameId?: string;
  framePhash?: string;
}
```

Add to `LiftInput`:

```ts
  /** The keyboard layout in force at `tMono`, for character resolution. */
  keymapAt?(tMono: number): Keymap | undefined;
```

Add the pre-pass:

```ts
/**
 * Fill in `data.char` on key events from the layout in force at each event's
 * t_mono, so `groupGestures` — which is pure and unchanged — can read it.
 *
 * The consume-and-strip rule in `resolveChar` is what keeps a capital letter
 * text rather than a chord: `groupGestures` treats any surviving modifier as
 * chord-forming, so shift has to be gone by the time it looks.
 */
export function resolveKeys(
  events: readonly TraceEvent[],
  keymapAt: (tMono: number) => Keymap | undefined,
): TraceEvent[] {
  return events.map((e) => {
    if (e.kind !== "key_down" && e.kind !== "key_up") return e;
    const km = keymapAt(e.tMono);
    if (km === undefined) return e;
    const d = e.data !== null && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {};
    const keycode = typeof d.keycode === "number" ? d.keycode : undefined;
    if (keycode === undefined) return e;
    const mods = Array.isArray(d.modifiers)
      ? d.modifiers.filter((m): m is string => typeof m === "string")
      : [];
    const { char, modifiers } = resolveChar(km, keycode, mods);
    return {
      ...e,
      data: { ...d, modifiers, ...(char !== undefined ? { char } : {}) },
    };
  });
}
```

In `liftTrace`, apply it immediately after sorting:

```ts
  const sorted = [...input.events].sort((a, b) => a.tMono - b.tMono);
  const events =
    input.keymapAt !== undefined ? resolveKeys(sorted, input.keymapAt) : sorted;
```

In `buildNode`, guard the visual layer:

```ts
    ...(snap?.frameId !== undefined && snap.framePhash !== undefined
      ? { visual: { frameBlobId: snap.frameId, phash: snap.framePhash } }
      : {}),
```

In `anchorFor`, the existing spread already omits `framePhash` when absent; change it to:

```ts
    ...(snap !== undefined
      ? {
          ax: snap.elements,
          ...(snap.framePhash !== undefined ? { framePhash: snap.framePhash } : {}),
        }
      : {}),
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/trace.lift.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trace/lift.ts test/trace.lift.test.ts
git commit -m "feat(trace): resolve characters at lift time from the stored keymap

A pre-pass fills data.char from the layout in force at each event's t_mono,
so groupGestures stays pure and untouched. Typed text finally reaches the
IR, which means slots can actually be populated.

Carries the regression guard for the bug the design surfaced: a capital
letter now lifts as text, not as the chord shift+A.

AxSnapshot.frameId/framePhash become optional, because a boundary-triggered
snapshot has no keyframe. Nodes built from one carry no visual layer, which
degrades gracefully - node identity is predicate-primary by design."
```

---

## Task 12: Barrel exports and documentation

**Files:**
- Modify: `src/index.ts`, `CLAUDE.md`
- Test: `test/trace.barrel.test.ts` *(extend)*

- [ ] **Step 1: Write the failing test**

Append to `test/trace.barrel.test.ts`:

```ts
describe("capture/env barrel exports", () => {
  it("exports the PURE environment surface", () => {
    for (const name of ["displayIdAt", "outsideKnownDisplays", "macKeycodeFor", "resolveChar"]) {
      expect(deskrag, name).toHaveProperty(name);
    }
  });

  it("keeps the subprocess-backed sources OUT of the barrel", () => {
    // Same rule as SwiftAxSource: importing the package must never force-load a
    // subprocess adapter.
    for (const name of ["SwiftDisplaySource", "SwiftKeymapSource"]) {
      expect(deskrag, name).not.toHaveProperty(name);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/trace.barrel.test.ts`
Expected: FAIL — the pure helpers are missing.

- [ ] **Step 3: Add the barrel section**

Append to `src/index.ts`:

```ts
/**
 * capture/env/ — display topology and keyboard layout. Both are facts that can
 * change mid-session and both fail SILENTLY when they do, so both are captured
 * as `t_mono`-stamped events and resolved at lift time by "latest at-or-before".
 *
 * Only the PURE helpers and types are here. `SwiftDisplaySource` and
 * `SwiftKeymapSource` spawn a subprocess and are therefore deliberately NOT
 * re-exported — import them from `./capture/env/swift-displays.js` and
 * `./capture/env/swift-keymap.js`.
 */
export type {
  DisplayInfo,
  DisplaySource,
  Keymap,
  KeymapSource,
} from "./capture/env/types.js";
export { coerceDisplays, coerceKeymap } from "./capture/env/parse.js";
export {
  displayIdAt,
  outsideKnownDisplays,
  type Bounds,
  type Point2,
} from "./capture/env/displays.js";
export { macKeycodeFor, resolveChar } from "./capture/env/keymap.js";
export { FakeDisplaySource, FakeKeymapSource } from "./capture/env/fake.js";
export {
  shouldSampleMove,
  modifiersOf,
  DEFAULT_SAMPLE_OPTIONS,
  type SampleOptions,
  type SampleState,
} from "./capture/producers/sampling.js";
export { KeymapProducer, type KeymapProducerOptions } from "./capture/producers/keymap-producer.js";
export { BoundaryAxTrigger, type BoundaryAxTriggerOptions } from "./capture/ax/boundary.js";
```

- [ ] **Step 4: Update CLAUDE.md**

Add to the capture section, after the "Producers never touch the store" paragraph:

```markdown
**Environment facts are events, not configuration.** Display topology
(`display_change`) and keyboard layout (`keymap_change`) both change mid-session
and both fail *silently* when they do — a coordinate attributed to the wrong
display, text resolved against the wrong layout. Both are `t_mono`-stamped events
resolved at lift time by "latest at-or-before", like every other signal.
`ActiveWindowProducer` owns display topology because the re-query signal is a
focused window lying outside every known display, and it is the only producer
that sees bounds (`CaptureContext` is emit-only). `KeymapProducer` polls at 60s
instead, because a layout change has no observable side effect in anything
recorded — the alternative is a long-running sidecar watching a Darwin
notification.

**Characters are resolved at lift time, not capture time.** uiohook gives a
keycode and modifier booleans, never a character. `ax-dump --keymap` dumps the
layout's `UCKeyTranslate` table; `resolveKeys` in `lift.ts` applies it. Two
halves, and the split matters: **scancode → virtual keycode is layout-independent**
(a fixed table identifying physical keys, shared by US and Dvorak alike), while
**virtual keycode → character is layout-dependent** and comes from the sidecar.
The mapping is needed in both directions — the executor must go char → keycode to
replay a substituted slot value — so one keymap serves both.

**The modifier rule is load-bearing.** cmd/ctrl means a command: no character,
all modifiers kept. Otherwise the character resolves and shift/alt are
**consumed** into the column choice and stripped. `gestures.ts` treats any
surviving modifier as chord-forming, so without consume-and-strip every capital
letter lifts as the chord `shift+A` instead of the text `"A"`.

**AX is captured at boundaries as well as keyframes.** `KeyframeGate`
de-duplicates by pHash, so a settled screen produces no keyframes — and settled is
exactly when a boundary fires, which is why keyframe-only AX has nothing to offer
at the moments that matter most. Keyframe AX serves region proposal (keyed by
frame); boundary AX serves node predicates (keyed by `t_mono`). `BoundaryAxTrigger`
coalesces and applies a settle delay, because the walk is budgeted at 800ms and a
flurry of app switches would queue walks faster than they complete. Both land in
**`ax_snapshot`**, which supersedes `frame_ax` — the repo has **no migration
mechanism** (`CREATE TABLE IF NOT EXISTS` on every open), so an existing table's
shape can never change; `frame_ax` stays readable for older sessions.
**An empty AX result still writes a row**, so "captured nothing" stays
distinguishable from "never captured" — which is what `reason` exists to measure.

**Adaptive mouse sampling:** 12ms while a button is held, 100ms otherwise. `Path`
fitting cannot recover a drag curve from 100ms samples, and on a drag the path
*is* the payload. Not a global rate increase.
```

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run typecheck && npm test && npm run build && npm --prefix app run typecheck
git add src/index.ts CLAUDE.md test/trace.barrel.test.ts
git commit -m "feat(capture): export the pure environment surface, document the seams

Only the pure helpers and types reach the barrel; SwiftDisplaySource and
SwiftKeymapSource spawn subprocesses and stay out, same rule as
SwiftAxSource."
```

---

## Self-Review

**Spec coverage.** All seven derived requirements map to tasks: adaptive mouse sampling → Task 6; modifiers + layout-resolved characters → Tasks 2, 4, 6, 11; display topology → Tasks 1, 5, 7; window bounds → Task 7; AX element path → already shipped in `axPathOf`, superseded by `AXIdentifier` in Task 3; AX capture cadence → Tasks 9, 10; app/document identity → Task 7. The spec's architecture, event shapes, schema, failure table, and testing list are covered; the "honest limits" section describes behavior, not work.

**Three ambiguities the spec left, resolved here:**

1. **`ActiveWindowProducer` had no test seam.** `active-win` is imported at module top, so the producer could not be tested offline. Task 7 extracts a `protected queryWindow()` the test subclasses — the minimum change that makes the display-union logic testable without touching the native import.
2. **`AxCapturer` gained a session id and a clock.** Writing `ax_snapshot` needs both, and it previously had neither. Passed in by `CaptureSession`, preserving "producers and helpers never reach for globals."
3. **`AxSnapshot.frameId` had to become optional.** A boundary snapshot has no frame. Task 11 makes it optional and guards `buildNode`, with the consequence stated: nodes from boundary snapshots carry no visual layer. That degrades gracefully because node identity is predicate-primary.

**Type consistency:** `DisplayInfo`, `Keymap`, `AxSnapshotRow`, `AxSnapshotReason`, `SampleState`, `SampleOptions`, `WindowSnapshot`, `Point2`, `Bounds`, and `BoundaryAxTriggerOptions` are each defined once and referenced consistently. `resolveChar` returns `{ char?: string; modifiers: string[] }` in Task 4 and is consumed with that exact shape in Task 11. `capture()` takes `(reason, frameId?)` in Task 10 and is called that way from `CaptureSession`.

**Dependency order:** 1 → (2, 3, 5) → 4 → (6, 7, 8) → 9 → 10 → 11 → 12. Tasks 2, 3, 5, and 6 are independent of one another; 7 needs 1 and 5; 11 needs 4 and 9.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-30-replay-fidelity-capture.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
