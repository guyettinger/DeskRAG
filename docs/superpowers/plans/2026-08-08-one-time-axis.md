# One Time Axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `t_mono` universal — every captured signal stored on one clock, so segments, search hits and the track rail are correct together instead of each being approximately right in its own way.

**Architecture:** `ax-dump` grows a permission-free `--clock` mode reading `CLOCK_UPTIME_RAW` (the base avfoundation timestamps use). `CaptureSession` reads it once at start and builds a `DeviceClock`; both ffmpeg producers pass `-copyts` and report device-base timestamps that the session converts through that one bridge. The mp4 becomes VFR so media seconds *are* lane seconds, which deletes the rail's rescaling rather than tuning it.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Swift (`swiftc`), vitest, ffmpeg CLI, better-sqlite3, electron-builder.

**Spec:** `docs/superpowers/specs/2026-08-08-one-time-axis-design.md`

## Global Constraints

- **Both spec gates are now settled — do not re-litigate them:**
  - `-copyts` **does** give avfoundation audio the device base, but **only via `ashowinfo` on stderr** — `mkvtimestamp_v2` rejects audio streams outright (`Output file does not contain any stream`). Measured: first audio pts 3479475532ms against a spawn at 3479475233ms.
  - A **VFR fragmented MP4 is well-formed and seekable**: 40 frames, duration 6.000s, PTS jumping 2.100 → 4.200 across a deliberate gap, and `-ss 4.5` decodes. What remains unverified is Chromium/Vidstack playback — that is Task 9's gate.
- **ffmpeg 5.1+** (already required for `-fps_mode`).
- **`timeline/` must never spawn.** `CaptureSession` runs the sidecar and passes the reading in as a number.
- **`npm run typecheck` after every task**; the app has its own gate (`npm --prefix app run typecheck`), and the app imports `dist/` so `npm run build` comes first.
- **`grep -a` for `src/store/store.ts`** — it contains deliberate NUL bytes and plain grep silently prints nothing.
- **Rebuilding `native/` requires `npm run build` + restarting the app**, or a stale `dist/` parses the new sidecar output as nothing.
- Commit after each task. Do not push or open a PR.

---

## Phase A — packaging (first, because the refusal guarantee is dishonest without it)

### Task 1: `ax-dump --clock`

**Files:**
- Modify: `native/ax-dump.swift` (new mode block beside `--displays` at ~line 195 and `--keymap` at ~line 248)
- Create: `src/capture/env/clock.ts` (pure parse), `src/capture/env/swift-clock.ts` (the spawn)
- Modify: `src/capture/env/types.ts`, `src/capture/env/fake.ts`, `src/index.ts`
- Test: `test/env.clock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface DeviceClockSource { read(): Promise<number> }` (ms on the device base)
  - `function parseDeviceClock(stdout: string): number`
  - `class SwiftDeviceClockSource implements DeviceClockSource`
  - `class FakeDeviceClockSource implements DeviceClockSource`

- [ ] **Step 1: Write the failing test**

Create `test/env.clock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseDeviceClock } from "../src/capture/env/clock.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/env.clock.test.ts`
Expected: FAIL — cannot resolve `../src/capture/env/clock.js`.

- [ ] **Step 3: Write the parser**

Create `src/capture/env/clock.ts`:

```ts
/**
 * The device timebase reading, parsed from `ax-dump --clock`.
 *
 * The number is `clock_gettime_nsec_np(CLOCK_UPTIME_RAW)` in ms — the
 * `mach_absolute_time` base, which EXCLUDES sleep. That is the base
 * avfoundation stamps capture timestamps on (verified: ffmpeg's `-copyts`
 * output tracks it), and it sits 4.78 days away from what Node reports
 * (`mach_continuous_time`, which includes sleep). This reading is the ONLY
 * bridge between them.
 *
 * It throws rather than returning a fallback. A stale binary predating this
 * mode prints usage or nothing, and inventing a number there would mis-time a
 * whole recording silently — the failure this design exists to remove.
 */
export function parseDeviceClock(stdout: string): number {
  const text = stdout.trim();
  let ms: unknown;
  try {
    ms = (JSON.parse(text) as { deviceMs?: unknown }).deviceMs;
  } catch {
    throw new Error(`ax-dump --clock produced no clock reading: ${JSON.stringify(text.slice(0, 80))}`);
  }
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new Error(`ax-dump --clock produced no clock reading: ${JSON.stringify(text.slice(0, 80))}`);
  }
  return ms;
}
```

Add to `src/capture/env/types.ts`:

```ts
/** Reads the device timebase (`ax-dump --clock`). See `parseDeviceClock`. */
export interface DeviceClockSource {
  read(): Promise<number>;
}
```

Create `src/capture/env/swift-clock.ts`, mirroring `swift-keymap.ts`'s spawn shape:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseDeviceClock } from "./clock.js";
import type { DeviceClockSource } from "./types.js";

const run = promisify(execFile);

/**
 * Reads the device timebase from the Swift sidecar.
 *
 * `--clock` needs no Accessibility permission — it exits above the
 * `AXIsProcessTrusted()` gate, like `--displays` and `--keymap` — so this runs
 * on a machine that has never granted anything.
 */
export class SwiftDeviceClockSource implements DeviceClockSource {
  private readonly binaryPath: string;

  constructor(opts: { binaryPath?: string } = {}) {
    this.binaryPath = opts.binaryPath ?? process.env["ERAG_AX_BIN"] ?? "ax-dump";
  }

  async read(): Promise<number> {
    const { stdout } = await run(this.binaryPath, ["--clock"], { timeout: 5000 });
    return parseDeviceClock(stdout);
  }
}
```

Add to `src/capture/env/fake.ts`:

```ts
/** A device clock that returns whatever the test says, for deterministic runs. */
export class FakeDeviceClockSource implements DeviceClockSource {
  constructor(private readonly deviceMs: number) {}
  read(): Promise<number> {
    return Promise.resolve(this.deviceMs);
  }
}
```

Export all four from `src/index.ts` beside the existing env sources. `SwiftDeviceClockSource` spawns a binary and loads no native module, so it belongs in the barrel — the line is native module, not subprocess.

- [ ] **Step 4: Add the Swift mode**

In `native/ax-dump.swift`, add immediately after the `--keymap` block (~line 265) so it sits above the `--self-test` block at ~line 339 and above the `AXIsProcessTrusted` gate:

```swift
// MARK: - Device clock (--clock)
//
// CLOCK_UPTIME_RAW is the mach_absolute_time base: monotonic and EXCLUDING
// sleep. avfoundation stamps capture timestamps on it (verified against
// ffmpeg's -copyts), while Node's uv_hrtime reports mach_continuous_time, which
// INCLUDES sleep — measured 4.78 days apart on one machine. This reading is the
// only bridge, and without it a captured frame cannot be placed on t_mono.
//
// Needs no Accessibility permission, so like --displays and --keymap it sits
// above the AXIsProcessTrusted gate and above the AX --self-test block.
if args.contains("--clock") {
    if args.contains("--self-test") {
        print("{\"ok\":true,\"mode\":\"clock\"}")
        exit(0)
    }
    let ms = Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000
    print(String(format: "{\"deviceMs\":%.3f}", ms))
    exit(0)
}
```

- [ ] **Step 5: Build the sidecar and verify against the real base**

```bash
npm run build:ax
./native/ax-dump --clock
python3 -c "import time; print(f'{time.monotonic()*1000:.3f}  <- must be within ~50ms')"
```

Expected: the two numbers within tens of milliseconds of each other (spawn cost). If they differ by days, the Swift block is reading `CLOCK_MONOTONIC_RAW` (the continuous clock) rather than `CLOCK_UPTIME_RAW`.

- [ ] **Step 6: Run tests, typecheck, commit**

```bash
npx vitest run test/env.clock.test.ts && npm run typecheck
git add native/ax-dump.swift src/capture/env/clock.ts src/capture/env/swift-clock.ts \
        src/capture/env/types.ts src/capture/env/fake.ts src/index.ts test/env.clock.test.ts
git commit -m "feat(capture): read the device timebase from a permission-free ax-dump mode"
```

---

### Task 2: Ship the sidecar in the packaged app

**Files:**
- Modify: `app/electron-builder.yml`
- Modify: `app/package.json` (build scripts)
- Modify: `app/src/main/index.ts:49-52`
- Modify: `docs/setup.md`

**Interfaces:**
- Consumes: `native/ax-dump` built by `npm run build:ax`.
- Produces: `ERAG_AX_BIN` resolving in a packaged build.

This task exists because **the packaged app does not ship the sidecar today**: `files:` bundles only `out/**`, `build/**` and `package.json`, the dev resolution points at `<repo>/native/ax-dump`, and the fallback is `ax-dump` on `PATH`. Refusing to record without the bridge is dishonest until this lands — and it is also why AX capture is dev-only today.

- [ ] **Step 1: Bundle the binary**

In `app/electron-builder.yml`, add beside `files:`:

```yaml
extraResources:
  - from: ../native/ax-dump
    to: ax-dump
```

In `app/package.json`, make the packaging scripts build it first — the binary is gitignored, so a clean checkout has none:

```json
"build:ax": "npm --prefix .. run build:ax",
"dist": "npm run build:ax && electron-vite build && electron-builder"
```

Check the existing `dist`/`build` script names first and preserve them; only prepend `npm run build:ax`.

- [ ] **Step 2: Resolve the packaged path**

In `app/src/main/index.ts`, replace the dev-only resolution:

```ts
// The sidecar is REQUIRED now: the capture clock comes from it, and a session
// refuses to start without one. Packaged, it lives in Resources; in dev it is
// the repo's built binary. An explicit ERAG_AX_BIN always wins.
if (!process.env["ERAG_AX_BIN"]) {
  const candidates = [
    join(process.resourcesPath, "ax-dump"),
    join(__dirname, "../../../native/ax-dump"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found) process.env["ERAG_AX_BIN"] = found;
}
```

`process.resourcesPath` is undefined in some test contexts, so guard the join if `npm --prefix app run typecheck` objects.

- [ ] **Step 3: Package and verify the binary is really there and signed**

```bash
npm run app:dist
ls -l app/dist-app/mac*/DeskRAG.app/Contents/Resources/ax-dump
codesign -dv --verbose=4 app/dist-app/mac*/DeskRAG.app/Contents/Resources/ax-dump
```

Expected: the file exists and `codesign` reports a signature. **Verify by running these, not by reading the yml** — the same rule the mic entitlements already carry, and unsigned nested binaries fail under hardened runtime at spawn time, not at build time. If it is unsigned, add it to electron-builder's `mac.binaries` list and re-run.

- [ ] **Step 4: Confirm the packaged app can read the clock**

```bash
open app/dist-app/mac*/DeskRAG.app
```

Then in the app, open Settings and confirm the accessibility sidecar shows as available. This is the first build in which that can be true.

- [ ] **Step 5: Document and commit**

In `docs/setup.md`, move the sidecar from optional to required: `swiftc` is needed to *build* it, and a packaged build ships it, but recording now needs it present.

```bash
git add app/electron-builder.yml app/package.json app/src/main/index.ts docs/setup.md
git commit -m "build(app): ship the ax-dump sidecar in the packaged bundle"
```

---

## Phase B — the bridge

### Task 3: `DeviceClock`

**Files:**
- Create: `src/timeline/device-clock.ts`
- Modify: `src/index.ts`
- Test: `test/device-clock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class DeviceClock { static calibrate(deviceMs: number, tMono: number): DeviceClock; toTMono(deviceMs: number): number; readonly offsetMs: number }`

**Deviation from the spec, deliberate:** the spec put `fromDeviceMs` on `MonotonicClock`. A separate immutable `DeviceClock` is used instead so the calibration is a value rather than hidden mutable state on the clock every module imports, and so "uncalibrated" is representable as *not having one* rather than as a flag. Same behaviour, better boundary.

- [ ] **Step 1: Write the failing test**

Create `test/device-clock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DeviceClock } from "../src/timeline/device-clock.js";

describe("DeviceClock", () => {
  it("maps a device timestamp onto t_mono", () => {
    // The sidecar read 3_477_946_316.602 at t_mono 250.
    const c = DeviceClock.calibrate(3_477_946_316.602, 250);
    expect(c.toTMono(3_477_946_316.602)).toBeCloseTo(250, 6);
    expect(c.toTMono(3_477_947_316.602)).toBeCloseTo(1250, 6); // one second later
  });

  it("maps a timestamp from BEFORE the calibration to a smaller t_mono", () => {
    // Frames arrive after calibration but can be CAPTURED before it — the whole
    // point is that capture time is not arrival time.
    const c = DeviceClock.calibrate(1000, 500);
    expect(c.toTMono(900)).toBe(400);
  });

  it("exposes its offset so the calibration can be persisted and re-read", () => {
    expect(DeviceClock.calibrate(1000, 250).offsetMs).toBe(-750);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/device-clock.test.ts`
Expected: FAIL — cannot resolve `../src/timeline/device-clock.js`.

- [ ] **Step 3: Write the implementation**

Create `src/timeline/device-clock.ts`:

```ts
/**
 * The bridge between the capture device's timebase and the session's t_mono.
 *
 * avfoundation stamps capture timestamps on `mach_absolute_time`
 * (`CLOCK_UPTIME_RAW`, excluding sleep); Node's clock is
 * `mach_continuous_time`, which includes it — measured 4.78 days apart on one
 * machine. Nothing in Node reads the other base, so the offset is established
 * ONCE from a sidecar reading paired with a `clock.now()` taken beside it, and
 * every device timestamp in the session is converted through it.
 *
 * This is what makes t_mono universal rather than nominal: a frame's timestamp
 * becomes when its pixels were captured, not when Node happened to receive
 * them — which measured 3.05s late on a real device.
 *
 * `timeline/` never spawns. `CaptureSession` runs the sidecar and passes the
 * number in.
 */
export class DeviceClock {
  private constructor(readonly offsetMs: number) {}

  /** Pair a device reading with the `t_mono` at which it was taken. */
  static calibrate(deviceMs: number, tMono: number): DeviceClock {
    return new DeviceClock(tMono - deviceMs);
  }

  toTMono(deviceMs: number): number {
    return deviceMs + this.offsetMs;
  }
}
```

Export it from `src/index.ts` beside `MonotonicClock`.

- [ ] **Step 4: Run test, typecheck, commit**

```bash
npx vitest run test/device-clock.test.ts && npm run typecheck
git add src/timeline/device-clock.ts src/index.ts test/device-clock.test.ts
git commit -m "feat(timeline): a device-timebase bridge onto t_mono"
```

---

### Task 4: Persist the calibration

**Files:**
- Modify: `src/store/store.ts` (schema block, prepared statements, methods)
- Modify: `src/store/types.ts`
- Test: `test/session-clock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface SessionClockRow { sessionId: string; deviceEpochMs: number; monoEpochMs: number }`
  - `Store.putSessionClock(row: SessionClockRow): Promise<void>`
  - `Store.getSessionClock(sessionId: string): SessionClockRow | undefined`

- [ ] **Step 1: Write the failing test**

Create `test/session-clock.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";

describe("session_clock", () => {
  let dir: string;
  let store: DualStore;
  let sessionId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "deskrag-clock-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a calibration", async () => {
    await store.putSessionClock({ sessionId, deviceEpochMs: 3_477_946_316.602, monoEpochMs: 250 });
    expect(store.getSessionClock(sessionId)).toEqual({
      sessionId,
      deviceEpochMs: 3_477_946_316.602,
      monoEpochMs: 250,
    });
  });

  it("returns undefined for a session recorded before calibration existed", () => {
    // ABSENCE is the marker. Every existing recording has no row, and the rail
    // says the axis is uncalibrated rather than pretending it is aligned.
    expect(store.getSessionClock(sessionId)).toBeUndefined();
  });

  it("cascades with the session, so a deleted recording leaves no calibration", async () => {
    await store.putSessionClock({ sessionId, deviceEpochMs: 1, monoEpochMs: 2 });
    await store.deleteSession(sessionId);
    expect(store.getSessionClock(sessionId)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session-clock.test.ts`
Expected: FAIL — `store.putSessionClock is not a function`.

- [ ] **Step 3: Add the table, statements and methods**

Adding a TABLE is the sanctioned schema move — `CREATE TABLE IF NOT EXISTS` runs on every open, so it appears on an existing database, while an existing table's shape can never change. Add beside the other `CREATE TABLE IF NOT EXISTS` statements in `src/store/store.ts` (find them with `grep -a "CREATE TABLE IF NOT EXISTS" src/store/store.ts`):

```sql
CREATE TABLE IF NOT EXISTS session_clock (
  session_id      TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  device_epoch_ms REAL NOT NULL,
  mono_epoch_ms   REAL NOT NULL
);
```

Prepared statements:

```ts
      insertSessionClock: db.prepare(
        `INSERT INTO session_clock(session_id, device_epoch_ms, mono_epoch_ms)
         VALUES (@sessionId, @deviceEpochMs, @monoEpochMs)
         ON CONFLICT(session_id) DO UPDATE SET
           device_epoch_ms = excluded.device_epoch_ms,
           mono_epoch_ms   = excluded.mono_epoch_ms`,
      ),
      selectSessionClock: db.prepare("SELECT * FROM session_clock WHERE session_id = ?"),
```

Methods:

```ts
  /**
   * The device-timebase calibration for a session.
   *
   * ABSENCE is meaningful: a session with no row was recorded before the clock
   * bridge existed, so its frames and audio are on the old per-producer
   * conventions and are NOT comparable with a calibrated recording.
   */
  async putSessionClock(row: SessionClockRow): Promise<void> {
    await this.mutex.run(async () => {
      this.stmts.insertSessionClock.run({
        sessionId: row.sessionId,
        deviceEpochMs: row.deviceEpochMs,
        monoEpochMs: row.monoEpochMs,
      });
    });
  }

  getSessionClock(sessionId: string): SessionClockRow | undefined {
    const r = this.stmts.selectSessionClock.get(sessionId) as
      | { session_id: string; device_epoch_ms: number; mono_epoch_ms: number }
      | undefined;
    return r === undefined
      ? undefined
      : { sessionId: r.session_id, deviceEpochMs: r.device_epoch_ms, monoEpochMs: r.mono_epoch_ms };
  }
```

Add `SessionClockRow` and both method signatures to the `Store` interface in `src/store/types.ts`.

- [ ] **Step 4: Run test, typecheck, commit**

```bash
npx vitest run test/session-clock.test.ts && npm run typecheck
git add src/store/store.ts src/store/types.ts test/session-clock.test.ts
git commit -m "feat(store): persist the device-clock calibration per session"
```

---

### Task 5: The session refuses without a bridge

**Files:**
- Modify: `src/capture/session.ts` (options, `start()`, the `CaptureContext` literal at ~line 138)
- Modify: `src/capture/types.ts` (`CaptureContext`)
- Test: `test/capture-clock.test.ts`

**Interfaces:**
- Consumes: `DeviceClock` (Task 3), `DeviceClockSource` / `FakeDeviceClockSource` (Task 1), `putSessionClock` (Task 4).
- Produces: `CaptureContext.deviceClock: DeviceClock`; `CaptureSessionOptions.deviceClockSource: DeviceClockSource`.

- [ ] **Step 1: Write the failing test**

Create `test/capture-clock.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";
import { CaptureSession } from "../src/capture/session.js";
import { MonotonicClock } from "../src/timeline/clock.js";
import { FakeDeviceClockSource } from "../src/capture/env/fake.js";
import type { CaptureContext, Producer } from "../src/capture/types.js";

describe("CaptureSession device clock", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-clk-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  class ClockReader implements Producer {
    readonly id = "probe";
    seen: number | undefined;
    start(ctx: CaptureContext): void {
      // A device timestamp captured 1000ms before the calibration reading.
      this.seen = ctx.deviceClock.toTMono(4000);
    }
    stop(): void {}
  }

  it("calibrates from the source and hands producers the bridge", async () => {
    let mono = 0;
    const clock = MonotonicClock.start(() => (mono += 100), () => 1000);
    const session = new CaptureSession(store, {
      clock,
      deviceClockSource: new FakeDeviceClockSource(5000),
    });
    const probe = new ClockReader();
    session.addProducer(probe);
    const sessionId = await session.start();
    await session.stop();

    // The reading 5000 was paired with some t_mono T; a device stamp of 4000 is
    // one second earlier, so it must land at T - 1000.
    const row = store.getSessionClock(sessionId)!;
    expect(row.deviceEpochMs).toBe(5000);
    expect(probe.seen).toBeCloseTo(row.monoEpochMs - 1000, 6);
  });

  it("REFUSES to start when the clock cannot be read", async () => {
    // Recording without a bridge would store timestamps that mean something
    // different from every calibrated session. Refusing loudly beats silently
    // producing a second convention.
    const failing = { read: () => Promise.reject(new Error("ENOENT ax-dump")) };
    const session = new CaptureSession(store, {
      clock: MonotonicClock.start(),
      deviceClockSource: failing,
    });
    await expect(session.start()).rejects.toThrow(/clock/i);
    expect(store.listSessions()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/capture-clock.test.ts`
Expected: FAIL — `deviceClockSource` is not a known option and `ctx.deviceClock` does not exist.

- [ ] **Step 3: Wire it**

Add to `CaptureContext` in `src/capture/types.ts`:

```ts
  /**
   * Converts a capture-device timestamp (ffmpeg `-copyts`) to t_mono.
   *
   * Producers that sample through a device clock MUST time their samples with
   * this rather than `clock.now()`: arrival time carries the whole capture
   * latency, measured 3.05s on a real avfoundation device.
   */
  readonly deviceClock: DeviceClock;
```

In `src/capture/session.ts`, take `deviceClockSource` in the options and, in `start()`, read it BEFORE creating the session row so a failure leaves nothing behind:

```ts
    // Read the bridge FIRST. A session with no calibration would store
    // timestamps meaning something different from every other session, so this
    // refuses rather than falling back — and it refuses before any row exists.
    let deviceClock: DeviceClock;
    try {
      const deviceMs = await this.opts.deviceClockSource.read();
      deviceClock = DeviceClock.calibrate(deviceMs, this.clock.now());
      this.calibration = { deviceEpochMs: deviceMs, monoEpochMs: this.clock.now() };
    } catch (err) {
      throw new Error(
        `cannot read the capture clock (ax-dump --clock): ${(err as Error).message}. ` +
          `Build the sidecar with \`npm run build:ax\`, or set ERAG_AX_BIN.`,
      );
    }
```

Persist with `putSessionClock` once the session row exists, and pass `deviceClock` into the `CaptureContext` literal at ~line 138.

Note for the implementer: `this.clock.now()` is called twice above — capture it into a local so the stored `monoEpochMs` is the same value used for the calibration, or the two drift by however long the read took.

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
npx vitest run test/capture-clock.test.ts && npm run typecheck && npm test
git add src/capture/session.ts src/capture/types.ts test/capture-clock.test.ts
git commit -m "feat(capture): calibrate the device clock at start, and refuse without it"
```

Existing tests construct `CaptureSession` without a `deviceClockSource` and will now fail to start. Give them `new FakeDeviceClockSource(0)`; do NOT make the option optional to keep them passing — that reintroduces the silent second convention this task exists to prevent.

---

### Task 6: The screen producer reports device time

**Files:**
- Modify: `src/capture/producers/ffmpeg-screen.ts`
- Delete: `src/capture/sample-clock.ts`, `test/sample-clock.test.ts`
- Modify: `test/ffmpeg-screen.test.ts`

**Interfaces:**
- Consumes: `ctx.deviceClock` (Task 5).
- Produces: `frame.tMono` = true capture time; `video.tMonoStart` = true t_mono of media 0.

- [ ] **Step 1: Write the failing test**

In `test/ffmpeg-screen.test.ts`'s `args` describe block:

```ts
  it("asks for absolute device timestamps on the pts tap", () => {
    const p = new FfmpegScreenProducer({ fps: 1, videoFps: 10, grayW: 32, grayH: 32 });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args("/tmp/out.mp4");
    // -copyts is per-OUTPUT: the tap reports the device base while the mp4
    // stays normalized to zero. Without it the tap reports media time and the
    // bridge has nothing real to convert.
    expect(a.indexOf("-copyts")).toBeGreaterThan(a.indexOf("[tt]"));
    expect(a.slice(a.indexOf("[tt]")).join(" ")).toContain("-copyts");
    expect(a.slice(0, a.indexOf("/tmp/out.mp4")).join(" ")).not.toContain("-copyts");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ffmpeg-screen.test.ts -t "absolute device timestamps"`
Expected: FAIL — no `-copyts` in the args.

- [ ] **Step 3: Implement**

In `args()`, add `-copyts` to the timestamp output only:

```ts
    out.push("-map", "[tt]", ...PASSTHROUGH, "-copyts", "-f", "mkvtimestamp_v2", "pipe:4");
```

and the same in the `!storeImages && !videoPath` branch.

Replace `SampleClock` use in `enqueue`:

```ts
    // ffmpeg's pts is now the DEVICE timestamp, so this is the true capture
    // time — not the media offset, and not arrival. The video blob stops being
    // an input to frame timing, which is what put frames on the media clock.
    const tMono = ctx.deviceClock.toTMono(sample.ptsMs!);
```

`ptsMs` can no longer be null: every graph this producer builds has the tap, and the `ffmpegArgs` override is the only exception. Keep the null branch but make it **throw** rather than fall back to `clock.now()` — an override that omits the tap is a caller error, not a degradation:

```ts
    if (sample.ptsMs === null) {
      throw new Error(
        "ffmpegArgs override omits the mkvtimestamp_v2 tap on pipe:4 — a frame " +
          "cannot be timed without it. Add the tap or drop the override.",
      );
    }
```

Update `test/ffmpeg-screen.test.ts`'s `ffmpegArgs` test to include a pts tap, since the override now needs one.

Set the video origin from the first sample rather than from a pre-spawn stamp. `select` always keeps input frame 0 (`isnan(prev_selected_t)`), and with the mp4 at `-fps_mode passthrough` (Task 8) media 0 is that same frame, so:

```ts
    // media 0 IS the first sampled frame: `select` keeps input frame 0, and the
    // mp4 carries capture timestamps. So the video's origin is that frame's
    // capture time — a real measurement, where the old pre-spawn stamp was a
    // guess that sat D ahead of media 0 (measured 0.86-1.5s).
    if (this.video && this.firstPtsMs === undefined) {
      this.firstPtsMs = sample.ptsMs;
      this.video.tMonoStart = ctx.deviceClock.toTMono(sample.ptsMs);
    }
```

Declare the new field beside `ptsQueue`: `private firstPtsMs: number | undefined;`

Delete `src/capture/sample-clock.ts` and `test/sample-clock.test.ts`.

- [ ] **Step 4: Add a structural guard against arrival stamping coming back**

Create `test/capture.no-arrival-stamp.test.ts`. This is the same principle as
`test/replay.barrel.test.ts`'s `spawn` guard: make the suite *structurally*
unable to regress, because every arrival-time fallback in this area has silently
produced a second time convention that nobody noticed for weeks.

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A producer that samples through a device clock must time its samples from
 * `ctx.deviceClock`, never from `ctx.clock.now()`. Arrival time carries the
 * whole capture latency — measured 3.05s on a real avfoundation device.
 */
describe("no producer stamps a sample from arrival time", () => {
  for (const file of [
    "src/capture/producers/ffmpeg-screen.ts",
    "src/capture/producers/ffmpeg-audio.ts",
  ]) {
    it(`${file} does not call clock.now()`, () => {
      expect(readFileSync(file, "utf8")).not.toMatch(/clock\.now\(\)/);
    });
  }
});
```

Producers that emit *events* (uiohook, active-win, keymap) legitimately use
`clock.now()` — an event has no device timestamp and is stamped in-process, so
they are deliberately not in this list.

- [ ] **Step 5: Run the suite, typecheck, commit**

```bash
npx vitest run test/ffmpeg-screen.test.ts test/capture.no-arrival-stamp.test.ts \
  && npm run typecheck && npm test
git add -A src/capture/producers/ffmpeg-screen.ts src/capture/sample-clock.ts \
        test/sample-clock.test.ts test/ffmpeg-screen.test.ts \
        test/capture.no-arrival-stamp.test.ts
git commit -m "feat(capture): time frames by device capture timestamp"
```

---

### Task 7: The audio producer anchors on device time

**Files:**
- Create: `src/capture/ashowinfo.ts`
- Modify: `src/capture/producers/ffmpeg-audio.ts`
- Test: `test/ashowinfo.test.ts`

**Interfaces:**
- Consumes: `ctx.deviceClock` (Task 5).
- Produces: `function firstAshowinfoPts(line: string): number | null` — device ms, or null when the line is not an `ashowinfo` frame line.

`mkvtimestamp_v2` cannot be used here: it rejects audio streams (`Output file does not contain any stream`). `ashowinfo` logs to stderr instead, and with `-copyts` its `pts_time` is on the device base — measured, first audio pts 3479475532ms against a spawn at 3479475233ms.

- [ ] **Step 1: Write the failing test**

Create `test/ashowinfo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { firstAshowinfoPts } from "../src/capture/ashowinfo.js";

describe("firstAshowinfoPts", () => {
  it("reads pts_time as device milliseconds", () => {
    const line =
      "[Parsed_ashowinfo_0 @ 0x600] n:0 pts:167014825542 pts_time:3479475.532125 " +
      "planar:1 channels:1 samples:1024";
    expect(firstAshowinfoPts(line)).toBeCloseTo(3479475532.125, 3);
  });

  it("ignores every other stderr line ffmpeg emits", () => {
    expect(firstAshowinfoPts("[avfoundation @ 0x1] Overriding pixel format")).toBeNull();
    expect(firstAshowinfoPts("")).toBeNull();
    expect(firstAshowinfoPts("pts_time:notanumber")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ashowinfo.test.ts`
Expected: FAIL — cannot resolve `../src/capture/ashowinfo.js`.

- [ ] **Step 3: Implement the parser**

Create `src/capture/ashowinfo.ts`:

```ts
/**
 * Reads a device-base timestamp out of ffmpeg's `ashowinfo` stderr.
 *
 * The audio branch cannot use `mkvtimestamp_v2` — that muxer rejects audio
 * streams outright ("Output file does not contain any stream"). `ashowinfo`
 * logs one line per audio frame instead, and with `-copyts` its `pts_time` is
 * on the capture device's timebase.
 *
 * Only the FIRST value matters: it anchors the stream, and everything after it
 * is derived from the byte count, which is exact.
 */
export function firstAshowinfoPts(line: string): number | null {
  const m = /pts_time:(-?\d+(?:\.\d+)?)/.exec(line);
  if (m === null) return null;
  const sec = Number(m[1]);
  return Number.isFinite(sec) ? sec * 1000 : null;
}
```

- [ ] **Step 4: Wire the producer**

In `src/capture/producers/ffmpeg-audio.ts`:

- Add `-copyts` and `-af ashowinfo` to the args, and raise `-loglevel` to `info` (ashowinfo logs at info).
- In the stderr handler, take the first `pts_time` as the anchor and keep passing everything else to `onError`, so ffmpeg's real warnings stay visible:

```ts
    proc.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        const pts = firstAshowinfoPts(line);
        if (pts !== null) {
          // The device time of audio sample 0. Everything after it comes from
          // the byte count, which was always exact — only the anchor was
          // arrival-contaminated.
          this.anchorMono ??= ctx.deviceClock.toTMono(pts);
          continue;
        }
        if (line.includes("Parsed_ashowinfo")) continue; // per-frame noise
        if (line.trim() !== "") onError(line.trim());
      }
    });
```

- Remove `if (this.anchorMono === undefined) this.anchorMono = ctx.clock.now();` from the stdout handler.
- In `enqueue`, drop the `?? ctx.clock.now()` fallback and throw if the anchor is still unset when bytes arrive, naming `ashowinfo` — a silent arrival anchor is the bug being removed.

- [ ] **Step 5: Verify against a real microphone**

```bash
npx vitest run test/ffmpeg-audio.test.ts && npm test
```

Then record 10 seconds through the app (Task 12 covers the full gate) and confirm the audio blob's `tMonoStart` is *earlier* than the first stdout arrival — the difference is the audio pipeline latency that used to be baked in.

- [ ] **Step 6: Commit**

```bash
git add src/capture/ashowinfo.ts src/capture/producers/ffmpeg-audio.ts test/ashowinfo.test.ts
git commit -m "feat(capture): anchor audio on device capture time, not first arrival"
```

---

## Phase C — the video timeline and the rail

### Task 8: The mp4 carries capture timestamps

**Files:**
- Modify: `src/capture/producers/ffmpeg-screen.ts` (mp4 output args)
- Modify: `test/ffmpeg-screen.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: an mp4 whose media time equals capture elapsed.

**This REVERSES yesterday's rule.** CLAUDE.md says `-fps_mode passthrough` goes on the sampling outputs and "never on the mp4, which stays CFR at `videoFps`". That was right when the mp4 only had to be watchable; it is wrong now that the rail's axis *is* the video's timeline. Task 11 updates the line.

- [ ] **Step 1: Write the failing test**

```ts
  it("gives the mp4 capture timestamps, so media seconds are lane seconds", () => {
    const p = new FfmpegScreenProducer({ fps: 1, videoFps: 10, grayW: 32, grayH: 32 });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args("/tmp/out.mp4");
    // CFR would re-time the video to exactly videoFps, compressing it against
    // real time — measured 1.4%, which is what made the rail need a rescale.
    const mp4 = a.slice(a.indexOf("-map"), a.indexOf("/tmp/out.mp4"));
    expect(mp4.join(" ")).toContain("-fps_mode passthrough");
    expect(a.filter((x) => x === "-fps_mode")).toHaveLength(4);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ffmpeg-screen.test.ts -t "capture timestamps"`
Expected: FAIL — 3 `-fps_mode` flags, none on the mp4.

- [ ] **Step 3: Implement**

Add `...PASSTHROUGH` to the mp4 output push, and update the comment above it — the existing one says the video "keeps CFR at videoFps and must NOT get -fps_mode passthrough", which becomes false.

- [ ] **Step 4: GATE — verify VFR plays and seeks in the app**

The container half is already settled (40 frames, duration 6.000s, PTS jumping 2.100 → 4.200, `-ss` decodes). What is NOT settled is Chromium/Vidstack.

```bash
npm run build && npm --prefix app run build
```

Record ~20s, open it in the Library, and check: the video plays, the scrubber reports a real duration (not `Infinity`), and clicking three different points in the rail seeks to visibly different frames.

**If it misbehaves**, do not fight it: revert this task, keep the mp4 CFR, and instead store the measured rate per session (`session_clock` can carry a third column added as a new table) and convert on read. That works and keeps two clocks — a worse outcome, but a real one. Record which branch was taken in the spec.

- [ ] **Step 5: Commit**

```bash
git add src/capture/producers/ffmpeg-screen.ts test/ffmpeg-screen.test.ts
git commit -m "feat(capture): record the screen video VFR so media time is capture time"
```

---

### Task 9: The rail's conversions collapse

**Files:**
- Modify: `app/src/renderer/src/screens/TrackRail.tsx:180-217` (playhead, `seek`)

**Interfaces:**
- Consumes: an mp4 whose media time equals lane seconds (Task 8).
- Produces: no new exports.

With media 0 at lane 0 and the video carrying capture timestamps, lane seconds and media seconds are the same number. The rescaling is not tuned — it is deleted.

- [ ] **Step 1: Replace the playhead divisor**

```ts
  // ONE AXIS. Lane offset 0 is media 0 (the video blob's tMonoStart is now the
  // capture time of its first frame), and the mp4 carries capture timestamps,
  // so media seconds ARE lane seconds. The old divisor rescaled media onto the
  // lane span to paper over an offset AND a 1.4% rate divergence; both are gone.
  useEffect(() => {
    const p = player?.current;
    if (!p || totalSec <= 0) return;
    return p.subscribe(({ currentTime }) => {
      const at = `${(currentTime / totalSec) * 100}%`;
      if (headRef.current) headRef.current.style.transform = `translateX(${at})`;
      if (knobRef.current) knobRef.current.style.transform = `translateX(${at})`;
      const el = clockRef.current;
      if (el && !el.dataset.hovering) el.textContent = timecodeAt(currentTime);
    });
  }, [player, totalSec]);
```

- [ ] **Step 2: Make `seek` identity**

```ts
  /** Lane seconds ARE media seconds now — see the playhead above. */
  const seek = (sec: number): void => {
    const p = player?.current;
    if (p) p.currentTime = Math.max(0, sec);
  };
```

Remove `mediaSec` if nothing else uses it; keep `videoSec` only if the player still needs it for duration seeding. Delete the "Media seconds are NOT lane seconds" comment rather than editing it.

- [ ] **Step 3: Verify on screen**

```bash
npm run build && npm --prefix app run build
```

Record ~25s that includes an app switch. In the Library, scrub to the moment the APPS lane changes app and confirm the video shows that switch **at the playhead**, not ~0.9s later. This is the whole point of the plan; if it is off, stop and re-measure rather than adjusting a constant.

- [ ] **Step 4: Commit**

```bash
npm --prefix app run typecheck
git add app/src/renderer/src/screens/TrackRail.tsx
git commit -m "feat(app): one axis - lane seconds are media seconds"
```

---

### Task 10: The rail says when a session is uncalibrated

**Files:**
- Modify: `app/src/shared/types.ts` (`SessionTracksDTO`)
- Modify: `app/src/main/session-tracks.ts`, `app/src/main/deskrag-service.ts`
- Modify: `app/src/renderer/src/screens/TrackRail.tsx`

**Interfaces:**
- Consumes: `Store.getSessionClock` (Task 4).
- Produces: `SessionTracksDTO.clockCalibrated: boolean`.

- [ ] **Step 1: Carry the flag**

Add `clockCalibrated: boolean` to `SessionTracksDTO` as a REQUIRED field, so the compiler finds every builder and fixture — the same rationale as `showLabels` and `TrackGroup`. `DeskRagService.sessionTracks` sets it from `Boolean(this.store.getSessionClock(sessionId))`.

- [ ] **Step 2: Say so in the rail**

When `false`, render a line in the rail's ruler area:

> Recorded before the capture clock was calibrated — lanes and video may differ by about a second.

Every existing recording is in this state, and it is not repairable: the delivery latency of a past session was never recorded. Saying so is the same disclosure the `phash` and pre-stamp trace notes make.

- [ ] **Step 3: Verify and commit**

```bash
npm run build && npm --prefix app run build && npm --prefix app run typecheck
```

Open an old recording (any from before this branch) and confirm the notice appears; open a new one and confirm it does not.

```bash
git add app/src/shared/types.ts app/src/main/session-tracks.ts \
        app/src/main/deskrag-service.ts app/src/renderer/src/screens/TrackRail.tsx
git commit -m "feat(app): disclose recordings captured before clock calibration"
```

---

## Phase D — docs and the real gate

### Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md` (the `FfmpegScreenProducer` block, the timeline rule, the rail's media-vs-lane rule)
- Modify: `docs/setup.md`

- [ ] **Step 1: Reverse the mp4 CFR rule**

CLAUDE.md currently says `-fps_mode passthrough` goes on the sampling outputs and "never on the mp4, which stays CFR at `videoFps`". Replace with: it goes on **all four** outputs, because the mp4's timeline is now the rail's axis; CFR re-timed the video to exactly `videoFps` and compressed it against real time by a measured 1.4%.

- [ ] **Step 2: Replace the residual bullet**

The bullet added yesterday describes an uncorrected offset and rate. Replace it with the bridge: `ax-dump --clock` reads `CLOCK_UPTIME_RAW`; `DeviceClock` is the one conversion; frames and audio carry capture time; `session_clock`'s absence marks old recordings. Keep the measurements — they are why the design exists.

- [ ] **Step 3: Delete the three-clocks rule from the rail section**

"Media seconds are NOT lane seconds" is now false. Replace it with the invariant that makes it false: lane 0 is media 0 because `video.tMonoStart` is the capture time of the first video frame, and the mp4 carries capture timestamps, so the two axes are one.

- [ ] **Step 4: Make the sidecar required in setup.md**

Recording now needs `ax-dump`. Note that a packaged build ships it and a dev checkout needs `npm run build:ax`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/setup.md
git commit -m "docs: one t_mono axis, and the mp4 CFR rule reversed"
```

---

### Task 12: Validate against a real recording

**Files:** none — this is the gate the suite cannot be.

The suite **structurally cannot** test the bridge: lavfi has no device clock, so `-copyts` has nothing real to report. Do not skip this, and do not report the work as done before it passes.

- [ ] **Step 1: Record against a reference clock**

Build both packages, launch the app, and record ~30s with a millisecond wall-clock visible in another window. Close the recorder to the tray — its own millisecond timer defeats `mpdecimate` entirely (measured 18/18 and 22/22 frames kept with it on screen).

- [ ] **Step 2: Frame timestamps are TRUE capture time**

For a keyframe at `t_mono` T, the reference clock in its JPEG must read `session.started_at + T`.

Expected: agreement within ~100ms. This is the assertion the previous spec could not make — it only checked frames against the video, which both being wrong together would have satisfied.

- [ ] **Step 3: Events and video agree on screen**

Scrub to an app switch. The APPS lane boundary and the video must coincide at the playhead. Before this work they differed by ~0.9s and growing.

- [ ] **Step 4: Audio lines up**

Confirm the transcript/audio lanes sit under the speech in the video rather than ~0.3s late.

- [ ] **Step 5: Record the measurements**

Add a `### Validated on a real recording (YYYY-MM-DD)` section to the spec with the actual readings, including any residual — not a claim that it works.

```bash
git add docs/superpowers/specs/2026-08-08-one-time-axis-design.md
git commit -m "docs: real-recording validation of the one-axis capture clock"
```

---

## Notes for the implementer

- **Task 5 will break existing `CaptureSession` tests.** Give them
  `new FakeDeviceClockSource(0)`. Do NOT make `deviceClockSource` optional to
  keep them green — an optional bridge is the silent second convention the whole
  design removes.
- **Do not re-add an arrival-time fallback anywhere.** Both producers now throw
  instead. That is deliberate: every fallback in this area has silently produced
  a second time convention that nobody noticed for weeks.
- **`-copyts` is per-OUTPUT.** It belongs on the timestamp taps, never on the
  mp4, which must stay normalized to zero even while carrying capture *spacing*.
- **Task 8's gate can fail.** The fallback is written down; take it rather than
  forcing VFR through a player that mishandles it.
