# Keyframe Capture Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp a sampled keyframe with ffmpeg's own capture timestamp instead of its wall-clock arrival time, and associate each AX walk with the frame whose pixels it actually describes.

**Architecture:** `FfmpegScreenProducer` gains a third output on the sampling branch (`mkvtimestamp_v2` on fd 4) carrying one millisecond PTS per kept frame, index-aligned with the existing grayscale and MJPEG outputs because all three sit downstream of the same decimator. `frame.tMono` becomes `video.tMonoStart + pts`. Separately, keyframe AX walks stop recording their triggering frame and are assigned to the nearest frame by content time in a new always-on represent stage.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, ffmpeg CLI, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-08-08-keyframe-capture-time-design.md`

## Global Constraints

- **ffmpeg 5.1+ is required** — `-fps_mode` was added there. `-vsync passthrough` is the older spelling and is deliberately NOT used: it prints a deprecation line on every run, and the producer routes stderr straight to `onError` and the user.
- **`npm run typecheck` is the primary gate.** Run it after every task. The app has its own gate: `npm --prefix app run typecheck`.
- **The app imports `dist/`, not `src/`.** After changing library code, `npm run build` before launching the app.
- **`grep` silently skips `src/store/store.ts`** (it contains deliberate NUL bytes). Use `grep -a` / `rg -a` for that file.
- **Never widen the `select` filter's comma escaping.** Inside a filtergraph an unescaped comma ends the filter; the graph then silently becomes a different, valid graph.
- **`-fps_mode passthrough` goes on the three SAMPLING outputs only**, never on the mp4 output, which must stay CFR at `videoFps`.
- Commit after each task. Do not push; do not open a PR.

---

### Task 1: TimestampLineSplitter

**Files:**
- Create: `src/capture/timestamp-splitter.ts`
- Test: `test/timestamp-splitter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class TimestampLineSplitter { push(chunk: Uint8Array): number[]; get pending(): number }`

- [ ] **Step 1: Write the failing test**

Create `test/timestamp-splitter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TimestampLineSplitter } from "../src/capture/timestamp-splitter.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("TimestampLineSplitter", () => {
  it("skips the mkvtimestamp_v2 header and yields whole values", () => {
    const s = new TimestampLineSplitter();
    expect(s.push(enc("# timecode format v2\n0\n1000\n2000\n"))).toEqual([0, 1000, 2000]);
  });

  it("buffers a value split across a chunk boundary", () => {
    // The whole point: a chunk boundary lands mid-number, and "10" then "00"
    // parsed independently yields 10 and 0 — two plausible, wrong timestamps.
    const s = new TimestampLineSplitter();
    expect(s.push(enc("# timecode format v2\n10"))).toEqual([]);
    expect(s.push(enc("00\n"))).toEqual([1000]);
  });

  it("holds a trailing partial line until its newline arrives", () => {
    const s = new TimestampLineSplitter();
    expect(s.push(enc("# timecode format v2\n0\n15"))).toEqual([0]);
    expect(s.pending).toBeGreaterThan(0);
    expect(s.push(enc("00\n3000\n"))).toEqual([1500, 3000]);
    expect(s.pending).toBe(0);
  });

  it("ignores blank lines and yields nothing for an empty chunk", () => {
    const s = new TimestampLineSplitter();
    expect(s.push(enc("# timecode format v2\n\n0\n\n500\n"))).toEqual([0, 500]);
    expect(s.push(enc(""))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/timestamp-splitter.test.ts`
Expected: FAIL — cannot resolve `../src/capture/timestamp-splitter.js`.

- [ ] **Step 3: Write the implementation**

Create `src/capture/timestamp-splitter.ts`:

```ts
/**
 * TimestampLineSplitter — extracts per-frame presentation timestamps from
 * ffmpeg's `mkvtimestamp_v2` output, which writes a `# timecode format v2`
 * header followed by one integer millisecond value per packet, newline
 * separated.
 *
 * BUFFER UNTIL A NEWLINE BEFORE PARSING. A real stream arrives in chunks whose
 * boundaries land mid-number, and parsing each chunk independently turns one
 * `1000` into `10` and `0` — two plausible, wrong timestamps that no assertion
 * about the value's shape can catch. It is the same rule the AX sidecar needs
 * for its >64KB stdout, one digit at a time instead of one JSON document.
 *
 * Pure and synchronous — the unit-testable counterpart to the producer's
 * process spawning, like JpegStreamSplitter and FrameChunker.
 */
export class TimestampLineSplitter {
  private buf = "";

  push(chunk: Uint8Array): number[] {
    this.buf += Buffer.from(chunk).toString("utf8");
    const lines = this.buf.split("\n");
    // Whatever follows the final newline is an incomplete line — or "" when the
    // chunk ended exactly on one. Either way it is not ready to parse.
    this.buf = lines.pop() ?? "";
    const out: number[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (t === "" || t.startsWith("#")) continue; // blank or the format header
      const n = Number(t);
      if (Number.isFinite(n)) out.push(n);
    }
    return out;
  }

  /** Bytes held back awaiting a newline (diagnostics + tests). */
  get pending(): number {
    return this.buf.length;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/timestamp-splitter.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/capture/timestamp-splitter.ts test/timestamp-splitter.test.ts
git commit -m "feat(capture): parse mkvtimestamp_v2 output into per-frame PTS"
```

---

### Task 2: Three-way sample pairing

**Files:**
- Create: `src/capture/frame-pairing.ts`
- Test: `test/frame-pairing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PairedSample { gray: Uint8Array; ptsMs: number | null; jpeg?: Uint8Array }`
  - `function drainPairs(gray: Uint8Array[], pts: number[] | null, jpeg: Uint8Array[] | null): PairedSample[]`

- [ ] **Step 1: Write the failing test**

Create `test/frame-pairing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { drainPairs } from "../src/capture/frame-pairing.js";

const g = (n: number) => Uint8Array.of(n);

describe("drainPairs", () => {
  it("emits only tuples every stream has, leaving the rest queued", () => {
    const gray = [g(1), g(2), g(3)];
    const pts = [100, 200];
    const jpeg = [g(11)];
    expect(drainPairs(gray, pts, jpeg)).toEqual([{ gray: g(1), ptsMs: 100, jpeg: g(11) }]);
    // The unmatched remainder stays queued for the next arrival on the short
    // stream — dropping it would desynchronize every later frame.
    expect(gray).toEqual([g(2), g(3)]);
    expect(pts).toEqual([200]);
    expect(jpeg).toEqual([]);
  });

  it("drains several complete tuples in one call", () => {
    const gray = [g(1), g(2)];
    const pts = [100, 200];
    const jpeg = [g(11), g(22)];
    expect(drainPairs(gray, pts, jpeg)).toEqual([
      { gray: g(1), ptsMs: 100, jpeg: g(11) },
      { gray: g(2), ptsMs: 200, jpeg: g(22) },
    ]);
    expect(gray).toEqual([]);
  });

  it("omits the jpeg member entirely when images are not stored", () => {
    const gray = [g(1)];
    const pts = [100];
    const out = drainPairs(gray, pts, null);
    expect(out).toEqual([{ gray: g(1), ptsMs: 100 }]);
    expect("jpeg" in out[0]!).toBe(false);
  });

  it("reports ptsMs null when the graph carries no timestamp output", () => {
    // A caller-supplied `ffmpegArgs` override replaces the whole arg list and
    // therefore has no pts pipe. Waiting for one would emit no frames at all.
    const gray = [g(1), g(2)];
    const jpeg = [g(11), g(22)];
    expect(drainPairs(gray, null, jpeg)).toEqual([
      { gray: g(1), ptsMs: null, jpeg: g(11) },
      { gray: g(2), ptsMs: null, jpeg: g(22) },
    ]);
  });

  it("emits nothing when any required stream is empty", () => {
    expect(drainPairs([], [100], [g(1)])).toEqual([]);
    expect(drainPairs([g(1)], [], [g(1)])).toEqual([]);
    expect(drainPairs([g(1)], [100], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/frame-pairing.test.ts`
Expected: FAIL — cannot resolve `../src/capture/frame-pairing.js`.

- [ ] **Step 3: Write the implementation**

Create `src/capture/frame-pairing.ts`:

```ts
/**
 * Pairing of the sampling branch's parallel outputs.
 *
 * ffmpeg emits the grayscale hash frames, the MJPEG keyframes and the PTS
 * stream on three separate pipes, and they are index-aligned ONLY because all
 * three sit downstream of one `mpdecimate` — frame N of each is the same frame.
 * Node still receives them independently, so a tuple is complete only once
 * every stream has delivered its N-th item.
 *
 * Extracted from the producer because the producer spawns a process and cannot
 * be unit-tested; this rule can. Same split as FrameChunker and
 * JpegStreamSplitter.
 */

export interface PairedSample {
  gray: Uint8Array;
  /**
   * ffmpeg's presentation timestamp in ms — the frame's CAPTURE time.
   *
   * `null` when the graph carries no timestamp output, which happens only under
   * a caller-supplied `ffmpegArgs` override. The caller then falls back to
   * arrival time; waiting for a stream that will never arrive would emit no
   * frames at all.
   */
  ptsMs: number | null;
  jpeg?: Uint8Array;
}

/**
 * Shift every complete tuple off the queues and return them.
 *
 * Pass `null` for a stream the graph does not produce (`pts` under an
 * `ffmpegArgs` override, `jpeg` when `storeImages` is false) — absent is not
 * the same as empty, which means "expected but not yet arrived" and must block.
 */
export function drainPairs(
  gray: Uint8Array[],
  pts: number[] | null,
  jpeg: Uint8Array[] | null,
): PairedSample[] {
  const out: PairedSample[] = [];
  while (
    gray.length > 0 &&
    (pts === null || pts.length > 0) &&
    (jpeg === null || jpeg.length > 0)
  ) {
    const sample: PairedSample = {
      gray: gray.shift()!,
      ptsMs: pts === null ? null : pts.shift()!,
    };
    if (jpeg !== null) sample.jpeg = jpeg.shift()!;
    out.push(sample);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/frame-pairing.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/capture/frame-pairing.ts test/frame-pairing.test.ts
git commit -m "feat(capture): pure three-way pairing for the sampling branch outputs"
```

---

### Task 3: SampleClock — PTS to t_mono

**Files:**
- Create: `src/capture/sample-clock.ts`
- Test: `test/sample-clock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class SampleClock { constructor(videoTMonoStart?: number); tMonoFor(ptsMs: number, nowTMono: number): number }`

- [ ] **Step 1: Write the failing test**

Create `test/sample-clock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SampleClock } from "../src/capture/sample-clock.js";

describe("SampleClock", () => {
  it("anchors to the video blob's origin so a frame lands where the video shows it", () => {
    const c = new SampleClock(1800);
    // Media time IS the pts, so (tMono - videoTMonoStart) / 1000 is the exact
    // seek offset the Library already computes.
    expect(c.tMonoFor(0, 99_999)).toBe(1800);
    expect(c.tMonoFor(20_109, 99_999)).toBe(21_909);
  });

  it("ignores arrival time entirely when an origin is known", () => {
    const c = new SampleClock(1000);
    // Same pts, wildly different arrival times, same answer — that is the whole
    // point: delivery latency stops reaching the timestamp.
    expect(c.tMonoFor(5000, 6000)).toBe(6000);
    expect(c.tMonoFor(5000, 60_000)).toBe(6000);
  });

  it("seeds the origin from the first sample when there is no video", () => {
    const c = new SampleClock();
    expect(c.tMonoFor(500, 3000)).toBe(3000); // origin = 3000 - 500 = 2500
    expect(c.tMonoFor(1500, 9999)).toBe(4000); // same origin, spacing exact
  });

  it("honours a zero origin instead of re-seeding from arrival", () => {
    // A session whose screen producer starts at t_mono 0 is legitimate, and `||`
    // rather than `??` here would silently swap it for an arrival-derived one.
    const c = new SampleClock(0);
    expect(c.tMonoFor(250, 7777)).toBe(250);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sample-clock.test.ts`
Expected: FAIL — cannot resolve `../src/capture/sample-clock.js`.

- [ ] **Step 3: Write the implementation**

Create `src/capture/sample-clock.ts`:

```ts
/**
 * SampleClock — turns ffmpeg's presentation timestamp into t_mono.
 *
 * A sampled frame's t_mono is `origin + pts`, and `origin` is the video blob's
 * `tMonoStart`. That is exact for the thing that matters: the Library maps a
 * frame onto the video with `(frame.tMono - videoBlob.tMonoStart) / 1000`, so
 * anchoring here makes a keyframe and the video frame showing it agree BY
 * CONSTRUCTION rather than by both being approximately right.
 *
 * It replaces stamping arrival time, which measured 3.05s late on a real
 * avfoundation device — ~0.8s of device start-up plus ~2.2s of capture-to-
 * delivery latency, all of it landing in the timestamp. PTS carries none of it.
 *
 * Without a video blob (no blob store, `recordVideo: false` — i.e. every test)
 * the origin is seeded from the first sample instead. Relative spacing stays
 * exact; the absolute offset then carries that one frame's delivery latency.
 * One code path that degrades, rather than two that diverge.
 */
export class SampleClock {
  private origin: number | undefined;

  constructor(videoTMonoStart?: number) {
    this.origin = videoTMonoStart;
  }

  /**
   * t_mono for a sample carrying `ptsMs`. `nowTMono` is used ONLY to seed the
   * origin on the first sample of a video-less session.
   */
  tMonoFor(ptsMs: number, nowTMono: number): number {
    // `??=`, never `||=`: an origin of 0 is a real value and must not re-seed.
    this.origin ??= nowTMono - ptsMs;
    return this.origin + ptsMs;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sample-clock.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/capture/sample-clock.ts test/sample-clock.test.ts
git commit -m "feat(capture): map ffmpeg PTS onto t_mono via the video blob origin"
```

---

### Task 4: Wire PTS through FfmpegScreenProducer

**Files:**
- Modify: `src/capture/producers/ffmpeg-screen.ts` (module docstring, `args`, new `rateFilter`, `start`, `pair`, `enqueue`, fields)
- Modify: `test/ffmpeg-screen.test.ts` (extend the `args` describe block and the real-ffmpeg mp4 test)

**Interfaces:**
- Consumes: `TimestampLineSplitter` (Task 1), `drainPairs` / `PairedSample` (Task 2), `SampleClock` (Task 3).
- Produces: no new exports. `frame.tMono` on every ingested `SampledFrame` becomes `video.tMonoStart + pts`.

- [ ] **Step 1: Write the failing tests**

In `test/ffmpeg-screen.test.ts`, add these to the existing `describe("FfmpegScreenProducer.args", ...)` block:

```ts
  it("rate-limits with select, not fps, so each frame keeps its own pts", () => {
    const p = new FfmpegScreenProducer({ fps: 1, videoFps: 10, grayW: 32, grayH: 32 });
    // @ts-expect-error — exercising the private arg builder directly.
    const args: string[] = p.args("/tmp/v.mp4");
    const fc = args[args.indexOf("-filter_complex") + 1]!;
    // vf_fps relabels the frame it picks to the slot start — a constant -0.400s
    // against the picture at fps=1 over a 10fps input.
    expect(fc).not.toContain("fps=1,");
    expect(fc).toContain("select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,1)'");
  });

  it("taps a third sampling output for the per-frame pts", () => {
    const p = new FfmpegScreenProducer({ fps: 1, videoFps: 10, grayW: 32, grayH: 32 });
    // @ts-expect-error — exercising the private arg builder directly.
    const args: string[] = p.args("/tmp/v.mp4");
    const fc = args[args.indexOf("-filter_complex") + 1]!;
    // Downstream of the SAME decimator as gray and MJPEG, which is what keeps
    // all three index-aligned.
    expect(fc).toContain("[d]split=3[g][c][t]");
    expect(args).toContain("mkvtimestamp_v2");
    expect(args).toContain("pipe:4");
  });

  it("passes frame-rate mode through on the sampling outputs only", () => {
    const p = new FfmpegScreenProducer({ fps: 1, videoFps: 10, grayW: 32, grayH: 32 });
    // @ts-expect-error — exercising the private arg builder directly.
    const args: string[] = p.args("/tmp/v.mp4");
    // select does not change the stream's frame-rate metadata, so the default
    // CFR mode duplicates frames back up to the input rate — measured, 139
    // where 14 were expected. One per sampling output; never on the mp4.
    expect(args.filter((a) => a === "-fps_mode")).toHaveLength(3);
    const mp4 = args.indexOf("/tmp/v.mp4");
    const firstMode = args.indexOf("-fps_mode");
    expect(firstMode).toBeGreaterThan(mp4);
  });

  it("still taps pts with images off and no video", () => {
    const p = new FfmpegScreenProducer({ fps: 1, storeImages: false });
    // @ts-expect-error — exercising the private arg builder directly.
    const args: string[] = p.args(null);
    expect(args).toContain("mkvtimestamp_v2");
    expect(args).toContain("pipe:4");
  });
```

And in the existing real-ffmpeg test `"records a continuous MP4 alongside the sampled keyframes"`, replace the final assertion block (currently `expect(frames.some((f) => f.blobId)).toBe(true);`) with:

```ts
    // The keyframe pipeline is untouched by the new branch.
    const frames = store.getFramesBySession(sessionId);
    expect(frames.some((f) => f.blobId)).toBe(true);

    // Frames are stamped from ffmpeg's pts, anchored to the video blob — NOT
    // from arrival. The first sample has pts ~0, so it lands on the video's
    // own origin. Under arrival stamping it landed a whole delivery latency
    // later (measured 3.05s on a real device, a few hundred ms on lavfi).
    const first = frames.reduce((a, b) => (a.tMono <= b.tMono ? a : b));
    expect(first.tMono - video!.tMonoStart).toBeLessThan(150);
    // And every frame sits inside the video's own span.
    for (const f of frames) {
      expect(f.tMono).toBeGreaterThanOrEqual(video!.tMonoStart);
      expect(f.tMono).toBeLessThanOrEqual(video!.tMonoEnd);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ffmpeg-screen.test.ts`
Expected: FAIL — the `args` tests fail on `fps=1,` still being present and `pipe:4` missing; the mp4 test fails its `< 150` assertion because frames are still arrival-stamped.

- [ ] **Step 3: Add the rate filter and rebuild the arg graph**

In `src/capture/producers/ffmpeg-screen.ts`, add imports at the top:

```ts
import { TimestampLineSplitter } from "../timestamp-splitter.js";
import { drainPairs, type PairedSample } from "../frame-pairing.js";
import { SampleClock } from "../sample-clock.js";
```

Add this method next to `decimateFilter()`:

```ts
  /**
   * The sampling rate limit.
   *
   * `select` rather than `fps` because the frame's PTS is now the frame's
   * TIMESTAMP. `vf_fps` picks the last frame before each slot boundary and
   * RELABELS it to the slot start — measured as a constant -0.400s against the
   * picture at fps=1 over a 10fps input. `select` keeps each frame's own pts
   * (measured 0.000s) and picks the FIRST frame past the interval, which is
   * also what KeyframeBudget does one layer down.
   *
   * The comma inside the expression MUST stay escaped: an unescaped one ends
   * the filter, and the graph silently becomes a different, valid graph.
   *
   * It REQUIRES `-fps_mode passthrough` on every output fed from it — select
   * does not change the stream's frame-rate metadata, so the default CFR mode
   * duplicates frames back up to the input rate. Measured: 139 frames where 14
   * were expected.
   */
  private rateFilter(fps: number): string {
    return `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${1 / fps})'`;
  }
```

Now replace the body of `args()` after the `head` array. Replace this block:

```ts
    if (!this.storeImages && !videoPath) {
      return [
        ...head,
        "-vf", `${sample},${gray}`,
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
      ];
    }
```

with:

```ts
    // Even the leanest configuration goes through filter_complex now: `-vf`
    // feeds ONE output, and the pts tap is a second one.
    if (!this.storeImages && !videoPath) {
      return [
        ...head,
        "-filter_complex",
        `[0:v]${sample}[d];[d]split=2[g][t];[g]${gray}[gg];[t]null[tt]`,
        "-map", "[gg]", ...PASSTHROUGH, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
        "-map", "[tt]", ...PASSTHROUGH, "-f", "mkvtimestamp_v2", "pipe:4",
      ];
    }
```

Change the `sample` const to use the new filter:

```ts
    const sample = `${this.rateFilter(fps)},scale=${maxW}:-2,${this.decimateFilter()}`;
```

Add this module-level constant just above the `FfmpegScreenProducer` class:

```ts
/** See `rateFilter` — mandatory on every output fed from `select`. */
const PASSTHROUGH = ["-fps_mode", "passthrough"] as const;
```

Replace the split/output section (the `if (this.storeImages) { chains.push(...) }` block and everything after it up to `return out;`) with:

```ts
    if (this.storeImages) {
      chains.push(`[d]split=3[g][c][t]`, `[g]${gray}[gg]`, `[c]null[cc]`, `[t]null[tt]`);
    } else {
      chains.push(`[d]split=2[g][t]`, `[g]${gray}[gg]`, `[t]null[tt]`);
    }

    const out: string[] = [...head, "-filter_complex", chains.join(";")];
    // Fragmented MP4: playable even if ffmpeg is killed mid-recording, at the
    // cost of fragment-granular (rather than indexed) seeking. It keeps CFR at
    // videoFps and must NOT get -fps_mode passthrough.
    if (videoPath) {
      out.push(
        "-map", "[vv]",
        "-c:v", "libx264", "-preset", preset, "-crf", String(crf),
        "-pix_fmt", "yuv420p", "-g", String(this.videoFps * 2),
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "-y", videoPath,
      );
    }
    out.push("-map", "[gg]", ...PASSTHROUGH, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1");
    if (this.storeImages) {
      out.push(
        "-map", "[cc]", ...PASSTHROUGH,
        "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", String(q), "pipe:3",
      );
    }
    out.push("-map", "[tt]", ...PASSTHROUGH, "-f", "mkvtimestamp_v2", "pipe:4");
    return out;
```

- [ ] **Step 4: Wire the pts pipe, the pairing and the stamp**

Add these fields to the class, beside `jpegQueue`:

```ts
  private readonly ts = new TimestampLineSplitter();
  private readonly ptsQueue: number[] = [];
  private sampleClock: SampleClock | undefined;
  /**
   * Whether the graph carries a pts tap. A caller-supplied `ffmpegArgs`
   * replaces the WHOLE arg list, so it has no fd 4 — waiting for one would
   * pair nothing and record no frames at all.
   */
  private readonly usePts: boolean;
```

In the constructor, after `this.videoFps = ...`:

```ts
    this.usePts = opts.ffmpegArgs === undefined;
```

In `start()`, replace the `stdio` const and the `spawn` call's listener block. The `stdio` becomes:

```ts
    // fd 3 is the MJPEG stream (only when storing images); fd 4 is always the
    // pts tap, so its number does not move when images are off.
    const stdio = [
      "ignore",
      "pipe",
      "pipe",
      this.storeImages ? "pipe" : "ignore",
      "pipe",
    ] as const;
```

Immediately after `this.proc = proc;`, add:

```ts
    // The video origin is known only after reserveBlob above.
    this.sampleClock = new SampleClock(this.video?.tMonoStart);
```

Add the fd 4 listener beside the existing stdout/fd3 ones:

```ts
    if (this.usePts) {
      const times = proc.stdio[4] as Readable | undefined;
      times?.on("data", (chunk: Buffer) => {
        for (const ms of this.ts.push(chunk)) {
          this.ptsQueue.push(ms);
          this.pair();
        }
      });
    }
```

Replace `pair()` and `enqueue()` entirely:

```ts
  /** Emit every sample all of the graph's outputs have delivered. */
  private pair(): void {
    for (const sample of drainPairs(
      this.grayQueue,
      this.usePts ? this.ptsQueue : null,
      this.storeImages ? this.jpegQueue : null,
    )) {
      this.enqueue(sample);
    }
  }

  private enqueue(sample: PairedSample): void {
    const ctx = this.ctx!;
    // STAMP HERE, NOT INSIDE THE CHAIN. `tMono` is ffmpeg's capture time, which
    // carries none of the delivery latency that arrival time did — measured
    // 3.05s of it on a real avfoundation device. Reading any clock inside the
    // continuation below would also add however long every earlier frame's blob
    // write and insert took, which is unbounded and never recovers.
    const tMono =
      sample.ptsMs === null
        ? ctx.clock.now()
        : this.sampleClock!.tMonoFor(sample.ptsMs, ctx.clock.now());
    this.ingestChain = this.ingestChain.then(async () => {
      await ctx.ingestFrame({
        tMono,
        width: this.width,
        height: this.height,
        gray: sample.gray,
        grayW: this.grayW,
        grayH: this.grayH,
        ...(sample.jpeg ? { image: { bytes: sample.jpeg, codec: "jpeg" } } : {}),
      });
    });
  }
```

Update the module docstring's opening list to mention three outputs and fd 4.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/ffmpeg-screen.test.ts`
Expected: PASS. If ffmpeg is absent the two real-ffmpeg tests skip; the `args` tests still run.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS. `test/capture-frames.test.ts` and `test/capture-session.test.ts` exercise ingest through fakes and must be unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/capture/producers/ffmpeg-screen.ts test/ffmpeg-screen.test.ts
git commit -m "fix(capture): stamp sampled frames from ffmpeg PTS, not arrival time"
```

---

### Task 5: Store support for re-pointing an AX walk

**Files:**
- Modify: `src/store/types.ts` (the `Store` interface, near `getFrameAx` at ~line 449)
- Modify: `src/store/store.ts` (prepared statements at ~line 167, method near `getAxSnapshotsBySession` at ~line 762)
- Test: `test/frame-ax.test.ts` (created here, extended in Task 6)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Store.getAxSnapshotsBySession(sessionId: string): AxSnapshotRow[]` (already on `DualStore`; this puts it on the interface)
  - `Store.setAxSnapshotFrame(snapshotId: string, frameId: string | null): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `test/frame-ax.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";

describe("setAxSnapshotFrame", () => {
  let dir: string;
  let store: DualStore;
  let sessionId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "deskrag-frame-ax-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  });

  afterEach(async () => {
    store.close(); // synchronous — DualStore.close() returns void
    await rm(dir, { recursive: true, force: true });
  });

  it("re-points a stored walk at another frame", async () => {
    const frameId = ulid();
    await store.putFrames([
      {
        id: frameId,
        sessionId,
        tMono: 1000,
        width: 100,
        height: 100,
        phash: 0n,
        frameOffset: 0,
        segmentIds: [],
      },
    ]);
    const snapId = ulid();
    await store.putAxSnapshot({
      id: snapId,
      sessionId,
      tMono: 3200,
      frameId: null,
      reason: "keyframe",
      walkMs: 12,
      // UIElement is flat x/y/w/h — there is no `bbox` member.
      elements: [{ role: "Button", label: "Save", x: 0, y: 0, w: 10, h: 10 }],
    });

    expect(store.getFrameAx(frameId)).toEqual([]);
    await store.setAxSnapshotFrame(snapId, frameId);
    expect(store.getFrameAx(frameId)).toHaveLength(1);
    expect(store.getAxSnapshotsBySession(sessionId)[0]!.frameId).toBe(frameId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/frame-ax.test.ts`
Expected: FAIL — `store.setAxSnapshotFrame is not a function`.

- [ ] **Step 3: Add the statement and method**

In `src/store/store.ts`, add to the prepared statements object beside `selectAxByFrame`:

```ts
      updateAxSnapshotFrame: db.prepare("UPDATE ax_snapshot SET frame_id = ? WHERE id = ?"),
```

Add this method immediately after `getAxSnapshotsBySession`:

```ts
  /**
   * Point a stored walk at the frame it describes.
   *
   * Capture cannot know that frame: a walk starts when a frame ARRIVES, and the
   * frame arrives a whole capture latency after the pixels it shows (measured
   * ~2.2s), so the triggering frame is the wrong one by construction. See
   * `associateFrameAx`, which is the only caller.
   */
  async setAxSnapshotFrame(snapshotId: string, frameId: string | null): Promise<void> {
    await this.mutex.run(async () => {
      this.stmts.updateAxSnapshotFrame.run(frameId, snapshotId);
    });
  }
```

In `src/store/types.ts`, add to the `Store` interface immediately after the `getFrameAx` declaration:

```ts
  /** Every AX snapshot for a session, oldest first — including empty ones. */
  getAxSnapshotsBySession(sessionId: string): AxSnapshotRow[];
  /** Point a stored walk at the frame it describes (see `associateFrameAx`). */
  setAxSnapshotFrame(snapshotId: string, frameId: string | null): Promise<void>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/frame-ax.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

`DualStore` is the only `Store` implementation, so the interface additions compile with no other changes.

```bash
npm run typecheck
git add src/store/store.ts src/store/types.ts test/frame-ax.test.ts
git commit -m "feat(store): allow an AX walk to be re-pointed at another frame"
```

---

### Task 6: The associateFrameAx stage

**Files:**
- Create: `src/represent/frame-ax.ts`
- Modify: `src/index.ts` (beside the `frame-segments` export at ~line 167)
- Test: `test/frame-ax.test.ts` (extend)

**Interfaces:**
- Consumes: `Store.getFramesBySession`, `Store.getAxSnapshotsBySession`, `Store.setAxSnapshotFrame` (Task 5).
- Produces:
  - `function nearestFrameId(walkTMono: number, frames: readonly { id: string; tMono: number }[]): string | undefined`
  - `function associateFrameAx(store: Store, sessionId: string): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Append to `test/frame-ax.test.ts`:

```ts
import { associateFrameAx, nearestFrameId } from "../src/represent/frame-ax.js";

describe("nearestFrameId", () => {
  const frames = [
    { id: "a", tMono: 1000 },
    { id: "b", tMono: 2000 },
    { id: "c", tMono: 3000 },
  ];

  it("picks the frame closest in content time, in either direction", () => {
    expect(nearestFrameId(2900, frames)).toBe("c");
    expect(nearestFrameId(1400, frames)).toBe("a");
  });

  it("keeps the earlier frame on an exact tie, so the result is deterministic", () => {
    expect(nearestFrameId(1500, frames)).toBe("a");
  });

  it("returns undefined when there are no frames", () => {
    expect(nearestFrameId(1000, [])).toBeUndefined();
  });
});

describe("associateFrameAx", () => {
  let dir2: string;
  let store2: DualStore;
  let session2: string;

  beforeEach(async () => {
    dir2 = await mkdtemp(join(tmpdir(), "deskrag-assoc-ax-"));
    store2 = await DualStore.open(join(dir2, "meta.sqlite"), join(dir2, "lance"));
    session2 = ulid();
    await store2.putSession({ id: session2, startedAt: Date.now(), epochMono: 0 });
  });

  afterEach(async () => {
    store2.close();
    await rm(dir2, { recursive: true, force: true });
  });

  const putFrame = async (id: string, tMono: number, offset: number) =>
    store2.putFrames([
      { id, sessionId: session2, tMono, width: 10, height: 10, phash: 0n, frameOffset: offset, segmentIds: [] },
    ]);

  const putWalk = async (id: string, tMono: number, label: string) =>
    store2.putAxSnapshot({
      id, sessionId: session2, tMono, frameId: null, reason: "keyframe", walkMs: 5,
      elements: [{ role: "Button", label, x: 0, y: 0, w: 10, h: 10 }],
    });

  it("assigns each walk to the frame it describes, not the one that triggered it", async () => {
    // The walk at 3200 was triggered by the frame that ARRIVED then — but its
    // tree shows the screen at 3200, which is frame f3's picture.
    await putFrame("f1", 1000, 0);
    await putFrame("f3", 3000, 1);
    await putWalk("w1", 3200, "shown-at-3200");

    expect(await associateFrameAx(store2, session2)).toBe(1);
    expect(store2.getFrameAx("f3")[0]!.label).toBe("shown-at-3200");
    expect(store2.getFrameAx("f1")).toEqual([]);
  });

  it("leaves a frame with no nearby walk unlinked rather than borrowing one", async () => {
    await putFrame("f1", 1000, 0);
    await putFrame("f2", 2000, 1);
    await putWalk("w1", 2100, "near-f2");
    await associateFrameAx(store2, session2);
    // f1 is the first keyframe of the session: no walk had happened yet at its
    // content time, so region proposal falls back to hotspots and grid tiling.
    expect(store2.getFrameAx("f1")).toEqual([]);
    expect(store2.getFrameAx("f2")).toHaveLength(1);
  });

  it("is idempotent across re-indexing", async () => {
    await putFrame("f1", 1000, 0);
    await putWalk("w1", 1100, "once");
    expect(await associateFrameAx(store2, session2)).toBe(1);
    expect(await associateFrameAx(store2, session2)).toBe(1);
    expect(store2.getFrameAx("f1")).toHaveLength(1);
  });

  it("ignores boundary walks, which are keyed by t_mono and have no frame", async () => {
    await putFrame("f1", 1000, 0);
    // AxSnapshotReason is "keyframe" | "focus_change" | "bookmark" |
    // "dwell_resume"; the latter three are the boundary-triggered walks, read
    // through getAxForBoundary and never through a frame.
    await store2.putAxSnapshot({
      id: "b1", sessionId: session2, tMono: 1100, frameId: null, reason: "focus_change",
      walkMs: 5, elements: [{ role: "Window", label: "boundary", x: 0, y: 0, w: 1, h: 1 }],
    });
    expect(await associateFrameAx(store2, session2)).toBe(0);
    expect(store2.getFrameAx("f1")).toEqual([]);
  });

  it("returns 0 for a session with no frames", async () => {
    await putWalk("w1", 500, "orphan");
    expect(await associateFrameAx(store2, session2)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/frame-ax.test.ts`
Expected: FAIL — cannot resolve `../src/represent/frame-ax.js`.

- [ ] **Step 3: Write the implementation**

Create `src/represent/frame-ax.ts`:

```ts
/**
 * Frame↔AX association — pairing each accessibility walk with the frame whose
 * pixels it actually describes.
 *
 * Capture cannot do this. `CaptureSession` starts a walk when a frame ARRIVES,
 * and a frame arrives a whole capture latency after the pixels it shows —
 * measured ~2.2s on a real avfoundation device — so the walk reads a screen
 * that is roughly two keyframes NEWER than the frame that triggered it.
 * Recording the trigger as the walk's frame is wrong by construction, and it
 * fed region proposal a tree from one screen and a picture from another.
 *
 * This is the same class of bug as `AxCapturer`'s `boundaryTMono`, which exists
 * because a settle-delayed walk post-dates its boundary and a latest-at-or-
 * before lookup therefore returned the previous state — measured at 54% of
 * nodes incoherent. Same shape, one layer down.
 *
 * The join is only meaningful because `frame.tMono` is now ffmpeg's capture
 * time rather than its arrival time; both sides are finally on the same clock.
 * Pure SQLite over what capture wrote — no model, no provider — so it runs
 * unconditionally, like `associateFrames`.
 */

import type { Store } from "../store/types.js";

/**
 * The frame a walk taken at `walkTMono` describes: the one nearest in content
 * time. An exact tie keeps the EARLIER frame, so a re-run cannot flip the
 * layout on floating-point noise.
 */
export function nearestFrameId(
  walkTMono: number,
  frames: readonly { id: string; tMono: number }[],
): string | undefined {
  let best: { id: string; d: number } | undefined;
  for (const f of frames) {
    const d = Math.abs(f.tMono - walkTMono);
    if (best === undefined || d < best.d) best = { id: f.id, d };
  }
  return best?.id;
}

/**
 * Point every keyframe walk in a session at the frame it describes. Returns the
 * number of walks linked. Idempotent, so re-indexing is safe.
 *
 * The direction is WALK → FRAME, never frame → walk. Each walk goes to the
 * frame it best describes, so two walks cannot contend for one frame and "no
 * walk near this frame" stays a real, visible outcome: those frames keep a null
 * `frame_id`, `getFrameAx` returns [], and region proposal falls back to
 * interaction hotspots and grid tiling. Expect the first keyframes of a session
 * to land there — no walk has happened yet at their content time.
 *
 * Boundary walks are untouched: they are keyed by `t_mono` and read through
 * `getAxForBoundary`, which is a different question with a different answer.
 */
export async function associateFrameAx(store: Store, sessionId: string): Promise<number> {
  const frames = store.getFramesBySession(sessionId);
  if (frames.length === 0) return 0;
  const walks = store
    .getAxSnapshotsBySession(sessionId)
    .filter((s) => s.reason === "keyframe");

  let linked = 0;
  for (const walk of walks) {
    const frameId = nearestFrameId(walk.tMono, frames);
    if (frameId === undefined) continue;
    linked++;
    if (walk.frameId === frameId) continue; // already pointed there
    await store.setAxSnapshotFrame(walk.id, frameId);
  }
  return linked;
}
```

In `src/index.ts`, add beside the existing `frame-segments` export:

```ts
export { associateFrameAx, nearestFrameId } from "./represent/frame-ax.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/frame-ax.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/represent/frame-ax.ts src/index.ts test/frame-ax.test.ts
git commit -m "feat(represent): associate AX walks with the frame they describe"
```

---

### Task 7: Stop recording the triggering frame; run the stage

**Files:**
- Modify: `src/capture/session.ts:140-142`
- Modify: `app/src/main/deskrag-service.ts` (import at ~line 31, stage list at ~line 562, re-index path at ~line 1139)

**Interfaces:**
- Consumes: `associateFrameAx` (Task 6).
- Produces: nothing new.

- [ ] **Step 1: Stop passing the triggering frame at capture**

In `src/capture/session.ts`, replace the `ingestFrame` body:

```ts
      ingestFrame: async (frame) => {
        const res = await this.ingestor!.ingest(frame);
        // NO frameId. The walk starts now, but `frame` shows the screen a whole
        // capture latency ago (~2.2s measured), so this is not the frame the
        // walk describes. `associateFrameAx` assigns it at represent time, when
        // the neighbouring frames' capture times are known.
        if (res.kept && res.frameId && this.axCapturer) {
          await this.axCapturer.capture("keyframe");
        }
        return res;
      },
```

- [ ] **Step 2: Run the capture suite to see what depended on it**

Run: `npx vitest run test/capture.ax-cadence.test.ts test/capture-session.test.ts test/capture-frames.test.ts`
Expected: any assertion that a keyframe snapshot carries a `frameId` at capture time now fails. Update those assertions to expect `null`, adding a comment pointing at `associateFrameAx`. Do NOT restore the argument.

- [ ] **Step 3: Add the stage to the app**

In `app/src/main/deskrag-service.ts`, add to the `deskrag` import block beside `associateFrames`:

```ts
  associateFrameAx,
```

Insert this stage into the `stages` array immediately after the `Linking frames` entry:

```ts
      // AX walks post-date the pixels they describe by the capture latency, so
      // the frame that TRIGGERED a walk is not the frame it shows. Capture
      // writes no frame_id and this assigns one by content time. It MUST run
      // before Regions, which reads it through StoredAxProvider — and after
      // Segmenting, only because it shares that stage's frame list.
      { name: "Linking AX", run: () => associateFrameAx(this.store, sessionId) },
```

And in the re-index loop, immediately after the existing `await associateFrames(this.store, id);`:

```ts
        await associateFrameAx(this.store, id);
```

- [ ] **Step 4: Build the library and typecheck both packages**

Run: `npm run build && npm run typecheck && npm --prefix app run typecheck`
Expected: PASS. The app imports `dist/`, so the build must come first or `associateFrameAx` will not resolve.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/capture/session.ts app/src/main/deskrag-service.ts test/
git commit -m "feat(app): assign keyframe AX by content time instead of by trigger"
```

---

### Task 8: The measurement probe

**Files:**
- Create: `scripts/capture-latency-probe.mjs`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: nothing (standalone, spawns ffmpeg directly).
- Produces: `npm run probe:latency`

- [ ] **Step 1: Write the probe**

Create `scripts/capture-latency-probe.mjs`. It has two modes and is READ-ONLY — it writes the encoded video to `/dev/null`, never stores or inspects pixel content beyond a synthetic barcode, and touches no store.

`--synthetic` (default): drives the real arg graph from a lavfi source that burns the input frame number into the picture as an 8-stripe binary barcode, so the 32x32 grayscale branch alone recovers which input frame a sample is — no OCR, no JPEG decode. With `-re`, input frame N is produced at `t0 + N/videoFps`, so the picture's true time is known and the report is `pts - content` and `arrival - content`.

`--device`: the same graph against the real avfoundation screen, reporting `arrival - pts`. Decimation is disabled here (`--no-decimate` is implied) because a static desktop keeps ~1 frame per MINUTE via the `max=60` heartbeat and starves the measurement; delivery latency, not the keep decision, is what this mode measures.

```js
/**
 * Measures how far a sampled keyframe's TIMESTAMP sits from the picture it
 * shows. Read-only: the encoded video goes to /dev/null, the MJPEG pipe is
 * drained and discarded, and no store is touched.
 *
 * --synthetic (default) drives the real arg graph from a lavfi source that
 * burns the input frame number into the picture as an 8-stripe binary barcode,
 * so the 32x32 grayscale branch alone recovers WHICH input frame a sample is —
 * no OCR, no JPEG decode. With -re, input frame N is produced at t0 + N/rate,
 * so the picture's true time is known and both `pts - content` and
 * `arrival - content` are exact.
 *
 * --device runs the same graph against the real screen and reports
 * `arrival - pts`: the latency PTS stamping removes, which needs no ground
 * truth about content. PRIVACY: no pixel data is stored, decoded, printed or
 * kept in this mode — the grayscale pipe is COUNTED ONLY.
 *
 * Usage: node scripts/capture-latency-probe.mjs [--device] [--seconds N] [--fps N]
 */
import { spawn, execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : d);

const DEVICE = flag("--device");
const SECONDS = Number(val("--seconds", 25));
const fps = Number(val("--fps", 1));
const GRAY_W = 32, GRAY_H = 32, GRAY_BYTES = GRAY_W * GRAY_H, BITS = 8;
const maxW = 1280, q = 5, videoFps = 10, videoMaxW = 1920;

// Mirrors FfmpegScreenProducer.rateFilter — the escaped comma is load-bearing.
const rate = `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${1 / fps})'`;
// A static desktop keeps ~1 frame per MINUTE via the max=60 heartbeat, which
// starves the device measurement. Delivery latency, not the keep decision, is
// what is under test there.
const decimate = DEVICE ? "null" : `mpdecimate=hi=${64 * 64}:lo=${64 * 20}:frac=0.003:max=60`;
const sample = `${rate},scale=${maxW}:-2,${decimate}`;
const gray = `scale=${GRAY_W}:${GRAY_H},format=gray`;
const PT = ["-fps_mode", "passthrough"];

let input, inputArgs;
if (DEVICE) {
  // The index is DISCOVERED: cameras come first in this table, so a hard-coded
  // "1" is a camera on many Macs.
  let table = "";
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { table = String(e.stderr ?? ""); }
  const m = table.match(/\[(\d+)\]\s+Capture screen \d+/);
  if (!m) { console.error("no screen device found — grant Screen Recording"); process.exit(1); }
  input = m[1];
  inputArgs = ["-f", "avfoundation", "-framerate", String(videoFps), "-t", String(SECONDS), "-i", input];
  console.log(`using avfoundation input [${input}] (Capture screen)`);
} else {
  const barcode =
    `geq=lum='255*bitand(floor(N/pow(2\\,floor(X/(W/${BITS}))))\\,1)':cb=128:cr=128`;
  // -t is an INPUT option: as an output option it binds only to the NEXT
  // output (the mp4), leaving both pipes reading an infinite source.
  inputArgs = ["-re", "-f", "lavfi", "-t", String(SECONDS), "-i",
    `color=c=black:s=320x180:r=${videoFps},${barcode}`];
}

const chains = [
  // Generated small and scaled UP, so every stage does real Retina-sized work
  // without paying to SYNTHESIZE a 2560x1440 source, which cannot be done in
  // real time and silently invalidates the measurement.
  DEVICE ? `[0:v]split=2[v][s]` : `[0:v]scale=2560:1440:flags=neighbor,split=2[v][s]`,
  `[v]scale='min(${videoMaxW},iw)':-2[vv]`,
  `[s]${sample}[d]`,
  `[d]split=3[g][c][t]`,
  `[g]${gray}[gg]`, `[c]null[cc]`, `[t]null[tt]`,
];

const args = [
  "-hide_banner", "-loglevel", "warning", ...inputArgs,
  "-filter_complex", chains.join(";"),
  "-map", "[vv]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
  "-pix_fmt", "yuv420p", "-g", String(videoFps * 2),
  "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-y", "/dev/null",
  "-map", "[gg]", ...PT, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  "-map", "[cc]", ...PT, "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", String(q), "pipe:3",
  "-map", "[tt]", ...PT, "-f", "mkvtimestamp_v2", "pipe:4",
];

/** Recover the burned-in input frame number from one 32x32 gray frame. */
function decodeN(g) {
  const stripe = GRAY_W / BITS;
  const y = Math.floor(GRAY_H / 2);
  let n = 0;
  for (let b = 0; b < BITS; b++) {
    if (g[y * GRAY_W + Math.floor(b * stripe + stripe / 2)] > 128) n |= 1 << b;
  }
  return n;
}

const t0 = Date.now();
const el = () => (Date.now() - t0) / 1000;
const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });

let buf = Buffer.alloc(0), counted = 0;
const rows = [];
proc.stdout.on("data", (c) => {
  const at = el();
  buf = Buffer.concat([buf, c]);
  while (buf.length >= GRAY_BYTES) {
    const g = buf.subarray(0, GRAY_BYTES);
    buf = buf.subarray(GRAY_BYTES);
    // In --device mode the pixels are COUNTED, never inspected.
    rows.push({ at, n: DEVICE ? counted++ : decodeN(g) });
  }
});
proc.stdio[3].resume(); // drain and discard the JPEGs, or ffmpeg blocks

const ptsMs = [];
let tsBuf = "";
proc.stdio[4].on("data", (c) => {
  tsBuf += c.toString();
  const lines = tsBuf.split("\n");
  tsBuf = lines.pop() ?? "";
  for (const l of lines) if (/^\d/.test(l.trim())) ptsMs.push(Number(l.trim()));
});
proc.stderr.on("data", (d) => process.stderr.write(`[ffmpeg] ${d}`));

proc.on("exit", (code) => {
  const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  console.log(`\n=== ${DEVICE ? "real screen" : "synthetic barcode"}, fps=${fps} (exit ${code}) ===`);
  if (DEVICE) {
    console.log(" arrival     ptsSec   arrival-pts");
    const gaps = [];
    rows.forEach((r, i) => {
      const p = ptsMs[i];
      if (p == null) return;
      gaps.push(r.at - p / 1000);
      console.log(r.at.toFixed(3).padStart(8), (p / 1000).toFixed(3).padStart(10),
        (r.at - p / 1000).toFixed(3).padStart(13));
    });
    console.log(`\nmedian arrival-pts: ${med(gaps)?.toFixed(3)}s ` +
      `<- the latency PTS stamping removes`);
    return;
  }
  console.log(" arrival  frameN  contentSec  arrival-content   ptsSec  pts-content");
  let wraps = 0, prev = -1;
  const arr = [], pe = [];
  rows.forEach((r, i) => {
    if (r.n < prev) wraps++;
    prev = r.n;
    const content = (r.n + wraps * 256) / videoFps;
    const pts = ptsMs[i] != null ? ptsMs[i] / 1000 : null;
    arr.push(r.at - content);
    if (pts != null) pe.push(pts - content);
    console.log(r.at.toFixed(3).padStart(8), String(r.n).padStart(7),
      content.toFixed(3).padStart(11), (r.at - content).toFixed(3).padStart(16),
      (pts?.toFixed(3) ?? "-").padStart(9), (pts == null ? "-" : (pts - content).toFixed(3)).padStart(12));
  });
  console.log(`\narrival-content median ${med(arr.slice(Math.floor(arr.length / 2)))?.toFixed(3)}s ` +
    `(what arrival stamping cost)`);
  console.log(`pts-content    median ${med(pe)?.toFixed(3)}s (expect 0.000 with select)`);
});
```

Add to `package.json` scripts:

```json
    "probe:latency": "node scripts/capture-latency-probe.mjs",
```

- [ ] **Step 2: Verify the synthetic mode reproduces the spec's numbers**

Run: `npm run probe:latency -- --seconds 14` (synthetic is the default; `--device` selects the other mode)

Expected: `pts-content median 0.000s`, and an `arrival-content` median of roughly 0.6–1.0s — the cost of the old stamping, on the same run. If `pts-content` reports −0.400s the probe is still building a `fps=` filter rather than `select`.

- [ ] **Step 3: Verify the device mode runs**

Run: `npm run probe:latency -- --device --seconds 20`
Expected: a per-frame `arrival - pts` table. On this machine it measured ~3.05s. The number is the latency PTS stamping removes; it is machine- and load-dependent and is not asserted anywhere.

- [ ] **Step 4: Commit**

```bash
git add scripts/capture-latency-probe.mjs package.json
git commit -m "chore: read-only probe for capture delivery latency"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/setup.md` (ffmpeg requirement)
- Modify: `CLAUDE.md` (the `FfmpegScreenProducer` paragraph, the AX paragraph, and the open note at the end of the app section)

**Interfaces:** none.

- [ ] **Step 1: State the ffmpeg version floor**

In `docs/setup.md`, wherever ffmpeg is listed as a prerequisite, add:

> **ffmpeg 5.1 or newer.** The screen producer rate-limits sampling with
> `select` and needs `-fps_mode passthrough` on its sampling outputs; `-fps_mode`
> was added in 5.1. An older ffmpeg rejects the option and exits, so recording
> fails loudly rather than producing mistimed frames.

- [ ] **Step 2: Replace the arrival-stamping claim in CLAUDE.md**

The `FfmpegScreenProducer` paragraph currently says decimation is safe because
`enqueue()` stamps arrival time. That is now false and is the bug this work
fixed. Replace that clause with:

> It is also safe to decimate at all only because **a frame is stamped from
> ffmpeg's own PTS** (`mkvtimestamp_v2` on a third split of the sampling branch,
> fd 4) — capture time, never a frame index and never arrival — so dropping
> frames breaks no timestamp mapping. **Arrival time was the bug:** it measured
> **3.050s late on a real avfoundation device** (~0.8s device start-up plus
> ~2.2s capture-to-delivery), which put every stored keyframe ~3.2s behind its
> own `t_mono` while the video, which keeps PTS, was exact. `frame.tMono =
> video.tMonoStart + pts`, so a keyframe and the video frame showing it agree by
> construction. The rate limit is `select`, NOT `fps`: **vf_fps relabels the
> frame it picks to the slot start**, a measured constant −0.400s against the
> picture, where `select` measured 0.000s. `select` does not change frame-rate
> metadata, so **`-fps_mode passthrough` on the three sampling outputs is
> mandatory** — without it CFR duplication produced 139 frames where 14 were
> expected. Sampling PTS needs no `-copyts`: normalized PTS already equals video
> media time (verified `media 0s → N=0, 1s → N=10, 2s → N=20`). Residual,
> disclosed: `video.tMonoStart` is stamped before spawn while media 0 happens
> **D ≈ 808ms** later, so frames sit ~0.8s early against input events; closing
> it needs a `mach_absolute_time` reading Node cannot make.

- [ ] **Step 3: Record the AX association rule**

Beside the existing "AX is captured at boundaries as well as keyframes" paragraph, add:

> **A keyframe walk is assigned to a frame at REPRESENT time, not at capture
> time.** The walk starts when a frame arrives, and a frame arrives a whole
> capture latency (~2.2s) after the pixels it shows, so the triggering frame is
> the wrong one by construction — region proposal was fusing a tree from one
> screen with a picture from another. `CaptureSession` therefore writes no
> `frame_id`, and `associateFrameAx` (`represent/frame-ax.ts`, always-on, pure
> SQLite, between `Linking frames` and `Regions`) points each walk at the frame
> nearest its own `t_mono`. The direction is **walk → frame**, so two walks
> cannot contend for one frame and a frame with no nearby walk stays unlinked
> rather than borrowing one — expect the first keyframes of a session to land
> there. This is `AxCapturer.boundaryTMono`'s bug one layer down, and the join
> is only meaningful because `frame.tMono` is now capture time.

- [ ] **Step 4: Close the open note**

Delete the `**Open, unrelated: the stored keyframe JPEG appears to LAG its own
`t_mono` stamp by ~3.2s.**` bullet. Replace it with a one-line pointer:

> Keyframe timing was fixed on 2026-08-08 by stamping from PTS — see the
> `FfmpegScreenProducer` paragraph above. **Recordings made before that keep the
> ~3.2s skew and are not comparable**: the delivery latency of a past session
> was never recorded, so it cannot be recovered from what is stored.

- [ ] **Step 5: Commit**

```bash
git add docs/setup.md CLAUDE.md
git commit -m "docs: record PTS stamping and the AX content-time association"
```

---

### Task 10: Validate against a real recording

**Files:** none — this is the gate the suite cannot be.

**Interfaces:** none.

This task exists because the suite structurally cannot confirm the fix: it has no ffmpeg PTS and no real capture device. Three of this repo's worst bugs were invisible to `npm test` and obvious within minutes of driving a real session. Do not skip it, and do not report the work as done before it passes.

- [ ] **Step 1: Build and launch the app**

Run: `npm run build && npm run app:dev`
Use the `run-app` skill to drive it if working headlessly.

- [ ] **Step 2: Record a session with a visible millisecond clock**

Record ~30 seconds. The Record screen's own elapsed timer displays milliseconds and is the reference clock — but **close the recorder window to the tray while recording**, or its millisecond timer defeats `mpdecimate` entirely (measured: 18/18 and 22/22 frames kept with it on screen). Instead put a millisecond clock in another window and record that.

- [ ] **Step 3: Check a search hit's keyframe against its own timecode**

Open Search, run a query that returns a hit from this recording, and read the on-screen clock in the result card's picture. It must match the card's timecode.

Expected: agreement within ~0.5s (bounded by the sampling interval). Before this work it was 3.1–3.2s behind.

- [ ] **Step 4: Check the keyframe against the video**

Click the hit to jump into the Library. The video frame the playhead lands on must show the same clock reading as the card's picture did.

Expected: they agree. This is the criterion the whole design was chosen for.

- [ ] **Step 5: Confirm the AX association did something**

In the Library, hover the rail's `ax_snapshot` lane and confirm walks are present, then confirm region highlights on a keyframe correspond to controls visible **in that keyframe** rather than to a later screen.

- [ ] **Step 6: Record the measurement**

Add the observed numbers to the spec's Measurements section under a new
`### Validated on a real recording (YYYY-MM-DD)` heading — the actual readings,
including any residual, not a claim that it works.

```bash
git add docs/superpowers/specs/2026-08-08-keyframe-capture-time-design.md
git commit -m "docs: real-recording validation of PTS keyframe timing"
```

---

## Notes for the implementer

- **The spec did not cover the `ffmpegArgs` override.** A caller-supplied arg
  list replaces the whole graph and therefore has no pts pipe;
  `test/ffmpeg-screen.test.ts` has one such test. Tasks 2 and 4 handle it with
  the `usePts` flag and `ptsMs: null`. Without it, `pair()` would wait forever
  for fd 4 and that test would record zero frames — a silent, total failure.
- **Do not "simplify" `PASSTHROUGH` onto the mp4 output.** The video branch is
  not fed from `select` and must stay CFR at `videoFps`.
- **Do not restore the `frameId` argument** in `session.ts` to make a test pass.
  The whole point of Task 7 is that capture cannot know that frame.
