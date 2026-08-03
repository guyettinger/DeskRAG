# Library Timeline Tracks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Library player's `KeyframeStrip` with a time-scaled track rail showing every recorded signal — audio, typing, pointer motion, focus, AX walks, transcripts, captions, segments — on one axis.

**Architecture:** `main` reads SQLite rows and audio blobs, buckets everything to a fixed 1000 columns, and ships one `SessionTracksDTO`. Every lane is one of four shapes (`density`, `span`, `mark`, `thumb`), so the renderer implements four components rather than one per signal. All the bucketing arithmetic lives in pure modules tested in the ROOT vitest suite; `DeskRagService` does the I/O and memoizes.

**Tech Stack:** TypeScript strict/ESM, better-sqlite3, Electron + electron-vite, React, Vidstack, vitest.

**Spec:** `docs/superpowers/specs/2026-08-02-library-timeline-tracks-design.md`

## Global Constraints

- **Bucket count is fixed at `TRACK_BUCKETS = 1000`**, declared in `app/src/shared/types.ts`. Never the renderer's pixel width.
- **Density values are `(number | null)[]`. `null` means NO COVERAGE and is never interchangeable with `0`.** Only audio ever emits `null`.
- **`emptyReason` = the lane has no data and here is why. `warning` = the lane HAS data and that data is compromised.** Both are `string | null`. They are not alternatives.
- **`.rail` is already the app's left nav sidebar** (`--rail-w: 76px`). The track rail is `.tracks`. `styles.css` is one global sheet with no scoping — grep for any base class before minting it.
- **Pure renderer modules must be `.ts`, never `.tsx`**, or a root test that imports them breaks `npm run typecheck` (the root tsconfig sets no `jsx`).
- **`app/` is a separate install.** Library changes need `npm run build` before the app sees them.
- **Gates:** `npm run typecheck`, `npm test`, `npm --prefix app run typecheck`. All three must pass before every commit.
- **The app imports `deskrag` (the barrel), not `src/`.** Anything new the app needs must be barrel-exported.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/capture/producers/wav.ts` (modify) | `wavPeaks` — the inverse of `encodeWav`, beside it so the 44-byte header is described once |
| `src/store/store.ts` (modify) | `getAxSnapshotsBySession` — the AX lane needs every snapshot; only single-row accessors exist |
| `src/index.ts` (modify) | Barrel: `wavPeaks`, `WavPeaks`, `urlPrefix` |
| `app/src/shared/types.ts` (modify) | The contract: `TRACK_BUCKETS`, track DTOs, IPC channel, API method |
| `app/src/main/track-buckets.ts` (create) | Pure time→bucket primitives. No DTOs, no I/O |
| `app/src/main/session-tracks.ts` (create) | Pure lane builders + `buildSessionTracks`. Rows in, DTO out |
| `app/src/main/deskrag-service.ts` (modify) | Reads rows + audio bytes, calls the pure builder, memoizes finished sessions |
| `app/src/main/ipc.ts` (modify) | One handler |
| `app/src/preload/index.ts` (modify) | One bridge method |
| `app/src/renderer/src/screens/track-view.ts` (create) | Pure: `readoutAt`, `thumbPlacement`. `.ts` so root tests can reach it |
| `app/src/renderer/src/screens/TrackLane.tsx` (create) | The four shape renderers |
| `app/src/renderer/src/screens/TrackRail.tsx` (create) | Container: playhead, click-to-seek, hover readout, vertical scroll |
| `app/src/renderer/src/screens/SessionPlayer.tsx` (modify) | Swap `KeyframeStrip` → `TrackRail` |
| `app/src/renderer/src/screens/KeyframeStrip.tsx` (delete) | Superseded by the rail |
| `app/src/renderer/src/styles.css` (modify) | `.tracks*` rules; delete `.filmstrip*` |
| `test/wav.test.ts` (modify) | `wavPeaks` round-trips `encodeWav` |
| `test/ax-snapshot.store.test.ts` (modify) | `getAxSnapshotsBySession` returns every snapshot in `t_mono` order |
| `test/track-buckets.test.ts` (create) | Bucketing arithmetic |
| `test/session-tracks.test.ts` (create) | Lane builders + assembly |
| `test/track-view.test.ts` (create) | Readout + thumb placement |

---

### Task 1: Library — `wavPeaks` and the per-session AX accessor

Everything the rail needs from `deskrag`, done first because the app imports `dist/` and the build order runs library → shared types → main → renderer.

Two pieces. `wavPeaks` lives beside `encodeWav` because describing the 44-byte WAV header in two places is exactly how `ax-dump` and `ax-exec` drifted into a one-element disagreement that stopped nodes verifying. And `DualStore` has **no** accessor returning every AX snapshot for a session — `getAxForBoundary` and `getAxAt` both return one row — so the AX lane needs a new one.

**Files:**
- Modify: `src/capture/producers/wav.ts`
- Modify: `src/store/store.ts` (statement table ~line 156, method beside `getAxAt` ~line 614)
- Modify: `src/index.ts:96`
- Test: `test/wav.test.ts`, `test/ax-snapshot.store.test.ts`

**Interfaces:**
- Consumes: `encodeWav(pcm, fmt)`, `WavFormat` — already in this file. `hydrateAxSnapshot` — already private in `store.ts`.
- Produces:
  - `wavPeaks(wav: Uint8Array, buckets: number): WavPeaks | null`
  - `interface WavPeaks { peaks: number[]; sampleRate: number; channels: number; durationSec: number }`
  - `DualStore.getAxSnapshotsBySession(sessionId: string): AxSnapshotRow[]`

Task 6 calls both; Task 2's `mergeAudioPeaks` consumes `peaks` and `durationSec`; Task 4's `axLane` consumes the snapshot rows.

- [ ] **Step 1: Write the failing tests**

Append to `test/wav.test.ts`:

```ts
import { encodeWav, wavPeaks } from "../src/capture/producers/wav.js";

/** PCM whose four quarters have amplitudes 0, 1/4, 1/2, full. Signs alternate so
 *  the peak is a genuine max of |s| rather than a DC offset. */
function rampPcm(amps: number[], framesPer: number): Uint8Array {
  const pcm = new Uint8Array(amps.length * framesPer * 2);
  const dv = new DataView(pcm.buffer);
  amps.forEach((a, q) => {
    for (let i = 0; i < framesPer; i++) {
      dv.setInt16((q * framesPer + i) * 2, i % 2 === 0 ? a : -a, true);
    }
  });
  return pcm;
}

const FMT = { sampleRate: 16000, channels: 1, bitsPerSample: 16 } as const;

describe("wavPeaks", () => {
  it("recovers the envelope encodeWav wrote", () => {
    const wav = encodeWav(rampPcm([0, 8192, 16384, 32767], 400), FMT);
    const out = wavPeaks(wav, 4);
    expect(out).not.toBeNull();
    expect(out!.peaks.map((p) => Math.round(p * 100))).toEqual([0, 25, 50, 100]);
    expect(out!.sampleRate).toBe(16000);
    expect(out!.channels).toBe(1);
    expect(out!.durationSec).toBeCloseTo(1600 / 16000, 5);
  });

  it("reports duration from the BYTES PRESENT, not the declared size", () => {
    // A killed recorder leaves exactly this: a header promising more than the
    // file holds. The measured duration is what makes the missing tail read as
    // a coverage gap instead of a stretched envelope.
    const wav = encodeWav(rampPcm([32767], 1600), FMT);
    const truncated = wav.slice(0, 44 + 1600); // half the declared data chunk
    const out = wavPeaks(truncated, 2);
    expect(out).not.toBeNull();
    expect(out!.durationSec).toBeCloseTo(800 / 16000, 5);
  });

  it("returns null for a format it cannot read, so the caller can say why", () => {
    expect(wavPeaks(encodeWav(new Uint8Array(64), { ...FMT, bitsPerSample: 8 }), 4)).toBeNull();
    expect(wavPeaks(new Uint8Array([1, 2, 3]), 4)).toBeNull();
    expect(wavPeaks(encodeWav(new Uint8Array(0), FMT), 4)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/wav.test.ts`
Expected: FAIL — `wavPeaks` is not exported from `src/capture/producers/wav.ts`.

- [ ] **Step 3: Implement `wavPeaks`**

Append to `src/capture/producers/wav.ts`:

```ts
export interface WavPeaks {
  /** Max absolute amplitude per bucket, 0–1. Length is exactly `buckets`. */
  peaks: number[];
  sampleRate: number;
  channels: number;
  /** MEASURED FROM THE BYTES PRESENT, not from the declared chunk size. */
  durationSec: number;
}

/**
 * Peak envelope of a 16-bit PCM WAV — the exact inverse of {@link encodeWav},
 * and here rather than in the app so the 44-byte header layout is described
 * once. Pure and synchronous; loads nothing.
 *
 * Returns null for anything that is not 16-bit PCM and for a file with no
 * readable frames, so a caller can distinguish "cannot read this" from "read it
 * and it was silent" — a distinction the audio lane depends on.
 *
 * A `data` chunk declaring more bytes than the file holds is TRUNCATED to what
 * is there and `durationSec` reports the real length. A killed recorder leaves
 * exactly that, and the missing tail must surface as absent coverage rather
 * than as an envelope stretched over time that was never recorded.
 */
export function wavPeaks(wav: Uint8Array, buckets: number): WavPeaks | null {
  if (buckets <= 0 || wav.length < 12) return null;
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (o: number): string =>
    String.fromCharCode(wav[o]!, wav[o + 1]!, wav[o + 2]!, wav[o + 3]!);
  if (ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return null;

  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  let data: { start: number; length: number } | null = null;

  // Walk the chunk list rather than assuming the canonical 44-byte header:
  // encodeWav emits exactly that, but ffmpeg and other writers interleave
  // LIST/fact chunks ahead of `data`, and tolerating them costs ten lines.
  for (let o = 12; o + 8 <= wav.length; ) {
    const id = ascii(o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= wav.length) {
      if (dv.getUint16(body, true) !== 1) return null; // 1 = uncompressed PCM
      fmt = {
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      data = { start: body, length: Math.max(0, Math.min(size, wav.length - body)) };
      break;
    }
    o = body + size + (size % 2); // RIFF chunks are word-aligned
  }

  if (!fmt || !data) return null;
  if (fmt.bits !== 16 || fmt.channels <= 0 || fmt.sampleRate <= 0) return null;

  const frameBytes = 2 * fmt.channels;
  const frames = Math.floor(data.length / frameBytes);
  if (frames <= 0) return null;

  // Every sample is read — no striding. At 16 kHz a thirty-minute session is
  // 28.8M samples, which is tens of milliseconds, and a stride can miss the
  // very peak the envelope exists to show.
  const peaks = new Array<number>(buckets).fill(0);
  for (let f = 0; f < frames; f++) {
    const b = Math.min(buckets - 1, Math.floor((f / frames) * buckets));
    // Channel 0 only: every audio blob this repo writes is mono, and a
    // single-channel peak is what the lane draws.
    const a = Math.abs(dv.getInt16(data.start + f * frameBytes, true)) / 32768;
    if (a > peaks[b]!) peaks[b] = a;
  }

  return { peaks, sampleRate: fmt.sampleRate, channels: fmt.channels, durationSec: frames / fmt.sampleRate };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/wav.test.ts`
Expected: PASS, all three cases.

- [ ] **Step 5: Write the failing test for the AX accessor**

Append to `test/ax-snapshot.store.test.ts`, inside the existing `describe("ax_snapshot", ...)`:

```ts
  it("returns every snapshot for a session, in t_mono order", async () => {
    // Written out of order on purpose: the AX lane draws marks left to right and
    // must not depend on insertion order.
    for (const tMono of [300, 100, 200]) {
      await store.putAxSnapshot({
        id: ulid(),
        sessionId,
        tMono,
        frameId: null,
        reason: "focus_change",
        walkMs: 80,
        elements: els("Button"),
      });
    }
    const rows = store.getAxSnapshotsBySession(sessionId);
    expect(rows.map((r) => r.tMono)).toEqual([100, 200, 300]);
    expect(rows[0]!.elements).toHaveLength(1);
  });

  it("returns an empty array for a session with no snapshots", () => {
    expect(store.getAxSnapshotsBySession("nope")).toEqual([]);
  });
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run test/ax-snapshot.store.test.ts`
Expected: FAIL — `store.getAxSnapshotsBySession is not a function`.

- [ ] **Step 7: Implement the accessor**

In `src/store/store.ts`, add to the prepared-statement table immediately after `selectAxAt` (~line 160):

```ts
      selectAxSnapshotsBySession: db.prepare(
        "SELECT * FROM ax_snapshot WHERE session_id = ? ORDER BY t_mono ASC",
      ),
```

And add the method immediately after `getAxAt` (~line 616):

```ts
  /**
   * Every AX snapshot for a session, oldest first.
   *
   * `getAxForBoundary` and `getAxAt` both answer "which tree was in force at
   * this instant", which is the question represent and lift ask. This one
   * answers "what was walked, and when" — the shape a timeline needs, including
   * the empty results that exist precisely so "captured nothing" stays
   * distinguishable from "never captured".
   */
  getAxSnapshotsBySession(sessionId: string): AxSnapshotRow[] {
    return (this.stmts.selectAxSnapshotsBySession.all(sessionId) as unknown[]).flatMap((r) => {
      const row = this.hydrateAxSnapshot(r);
      return row ? [row] : [];
    });
  }
```

Note `grep -a` if you search this file: `store.ts` contains two deliberate NUL bytes, so plain `grep` reports nothing at all for it.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run test/ax-snapshot.store.test.ts`
Expected: PASS.

- [ ] **Step 9: Barrel-export `wavPeaks` and `urlPrefix`**

In `src/index.ts`, replace line 96:

```ts
export { encodeWav, wavPeaks, type WavFormat, type WavPeaks } from "./capture/producers/wav.js";
```

And add, near the other `trace/` exports:

```ts
// The site-level prefix rule. Exported so the app's web lane reads a URL the
// same way node identity does, rather than growing a second prefix rule.
export { urlPrefix } from "./trace/url.js";
```

- [ ] **Step 10: Run the full gate**

Run: `npm run typecheck && npm test`
Expected: PASS. `npm test` is ~6s.

- [ ] **Step 11: Commit**

```bash
git add src/capture/producers/wav.ts src/store/store.ts src/index.ts test/wav.test.ts test/ax-snapshot.store.test.ts
git commit -m "feat(lib): wavPeaks and a per-session AX snapshot accessor

wavPeaks sits beside encodeWav so the 44-byte header layout is described
once. Duration is measured from the bytes present, not the declared chunk
size, so a truncated blob surfaces as missing coverage rather than a
stretched envelope.

getAxSnapshotsBySession answers 'what was walked, and when' — a different
question from getAxForBoundary/getAxAt, which both answer 'which tree was
in force at this instant' and return one row.

Also barrel-exports urlPrefix so consumers share one site-prefix rule
instead of growing a second.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The contract and the bucketing primitives

The IPC shape changes in `shared/types.ts` first — that file is the contract both processes depend on, and changing it anywhere else means main and preload can drift. The bucketing primitives ship with it because every lane builder in Tasks 3–5 is written against them.

**Files:**
- Modify: `app/src/shared/types.ts`
- Create: `app/src/main/track-buckets.ts`
- Test: `test/track-buckets.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `TRACK_BUCKETS = 1000`, `TrackTone`, `TrackShape`, `TrackSpanDTO`, `TrackMarkDTO`, `TrackThumbDTO`, `TrackDensityDTO`, `TrackLaneDTO`, `SessionTracksDTO`, `IPC.sessionTracks`, `DeskRagApi["sessions"]["tracks"]`.
  - `bucketIndex(sec, totalSec, buckets): number`
  - `bucketCounts(secs: number[], totalSec, buckets): number[]`
  - `bucketMax(samples: readonly {sec,value}[], totalSec, buckets): number[]`
  - `bucketHold(samples: readonly {sec,value}[], totalSec, buckets): (number|null)[]`
  - `normalize(raw: readonly (number|null)[]): { values: (number|null)[]; peak: number }`
  - `peakCountFor(durationSec, totalSec, buckets): number`
  - `mergeAudioPeaks(blobs: readonly AudioBlobPeaks[], totalSec, buckets): (number|null)[]`
  - `interface AudioBlobPeaks { startSec: number; durationSec: number; peaks: readonly number[] }`

- [ ] **Step 1: Write the failing tests**

Create `test/track-buckets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  bucketCounts,
  bucketHold,
  bucketIndex,
  bucketMax,
  mergeAudioPeaks,
  normalize,
  peakCountFor,
} from "../app/src/main/track-buckets.js";

describe("bucketIndex", () => {
  it("clamps at both ends and puts totalSec itself in the LAST bucket", () => {
    expect(bucketIndex(0, 10, 10)).toBe(0);
    expect(bucketIndex(5, 10, 10)).toBe(5);
    expect(bucketIndex(10, 10, 10)).toBe(9); // not 10 — that index does not exist
    expect(bucketIndex(99, 10, 10)).toBe(9);
    expect(bucketIndex(-1, 10, 10)).toBe(0);
  });

  it("does not divide by zero on a session with no span", () => {
    expect(bucketIndex(3, 0, 10)).toBe(0);
  });
});

describe("bucketCounts", () => {
  it("puts an event exactly on a boundary in exactly one bucket", () => {
    const counts = bucketCounts([0, 1, 1, 2.999, 3], 10, 10);
    expect(counts[0]).toBe(1);
    expect(counts[1]).toBe(2);
    expect(counts[2]).toBe(1);
    expect(counts[3]).toBe(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
  });
});

describe("bucketMax", () => {
  it("takes the max, never the mean — a flick must not average away", () => {
    const out = bucketMax(
      [
        { sec: 0.1, value: 10 },
        { sec: 0.2, value: 900 },
        { sec: 0.3, value: 10 },
      ],
      10,
      10,
    );
    expect(out[0]).toBe(900);
  });

  it("leaves untouched buckets at zero", () => {
    expect(bucketMax([{ sec: 5, value: 3 }], 10, 10)[0]).toBe(0);
  });
});

describe("bucketHold", () => {
  it("is null before the first sample and holds the last value after", () => {
    const out = bucketHold([{ sec: 3, value: 42 }], 10, 10);
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out.slice(3)).toEqual([42, 42, 42, 42, 42, 42, 42]);
  });
});

describe("normalize", () => {
  it("scales to 0–1, reports the peak in real units, and preserves nulls", () => {
    const { values, peak } = normalize([null, 5, 10, 0]);
    expect(peak).toBe(10);
    expect(values).toEqual([null, 0.5, 1, 0]);
  });

  it("does not produce NaN when everything is zero", () => {
    const { values, peak } = normalize([0, 0]);
    expect(peak).toBe(0);
    expect(values).toEqual([0, 0]);
  });
});

describe("peakCountFor", () => {
  it("oversamples enough that every bucket a blob spans gets a sample", () => {
    // A blob covering a tenth of a 1000-bucket session spans 100 buckets.
    expect(peakCountFor(10, 100, 1000)).toBeGreaterThanOrEqual(100);
  });

  it("never returns zero, however short the blob", () => {
    expect(peakCountFor(0.001, 3600, 1000)).toBe(1);
    expect(peakCountFor(0, 10, 1000)).toBe(1);
  });
});

describe("mergeAudioPeaks", () => {
  it("leaves a stretch no blob covers NULL, not zero", () => {
    // Two blobs with a hole between them. A dead microphone must not look like
    // a quiet room — that is the entire point of the null.
    const out = mergeAudioPeaks(
      [
        { startSec: 0, durationSec: 2, peaks: [0.5, 0.5] },
        { startSec: 8, durationSec: 2, peaks: [0.5, 0.5] },
      ],
      10,
      10,
    );
    expect(out[0]).toBeGreaterThan(0);
    expect(out[9]).toBeGreaterThan(0);
    expect(out.slice(3, 8)).toEqual([null, null, null, null, null]);
  });

  it("keeps recorded silence at ZERO, which is covered and quiet", () => {
    const out = mergeAudioPeaks([{ startSec: 0, durationSec: 10, peaks: new Array(40).fill(0) }], 10, 10);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("takes the max where two media overlap", () => {
    const out = mergeAudioPeaks(
      [
        { startSec: 0, durationSec: 10, peaks: new Array(40).fill(0.2) },
        { startSec: 0, durationSec: 10, peaks: new Array(40).fill(0.7) },
      ],
      10,
      10,
    );
    expect(out[5]).toBeCloseTo(0.7, 5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/track-buckets.test.ts`
Expected: FAIL — cannot resolve `../app/src/main/track-buckets.js`.

- [ ] **Step 3: Add the contract to `app/src/shared/types.ts`**

Insert after `SessionDetailDTO` (currently ends at line 236):

```ts
// --- timeline tracks ---------------------------------------------------------

/**
 * Bucket count for every density lane. FIXED, never the renderer's pixel width:
 * the width changes on every frame of a resize drag, and an SVG path scales to
 * any width for free.
 */
export const TRACK_BUCKETS = 1000;

/**
 * Tone names, mapped to colours by `styles.css`. `app-N` slots come from a
 * stable hash of the application name, so one app is one colour across every
 * lane and every session.
 */
export type TrackTone =
  | "neutral"
  | "accent"
  | "ok"
  | "warn"
  | "alarm"
  | "app-0"
  | "app-1"
  | "app-2"
  | "app-3"
  | "app-4"
  | "app-5"
  | "app-6"
  | "app-7";

export type TrackShape = "density" | "span" | "mark" | "thumb";

export interface TrackSpanDTO {
  startSec: number;
  endSec: number;
  label: string;
  tone: TrackTone;
}

export interface TrackMarkDTO {
  atSec: number;
  label: string;
  tone: TrackTone;
}

export interface TrackThumbDTO {
  atSec: number;
  /**
   * The SAME marker the player's chapter cues and hover thumbnails use, so
   * `keyframeLabel()` stays the one label rule rather than gaining a second
   * implementation here.
   */
  marker: KeyframeMarkerDTO;
  regionCount: number;
}

export interface TrackDensityDTO {
  /**
   * Length TRACK_BUCKETS, normalized 0–1.
   *
   * `null` means NO COVERAGE and is NOT zero. Recorded silence is a flat zero;
   * a stretch with no audio blob at all is null. Only audio emits null — for
   * event-sourced lanes absence genuinely is zero, because nobody typed.
   */
  values: (number | null)[];
  /** The real-world value that 1.0 corresponds to. */
  peak: number;
  unit: string;
  /** A second trace in the same lane, same length. Only `mouse:xy` uses it. */
  values2?: (number | null)[];
}

export interface TrackLaneDTO {
  id: string;
  title: string;
  shape: TrackShape;
  density?: TrackDensityDTO;
  spans?: TrackSpanDTO[];
  marks?: TrackMarkDTO[];
  thumbs?: TrackThumbDTO[];
  /** Non-null when the lane is legitimately empty. The reason IS the payload. */
  emptyReason: string | null;
  /**
   * Non-null when the lane HAS data and that data is compromised. Not an
   * alternative to emptyReason: a session with keys but no keymap has a
   * perfectly healthy-looking typing lane whose every character was dropped.
   */
  warning: string | null;
}

export interface SessionTracksDTO {
  sessionId: string;
  /** Seconds. The axis every lane's offsets are measured against. */
  totalSec: number;
  /** Offsets are relative to the video when there is one, else to t_mono zero. */
  anchoredToVideo: boolean;
  lanes: TrackLaneDTO[];
}
```

Add to the `sessions` block of `DeskRagApi` (after `reindex`):

```ts
    /** Every recorded signal, bucketed onto the session's time axis. */
    tracks(sessionId: string): Promise<SessionTracksDTO | null>;
```

Add to the `IPC` map after `sessionsReindex`:

```ts
  sessionsTracks: "sessions:tracks",
```

- [ ] **Step 4: Create `app/src/main/track-buckets.ts`**

```ts
/**
 * Time → fixed-width buckets. Every density lane is built from these, so the
 * arithmetic lives in one tested place instead of in fifteen lane builders.
 *
 * PURE: no store, no filesystem, no Electron, no DTOs. Tested in the ROOT
 * vitest suite alongside `plan-view.ts` and `graph-layout.ts`.
 */

/**
 * The bucket a second-offset falls in. Clamped at both ends, so `totalSec`
 * itself lands in the LAST bucket rather than one past the array.
 */
export function bucketIndex(sec: number, totalSec: number, buckets: number): number {
  if (!(totalSec > 0) || buckets <= 0) return 0;
  const i = Math.floor((sec / totalSec) * buckets);
  return Math.min(buckets - 1, Math.max(0, i));
}

/** How many of `secs` land in each bucket. */
export function bucketCounts(
  secs: readonly number[],
  totalSec: number,
  buckets: number,
): number[] {
  const out = new Array<number>(buckets).fill(0);
  for (const s of secs) out[bucketIndex(s, totalSec, buckets)] += 1;
  return out;
}

/**
 * Max value per bucket; buckets with no sample stay 0.
 *
 * Max, never mean. A fast pointer flick inside an otherwise idle bucket must
 * not be averaged away — showing when the pointer moved fast is the whole
 * purpose of the speed lane.
 */
export function bucketMax(
  samples: readonly { sec: number; value: number }[],
  totalSec: number,
  buckets: number,
): number[] {
  const out = new Array<number>(buckets).fill(0);
  for (const s of samples) {
    const b = bucketIndex(s.sec, totalSec, buckets);
    if (s.value > out[b]!) out[b] = s.value;
  }
  return out;
}

/**
 * Last value seen at or before each bucket — a step function, which is what a
 * pointer coordinate is between samples.
 *
 * Buckets before the first sample are null: a pointer has no position before it
 * was first observed, and that is absent coverage rather than the origin.
 */
export function bucketHold(
  samples: readonly { sec: number; value: number }[],
  totalSec: number,
  buckets: number,
): (number | null)[] {
  const out = new Array<number | null>(buckets).fill(null);
  for (const s of samples) out[bucketIndex(s.sec, totalSec, buckets)] = s.value;
  let last: number | null = null;
  for (let i = 0; i < buckets; i++) {
    if (out[i] === null) out[i] = last;
    else last = out[i]!;
  }
  return out;
}

/** Scale to 0–1 by the largest value present, preserving nulls. */
export function normalize(raw: readonly (number | null)[]): {
  values: (number | null)[];
  peak: number;
} {
  let peak = 0;
  for (const v of raw) if (v !== null && v > peak) peak = v;
  return {
    values: raw.map((v) => (v === null ? null : peak > 0 ? v / peak : 0)),
    peak,
  };
}

export interface AudioBlobPeaks {
  /** Offset of the blob's first sample on the session axis. */
  startSec: number;
  /**
   * Duration MEASURED FROM THE BYTES (`WavPeaks.durationSec`), never the blob
   * row's declared span. A truncated file must read as a gap for the part that
   * is missing, not as an envelope stretched over time nobody recorded.
   */
  durationSec: number;
  peaks: readonly number[];
}

/**
 * How many peaks to ask `wavPeaks` for so every session bucket the blob covers
 * receives at least one sample. Oversampled 4x, because a blob starts and ends
 * mid-bucket and an exact ratio would leave its edge buckets empty.
 */
export function peakCountFor(durationSec: number, totalSec: number, buckets: number): number {
  if (!(totalSec > 0) || !(durationSec > 0)) return 1;
  return Math.max(1, Math.ceil((durationSec / totalSec) * buckets * 4));
}

/**
 * Place per-blob envelopes onto the session axis, taking the max where they
 * overlap.
 *
 * A bucket no blob covers stays NULL — not zero. Silence during a recorded
 * stretch is a flat zero; a stretch with no blob at all is unknown, and a dead
 * microphone must not be indistinguishable from a quiet room.
 */
export function mergeAudioPeaks(
  blobs: readonly AudioBlobPeaks[],
  totalSec: number,
  buckets: number,
): (number | null)[] {
  const out = new Array<number | null>(buckets).fill(null);
  for (const b of blobs) {
    if (b.peaks.length === 0 || !(b.durationSec > 0)) continue;
    for (let p = 0; p < b.peaks.length; p++) {
      // Sample the CENTRE of each peak's slice, so a blob starting at 0 does
      // not bias its first peak into the bucket before it.
      const sec = b.startSec + ((p + 0.5) / b.peaks.length) * b.durationSec;
      const i = bucketIndex(sec, totalSec, buckets);
      const cur = out[i];
      out[i] = cur === null ? b.peaks[p]! : Math.max(cur, b.peaks[p]!);
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/track-buckets.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Run the full gate**

Run: `npm run typecheck && npm test && npm --prefix app run typecheck`
Expected: PASS. The app typecheck passes because nothing calls `sessions.tracks` yet — the preload does not implement it until Task 6, and `DeskRagApi` is only satisfied there.

If the app typecheck fails on `preload/index.ts` not satisfying `DeskRagApi`, add the preload line from Task 6 Step 4 now and note it as done early.

- [ ] **Step 7: Commit**

```bash
git add app/src/shared/types.ts app/src/main/track-buckets.ts test/track-buckets.test.ts
git commit -m "feat(app): track DTO contract and the bucketing primitives

Density values are (number | null)[] because an audio gap is not silence,
and a lane carries `warning` alongside `emptyReason` because a lane can
hold data that cannot be trusted. Bucket count is fixed at 1000 in main,
never the renderer's pixel width.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The event-sourced lanes

Eight lanes built from `event` rows alone: apps, web, typing, clicks, scroll, mouse speed, mouse x/y, markers.

**Files:**
- Create: `app/src/main/session-tracks.ts`
- Test: `test/session-tracks.test.ts`

**Interfaces:**
- Consumes: `bucketCounts`, `bucketMax`, `bucketHold`, `normalize` from Task 2; `urlPrefix` from the `deskrag` barrel (Task 1); `EventRow` from the barrel.
- Produces:
  - `interface LaneInput { originMono: number; totalSec: number; buckets: number; events: readonly EventRow[]; segments: readonly SegmentRow[]; frames: readonly FrameRow[]; axSnapshots: readonly AxSnapshotRow[]; keyframes: readonly KeyframeMarkerDTO[]; regionCounts: ReadonlyMap<string, number>; audio: readonly AudioLaneInput[] }`
  - `interface AudioLaneInput { media: string; blobs: readonly AudioBlobPeaks[] }`
  - `appTone(name: string): TrackTone`
  - `appsLane`, `webLane`, `typingLane`, `clicksLane`, `scrollLane`, `mouseSpeedLane`, `mouseXyLane`, `markersLane` — each `(input: LaneInput) => TrackLaneDTO`.
- Task 4 adds `framesLane`, `segmentLanes`, `transcriptLane`, `captionLane`, `axLane` to this same file. Task 5 adds `audioLanes` and `buildSessionTracks`.

- [ ] **Step 1: Write the failing tests**

Create `test/session-tracks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { EventRow } from "../src/store/types.js";
import {
  appTone,
  appsLane,
  clicksLane,
  markersLane,
  mouseSpeedLane,
  mouseXyLane,
  scrollLane,
  typingLane,
  type LaneInput,
} from "../app/src/main/session-tracks.js";

let seq = 0;
const ev = (kind: string, tMono: number, extra: Partial<EventRow> = {}): EventRow => ({
  id: `e${seq++}`,
  sessionId: "s1",
  tMono,
  kind,
  x: null,
  y: null,
  data: null,
  ...extra,
});

/** A LaneInput with a 10s axis and 10 buckets — small enough to assert exactly. */
const input = (events: EventRow[], over: Partial<LaneInput> = {}): LaneInput => ({
  originMono: 0,
  totalSec: 10,
  buckets: 10,
  events,
  segments: [],
  frames: [],
  axSnapshots: [],
  keyframes: [],
  regionCounts: new Map(),
  audio: [],
  ...over,
});

describe("appTone", () => {
  it("gives one app one colour, stably", () => {
    expect(appTone("Google Chrome")).toBe(appTone("Google Chrome"));
    expect(appTone("Google Chrome")).toMatch(/^app-[0-7]$/);
  });
});

describe("appsLane", () => {
  it("closes the last span at the END OF THE SESSION — focus does not end, the recording does", () => {
    const lane = appsLane(
      input([
        ev("focus_change", 0, { data: { app: "TextEdit" } }),
        ev("focus_change", 4000, { data: { app: "Google Chrome" } }),
      ]),
    );
    expect(lane.spans).toEqual([
      { startSec: 0, endSec: 4, label: "TextEdit", tone: appTone("TextEdit") },
      { startSec: 4, endSec: 10, label: "Google Chrome", tone: appTone("Google Chrome") },
    ]);
    expect(lane.emptyReason).toBeNull();
  });

  it("says why it is empty rather than rendering nothing", () => {
    expect(appsLane(input([])).emptyReason).toBeTruthy();
  });
});

describe("typingLane", () => {
  it("WARNS when there are keys but no keymap — the lane is not empty, it is untrustworthy", () => {
    const lane = typingLane(input([ev("key_down", 1000), ev("key_down", 1100)]));
    expect(lane.emptyReason).toBeNull();
    expect(lane.warning).toContain("dropped at lift");
  });

  it("has no warning once a keymap was captured", () => {
    const lane = typingLane(input([ev("keymap_change", 0), ev("key_down", 1000)]));
    expect(lane.warning).toBeNull();
  });

  it("reports its peak in keys per second", () => {
    // 10s over 10 buckets = 1s each; three keys in bucket 1 is 3 keys/s.
    const lane = typingLane(
      input([ev("keymap_change", 0), ev("key_down", 1000), ev("key_down", 1200), ev("key_down", 1400)]),
    );
    expect(lane.density!.unit).toBe("keys/s");
    expect(lane.density!.peak).toBeCloseTo(3, 5);
    expect(lane.density!.values[1]).toBe(1);
    expect(lane.density!.values[5]).toBe(0); // absence of typing IS zero, not null
  });
});

describe("clicksLane", () => {
  it("labels a press that travelled as a drag, and one that did not as a click", () => {
    const lane = clicksLane(
      input([
        ev("mouse_down", 1000, { x: 10, y: 10 }),
        ev("mouse_up", 1200, { x: 11, y: 10 }),
        ev("mouse_down", 3000, { x: 10, y: 10 }),
        ev("mouse_up", 3400, { x: 200, y: 90 }),
      ]),
    );
    expect(lane.marks![0]!.label).toBe("click");
    expect(lane.marks![1]!.label).toMatch(/^drag 400ms · \d+px$/);
  });
});

describe("scrollLane", () => {
  it("counts scroll events per bucket", () => {
    const lane = scrollLane(input([ev("scroll", 2000), ev("scroll", 2500)]));
    expect(lane.density!.values[2]).toBe(1);
    expect(lane.density!.peak).toBeCloseTo(2, 5);
  });
});

describe("mouseSpeedLane", () => {
  it("takes the peak speed in a bucket, in px/s", () => {
    const lane = mouseSpeedLane(
      input([
        ev("mouse_move", 1000, { x: 0, y: 0 }),
        ev("mouse_move", 1100, { x: 100, y: 0 }), // 1000 px/s
        ev("mouse_move", 1200, { x: 101, y: 0 }), // 10 px/s
      ]),
    );
    expect(lane.density!.unit).toBe("px/s");
    expect(lane.density!.peak).toBeCloseTo(1000, 0);
  });
});

describe("mouseXyLane", () => {
  it("normalizes against recorded display topology when there is any", () => {
    const lane = mouseXyLane(
      input([
        ev("display_change", 0, {
          data: { displays: [{ id: "1", x: 0, y: 0, w: 2000, h: 1000, scale: 2, primary: true }] },
        }),
        ev("mouse_move", 1000, { x: 1000, y: 500 }),
      ]),
    );
    expect(lane.density!.values[1]).toBeCloseTo(0.5, 5);
    expect(lane.density!.values2![1]).toBeCloseTo(0.5, 5);
  });

  it("is null before the pointer was first seen — no position is not the origin", () => {
    const lane = mouseXyLane(input([ev("mouse_move", 5000, { x: 10, y: 10 })]));
    expect(lane.density!.values[0]).toBeNull();
  });
});

describe("markersLane", () => {
  it("carries bookmarks and environment changes, which are rare and high-signal", () => {
    const lane = markersLane(input([ev("keymap_change", 0), ev("bookmark", 5000), ev("display_change", 9000)]));
    expect(lane.marks!.map((m) => m.label)).toEqual(["keyboard layout", "bookmark", "displays changed"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/session-tracks.test.ts`
Expected: FAIL — cannot resolve `../app/src/main/session-tracks.js`.

- [ ] **Step 3: Create `app/src/main/session-tracks.ts` with the event lanes**

```ts
/**
 * Session signals → timeline lanes.
 *
 * PURE: rows in, DTO out. No store, no filesystem, no Electron — `DeskRagService`
 * performs the reads and hands the results here, which is what keeps every
 * lane's arithmetic in the fast ROOT suite (the same arrangement as
 * `plan-view.ts` and `graph-layout.ts`).
 *
 * Fifteen lanes, four shapes. A new signal is a builder here plus a line in
 * `buildSessionTracks` — never a new renderer component.
 */

import { urlPrefix, type AxSnapshotRow, type EventRow, type FrameRow, type SegmentRow } from "deskrag";
import type {
  KeyframeMarkerDTO,
  SessionTracksDTO,
  TrackLaneDTO,
  TrackMarkDTO,
  TrackSpanDTO,
  TrackTone,
} from "@shared/types";
import {
  bucketCounts,
  bucketHold,
  bucketMax,
  normalize,
  type AudioBlobPeaks,
} from "./track-buckets.js";

export interface AudioLaneInput {
  media: string;
  blobs: readonly AudioBlobPeaks[];
}

export interface LaneInput {
  /** t_mono that offset 0 corresponds to — the video's start when there is one. */
  originMono: number;
  totalSec: number;
  buckets: number;
  events: readonly EventRow[];
  segments: readonly SegmentRow[];
  frames: readonly FrameRow[];
  axSnapshots: readonly AxSnapshotRow[];
  /** Built by `DeskRagService.sessionDetail`, reused so one label rule serves both. */
  keyframes: readonly KeyframeMarkerDTO[];
  regionCounts: ReadonlyMap<string, number>;
  audio: readonly AudioLaneInput[];
}

function secOf(tMono: number, originMono: number): number {
  return (tMono - originMono) / 1000;
}

function asRecord(data: unknown): Record<string, unknown> {
  return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

/**
 * Stable application name → palette slot, so one app is one colour across every
 * lane and every session. Position in the timeline must never decide a colour;
 * a recording made tomorrow has to look like the same app.
 */
export function appTone(name: string): TrackTone {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
  return `app-${h % 8}` as TrackTone;
}

// --- attention ---------------------------------------------------------------

export function appsLane(input: LaneInput): TrackLaneDTO {
  const changes = input.events.filter((e) => e.kind === "focus_change");
  const spans: TrackSpanDTO[] = [];
  for (let i = 0; i < changes.length; i++) {
    const label = String(asRecord(changes[i]!.data).app ?? "unknown");
    const startSec = secOf(changes[i]!.tMono, input.originMono);
    const next = changes[i + 1];
    // The last span runs to the end of the axis: focus does not end, the
    // recording does.
    const endSec = next ? secOf(next.tMono, input.originMono) : input.totalSec;
    if (endSec <= startSec) continue;
    spans.push({ startSec, endSec, label, tone: appTone(label) });
  }
  return {
    id: "apps",
    title: "apps",
    shape: "span",
    spans,
    emptyReason:
      spans.length === 0
        ? "no focus changes recorded — the active-window signal was off or unavailable"
        : null,
    warning: null,
  };
}

export function webLane(input: LaneInput): TrackLaneDTO {
  const marks: TrackMarkDTO[] = [];
  for (const e of input.events) {
    if (e.kind !== "url_change") continue;
    const raw = asRecord(e.data).url;
    if (typeof raw !== "string") continue;
    // The trace IR's own site-prefix rule, imported rather than re-derived: two
    // URLs that merge into one graph node must read as one site here too.
    marks.push({
      atSec: secOf(e.tMono, input.originMono),
      label: urlPrefix(raw) ?? raw,
      tone: "accent",
    });
  }
  return {
    id: "web",
    title: "web",
    shape: "mark",
    marks,
    emptyReason:
      marks.length === 0
        ? "no page URLs recorded — no browser was focused, or AXURL was unavailable"
        : null,
    warning: null,
  };
}

const MARKER_LABELS: Record<string, string> = {
  keymap_change: "keyboard layout",
  display_change: "displays changed",
  bookmark: "bookmark",
};

export function markersLane(input: LaneInput): TrackLaneDTO {
  const marks: TrackMarkDTO[] = input.events
    .filter((e) => e.kind in MARKER_LABELS)
    .map((e) => ({
      atSec: secOf(e.tMono, input.originMono),
      label: MARKER_LABELS[e.kind]!,
      tone: e.kind === "bookmark" ? ("ok" as TrackTone) : ("neutral" as TrackTone),
    }));
  return {
    id: "markers",
    title: "markers",
    shape: "mark",
    marks,
    emptyReason: marks.length === 0 ? "no bookmarks or environment changes recorded" : null,
    warning: null,
  };
}

// --- input -------------------------------------------------------------------

export function typingLane(input: LaneInput): TrackLaneDTO {
  const secs = input.events
    .filter((e) => e.kind === "key_down")
    .map((e) => secOf(e.tMono, input.originMono));
  const perBucketSec = input.totalSec / input.buckets;
  const rate = bucketCounts(secs, input.totalSec, input.buckets).map((c) =>
    perBucketSec > 0 ? c / perBucketSec : 0,
  );
  const { values, peak } = normalize(rate);
  const hasKeymap = input.events.some((e) => e.kind === "keymap_change");
  return {
    id: "typing",
    title: "typing",
    shape: "density",
    density: { values, peak, unit: "keys/s" },
    emptyReason: secs.length === 0 ? "no keys were pressed, or the input signal was off" : null,
    // The lane is NOT empty and still cannot be trusted. `resolveKeys` needs the
    // session's own keymap to turn a keycode into a character, so a recording
    // with keys and no keymap lost every character it typed, silently, at lift.
    warning:
      secs.length > 0 && !hasKeymap
        ? "no keyboard layout was captured — every typed character was dropped at lift"
        : null,
  };
}

export function clicksLane(input: LaneInput): TrackLaneDTO {
  const ups = input.events.filter((e) => e.kind === "mouse_up");
  const marks: TrackMarkDTO[] = input.events
    .filter((e) => e.kind === "mouse_down")
    .map((d) => {
      // The first mouse_up at or after this down closes it. Overlapping
      // multi-button presses are rare enough that pairing in order is right.
      const up = ups.find((u) => u.tMono >= d.tMono);
      const heldMs = up ? up.tMono - d.tMono : 0;
      const moved =
        up && d.x !== null && d.y !== null && up.x !== null && up.y !== null
          ? Math.hypot(up.x - d.x, up.y - d.y)
          : 0;
      // 4px of slop: a click on a trackpad travels a pixel or two, and calling
      // that a drag would label almost every click one.
      const isDrag = moved > 4;
      return {
        atSec: secOf(d.tMono, input.originMono),
        label: isDrag ? `drag ${Math.round(heldMs)}ms · ${Math.round(moved)}px` : "click",
        tone: isDrag ? ("warn" as TrackTone) : ("accent" as TrackTone),
      };
    });
  return {
    id: "clicks",
    title: "clicks",
    shape: "mark",
    marks,
    emptyReason: marks.length === 0 ? "no clicks recorded" : null,
    warning: null,
  };
}

export function scrollLane(input: LaneInput): TrackLaneDTO {
  const secs = input.events
    .filter((e) => e.kind === "scroll")
    .map((e) => secOf(e.tMono, input.originMono));
  const perBucketSec = input.totalSec / input.buckets;
  const rate = bucketCounts(secs, input.totalSec, input.buckets).map((c) =>
    perBucketSec > 0 ? c / perBucketSec : 0,
  );
  const { values, peak } = normalize(rate);
  return {
    id: "scroll",
    title: "scroll",
    shape: "density",
    density: { values, peak, unit: "events/s" },
    emptyReason: secs.length === 0 ? "no scrolling recorded" : null,
    warning: null,
  };
}

// --- pointer motion ----------------------------------------------------------

interface Bounds {
  w: number;
  h: number;
}

/**
 * Screen extent for normalizing pointer coordinates.
 *
 * From recorded display topology when there is any — that is what
 * `display_change` exists for, and it is resolved latest-first like every other
 * environment fact. Otherwise the largest coordinate actually observed, which
 * is a floor rather than a guess.
 */
function screenBounds(events: readonly EventRow[]): Bounds {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "display_change") continue;
    const displays = asRecord(e.data).displays;
    if (!Array.isArray(displays)) continue;
    let w = 0;
    let h = 0;
    for (const d of displays) {
      const r = asRecord(d);
      const right = Number(r.x ?? 0) + Number(r.w ?? 0);
      const bottom = Number(r.y ?? 0) + Number(r.h ?? 0);
      if (Number.isFinite(right)) w = Math.max(w, right);
      if (Number.isFinite(bottom)) h = Math.max(h, bottom);
    }
    if (w > 0 && h > 0) return { w, h };
  }
  let w = 1;
  let h = 1;
  for (const e of events) {
    if (e.x !== null) w = Math.max(w, e.x);
    if (e.y !== null) h = Math.max(h, e.y);
  }
  return { w, h };
}

function moves(input: LaneInput): EventRow[] {
  return input.events.filter((e) => e.kind === "mouse_move" && e.x !== null && e.y !== null);
}

export function mouseSpeedLane(input: LaneInput): TrackLaneDTO {
  const ms = moves(input);
  const samples: { sec: number; value: number }[] = [];
  for (let i = 1; i < ms.length; i++) {
    const a = ms[i - 1]!;
    const b = ms[i]!;
    const dt = (b.tMono - a.tMono) / 1000;
    if (dt <= 0) continue;
    samples.push({
      sec: secOf(b.tMono, input.originMono),
      value: Math.hypot(b.x! - a.x!, b.y! - a.y!) / dt,
    });
  }
  const { values, peak } = normalize(bucketMax(samples, input.totalSec, input.buckets));
  return {
    id: "mouse-speed",
    title: "mouse speed",
    shape: "density",
    density: { values, peak, unit: "px/s" },
    emptyReason: samples.length === 0 ? "no pointer movement recorded" : null,
    warning: null,
  };
}

export function mouseXyLane(input: LaneInput): TrackLaneDTO {
  const ms = moves(input);
  const bounds = screenBounds(input.events);
  const xs = ms.map((e) => ({ sec: secOf(e.tMono, input.originMono), value: e.x! / bounds.w }));
  const ys = ms.map((e) => ({ sec: secOf(e.tMono, input.originMono), value: e.y! / bounds.h }));
  return {
    id: "mouse-xy",
    title: "mouse x/y",
    shape: "density",
    density: {
      // Already 0–1 by construction, so these are NOT re-normalized: rescaling
      // would make the traces depend on how far the pointer happened to travel
      // rather than on where it was.
      values: bucketHold(xs, input.totalSec, input.buckets),
      values2: bucketHold(ys, input.totalSec, input.buckets),
      peak: 1,
      unit: "screen",
    },
    emptyReason: ms.length === 0 ? "no pointer movement recorded" : null,
    warning: null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/session-tracks.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Run the full gate**

Run: `npm run typecheck && npm test && npm --prefix app run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/session-tracks.ts test/session-tracks.test.ts
git commit -m "feat(app): the event-sourced timeline lanes

Apps, web, typing, clicks, scroll, mouse speed and mouse x/y, built from
the event table alone. The typing lane WARNS rather than reporting empty
when a session has keys but no keymap: the lane is full and every
character it recorded was dropped at lift.

Pointer coordinates normalize against recorded display topology, resolved
latest-first like every other environment fact, and fall back to the
largest observed coordinate rather than to a guessed screen size.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The index lanes

Five more builders in the same file: frames, one lane per segment granularity, transcript, caption, AX walks.

**Files:**
- Modify: `app/src/main/session-tracks.ts`
- Test: `test/session-tracks.test.ts`

**Interfaces:**
- Consumes: `LaneInput` from Task 3.
- Produces: `framesLane(input): TrackLaneDTO`, `segmentLanes(input): TrackLaneDTO[]`, `transcriptLane(input): TrackLaneDTO`, `captionLane(input): TrackLaneDTO`, `axLane(input): TrackLaneDTO`, `finestGranularity(segments): string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/session-tracks.test.ts`:

```ts
import type { AxSnapshotRow, SegmentRow } from "../src/store/types.js";
import {
  axLane,
  captionLane,
  finestGranularity,
  framesLane,
  segmentLanes,
  transcriptLane,
} from "../app/src/main/session-tracks.js";

const seg = (
  id: string,
  granularity: string,
  startMs: number,
  endMs: number,
  over: Partial<SegmentRow> = {},
): SegmentRow => ({
  id,
  sessionId: "s1",
  granularity,
  tMonoStart: startMs,
  tMonoEnd: endMs,
  boundaryReason: "window",
  transcript: null,
  digest: null,
  caption: null,
  ...over,
});

const snap = (id: string, tMono: number, elements: number, over: Partial<AxSnapshotRow> = {}): AxSnapshotRow => ({
  id,
  sessionId: "s1",
  tMono,
  frameId: null,
  reason: "focus_change",
  walkMs: 80,
  elements: new Array(elements).fill({ role: "Button", label: "x" }) as AxSnapshotRow["elements"],
  ...over,
});

describe("finestGranularity", () => {
  it("picks the granularity with the most segments — action over task", () => {
    expect(
      finestGranularity([
        seg("a1", "action", 0, 1000),
        seg("a2", "action", 1000, 2000),
        seg("t1", "task", 0, 2000),
      ]),
    ).toBe("action");
  });

  it("returns null when there are no segments at all", () => {
    expect(finestGranularity([])).toBeNull();
  });
});

describe("segmentLanes", () => {
  it("emits ONE LANE PER GRANULARITY found in the data, not a hardcoded pair", () => {
    const lanes = segmentLanes(
      input([], { segments: [seg("a1", "action", 0, 4000), seg("t1", "task", 0, 10000)] }),
    );
    expect(lanes.map((l) => l.id)).toEqual(["seg-action", "seg-task"]);
    expect(lanes[0]!.spans).toEqual([
      { startSec: 0, endSec: 4, label: "window", tone: "neutral" },
    ]);
  });

  it("prefers the caption as the span label and falls back to the digest", () => {
    const lanes = segmentLanes(
      input([], {
        segments: [
          seg("a1", "action", 0, 1000, { caption: "the PR page", digest: "clicked Files" }),
          seg("a2", "action", 1000, 2000, { digest: "typed a comment" }),
        ],
      }),
    );
    expect(lanes[0]!.spans!.map((s) => s.label)).toEqual(["the PR page", "typed a comment"]);
  });
});

describe("transcriptLane / captionLane", () => {
  it("covers only the segments that actually carry the view", () => {
    const i = input([], {
      segments: [
        seg("a1", "action", 0, 2000, { transcript: "hello" }),
        seg("a2", "action", 2000, 4000),
      ],
    });
    expect(transcriptLane(i).spans).toHaveLength(1);
    expect(transcriptLane(i).spans![0]!.endSec).toBe(2);
  });

  it("says a provider was probably never configured when NOTHING carries the view", () => {
    const i = input([], { segments: [seg("a1", "action", 0, 2000)] });
    expect(captionLane(i).emptyReason).toContain("captioner");
    expect(transcriptLane(i).emptyReason).toContain("whisper");
  });
});

describe("axLane", () => {
  it("flags a walk that returned ZERO elements — that is what `reason` exists to measure", () => {
    const lane = axLane(input([], { axSnapshots: [snap("x1", 1000, 0), snap("x2", 2000, 12)] }));
    expect(lane.marks![0]!.tone).toBe("alarm");
    expect(lane.marks![0]!.label).toContain("0 elements");
    expect(lane.marks![1]!.tone).not.toBe("alarm");
  });
});

describe("framesLane", () => {
  it("carries the marker itself so keyframeLabel() stays the ONE label rule", () => {
    const marker = {
      frameId: "f1",
      tMono: 3000,
      offsetSec: 3,
      thumbUrl: "deskrag://frame/b1",
      segmentCaption: "the PR page",
      segmentDigest: null,
    };
    const lane = framesLane(
      input([], { keyframes: [marker], regionCounts: new Map([["f1", 14]]) }),
    );
    expect(lane.thumbs).toEqual([{ atSec: 3, marker, regionCount: 14 }]);
  });

  it("says so when nothing was indexed", () => {
    expect(framesLane(input([])).emptyReason).toContain("keyframe");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/session-tracks.test.ts`
Expected: FAIL — `framesLane`, `segmentLanes`, `transcriptLane`, `captionLane`, `axLane`, `finestGranularity` are not exported.

- [ ] **Step 3: Append the index lanes to `app/src/main/session-tracks.ts`**

```ts
// --- the index ---------------------------------------------------------------

/** Boundary reason → tone. The union is `BoundaryReason` in `src/segment/types.ts`. */
const BOUNDARY_TONE: Record<string, TrackTone> = {
  session_start: "ok",
  session_end: "ok",
  focus_change: "accent",
  dwell_gap: "warn",
  bookmark: "ok",
  window: "neutral",
};

/**
 * The granularity with the most segments — `action` against `task` in every
 * recording so far.
 *
 * Presence lanes (transcript, caption) need ONE granularity or their spans
 * stack on top of each other, and the finest is the one that shows where a view
 * actually stops and starts.
 */
export function finestGranularity(segments: readonly SegmentRow[]): string | null {
  const counts = new Map<string, number>();
  for (const s of segments) counts.set(s.granularity, (counts.get(s.granularity) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [g, n] of counts) {
    if (n > bestN) {
      best = g;
      bestN = n;
    }
  }
  return best;
}

function segmentLabel(s: SegmentRow): string {
  // Caption first for the same reason `keyframeLabel` prefers it: the VLM
  // describes the pixels, the digest is a template over events.
  return s.caption ?? s.digest ?? s.boundaryReason ?? "segment";
}

export function segmentLanes(input: LaneInput): TrackLaneDTO[] {
  const byGranularity = new Map<string, SegmentRow[]>();
  for (const s of input.segments) {
    const list = byGranularity.get(s.granularity) ?? [];
    list.push(s);
    byGranularity.set(s.granularity, list);
  }
  // Sorted so lane order is stable across reads; Map iteration would otherwise
  // follow whatever order SQLite happened to return.
  return [...byGranularity.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([granularity, rows]) => ({
      id: `seg-${granularity}`,
      title: granularity,
      shape: "span" as const,
      spans: rows
        .slice()
        .sort((a, b) => a.tMonoStart - b.tMonoStart)
        .map((s) => ({
          startSec: secOf(s.tMonoStart, input.originMono),
          endSec: secOf(s.tMonoEnd, input.originMono),
          label: segmentLabel(s),
          tone: BOUNDARY_TONE[s.boundaryReason ?? "window"] ?? "neutral",
        })),
      emptyReason: null,
      warning: null,
    }));
}

function presenceLane(
  input: LaneInput,
  id: string,
  title: string,
  pick: (s: SegmentRow) => string | null,
  absent: string,
): TrackLaneDTO {
  const g = finestGranularity(input.segments);
  const spans: TrackSpanDTO[] = input.segments
    .filter((s) => s.granularity === g && pick(s) !== null)
    .sort((a, b) => a.tMonoStart - b.tMonoStart)
    .map((s) => ({
      startSec: secOf(s.tMonoStart, input.originMono),
      endSec: secOf(s.tMonoEnd, input.originMono),
      label: pick(s) ?? "",
      tone: "ok" as TrackTone,
    }));
  return {
    id,
    title,
    shape: "span",
    spans,
    emptyReason: spans.length === 0 ? absent : null,
    warning: null,
  };
}

export function transcriptLane(input: LaneInput): TrackLaneDTO {
  // Hedged deliberately: the store cannot prove retroactively that a provider
  // was absent, only that nothing carries the view.
  return presenceLane(
    input,
    "transcript",
    "transcript",
    (s) => s.transcript,
    "nothing was transcribed — most likely no whisper model was configured when this was indexed",
  );
}

export function captionLane(input: LaneInput): TrackLaneDTO {
  return presenceLane(
    input,
    "caption",
    "caption",
    (s) => s.caption,
    "nothing was captioned — most likely no captioner was configured when this was indexed",
  );
}

export function axLane(input: LaneInput): TrackLaneDTO {
  const marks: TrackMarkDTO[] = input.axSnapshots
    .slice()
    .sort((a, b) => a.tMono - b.tMono)
    .map((s) => {
      const n = s.elements.length;
      return {
        atSec: secOf(s.tMono, input.originMono),
        label: `${s.reason} · ${n} elements · ${Math.round(s.walkMs)}ms`,
        // An empty result is a real row, written precisely so that "captured
        // nothing" stays distinguishable from "never captured". Zero elements
        // is the failure this lane exists to surface.
        tone: n === 0 ? ("alarm" as TrackTone) : s.reason === "keyframe" ? ("accent" as TrackTone) : ("neutral" as TrackTone),
      };
    });
  return {
    id: "ax",
    title: "ax walks",
    shape: "mark",
    marks,
    emptyReason:
      marks.length === 0
        ? "no accessibility snapshots — the AX sidecar was unavailable or permission was not granted"
        : null,
    warning: null,
  };
}

export function framesLane(input: LaneInput): TrackLaneDTO {
  const thumbs = input.keyframes.map((marker) => ({
    atSec: marker.offsetSec,
    // The marker travels whole rather than being flattened to a string, so
    // `keyframeLabel()` in the renderer stays the ONE place a keyframe is named.
    marker,
    regionCount: input.regionCounts.get(marker.frameId) ?? 0,
  }));
  return {
    id: "frames",
    title: "keyframes",
    shape: "thumb",
    thumbs,
    emptyReason:
      thumbs.length === 0
        ? "no keyframes were indexed — the screen was settled throughout, or the Screen signal was off"
        : null,
    warning: null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/session-tracks.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `npm run typecheck && npm test && npm --prefix app run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/session-tracks.ts test/session-tracks.test.ts
git commit -m "feat(app): the index lanes — frames, segments, transcript, caption, AX

Segment lanes are generated per granularity found in the data, so a third
one appears without a code change. An AX walk that returned zero elements
gets the alarm tone: that is the measurement ax_snapshot.reason exists for.

The frames lane carries KeyframeMarkerDTO whole rather than a flattened
string, so keyframeLabel() stays the one place a keyframe is named.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Audio lanes and assembly

The last builder plus `buildSessionTracks`, which puts the lanes in reading order.

**Files:**
- Modify: `app/src/main/session-tracks.ts`
- Test: `test/session-tracks.test.ts`

**Interfaces:**
- Consumes: `mergeAudioPeaks` from Task 2; all lane builders from Tasks 3–4.
- Produces: `audioLanes(input): TrackLaneDTO[]`, `buildSessionTracks(input: TrackInput): SessionTracksDTO`, `interface TrackInput extends LaneInput { sessionId: string; anchoredToVideo: boolean }`. Task 6 calls `buildSessionTracks`.

- [ ] **Step 1: Write the failing tests**

Append to `test/session-tracks.test.ts`:

```ts
import { audioLanes, buildSessionTracks } from "../app/src/main/session-tracks.js";

describe("audioLanes", () => {
  it("gives each medium its own lane and leaves uncovered stretches null", () => {
    const lanes = audioLanes(
      input([], {
        audio: [
          { media: "mic", blobs: [{ startSec: 0, durationSec: 2, peaks: [0.4, 0.4] }] },
          { media: "desktop_audio", blobs: [{ startSec: 0, durationSec: 10, peaks: new Array(40).fill(0.9) }] },
        ],
      }),
    );
    expect(lanes.map((l) => l.id)).toEqual(["audio-mic", "audio-desktop_audio"]);
    expect(lanes[0]!.density!.values[9]).toBeNull(); // mic stopped at 2s
    expect(lanes[1]!.density!.values[9]).not.toBeNull();
    expect(lanes[0]!.density!.unit).toBe("amplitude");
  });

  it("produces one empty lane saying why when no audio was captured at all", () => {
    const lanes = audioLanes(input([]));
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.emptyReason).toContain("audio");
  });
});

describe("buildSessionTracks", () => {
  it("puts the lanes in reading order: screen, attention, index, hands, sound", () => {
    const dto = buildSessionTracks({
      ...input([ev("focus_change", 0, { data: { app: "TextEdit" } })], {
        segments: [seg("a1", "action", 0, 4000)],
      }),
      sessionId: "s1",
      anchoredToVideo: true,
    });
    expect(dto.lanes.map((l) => l.id)).toEqual([
      "frames",
      "apps",
      "web",
      "seg-action",
      "transcript",
      "caption",
      "ax",
      "typing",
      "clicks",
      "scroll",
      "mouse-speed",
      "mouse-xy",
      "audio-none",
      "markers",
    ]);
    expect(dto.sessionId).toBe("s1");
    expect(dto.totalSec).toBe(10);
    expect(dto.anchoredToVideo).toBe(true);
  });

  it("renders an empty rail rather than dividing by zero on a session with no span", () => {
    const dto = buildSessionTracks({
      ...input([], { totalSec: 0 }),
      sessionId: "s1",
      anchoredToVideo: false,
    });
    expect(dto.totalSec).toBe(0);
    expect(dto.lanes.every((l) => l.emptyReason !== null || l.shape === "span")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/session-tracks.test.ts`
Expected: FAIL — `audioLanes` and `buildSessionTracks` are not exported.

- [ ] **Step 3: Append audio and assembly to `app/src/main/session-tracks.ts`**

Add `mergeAudioPeaks` to the existing import from `./track-buckets.js`, then append:

```ts
// --- sound -------------------------------------------------------------------

export function audioLanes(input: LaneInput): TrackLaneDTO[] {
  if (input.audio.length === 0) {
    return [
      {
        id: "audio-none",
        title: "audio",
        shape: "density",
        density: { values: new Array(input.buckets).fill(null), peak: 0, unit: "amplitude" },
        emptyReason: "no audio was captured — the Audio signal was off, or every blob is missing",
        warning: null,
      },
    ];
  }
  return input.audio.map((a) => {
    const values = mergeAudioPeaks(a.blobs, input.totalSec, input.buckets);
    const covered = values.some((v) => v !== null);
    let peak = 0;
    for (const v of values) if (v !== null && v > peak) peak = v;
    return {
      id: `audio-${a.media}`,
      title: a.media === "mic" ? "audio (mic)" : `audio (${a.media})`,
      shape: "density" as const,
      // NOT re-normalized: amplitude is already 0–1 against full scale, and
      // rescaling to the loudest moment would make a whisper look like a shout.
      density: { values, peak, unit: "amplitude" },
      emptyReason: covered ? null : "every audio blob for this medium was unreadable or missing",
      warning: null,
    };
  });
}

// --- assembly ----------------------------------------------------------------

export interface TrackInput extends LaneInput {
  sessionId: string;
  anchoredToVideo: boolean;
}

/**
 * Lanes in reading order: screen → attention → index → hands → sound.
 *
 * Every lane is emitted even when it is empty. Absence is the answer to two of
 * the four questions this rail exists to answer, so a missing lane and a lane
 * that says why it is missing are very different things.
 */
export function buildSessionTracks(input: TrackInput): SessionTracksDTO {
  return {
    sessionId: input.sessionId,
    totalSec: input.totalSec,
    anchoredToVideo: input.anchoredToVideo,
    lanes: [
      framesLane(input),
      appsLane(input),
      webLane(input),
      ...segmentLanes(input),
      transcriptLane(input),
      captionLane(input),
      axLane(input),
      typingLane(input),
      clicksLane(input),
      scrollLane(input),
      mouseSpeedLane(input),
      mouseXyLane(input),
      ...audioLanes(input),
      markersLane(input),
    ],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/session-tracks.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `npm run typecheck && npm test && npm --prefix app run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/session-tracks.ts test/session-tracks.test.ts
git commit -m "feat(app): audio lanes and buildSessionTracks assembly

One lane per audio medium present, with uncovered stretches null rather
than zero. Amplitude is not re-normalized: rescaling to the loudest moment
would make a whisper look like a shout.

Every lane is emitted even when empty — absence is the answer to two of the
four questions the rail exists to answer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire main, IPC and preload

The only I/O in the feature. No new tests: `DeskRagService` opens a real store and cannot run in the root suite, which is exactly why every decision it makes was pushed into the pure modules above. The gate is both typechecks plus a real launch.

**Files:**
- Modify: `app/src/main/deskrag-service.ts`
- Modify: `app/src/main/ipc.ts:53`
- Modify: `app/src/preload/index.ts`

**Interfaces:**
- Consumes: `buildSessionTracks`, `TrackInput`, `AudioLaneInput` (Task 5); `peakCountFor`, `AudioBlobPeaks` (Task 2); `wavPeaks` (Task 1); `TRACK_BUCKETS`, `SessionTracksDTO`, `IPC.sessionsTracks` (Task 2).
- Produces: `DeskRagService.sessionTracks(sessionId): Promise<SessionTracksDTO | null>`, and `window.deskrag.sessions.tracks(id)` for Task 8.

- [ ] **Step 1: Extend the library import in `deskrag-service.ts`**

Add to the `from "deskrag"` import block (line 17–52):

```ts
  wavPeaks,
```

- [ ] **Step 2: Add the local imports**

After `import { OnnxHost } from "./onnx-host.js";`:

```ts
import { buildSessionTracks, type AudioLaneInput } from "./session-tracks.js";
import { peakCountFor, type AudioBlobPeaks } from "./track-buckets.js";
```

And add `SessionTracksDTO` and `TRACK_BUCKETS` to the existing `@shared/types` import. `TRACK_BUCKETS` is a value, not a type — it must not go in a `import type` block.

- [ ] **Step 3: Add the cache field and the method**

Add beside the other private fields:

```ts
  /**
   * Track rails, keyed by session id. A FINISHED session is immutable, so this
   * is correct by construction — see the guard in `sessionTracks`.
   */
  private readonly trackCache = new Map<string, SessionTracksDTO>();
```

Add the method after `sessionDetail`:

```ts
  /**
   * Every recorded signal, bucketed onto the session's time axis.
   *
   * All the arithmetic is in `session-tracks.ts`, which is pure and root-tested;
   * this method is only the reads and the cache.
   */
  async sessionTracks(sessionId: string): Promise<SessionTracksDTO | null> {
    const cached = this.trackCache.get(sessionId);
    if (cached) return cached;

    const detail = this.sessionDetail(sessionId);
    if (!detail) return null;

    // Offsets are measured from the video when there is one, so the rail and the
    // scrubber share an origin; from t_mono zero otherwise.
    const originMono = detail.video ? detail.video.tMonoStart : 0;
    const totalSec = detail.video
      ? (detail.video.tMonoEnd - detail.video.tMonoStart) / 1000
      : detail.durationMs / 1000;

    const frames = this.store.getFramesBySession(sessionId);
    const regionCounts = new Map<string, number>();
    for (const f of frames) {
      const n = this.store.getRegionsByFrame(f.id).length;
      if (n > 0) regionCounts.set(f.id, n);
    }

    const byMedia = new Map<string, AudioBlobPeaks[]>();
    for (const blob of this.store.getBlobsBySession(sessionId)) {
      if (blob.media !== "mic" && blob.media !== "desktop_audio") continue;
      let bytes: Uint8Array;
      try {
        bytes = await this.blobs.read(blob);
      } catch {
        // The row says the audio is there and the file is not. That stretch
        // stays uncovered, which is what the rail should show — one missing
        // blob must not sink the whole rail.
        continue;
      }
      const declaredSec = (blob.tMonoEnd - blob.tMonoStart) / 1000;
      const peaks = wavPeaks(bytes, peakCountFor(declaredSec, totalSec, TRACK_BUCKETS));
      if (!peaks) continue;
      const list = byMedia.get(blob.media) ?? [];
      list.push({
        startSec: (blob.tMonoStart - originMono) / 1000,
        // The MEASURED duration, so a truncated blob reads as a gap for its
        // missing tail rather than as a stretched envelope.
        durationSec: peaks.durationSec,
        peaks: peaks.peaks,
      });
      byMedia.set(blob.media, list);
    }
    const audio: AudioLaneInput[] = [...byMedia.entries()].map(([media, blobs]) => ({ media, blobs }));

    const dto = buildSessionTracks({
      sessionId,
      originMono,
      totalSec,
      buckets: TRACK_BUCKETS,
      anchoredToVideo: detail.video !== null,
      events: this.store.getEventsBySession(sessionId),
      segments: this.store.getSegmentsBySession(sessionId),
      frames,
      axSnapshots: this.store.getAxSnapshotsBySession(sessionId),
      keyframes: detail.keyframes,
      regionCounts,
      audio,
    });

    // Only a FINISHED session is immutable. Caching an open one would freeze the
    // rail at whatever the recording had reached when it was first opened.
    if (detail.endedAt !== null) this.trackCache.set(sessionId, dto);
    return dto;
  }
```

`getAxSnapshotsBySession` was added to `DualStore` in Task 1. `getAxForBoundary`
and `getAxAt` return a single row and are the wrong shape here.

- [ ] **Step 4: Drop the cache entry on delete**

In `removeSession`, after `this.lastHighlights.clear();`:

```ts
    this.trackCache.delete(sessionId);
```

- [ ] **Step 5: Add the IPC handler**

In `app/src/main/ipc.ts`, after the `sessionsReindex` line:

```ts
  ipcMain.handle(IPC.sessionsTracks, (_e, sessionId: string) => service.sessionTracks(sessionId));
```

- [ ] **Step 6: Add the preload bridge**

In `app/src/preload/index.ts`, inside `sessions`, after `reindex`:

```ts
    tracks: (sessionId: string) => ipcRenderer.invoke(IPC.sessionsTracks, sessionId),
```

- [ ] **Step 7: Build and verify both gates**

Run: `npm run build && npm run typecheck && npm test && npm --prefix app run typecheck`
Expected: PASS. The library build is required because `deskrag-service.ts` now imports `wavPeaks`, and the app resolves `deskrag` to `dist/`.

- [ ] **Step 8: Verify against the real recording**

Run: `npm run app:dev`

In the renderer devtools console:

```js
await window.deskrag.sessions.tracks((await window.deskrag.sessions.list())[0].id)
```

Expected, against the 39.7s session on disk: `totalSec` ≈ 39.7, and `lanes.length` = **15** — the fourteen fixed lanes plus a second segment lane, because that session has both an `action` and a `task` granularity. Also `audio-mic` present with non-null values across roughly the first ~40s, `frames` holding exactly 1 thumb, `seg-action` holding 8 spans and `seg-task` 1, `ax` holding 5 marks all with non-alarm tone, and `typing` carrying **no** warning (that session has a `keymap_change`).

Record anything that disagrees — a real recording falsifying an assumption is the point of this step, not a failure of it.

- [ ] **Step 9: Commit**

```bash
git add app/src/main/deskrag-service.ts app/src/main/ipc.ts app/src/preload/index.ts
git commit -m "feat(app): serve session tracks over IPC

The only I/O in the feature: reads rows and audio blobs, hands them to the
pure builder, memoizes. Only a FINISHED session is cached — caching an open
one would freeze the rail where the recording had reached.

A missing or unreadable audio blob leaves its stretch uncovered rather than
sinking the rail, and a truncated one contributes its MEASURED duration so
the missing tail reads as a gap.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Pure view logic and the four lane renderers

**Files:**
- Create: `app/src/renderer/src/screens/track-view.ts`
- Create: `app/src/renderer/src/screens/TrackLane.tsx`
- Test: `test/track-view.test.ts`

**Interfaces:**
- Consumes: the track DTOs (Task 2), `keyframeLabel` from `../api.js`.
- Produces:
  - `thumbPlacement(atSecs: readonly number[], totalSec: number, thumbFrac: number): boolean[]`
  - `readoutAt(tracks: SessionTracksDTO, sec: number): string[]`
  - `densityPath(values: readonly (number|null)[], height: number): string`
  - `<TrackLane lane={...} totalSec={...} onSeek={...} onInspect={...} />`

`track-view.ts` is `.ts`, never `.tsx`: the root tsconfig sets no `jsx`, so a root test importing a `.tsx` — even only for a type — breaks `npm run typecheck`.

- [ ] **Step 1: Write the failing tests**

Create `test/track-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SessionTracksDTO } from "../app/src/shared/types.js";
import { densityPath, readoutAt, thumbPlacement } from "../app/src/renderer/src/screens/track-view.js";

describe("thumbPlacement", () => {
  it("keeps images that clear their neighbour and degrades the rest to ticks", () => {
    // Thumbs are 10% of the rail wide. 0.0 and 0.5 clear each other; 0.52 does not.
    expect(thumbPlacement([0, 5, 5.2], 10, 0.1)).toEqual([true, true, false]);
  });

  it("is UNCHANGED by a uniform time shift — a layout that flips under translation twitches", () => {
    const a = thumbPlacement([1, 2, 5], 10, 0.1);
    const b = thumbPlacement([2, 3, 6], 10, 0.1);
    expect(a).toEqual(b);
  });

  it("always shows the first thumb", () => {
    expect(thumbPlacement([3], 10, 0.9)[0]).toBe(true);
  });
});

describe("densityPath", () => {
  it("breaks the path at a null so a coverage gap is literally a gap", () => {
    const d = densityPath([1, null, 1], 10);
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it("returns an empty path when there is nothing covered at all", () => {
    expect(densityPath([null, null], 10)).toBe("");
  });
});

describe("readoutAt", () => {
  const tracks: SessionTracksDTO = {
    sessionId: "s1",
    totalSec: 10,
    anchoredToVideo: true,
    lanes: [
      {
        id: "apps",
        title: "apps",
        shape: "span",
        spans: [{ startSec: 0, endSec: 5, label: "TextEdit", tone: "app-1" }],
        emptyReason: null,
        warning: null,
      },
      {
        id: "typing",
        title: "typing",
        shape: "density",
        density: { values: new Array(10).fill(0).map((_, i) => (i === 2 ? 1 : 0)), peak: 4, unit: "keys/s" },
        emptyReason: null,
        warning: null,
      },
      {
        id: "audio-mic",
        title: "audio (mic)",
        shape: "density",
        density: { values: new Array(10).fill(null), peak: 0, unit: "amplitude" },
        emptyReason: null,
        warning: null,
      },
    ],
  };

  it("names the span in force and the density value in real units", () => {
    expect(readoutAt(tracks, 2.5)).toEqual(["0:02", "TextEdit", "4 keys/s"]);
  });

  it("omits a lane with no coverage rather than reporting it as zero", () => {
    expect(readoutAt(tracks, 2.5).some((p) => p.includes("amplitude"))).toBe(false);
  });

  it("drops a span lane once its last span has ended", () => {
    expect(readoutAt(tracks, 7)).toEqual(["0:07", "0 keys/s"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/track-view.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Create `app/src/renderer/src/screens/track-view.ts`**

```ts
/**
 * Pure view logic for the track rail.
 *
 * `.ts`, never `.tsx`: the ROOT tsconfig sets no `jsx`, so a root test that
 * reaches into a `.tsx` — even only for a type — breaks `npm run typecheck`.
 * `run-log.ts` lives beside `RunLog.tsx` for exactly this reason.
 */

import type { SessionTracksDTO, TrackDensityDTO } from "@shared/types";

/**
 * Which keyframes get an image and which degrade to a tick.
 *
 * Walks in time order and keeps an image only where it clears the previous
 * image's right edge. The decision depends solely on the gaps between
 * neighbours, never on absolute position, so the layout is unchanged by a
 * uniform time shift — a rule that flipped under translation would make the
 * strip twitch as the axis rescales.
 *
 * @param thumbFrac thumbnail width as a fraction of the rail's width
 */
export function thumbPlacement(
  atSecs: readonly number[],
  totalSec: number,
  thumbFrac: number,
): boolean[] {
  const out: boolean[] = [];
  let lastRight = -Infinity;
  for (const sec of atSecs) {
    const left = totalSec > 0 ? sec / totalSec : 0;
    const show = left >= lastRight;
    out.push(show);
    if (show) lastRight = left + thumbFrac;
  }
  return out;
}

/**
 * An SVG path for a density lane, 0 at the baseline and `height` at full scale.
 *
 * A `null` STARTS A NEW SUBPATH rather than drawing through: an uncovered
 * stretch has to look like a hole, because "no audio was captured here" and
 * "it was silent here" are different facts.
 */
export function densityPath(values: readonly (number | null)[], height: number): string {
  if (values.length === 0) return "";
  const step = 100 / values.length; // percent of the viewBox width per bucket
  let d = "";
  let open = false;
  values.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    const x = i * step;
    const y = height - v * height;
    d += `${open ? "L" : "M"}${x.toFixed(3)},${y.toFixed(3)}`;
    open = true;
  });
  return d;
}

function timecodeShort(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function densityReadout(d: TrackDensityDTO, sec: number, totalSec: number): string | null {
  const i = totalSec > 0 ? Math.min(d.values.length - 1, Math.floor((sec / totalSec) * d.values.length)) : 0;
  const v = d.values[i];
  // No coverage is omitted entirely. Reporting it as 0 would assert silence
  // where nothing was recorded.
  if (v === null || v === undefined) return null;
  const real = v * d.peak;
  return `${real >= 10 ? Math.round(real) : Number(real.toFixed(2))} ${d.unit}`;
}

/**
 * Every lane resolved at one instant — the crosshair readout.
 *
 * One line answering "what was happening here" across all lanes is what makes
 * the rail readable; per-lane tooltips would make you hover fifteen times to
 * ask one question.
 */
export function readoutAt(tracks: SessionTracksDTO, sec: number): string[] {
  const parts: string[] = [timecodeShort(sec)];
  for (const lane of tracks.lanes) {
    if (lane.emptyReason !== null) continue;
    if (lane.shape === "span") {
      const span = lane.spans?.find((s) => sec >= s.startSec && sec < s.endSec);
      if (span) parts.push(span.label);
    } else if (lane.shape === "density" && lane.density) {
      const text = densityReadout(lane.density, sec, tracks.totalSec);
      if (text) parts.push(text);
    }
  }
  return parts;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/track-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `app/src/renderer/src/screens/TrackLane.tsx`**

```tsx
import React from "react";
import type { TrackLaneDTO } from "@shared/types";
import { keyframeLabel } from "../api.js";
import { densityPath, thumbPlacement } from "./track-view.js";

const DENSITY_H = 24;
/** Thumbnail width as a fraction of the rail, matched to `.tracks__thumb` in CSS. */
const THUMB_FRAC = 0.055;

interface Props {
  lane: TrackLaneDTO;
  totalSec: number;
  /** Null when there is no video: the axis is real but nothing can be sought. */
  onSeek: ((sec: number) => void) | null;
  onInspect: (frameId: string) => void;
}

const pct = (sec: number, totalSec: number): string =>
  `${totalSec > 0 ? Math.max(0, Math.min(100, (sec / totalSec) * 100)) : 0}%`;

/**
 * One lane of the rail. Four shapes cover fifteen lanes, so a new signal is a
 * builder in `session-tracks.ts` and never a new component here.
 */
export function TrackLane({ lane, totalSec, onSeek, onInspect }: Props): React.JSX.Element {
  return (
    <div className="tracks__lane" data-shape={lane.shape}>
      <div className="tracks__gutter">
        <span className="tracks__title">{lane.title}</span>
        {lane.warning && (
          <span className="tracks__warn" title={lane.warning}>
            !
          </span>
        )}
      </div>
      <div className="tracks__plot">
        {lane.emptyReason ? (
          <span className="tracks__empty">{lane.emptyReason}</span>
        ) : (
          <LaneBody lane={lane} totalSec={totalSec} onSeek={onSeek} onInspect={onInspect} />
        )}
      </div>
    </div>
  );
}

function LaneBody({ lane, totalSec, onSeek, onInspect }: Props): React.JSX.Element | null {
  if (lane.shape === "span") {
    return (
      <>
        {lane.spans?.map((s, i) => (
          <div
            key={i}
            className="tracks__span"
            data-tone={s.tone}
            title={s.label}
            style={{ left: pct(s.startSec, totalSec), width: pct(s.endSec - s.startSec, totalSec) }}
          >
            <span className="tracks__span-label">{s.label}</span>
          </div>
        ))}
      </>
    );
  }

  if (lane.shape === "mark") {
    return (
      <>
        {lane.marks?.map((m, i) => (
          <div
            key={i}
            className="tracks__mark"
            data-tone={m.tone}
            title={m.label}
            style={{ left: pct(m.atSec, totalSec) }}
          />
        ))}
      </>
    );
  }

  if (lane.shape === "thumb") {
    const thumbs = lane.thumbs ?? [];
    const show = thumbPlacement(
      thumbs.map((t) => t.atSec),
      totalSec,
      THUMB_FRAC,
    );
    return (
      <>
        {thumbs.map((t, i) => {
          const label = `${keyframeLabel(t.marker)} · ${t.regionCount} regions`;
          return (
            <button
              key={t.marker.frameId}
              className={show[i] ? "tracks__thumb" : "tracks__mark"}
              data-tone="accent"
              title={label}
              aria-label={label}
              style={{ left: pct(t.atSec, totalSec) }}
              onClick={() => (onSeek ? onSeek(t.atSec) : onInspect(t.marker.frameId))}
              onDoubleClick={() => onInspect(t.marker.frameId)}
            >
              {show[i] && t.marker.thumbUrl && (
                <img src={t.marker.thumbUrl} alt="" loading="lazy" draggable={false} />
              )}
            </button>
          );
        })}
      </>
    );
  }

  if (lane.shape === "density" && lane.density) {
    // preserveAspectRatio="none" so one viewBox stretches to any rail width —
    // this is what makes a fixed 1000 buckets independent of pixel width.
    return (
      <svg
        className="tracks__density"
        viewBox={`0 0 100 ${DENSITY_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={densityPath(lane.density.values, DENSITY_H)} className="tracks__trace" />
        {lane.density.values2 && (
          <path d={densityPath(lane.density.values2, DENSITY_H)} className="tracks__trace is-second" />
        )}
      </svg>
    );
  }

  return null;
}
```

- [ ] **Step 6: Run the gates**

Run: `npm run typecheck && npm test && npm --prefix app run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/renderer/src/screens/track-view.ts app/src/renderer/src/screens/TrackLane.tsx test/track-view.test.ts
git commit -m "feat(app): pure track view logic and the four lane renderers

Thumb placement depends only on gaps between neighbours, never on absolute
position, so the layout cannot flip under a uniform time shift. A null in a
density lane starts a new SVG subpath, so a coverage gap is literally a gap.
The readout omits an uncovered lane rather than reporting it as zero.

track-view.ts is .ts and not .tsx so the root suite can import it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The rail container

**Files:**
- Create: `app/src/renderer/src/screens/TrackRail.tsx`

**Interfaces:**
- Consumes: `TrackLane` (Task 7), `readoutAt` (Task 7), `api.sessions.tracks` (Task 6).
- Produces: `<TrackRail sessionId={...} player={...} totalSec={...} onInspect={...} />` for Task 9.

- [ ] **Step 1: Create `app/src/renderer/src/screens/TrackRail.tsx`**

```tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { MediaPlayerInstance } from "@vidstack/react";
import type { SessionTracksDTO } from "@shared/types";
import { api } from "../api.js";
import { TrackLane } from "./TrackLane.js";
import { readoutAt } from "./track-view.js";

interface Props {
  sessionId: string;
  /** Null for a session with no video: the axis is real, seeking is not. */
  player: React.RefObject<MediaPlayerInstance | null> | null;
  onInspect: (frameId: string) => void;
}

/**
 * Every recorded signal on one time axis, beneath the player. Replaces the
 * keyframe filmstrip, so the screen has exactly one time axis.
 *
 * The rail always spans the WHOLE session — width is scrubber width, always —
 * which is what makes alignment with the playhead structural rather than
 * computed. It scrolls vertically, because fifteen lanes do not fit above a
 * video frame in a 900x600 window and cutting lanes would sacrifice the
 * capture-audit reading to the navigation one.
 */
export function TrackRail({ sessionId, player, onInspect }: Props): React.JSX.Element | null {
  const [tracks, setTracks] = useState<SessionTracksDTO | null>(null);
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setTracks(null);
    void api.sessions.tracks(sessionId).then((t) => {
      if (live) setTracks(t);
    });
    return () => {
      live = false;
    };
  }, [sessionId]);

  // The playhead is written IMPERATIVELY. `player.subscribe` fires every
  // animation frame; routing it through state would re-render fifteen lanes at
  // 60fps. KeyframeStrip already encoded this lesson by setting state only when
  // the nearest keyframe changed.
  useEffect(() => {
    const p = player?.current;
    const total = tracks?.totalSec ?? 0;
    if (!p || total <= 0) return;
    return p.subscribe(({ currentTime }) => {
      const el = headRef.current;
      if (el) el.style.transform = `translateX(${(currentTime / total) * 100}%)`;
    });
  }, [player, tracks?.totalSec]);

  const secAt = (clientX: number): number | null => {
    const el = plotRef.current;
    const total = tracks?.totalSec ?? 0;
    if (!el || total <= 0) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return null;
    return Math.max(0, Math.min(total, ((clientX - r.left) / r.width) * total));
  };

  const seek = (sec: number): void => {
    const p = player?.current;
    if (p) p.currentTime = Math.max(0, sec);
  };

  const readout = useMemo(
    () => (tracks && hoverSec !== null ? readoutAt(tracks, hoverSec) : null),
    [tracks, hoverSec],
  );

  if (!tracks) return <div className="tracks tracks--loading">reading signals…</div>;

  if (tracks.totalSec <= 0) {
    return <div className="tracks tracks--loading">this recording has no measurable span</div>;
  }

  return (
    <div className="tracks">
      <div
        className="tracks__body"
        ref={plotRef}
        onMouseMove={(e) => setHoverSec(secAt(e.clientX))}
        onMouseLeave={() => setHoverSec(null)}
        onClick={(e) => {
          // A click on a keyframe is handled by the thumb itself and stops
          // there; anything else on the rail is a seek.
          if ((e.target as HTMLElement).closest(".tracks__thumb, .tracks__mark")) return;
          const sec = secAt(e.clientX);
          if (sec !== null && player) seek(sec);
        }}
      >
        {tracks.lanes.map((lane) => (
          <TrackLane
            key={lane.id}
            lane={lane}
            totalSec={tracks.totalSec}
            onSeek={player ? seek : null}
            onInspect={onInspect}
          />
        ))}
        {player && <div className="tracks__playhead" ref={headRef} />}
        {hoverSec !== null && (
          <div
            className="tracks__crosshair"
            style={{ left: `${(hoverSec / tracks.totalSec) * 100}%` }}
          />
        )}
      </div>
      <div className="tracks__readout mono">{readout ? readout.join(" · ") : " "}</div>
    </div>
  );
}
```

- [ ] **Step 2: Run the gates**

Run: `npm --prefix app run typecheck && npm run typecheck && npm test`
Expected: PASS. `TrackRail` is not mounted yet, so nothing renders it — that is Task 9.

- [ ] **Step 3: Commit**

```bash
git add app/src/renderer/src/screens/TrackRail.tsx
git commit -m "feat(app): the track rail container

Always spans the whole session, so alignment with the playhead is
structural rather than computed, and scrolls vertically because fifteen
lanes do not fit above a video frame.

The playhead is written imperatively from player.subscribe: it fires every
animation frame, and routing it through state would re-render every lane at
60fps.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Mount the rail, retire the filmstrip

**Files:**
- Modify: `app/src/renderer/src/screens/SessionPlayer.tsx`
- Delete: `app/src/renderer/src/screens/KeyframeStrip.tsx`
- Modify: `app/src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `TrackRail` (Task 8).
- Produces: nothing further.

- [ ] **Step 1: Swap the component in `SessionPlayer.tsx`**

Replace the import on line 18:

```tsx
import { TrackRail } from "./TrackRail.js";
```

Replace the no-video branch body (lines 216–227) with:

```tsx
  if (!detail.video) {
    return (
      <div className="player">
        <div className="player__note">
          No video for this session — it was recorded before video capture, or with the Screen
          signal off. Its signals are still on a real time axis:
        </div>
        {/* No player, so no seeking: a keyframe click opens it instead, which is
            what the filmstrip did in this case. */}
        <TrackRail sessionId={detail.id} player={null} onInspect={setOpenFrame} />
        {openFrame && <DetailView frameId={openFrame} onClose={() => setOpenFrame(null)} />}
      </div>
    );
  }
```

Replace the `<KeyframeStrip ... />` block (lines 336–341) with:

```tsx
      <TrackRail sessionId={detail.id} player={playerRef} onInspect={setOpenFrame} />
```

- [ ] **Step 2: Delete the now-unreachable strip state**

In `SessionPlayer.tsx`, delete the `activeFrameId` state (lines 147–149), the `seek` callback (lines 158–161) and the `player.subscribe` effect that tracked the nearest keyframe (lines 173–182). `TrackRail` owns the playhead now, and `nearestKeyframe` is still used by `InspectButton`, so leave that function in place.

Verify nothing else references them: `grep -n "activeFrameId\|seek\b" app/src/renderer/src/screens/SessionPlayer.tsx` should return nothing.

- [ ] **Step 3: Delete the component**

```bash
git rm app/src/renderer/src/screens/KeyframeStrip.tsx
```

- [ ] **Step 4: Replace the filmstrip CSS**

In `app/src/renderer/src/styles.css`, delete the block from `/* --- keyframe filmstrip ... */` (line 1356) through the end of `.filmstrip__item.is-active .filmstrip__tc` (line ~1404), and add in its place:

```css
/* --- timeline track rail --------------------------------------------------
   NOT `.rail` — that is the left navigation sidebar (--rail-w: 76px). This is
   one global sheet with no scoping, so a base class is a repo-wide identifier.
   --------------------------------------------------------------------------- */
.tracks {
  --tracks-inset: 12px; /* matches the docked control bar's horizontal padding */
  --tracks-gutter: 92px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0 var(--tracks-inset);
  gap: 4px;
}

.tracks--loading {
  color: var(--muted);
  font-size: 12px;
  padding: 12px var(--tracks-inset);
}

/* The rail scrolls VERTICALLY in its own bounded box: fifteen lanes do not fit
   above a video frame in a 900x600 window. min-height: 0 keeps it a bounded
   scroller inside the .player height chain rather than growing to fit. */
.tracks__body {
  position: relative;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  max-height: 34vh;
  border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-sm);
  background: var(--panel);
  cursor: crosshair;
}

.tracks__lane {
  display: grid;
  grid-template-columns: var(--tracks-gutter) minmax(0, 1fr);
  align-items: center;
  border-bottom: 1px solid var(--hairline-soft);
}

.tracks__lane:last-child {
  border-bottom: none;
}

.tracks__gutter {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 0 8px;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.tracks__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tracks__warn {
  color: var(--amber);
  font-weight: 700;
  cursor: help;
}

.tracks__plot {
  position: relative;
  min-width: 0;
  height: 18px;
}

.tracks__lane[data-shape="density"] .tracks__plot {
  height: 24px;
}

.tracks__lane[data-shape="thumb"] .tracks__plot {
  height: 34px;
}

.tracks__lane[data-shape="span"] .tracks__plot {
  height: 18px;
}

.tracks__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  padding-left: 6px;
  color: var(--muted-dim);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tracks__span {
  position: absolute;
  top: 3px;
  bottom: 3px;
  min-width: 1px;
  border-radius: 2px;
  overflow: hidden;
  background: var(--tone);
}

.tracks__span-label {
  display: block;
  padding: 0 4px;
  color: var(--ink);
  font-size: 9px;
  line-height: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tracks__mark {
  position: absolute;
  top: 3px;
  bottom: 3px;
  width: 2px;
  margin-left: -1px;
  padding: 0;
  border: none;
  border-radius: 1px;
  background: var(--tone);
}

.tracks__thumb {
  position: absolute;
  top: 2px;
  bottom: 2px;
  width: 5.5%; /* THUMB_FRAC in TrackLane.tsx — keep the two in step */
  margin-left: -2.75%;
  padding: 0;
  border: 1px solid var(--hairline);
  border-radius: 3px;
  overflow: hidden;
  background: var(--elevated);
  cursor: pointer;
}

.tracks__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.tracks__density {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.tracks__trace {
  fill: none;
  stroke: var(--accent);
  stroke-width: 0.6;
  vector-effect: non-scaling-stroke;
}

.tracks__trace.is-second {
  stroke: var(--ok);
}

.tracks__playhead,
.tracks__crosshair {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  pointer-events: none;
}

.tracks__playhead {
  left: 0;
  background: var(--rec);
  will-change: transform;
}

.tracks__crosshair {
  background: var(--text);
  opacity: 0.35;
}

.tracks__readout {
  min-height: 16px;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Tones. One app is one colour across every lane and every session, so these
   slots are assigned by a hash of the app name, never by position. */
.tracks__span[data-tone="neutral"],
.tracks__mark[data-tone="neutral"] { --tone: var(--muted-dim); }
.tracks__span[data-tone="accent"],
.tracks__mark[data-tone="accent"] { --tone: var(--accent); }
.tracks__span[data-tone="ok"],
.tracks__mark[data-tone="ok"] { --tone: var(--ok); }
.tracks__span[data-tone="warn"],
.tracks__mark[data-tone="warn"] { --tone: var(--amber); }
.tracks__span[data-tone="alarm"],
.tracks__mark[data-tone="alarm"] { --tone: var(--rec); }
.tracks__span[data-tone="app-0"] { --tone: #7c9cff; }
.tracks__span[data-tone="app-1"] { --tone: #58d5a3; }
.tracks__span[data-tone="app-2"] { --tone: #ffc24b; }
.tracks__span[data-tone="app-3"] { --tone: #d68cff; }
.tracks__span[data-tone="app-4"] { --tone: #4bd3e0; }
.tracks__span[data-tone="app-5"] { --tone: #ff9f6e; }
.tracks__span[data-tone="app-6"] { --tone: #9fd35c; }
.tracks__span[data-tone="app-7"] { --tone: #ff7fa8; }
```

- [ ] **Step 5: Check the height chain still bounds the video**

The comment at `styles.css:1205` names the bar, filmstrip and meta as what the
frame's height is computed against. Read that block and the `.player` /
`.player__media` rules around lines 1147–1213, and replace the word `filmstrip`
with `track rail` wherever it appears in a comment. If `.player` sets a
`min-height` floor sized for the old strip, it needs re-checking against the new
rail: the rail is `max-height: 34vh` and scrolls, so the floor should be the
~200px frame plus the ~100px bar plus one lane, not the whole rail.

- [ ] **Step 6: Verify no dangling references**

Run: `grep -rn "KeyframeStrip\|filmstrip" app/src/ | grep -v "\.map:"`
Expected: only the comment in `api.ts:34`, which should be updated to say "the rail tooltip" instead of "the filmstrip tooltip".

- [ ] **Step 7: Run the gates**

Run: `npm run typecheck && npm test && npm --prefix app run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A app/src/renderer/src
git commit -m "feat(app): the track rail replaces the keyframe filmstrip

One time axis, one mental model. The rail is .tracks, NOT .rail — that name
is already the left navigation sidebar, which is exactly the collision the
one-global-sheet rule exists to catch.

A session with no video still gets a rail: the t_mono span is a real
timeline, and a keyframe click opens DetailView there, as the filmstrip did.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Validate against a real recording, then document

Both of this repo's worst bugs were invisible to `npm test` and obvious within minutes of driving a real session through the pipeline. The suite proves the arithmetic; only a recording proves the rail.

**Files:**
- Modify: `CLAUDE.md`
- Possibly modify: any file the validation falsifies

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Launch against the real data directory**

Run: `npm run build && npm run app:dev`

Open the Library and select the 39.7s session.

- [ ] **Step 2: Check each claim the design made, and write down what disagrees**

| Claim | How to check |
|---|---|
| Sparse keyframes fit as thumbnails | The frames lane shows 1 image, not a tick |
| The mic envelope has usable dynamic range at 16 kHz mono | `audio (mic)` is a varying trace, not a flat line or a solid block |
| Fifteen lanes in a scrolling box is a rail, not a wall | Scroll it. Can you find the app switch in under two seconds? |
| Gaps are visibly different from silence | The stretch after the last mic blob is a hole in the trace |
| The playhead does not stutter | Play at 4x and watch it |
| Click-to-seek lands where you clicked | Click mid-rail, confirm the frame matches the readout timecode |
| The readout resolves every lane | Hover across a focus change; the app name in the readout should change with the span |

Anything that disagrees is a finding, not a failure. Fix it and note the measurement in the commit message — a number from a real recording is worth more than the estimate it replaces.

- [ ] **Step 3: Record a second session and re-check**

Record ~60 seconds that deliberately includes typing, a drag, scrolling, an app switch and a stretch of silence. Re-open it.

This is the step that exercises the lanes the existing recording cannot: it has no `scroll` events, no drags, and only one keyframe. Confirm the typing lane shows the burst, the clicks lane labels the drag as a drag, and the scroll lane is no longer empty.

- [ ] **Step 4: Document the invariants in `CLAUDE.md`**

Add to the app section, after the Library player bullets:

```markdown
- **The track rail is the Library's one time axis** (`renderer/src/screens/TrackRail.tsx`),
  and it REPLACED the keyframe filmstrip so the screen has a single mental model.
  `main/session-tracks.ts` and `main/track-buckets.ts` are the pure projection,
  tested in the ROOT suite like `plan-view.ts`; `DeskRagService` does the I/O.
  - **Fifteen lanes are FOUR shapes** (`density`, `span`, `mark`, `thumb`), so a
    new signal is a builder in `session-tracks.ts` and never a new component.
  - **`null` in a density lane means NO COVERAGE and is not zero.** Recorded
    silence is a flat zero; a stretch with no audio blob is null. Collapsing them
    makes a dead microphone indistinguishable from a quiet room, which is half
    the reason the rail exists. Only audio emits null — for event-sourced lanes
    absence genuinely is zero, because nobody typed.
  - **`warning` is not `emptyReason`.** A session with `key_down` events and no
    `keymap_change` has a full, healthy-looking typing lane whose every character
    was dropped at lift by `resolveKeys`. `emptyReason` cannot express that,
    because the lane is not empty.
  - **`wavPeaks` reports the duration it MEASURED from the bytes**, never the
    blob row's declared span, so a truncated file reads as a gap for its missing
    tail rather than as an envelope stretched over time nobody recorded.
  - **The bucket count is fixed at 1000 in main, never the renderer's width.**
    The width changes on every frame of a resize drag; an SVG path scales free.
  - **The playhead is written imperatively** from `player.subscribe`, which fires
    every animation frame — through state it would re-render fifteen lanes at
    60fps. Same lesson `KeyframeStrip` encoded before it was retired.
  - **The rail is `.tracks`, NOT `.rail`** — `.rail` is the left navigation
    sidebar (`--rail-w: 76px`). Caught by grepping before minting the class, the
    same rule that `.drawer` exists because of.
  - **A session with no video still gets a rail.** The axis comes from the
    `t_mono` span; there is no playhead and a keyframe click opens `DetailView`,
    which is what the filmstrip did in that case.
```

- [ ] **Step 5: Run the full gate one last time**

Run: `npm run typecheck && npm test && npm --prefix app run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: record the track rail's invariants, validated on real recordings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review notes

**Spec coverage.** Every lane in the spec's table maps to a builder in Tasks 3–5; `emptyReason`/`warning`, the `(number|null)[]` rule, fixed buckets, memoization-only-when-finished, the pure/ROOT-suite placements, `wavPeaks` beside `encodeWav`, DOM/SVG rendering, no zoom, vertical scroll, the shared readout, the imperative playhead, the no-video path, and the `.tracks` naming all have a step. The spec's "regions get no lane" decision is implemented as `regionCount` on `TrackThumbDTO` in Task 4.

**Signatures verified against the source.** Every library and store symbol this plan calls was checked before it was written: `encodeWav`/`WavFormat`, `BlobStore.read`, `DualStore.getEventsBySession`/`getSegmentsBySession`/`getFramesBySession`/`getRegionsByFrame`/`getBlobsBySession`, the `EventRow`/`SegmentRow`/`FrameRow`/`BlobRow`/`AxSnapshotRow` shapes (`export * from "./store/types.js"` puts all of them in the barrel), `urlPrefix`, the `BoundaryReason` union, `DisplayInfo` using `x/y/w/h` rather than `width/height`, and the exact `data` payloads each producer emits. The one gap found — no per-session AX accessor — became Task 1 Steps 5–8 rather than a caveat.

**One coupling nothing enforces.** `THUMB_FRAC` in `TrackLane.tsx` must equal the `width` in `.tracks__thumb`. They are two files, the compiler cannot connect them, and the failure mode is thumbnails that overlap slightly instead of degrading to ticks. Task 9 Step 4 flags it in a CSS comment.
