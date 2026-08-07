# Visual-State Keyframes and Track-Rail Readability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "the screen changed" a detected, persisted fact — decided by ffmpeg's `mpdecimate` instead of a 32×32 whole-frame hash — then let it drive `action` segmentation so a segment holds exactly one keyframe, and stop the track rail painting prose into bars.

**Architecture:** `capture/` moves the keyframe decision into the ffmpeg filter graph (`mpdecimate` on a single sampling branch, before the split that feeds gray+MJPEG), leaving a pure `KeyframeBudget` rate limiter in Node. `segment/` gains a `scene_change` boundary reason fed from kept frames, `action` stops cutting on inactivity and stops subdividing by clock. `represent/transcript/` persists real utterance intervals in a new `transcript_clip` table. The app's rail renders bars at true extent with a separately-padded hit rect, and text moves to the existing hover card.

**Tech Stack:** TypeScript (strict, ESM), ffmpeg filter graphs, better-sqlite3, React, vitest. No new dependencies.

## Global Constraints

- Run `npm run typecheck` after every task — it is the primary correctness gate (strict TS).
- Run the affected test file with `npx vitest run test/<file>.test.ts` after every task; run the full `npm test` at the end of Tasks 2, 5, and 10.
- Tasks 8 and 9 additionally require `npm --prefix app run typecheck` — the app is a separate package with its own gate.
- SQLite writes commit before Lance vector writes, always (dual-store invariant). `transcript_clip` is SQLite-only, so it introduces no vector-ordering hazard.
- **The schema changes and there is NO migration.** The data dir is deleted by hand (`~/Library/Application Support/deskrag-app/DeskRAG/`). Do not add a version guard, a migration step, or a fallback read.
- Pure renderer modules must be `.ts`, never `.tsx` — the root `tsconfig.json` sets no `jsx`, so a root test reaching into a `.tsx` even for a type breaks `npm run typecheck`.
- `grep` silently skips `src/store/store.ts` (it contains deliberate NUL bytes). Use `grep -a` / `rg -a` on that file.
- Never commit with `--no-verify`; only commit when a task's own steps say to.
- Spec: `docs/superpowers/specs/2026-08-06-visual-state-keyframes-and-track-rail-design.md`.

---

### Task 1: `KeyframeBudget` — the pure rate limiter

**Files:**
- Create: `src/capture/keyframe-budget.ts`
- Test: `test/frame-pipeline.test.ts`

**Interfaces:**
- Produces: `class KeyframeBudget { constructor(opts?: KeyframeBudgetOptions); consider(tMono: number): boolean; reset(): void }`; `interface KeyframeBudgetOptions { minIntervalMs?: number }`; `const DEFAULT_KEYFRAME_MIN_INTERVAL_MS: number`.

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `test/frame-pipeline.test.ts`, immediately **after** the existing `describe("KeyframeGate", ...)` block (that block is deleted in Task 2, not here). Add the import at the top of the file beside the existing `KeyframeGate` import:

```ts
import { KeyframeBudget } from "../src/capture/keyframe-budget.js";
```

```ts
describe("KeyframeBudget", () => {
  it("always keeps the first frame, whatever the interval", () => {
    const b = new KeyframeBudget({ minIntervalMs: 1000 });
    expect(b.consider(0)).toBe(true);
  });

  it("keeps the FIRST of a burst and drops the rest inside the interval", () => {
    const b = new KeyframeBudget({ minIntervalMs: 500 });
    expect(b.consider(0)).toBe(true);
    expect(b.consider(100)).toBe(false);
    expect(b.consider(400)).toBe(false);
    expect(b.consider(499)).toBe(false);
    expect(b.consider(500)).toBe(true); // the interval has elapsed
  });

  it("measures from the last KEPT frame, not the last considered one", () => {
    // A steady stream just under the interval must still yield a frame each
    // time the interval elapses — measuring from the last *considered* frame
    // would starve the lane forever.
    const b = new KeyframeBudget({ minIntervalMs: 500 });
    b.consider(0); // kept
    b.consider(400); // dropped
    expect(b.consider(600)).toBe(true); // 600 - 0 >= 500
  });

  it("keeps everything at minIntervalMs 0 — the rule tests want", () => {
    const b = new KeyframeBudget({ minIntervalMs: 0 });
    expect([0, 0, 1, 1].map((t) => b.consider(t))).toEqual([true, true, true, true]);
  });

  it("reset() forgets the last kept frame", () => {
    const b = new KeyframeBudget({ minIntervalMs: 500 });
    b.consider(0);
    expect(b.consider(100)).toBe(false);
    b.reset();
    expect(b.consider(100)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/frame-pipeline.test.ts -t "KeyframeBudget"`
Expected: FAIL — `src/capture/keyframe-budget.js` does not exist, so the import cannot resolve.

- [ ] **Step 3: Create `src/capture/keyframe-budget.ts`**

```ts
/**
 * KeyframeBudget — the ONLY rate limit on keyframes.
 *
 * What CHANGED on screen is decided by ffmpeg's `mpdecimate` in the filter
 * graph (see FfmpegScreenProducer), which compares 8x8 blocks against the last
 * kept frame and so can see a localized change. This class answers the separate
 * question of how OFTEN a change may produce a keyframe, because every kept
 * frame costs a JPEG blob, a caption, and an embedding — a video or an
 * animation playing on screen would otherwise flood all three.
 *
 * It keeps the FIRST frame of a burst and drops the rest: the frame that
 * started a change is the interesting one, and the ones behind it are the tail
 * of the same event. The clock is the last KEPT frame, never the last
 * considered one — measuring from the latter would let a steady stream just
 * under the interval starve the lane indefinitely.
 *
 * This REPLACES KeyframeGate, which decided keeps by dHash distance over a
 * 32x32 grayscale thumbnail. That could not see a Calculator digit on a
 * 2560x1440 screen — it is sub-pixel after the downscale — and produced one
 * keyframe in sixteen seconds of real use.
 */

export interface KeyframeBudgetOptions {
  /** Minimum gap between kept keyframes, in ms. 0 keeps every frame offered. */
  minIntervalMs?: number;
}

/** Provisional; replaced by a measured value in the calibration task. */
export const DEFAULT_KEYFRAME_MIN_INTERVAL_MS = 500;

export class KeyframeBudget {
  private readonly minIntervalMs: number;
  private lastKeptTMono: number | undefined;

  constructor(opts: KeyframeBudgetOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_KEYFRAME_MIN_INTERVAL_MS;
  }

  /** True when this frame may be kept. Only a kept frame moves the clock. */
  consider(tMono: number): boolean {
    if (
      this.lastKeptTMono !== undefined &&
      tMono - this.lastKeptTMono < this.minIntervalMs
    ) {
      return false;
    }
    this.lastKeptTMono = tMono;
    return true;
  }

  reset(): void {
    this.lastKeptTMono = undefined;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/frame-pipeline.test.ts -t "KeyframeBudget"`
Expected: PASS — all five cases.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/capture/keyframe-budget.ts test/frame-pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(capture): add KeyframeBudget, a pure keyframe rate limiter

Keeps the first frame of a burst and drops the rest, measuring from the
last KEPT frame. Nothing uses it yet — KeyframeGate still decides keeps,
which is the next commit.
EOF
)"
```

---

### Task 2: Wire `KeyframeBudget` in and retire `KeyframeGate`

**Files:**
- Delete: `src/capture/keyframe.ts`
- Modify: `src/capture/frame-ingest.ts`
- Modify: `src/capture/session.ts:25-40`, `src/capture/session.ts:98-102`
- Modify: `src/index.ts:78`
- Test: `test/frame-pipeline.test.ts`, `test/capture-frames.test.ts`, `test/ffmpeg-screen.test.ts`, `test/assemble.test.ts`, `test/ax.test.ts`, `test/caption.test.ts`, `test/rerank.test.ts`, `test/sharp-cropper.test.ts`, `test/tier2.test.ts`, `test/tier3.test.ts`

**Interfaces:**
- Consumes: `KeyframeBudget`, `KeyframeBudgetOptions` (Task 1).
- Produces: `FrameIngestor`'s 3rd constructor parameter is now `budget: KeyframeBudget`; `CaptureSessionOptions.keyframeBudget?: KeyframeBudget` (replaces `keyframeGate`); `IngestResult` loses its `forced` field.

- [ ] **Step 1: Delete the `KeyframeGate` test block**

In `test/frame-pipeline.test.ts`, delete the entire `describe("KeyframeGate", ...)` block (both `it`s) and the `import { KeyframeGate } from "../src/capture/keyframe.js";` line. The `KeyframeBudget` block from Task 1 replaces it.

Then change the `FrameIngestor -> Tier-0` test, which currently relies on pHash dedup dropping the middle frame. Replace its body from `const ing = ...` through the end of the `it`:

```ts
    const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 500 }));

    const frame = (tMono: number, gray: Uint8Array): SampledFrame => ({
      tMono, width: 1920, height: 1080, gray, grayW: 9, grayH: 8,
    });

    // Dedup is ffmpeg's job now (mpdecimate). What the ingestor still enforces
    // is the BUDGET: a second frame 1ms later is the tail of the same burst.
    const a = await ing.ingest(frame(0, gradient(false)));
    const b = await ing.ingest(frame(1, gradient(true)));   // inside the interval
    const c = await ing.ingest(frame(600, gradient(true))); // interval elapsed

    expect(a.kept).toBe(true);
    expect(b.kept).toBe(false);
    expect(c.kept).toBe(true);
    expect(ing.keptCount).toBe(2);
    expect(a.frameId).not.toBe(c.frameId);

    // Tier-0: a pHash query returns the near frame, not the far one.
    expect(store.phashPrefilter(0n, 5)).toEqual([a.frameId]);
    expect(store.phashPrefilter(ALL_ONES, 5)).toEqual([c.frameId]);
    // A wide radius returns both kept keyframes (and never the skipped one).
    expect(new Set(store.phashPrefilter(0n, 64))).toEqual(new Set([a.frameId, c.frameId]));
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/frame-pipeline.test.ts`
Expected: FAIL — `FrameIngestor`'s 3rd parameter is still typed `KeyframeGate`, so passing a `KeyframeBudget` is a type error and the ingest calls do not gate on time.

- [ ] **Step 3: Update `src/capture/frame-ingest.ts`**

Change the header comment's first paragraph, the import, the `IngestResult` shape, the constructor parameter, and the gate call:

```ts
/**
 * FrameIngestor — turns sampled frames into persisted keyframe rows. Every
 * frame offered here has ALREADY been decided to be a visual state change by
 * ffmpeg's `mpdecimate`; this applies the KeyframeBudget's rate limit, hashes
 * the frame (dHash) for the Tier-0 coarse visual index, and writes a frame row.
 * Frames are stored relational-only here (segment_ids are attached later, lazy,
 * at/after segmentation) and the frame_image vector is a later represent/ view.
 *
 * A frame source (e.g. the ffmpeg screen producer) feeds SampledFrames in; the
 * source owns decoding to grayscale and, if desired, writing the keyframe image
 * blob (passing its blobId here).
 */

import { ulid } from "ulid";
import type { Store } from "../store/types.js";
import type { BlobStore } from "../store/blob-store.js";
import { dHash } from "./phash.js";
import { KeyframeBudget } from "./keyframe-budget.js";
```

```ts
export interface IngestResult {
  kept: boolean;
  phash: bigint;
  frameId?: string;
}

export class FrameIngestor {
  private offset = 0;

  constructor(
    private readonly store: Store,
    private readonly sessionId: string,
    private readonly budget: KeyframeBudget = new KeyframeBudget(),
    private readonly blobStore?: BlobStore,
  ) {}

  async ingest(frame: SampledFrame): Promise<IngestResult> {
    // The hash is computed for EVERY frame regardless: it is the Tier-0 index
    // on the row, not a keep decision any more.
    const phash = dHash(frame.gray, frame.grayW, frame.grayH);
    if (!this.budget.consider(frame.tMono)) return { kept: false, phash };
```

Everything from `// Persist the keyframe image blob first` to the end of the class is unchanged except the final `return`, which becomes:

```ts
    return { kept: true, phash, frameId };
```

- [ ] **Step 4: Update `src/capture/session.ts`**

Change the import on line 17:

```ts
import { KeyframeBudget } from "./keyframe-budget.js";
```

Change the option in `CaptureSessionOptions` (lines 30-31):

```ts
  /** Keyframe rate limit for frame producers (defaults to a fresh KeyframeBudget). */
  keyframeBudget?: KeyframeBudget;
```

Change the `axSource` doc comment a few lines below, which describes the old gating rule:

```ts
  /**
   * Accessibility source. When set, the AX tree is captured per kept keyframe
   * AND at boundaries (focus change, bookmark, dwell resume) — a settled screen
   * produces no keyframes, and settled is exactly when a boundary fires, so
   * keyframe-only AX has nothing to offer where it matters most.
   */
```

Change the `FrameIngestor` construction (lines 98-102):

```ts
    this.ingestor = new FrameIngestor(
      this.store,
      this.sessionId,
      this.opts.keyframeBudget ?? new KeyframeBudget(),
      this.opts.blobStore,
    );
```

- [ ] **Step 5: Update the barrel export**

In `src/index.ts`, replace line 78:

```ts
export {
  KeyframeBudget,
  DEFAULT_KEYFRAME_MIN_INTERVAL_MS,
  type KeyframeBudgetOptions,
} from "./capture/keyframe-budget.js";
```

- [ ] **Step 6: Delete `src/capture/keyframe.ts`**

```bash
git rm src/capture/keyframe.ts
```

- [ ] **Step 7: Update the nine other test files**

Each of these constructs a `KeyframeGate` to mean "keep essentially everything". The budget equivalent is `minIntervalMs: 0`. Replace the import in each file:

```ts
import { KeyframeBudget } from "../src/capture/keyframe-budget.js";
```

Then replace each construction site:

| File:line | Replace with |
| --- | --- |
| `test/assemble.test.ts:75` | `const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);` |
| `test/ax.test.ts:215` | `const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);` |
| `test/ax.test.ts:264` | `keyframeBudget: new KeyframeBudget({ minIntervalMs: 0 }),` |
| `test/caption.test.ts:62` | `const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);` |
| `test/caption.test.ts:161` | `const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);` |
| `test/capture-frames.test.ts:54` | `keyframeBudget: new KeyframeBudget({ minIntervalMs: 0 }),` |
| `test/ffmpeg-screen.test.ts:51` | `keyframeBudget: new KeyframeBudget({ minIntervalMs: 0 }),` |
| `test/ffmpeg-screen.test.ts:102` | `keyframeBudget: new KeyframeBudget({ minIntervalMs: 0 }),` |
| `test/rerank.test.ts:80` | `const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);` |
| `test/sharp-cropper.test.ts:116` | `const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);` |
| `test/tier2.test.ts:62` | `const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);` |
| `test/tier3.test.ts:68` | `const ing = new FrameIngestor(store, sessionId, new KeyframeBudget({ minIntervalMs: 0 }), blobs);` |

- [ ] **Step 8: Run the full suite and fix what the permissiveness change exposes**

Run: `npm test`

`minIntervalMs: 0` is strictly MORE permissive than `hammingThreshold: 1`: a frame that was previously deduped as a near-identical pHash is now kept. Any failure will be a count assertion that assumed a drop. For each one, read the test's own ingest calls, count how many frames are now kept (all of them), and update the expected number. **Do not weaken an assertion** (no loosening an exact count to `toBeGreaterThan(0)`) — compute the real value.

Re-run `npm test` after each fix until green.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If anything still references `KeyframeGate`, `GateDecision`, `KeyframeGateOptions`, or `IngestResult.forced`, it surfaces here.

- [ ] **Step 10: Commit**

```bash
git add -A src/capture src/index.ts test/
git commit -m "$(cat <<'EOF'
refactor(capture): KeyframeBudget replaces KeyframeGate as the decider

The gate compared a 64-bit dHash of a 32x32 grayscale thumbnail, which
dHash then reduced to 9x8 — a Calculator digit on a 2560x1440 screen is
sub-pixel by then, and sixteen seconds of real use produced ONE keyframe.
What changed on screen becomes ffmpeg's job (next commit); what survives
in Node is the rate limit, which is a separate question and the only lever
on captioning and embedding cost.

dHash is unchanged and still runs on every frame — Tier-0 needs the hash
on the row, it just no longer decides which rows exist.
EOF
)"
```

---

### Task 3: `mpdecimate` in the ffmpeg filter graph

**Files:**
- Modify: `src/capture/producers/ffmpeg-screen.ts:70-122` (options), `:156-222` (`args`)
- Modify: `src/index.ts`
- Test: `test/ffmpeg-screen.test.ts`

**Interfaces:**
- Produces: `interface DecimateOptions { hi?: number; lo?: number; frac?: number; max?: number }`; `FfmpegScreenOptions.decimate?: DecimateOptions | false`; `const DEFAULT_DECIMATE: Required<DecimateOptions>`.

- [ ] **Step 1: Write the failing tests**

In `test/ffmpeg-screen.test.ts`, replace the whole first `it` of `describe("FfmpegScreenProducer.args", ...)` (the one titled `"emits three mapped outputs and decimates only the sampling branches"`) with these three:

```ts
  it("splits video off first, then decimates ONE sampling branch feeding gray+JPEG", () => {
    const p = new FfmpegScreenProducer({ fps: 1, videoFps: 10, grayW: 32, grayH: 32 });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args("/tmp/out.mp4");
    const joined = a.join(" ");

    expect(joined).toContain("[0:v]split=2[v][s]");
    // ONE scale, at the stored JPEG's width, feeding the decimator and both
    // branches — never two scale passes.
    expect(joined).toContain("[s]fps=1,scale=1280:-2,mpdecimate=");
    expect(joined).toContain("[d]split=2[g][c]");
    expect(joined).toContain("[g]scale=32:32,format=gray[gg]");
    expect(joined).toContain("[c]null[cc]");
    expect(joined).not.toContain("[v]fps="); // video branch keeps full rate
    expect(joined).not.toContain("[v]mpdecimate"); // and is never decimated
    expect(joined).toContain("-framerate 10"); // input runs at videoFps
    expect(joined).toContain("+frag_keyframe+empty_moov+default_base_moof");
    expect(joined).toContain("-pix_fmt yuv420p");
    expect(a[a.length - 1]).toBe("pipe:3");
    expect(joined).toContain("/tmp/out.mp4");
  });

  it("carries every mpdecimate parameter, including the heartbeat", () => {
    const p = new FfmpegScreenProducer({
      decimate: { hi: 1, lo: 2, frac: 0.5, max: 7 },
    });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args(null);
    expect(a.join(" ")).toContain("mpdecimate=hi=1:lo=2:frac=0.5:max=7");
  });

  it("decimate:false leaves an inert filter rather than a broken graph", () => {
    const p = new FfmpegScreenProducer({ decimate: false });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args(null);
    expect(a.join(" ")).not.toContain("mpdecimate");
    expect(a.join(" ")).toContain("[d]split=2[g][c]"); // the graph still links up
  });
```

Then update the two later `it`s in the same block whose assertions name the old labels:

```ts
  it("omits the video branch when recordVideo is false", () => {
    const p = new FfmpegScreenProducer({ recordVideo: false });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args(null);

    expect(a.join(" ")).toContain("[0:v]split=1[s]");
    expect(a.join(" ")).toContain("[d]split=2[g][c]");
    expect(a.join(" ")).not.toContain("libx264");
  });

  it("drops to a gray-only single output when storeImages is false", () => {
    const p = new FfmpegScreenProducer({ storeImages: false, recordVideo: false });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args(null);

    expect(a.join(" ")).not.toContain("split");
    expect(a.join(" ")).toContain("mpdecimate="); // still decimated
    expect(a[a.length - 1]).toBe("pipe:1");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ffmpeg-screen.test.ts -t "FfmpegScreenProducer.args"`
Expected: FAIL — the graph is still `[0:v]split=3[v][g][c]` with a per-branch `fps` filter, and there is no `mpdecimate` anywhere.

- [ ] **Step 3: Add the decimate options to `src/capture/producers/ffmpeg-screen.ts`**

Add this above `export interface FfmpegScreenOptions`:

```ts
/**
 * `mpdecimate` parameters. It divides each frame into 8x8 blocks, computes SAD
 * per block against the LAST KEPT frame, and keeps the frame when any block
 * exceeds `hi`, or when more than `frac` of blocks exceed `lo`.
 */
export interface DecimateOptions {
  /** Any single 8x8 block above this keeps the frame outright. */
  hi?: number;
  /** Blocks above this are counted toward `frac`. */
  lo?: number;
  /** Fraction of blocks that must exceed `lo` to keep the frame. */
  frac?: number;
  /** Force a keep after this many consecutive drops — the heartbeat. */
  max?: number;
}

/**
 * PROVISIONAL — replaced by measured values in the calibration task. Do not
 * treat these as tuned.
 *
 * `hi` is deliberately far above ffmpeg's own default (64*12 = 768) so the
 * any-ONE-block path effectively never fires alone: a blinking text caret is
 * roughly one 8x8 block whose SAD clears 768 easily, and on screen content that
 * alone would emit a keyframe every single sample. A real state change — a
 * digit, a menu, a field filling — spans several blocks and is caught by the
 * `lo`/`frac` path instead, which is why `frac` is small rather than ffmpeg's
 * 0.33.
 */
export const DEFAULT_DECIMATE: Required<DecimateOptions> = {
  hi: 64 * 64,
  lo: 64 * 5,
  frac: 0.002,
  max: 60,
};
```

Add the option to `FfmpegScreenOptions`, immediately after `imageQuality`:

```ts
  /**
   * Visual-state-change detection. `false` disables decimation entirely (every
   * sampled frame is offered to the KeyframeBudget) — for tests and for
   * diagnosing whether the filter is the reason a frame is missing.
   */
  decimate?: DecimateOptions | false;
```

- [ ] **Step 4: Rewrite `args()`**

Replace the whole `private args(videoPath: string | null): string[] { ... }` method and add the private helper below it:

```ts
  private args(videoPath: string | null): string[] {
    if (this.opts.ffmpegArgs) return this.opts.ffmpegArgs;
    const fps = this.opts.fps ?? 1;
    // start() refuses to spawn without one, so this is always set by here.
    const input = this.resolvedInput ?? this.opts.input ?? "1";
    // With video recording the input must run at the video's framerate; the
    // sampling branch then decimates back to `fps` with its own filter.
    const inputRate = videoPath ? this.videoFps : fps;
    const maxW = this.opts.imageMaxWidth ?? 1280;
    const q = this.opts.imageQuality ?? 5;
    const crf = this.opts.videoCrf ?? 28;
    const preset = this.opts.videoPreset ?? "veryfast";
    const videoMaxW = this.opts.videoMaxWidth ?? 1920;
    // ONE scale, at the stored JPEG's own width, feeding the decimator AND both
    // sampling branches. Decimating at native resolution and re-scaling for the
    // JPEG would be two scale passes and maximally sensitive to a caret.
    const sample = `fps=${fps},scale=${maxW}:-2,${this.decimateFilter()}`;
    const gray = `scale=${this.grayW}:${this.grayH},format=gray`;
    const head = [
      // `warning`, not `error`, on purpose. macOS avfoundation logs
      //   "Selected pixel format (yuv420p) is not supported by the input device"
      // at ERROR level and its recovery
      //   "Overriding selected pixel format to use uyvy422 instead"
      // at WARNING. At `error` the user sees only the alarming half of a pair
      // that ffmpeg then handles itself, which reads as a failed capture when
      // capture is in fact fine. These are one-time startup lines, not per-frame.
      "-hide_banner", "-loglevel", "warning",
      "-f", this.opts.inputFormat ?? "avfoundation",
      ...(this.opts.omitInputFramerate ? [] : ["-framerate", String(inputRate)]),
      "-i", input,
    ];
    if (!this.storeImages && !videoPath) {
      return [
        ...head,
        "-vf", `${sample},${gray}`,
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
      ];
    }

    // Top split: the video branch keeps the full input rate, and ONE sampling
    // branch carries everything the keyframe pipeline sees. Decimating BEFORE
    // the gray/JPEG split is what keeps pair() aligned by construction — both
    // branches are downstream of the same decimator.
    const topLabels = [...(videoPath ? ["[v]"] : []), "[s]"];
    const chains: string[] = [`[0:v]split=${topLabels.length}${topLabels.join("")}`];
    // The video scale lives INSIDE the graph: -vf cannot be combined with
    // -filter_complex on the same output stream.
    if (videoPath) chains.push(`[v]scale='min(${videoMaxW},iw)':-2[vv]`);
    chains.push(`[s]${sample}[d]`);
    if (this.storeImages) {
      chains.push(`[d]split=2[g][c]`, `[g]${gray}[gg]`, `[c]null[cc]`);
    } else {
      chains.push(`[d]${gray}[gg]`);
    }

    const out: string[] = [...head, "-filter_complex", chains.join(";")];
    // Fragmented MP4: playable even if ffmpeg is killed mid-recording, at the
    // cost of fragment-granular (rather than indexed) seeking.
    if (videoPath) {
      out.push(
        "-map", "[vv]",
        "-c:v", "libx264", "-preset", preset, "-crf", String(crf),
        "-pix_fmt", "yuv420p", "-g", String(this.videoFps * 2),
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "-y", videoPath,
      );
    }
    out.push("-map", "[gg]", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1");
    if (this.storeImages) {
      out.push("-map", "[cc]", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", String(q), "pipe:3");
    }
    return out;
  }

  /**
   * The mpdecimate expression, or an inert `null` filter when decimation is
   * disabled — `null` rather than an empty string so the chain still links its
   * labels and the graph stays well formed.
   */
  private decimateFilter(): string {
    const d = this.opts.decimate;
    if (d === false) return "null";
    const o = d ?? {};
    const hi = o.hi ?? DEFAULT_DECIMATE.hi;
    const lo = o.lo ?? DEFAULT_DECIMATE.lo;
    const frac = o.frac ?? DEFAULT_DECIMATE.frac;
    const max = o.max ?? DEFAULT_DECIMATE.max;
    return `mpdecimate=hi=${hi}:lo=${lo}:frac=${frac}:max=${max}`;
  }
```

- [ ] **Step 5: Update the file's header comment**

Replace the first paragraph of the module docstring:

```ts
/**
 * FfmpegScreenProducer — samples the screen by spawning ffmpeg. It emits TWO
 * aligned outputs from one process:
 *   - stdout (pipe:1): downscaled grayscale rawvideo → FrameChunker → dHash,
 *   - fd 3   (pipe:3): MJPEG full frames        → JpegStreamSplitter → the
 *                       stored keyframe image (frame_image view + region crops).
 *
 * WHAT CHANGED ON SCREEN IS DECIDED HERE, by `mpdecimate` on the shared
 * sampling branch BEFORE it splits into those two. mpdecimate compares 8x8
 * blocks against the last kept frame, so it sees a localized change that a
 * whole-frame hash averages away. Decimating before the split is also what
 * keeps the two outputs paired by index: both are downstream of one decimator,
 * so frame N of each still corresponds.
 *
 * Set `storeImages: false` to fall back to grayscale-only (dHash/Tier-0 only).
 * Device/input is platform-specific: on macOS the avfoundation display index is
 * discovered in start() (see `input`), and everything is overridable via
 * `ffmpegArgs`. Not exercised by the unit suite — the testable parts are
 * FrameChunker, JpegStreamSplitter, and args() itself.
 */
```

- [ ] **Step 6: Export the new types from the barrel**

In `src/index.ts`, find the existing `FfmpegScreenProducer` export block and add the two new names to it:

```ts
export {
  FfmpegScreenProducer,
  screenInputFor,
  DEFAULT_DECIMATE,
  type FfmpegScreenOptions,
  type DecimateOptions,
  type ScreenInput,
} from "./capture/producers/ffmpeg-screen.js";
```

If the existing block's member list differs, keep every name it already had and add `DEFAULT_DECIMATE` and `type DecimateOptions`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/ffmpeg-screen.test.ts`
Expected: PASS. The two real-ffmpeg integration tests (skipped without ffmpeg) also still pass: the first overrides `ffmpegArgs` entirely, and the second drives the real graph off a moving `testsrc` whose every frame changes.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/capture/producers/ffmpeg-screen.ts src/index.ts test/ffmpeg-screen.test.ts
git commit -m "$(cat <<'EOF'
feat(capture): decide visual state change with ffmpeg mpdecimate

mpdecimate is block-based — 8x8 SAD against the last KEPT frame — so it
sees a localized change that a whole-frame hash averages away. That is
what select='gt(scene,N)' and scdet cannot do: both score a whole-frame
average, which is the exact blindness being fixed.

It sits on the shared sampling branch BEFORE the gray/JPEG split, so
pair()'s index alignment holds by construction. One scale, at the stored
JPEG's own width, feeds the decimator and both branches — decimating at
native resolution and re-scaling would be two passes and maximally
sensitive to a blinking caret.

Consequence, disclosed: the gray branch now downscales from 1280 rather
than native, so stored phash values shift slightly. Old and new pHashes
are not Tier-0-comparable; the data-dir reset settles that.

DEFAULT_DECIMATE is provisional and is calibrated in the next commit.
EOF
)"
```

---

### Task 4: `scripts/decimate-probe.mjs` and calibration

**Files:**
- Create: `scripts/decimate-probe.mjs`
- Modify: `src/capture/producers/ffmpeg-screen.ts` (`DEFAULT_DECIMATE` values)
- Modify: `src/capture/keyframe-budget.ts` (`DEFAULT_KEYFRAME_MIN_INTERVAL_MS`)
- Modify: `package.json` (script entry)

**Interfaces:**
- Consumes: `DEFAULT_DECIMATE` (Task 3), `DEFAULT_KEYFRAME_MIN_INTERVAL_MS` (Task 1).
- Produces: no code interface. Its output is measured numbers written into those two constants.

This task has no unit test: its deliverable is a measurement. It is a task rather than a step because the numbers it produces are what makes Task 3's defaults real, and a reviewer should be able to see them and disagree.

- [ ] **Step 1: Create `scripts/decimate-probe.mjs`**

```js
#!/usr/bin/env node
/**
 * decimate-probe — how many keyframes would each mpdecimate parameter set
 * produce from a recording we already have?
 *
 * READ ONLY by construction: it never writes to the store, never spawns the
 * app, and only ever reads the H.264 session videos on disk. Same principle as
 * scripts/replay-probe.mjs — a harness that cannot change what it measures.
 *
 * Why this exists: mpdecimate's thresholds cannot be chosen from first
 * principles. A blinking text caret is about one 8x8 block and clears ffmpeg's
 * default `hi` on its own, which on screen content would emit a keyframe every
 * sample; a Calculator digit spans several blocks and must NOT be missed. The
 * gap between those two is the whole calibration, and it is a property of real
 * footage, not of an argument.
 *
 * Usage:
 *   node scripts/decimate-probe.mjs <video.mp4> [more.mp4 ...] [--fps 1] [--width 1280] [--dump <dir>]
 *
 * Session videos live at:
 *   ~/Library/Application Support/deskrag-app/DeskRAG/blobs/<sessionId>/
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const fps = Number(flag("fps", "1"));
const width = Number(flag("width", "1280"));
const dumpDir = flag("dump", null);
const videos = argv.filter((a) => !a.startsWith("--") && a.endsWith(".mp4"));

if (videos.length === 0) {
  console.error("usage: node scripts/decimate-probe.mjs <video.mp4> [...] [--fps N] [--width N] [--dump <dir>]");
  process.exit(1);
}

/**
 * The sets worth comparing. `off` is the control — it is the number of frames
 * offered at this fps, so every other row reads as a fraction of it.
 *
 * `ffmpeg-default` is included precisely because it is expected to be BAD on
 * screen content (hi=768 fires on a caret); seeing it fire far more than the
 * others is the confirmation that the any-one-block path is the problem.
 */
const SETS = [
  { name: "off", filter: "null" },
  { name: "ffmpeg-default", filter: "mpdecimate" },
  { name: "hi-4096-frac-0.002", filter: "mpdecimate=hi=4096:lo=320:frac=0.002:max=60" },
  { name: "hi-4096-frac-0.005", filter: "mpdecimate=hi=4096:lo=320:frac=0.005:max=60" },
  { name: "hi-4096-frac-0.02", filter: "mpdecimate=hi=4096:lo=320:frac=0.02:max=60" },
  { name: "hi-8192-frac-0.002", filter: "mpdecimate=hi=8192:lo=320:frac=0.002:max=60" },
  { name: "hi-2048-frac-0.002", filter: "mpdecimate=hi=2048:lo=320:frac=0.002:max=60" },
];

function durationSec(path) {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", path,
  ], { encoding: "utf8" });
  const d = Number(String(r.stdout).trim());
  return Number.isFinite(d) ? d : 0;
}

/** Count the frames that survive one filter chain, by decoding to null. */
function survivors(path, filter) {
  const r = spawnSync("ffmpeg", [
    "-hide_banner", "-nostats", "-i", path,
    "-vf", `fps=${fps},scale=${width}:-2,${filter}`,
    "-f", "null", "-",
  ], { encoding: "utf8" });
  // ffmpeg's final progress line reports the frames actually written.
  const m = String(r.stderr).match(/frame=\s*(\d+)/g);
  return m ? Number(m[m.length - 1].replace(/\D/g, "")) : 0;
}

function dump(path, filter, name) {
  const dir = join(dumpDir, `${basename(path, ".mp4")}--${name}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", path,
    "-vf", `fps=${fps},scale=${width}:-2,${filter}`,
    "-vsync", "0", join(dir, "%04d.jpg"),
  ]);
  console.log(`      dumped -> ${dir}`);
}

for (const path of videos) {
  const sec = durationSec(path);
  console.log(`\n${basename(path)}  (${sec.toFixed(1)}s, sampling at ${fps}fps, scaled to ${width}px)`);
  for (const set of SETS) {
    const n = survivors(path, set.filter);
    const perMin = sec > 0 ? (n / sec) * 60 : 0;
    console.log(
      `  ${set.name.padEnd(22)} ${String(n).padStart(5)} frames  ${perMin.toFixed(1)}/min`,
    );
    if (dumpDir) dump(path, set.filter, set.name);
  }
}

console.log(`
Reading this:
  - "off" is the ceiling: every frame offered at this fps.
  - A set close to "off" is firing on noise (a caret, a clock, a cursor).
    Open its dump and look: if consecutive frames are indistinguishable, hi is
    too low or frac is too small.
  - A set far below "off" may be MISSING state changes. Open its dump and check
    that every distinct screen you remember is present. A missed state is worse
    than a duplicate one.
  - Pick the largest hi / frac that still keeps every distinct screen, then set
    DEFAULT_KEYFRAME_MIN_INTERVAL_MS so the worst-case /min figure is affordable
    to caption and embed.
`);
```

- [ ] **Step 2: Add the script entry to `package.json`**

In the `"scripts"` block, beside the other probe/script entries:

```json
    "probe:decimate": "node scripts/decimate-probe.mjs",
```

- [ ] **Step 3: Run the probe against real recordings**

```bash
ls ~/Library/Application\ Support/deskrag-app/DeskRAG/blobs/*/
npm run probe:decimate -- ~/Library/Application\ Support/deskrag-app/DeskRAG/blobs/<sessionId>/<screen>.mp4 --dump /tmp/decimate
```

Run it against **at least two** recordings, and they must differ in kind — one mostly-static (the Calculator session) and one with motion or a text caret. A parameter set calibrated only on a static recording will flood on the other, which is the failure this probe exists to prevent.

Record the table in the commit message.

- [ ] **Step 4: Write the measured values into the defaults**

In `src/capture/producers/ffmpeg-screen.ts`, replace `DEFAULT_DECIMATE`'s four values with the chosen set, and replace the "PROVISIONAL" sentence of its doc comment with the measurement, in this form:

```ts
/**
 * MEASURED against <N> real recordings with scripts/decimate-probe.mjs — see
 * the commit that set these. At 1fps/1280px: <static session> gave <n>/min and
 * <motion session> gave <n>/min, against a ceiling of 60/min.
 *
 * `hi` sits far above ffmpeg's own default (64*12 = 768) so the any-ONE-block
 * path effectively never fires alone: <state what the probe measured about the
 * caret/noise case>. A real state change spans several blocks and is caught by
 * the `lo`/`frac` path instead, which is why `frac` is small rather than
 * ffmpeg's 0.33.
 */
```

In `src/capture/keyframe-budget.ts`, replace the `DEFAULT_KEYFRAME_MIN_INTERVAL_MS` line and its comment:

```ts
/**
 * Chosen so the busiest recording measured by scripts/decimate-probe.mjs
 * (<n>/min before the budget) lands at <n>/min after it — every kept frame
 * costs a JPEG blob, a caption, and an embedding.
 */
export const DEFAULT_KEYFRAME_MIN_INTERVAL_MS = <measured>;
```

- [ ] **Step 5: Run the affected tests**

Run: `npx vitest run test/ffmpeg-screen.test.ts test/frame-pipeline.test.ts`
Expected: PASS. Both files pass explicit options at every construction site, so neither depends on the default values.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add scripts/decimate-probe.mjs package.json src/capture/producers/ffmpeg-screen.ts src/capture/keyframe-budget.ts
git commit -m "$(cat <<'EOF'
feat(capture): calibrate mpdecimate against real recordings

scripts/decimate-probe.mjs is read-only — it reads the session MP4s
already on disk and never touches the store — so the thresholds come from
real footage instead of from an argument. Measured on two recordings that
differ in kind, because a set calibrated only on a static screen floods on
one with a caret.

<paste the probe table here: set name, frames, per-minute, for each video>

DEFAULT_DECIMATE and DEFAULT_KEYFRAME_MIN_INTERVAL_MS are no longer
provisional.
EOF
)"
```

---

### Task 5: `scene_change` boundaries; inactivity stops cutting `action`

**Files:**
- Modify: `src/segment/types.ts`
- Modify: `src/segment/boundaries.ts`
- Modify: `src/segment/windowing.ts:45-64`
- Modify: `src/segment/segmenter.ts:52-71`
- Modify: `src/index.ts`
- Test: `test/segment.test.ts`, plus the seven listed in Step 7

**Interfaces:**
- Produces: `BoundaryReason` gains `"scene_change"`; `GranularityConfig.subdivide?: boolean`; `computeBoundaries(events, endTMono, dwellGapMs?, burstGapMs?, sceneTMonos?)` — new 5th parameter, default `[]`; `MEANINGFUL_INPUT_KINDS: ReadonlySet<string>` exported from `src/segment/boundaries.ts` and the barrel.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe("computeBoundaries", ...)` block in `test/segment.test.ts`:

```ts
  it("marks a scene change from a kept frame's t_mono", () => {
    const b = computeBoundaries([ev(0, "mouse_move")], 8000, 3000, 1500, [4000]);
    expect(b).toEqual([
      { tMono: 0, reason: "session_start" },
      { tMono: 4000, reason: "scene_change" },
      { tMono: 8000, reason: "session_end" },
    ]);
  });

  it("prefers focus_change over a scene_change on the same t_mono, and scene_change over a gap", () => {
    const b = computeBoundaries([ev(0, "key_down"), ev(4000, "focus_change")], 8000, 3000, 1500, [
      4000, 6000,
    ]);
    expect(b[1]).toEqual({ tMono: 4000, reason: "focus_change" });
    expect(b[2]).toEqual({ tMono: 6000, reason: "scene_change" });
  });

  it("scene changes do NOT suppress a dwell gap — they are not input", () => {
    // dwell_gap means "no input at all". A frame arriving mid-gap is the screen
    // changing by itself, which is precisely NOT the user being active, so it
    // must not close the gap. This is why scene times are a separate parameter
    // rather than merged into the event list.
    const b = computeBoundaries([ev(0, "key_down"), ev(9000, "key_down")], 10_000, 3000, 1500, [
      4000,
    ]);
    expect(b.map((x) => x.reason)).toContain("dwell_gap");
  });
```

Add to the existing `describe("windowSegments", ...)` block:

```ts
  it("subdivide:false emits ONE segment per span, however long", () => {
    const g: GranularityConfig = {
      name: "action",
      targetMs: 10_000,
      strideMs: 10_000,
      boundaryAware: true,
      subdivide: false,
    };
    const bounds: Boundary[] = [
      { tMono: 0, reason: "session_start" },
      { tMono: 45_000, reason: "session_end" },
    ];
    const segs = windowSegments("s", g, bounds, ulid);
    expect(segs.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 45_000, "session_start"],
    ]);
  });
```

Add a new `describe` block at the end of the file:

```ts
describe("BASE_GRANULARITIES", () => {
  it("cuts action at visual state change, never at inactivity", () => {
    const action = BASE_GRANULARITIES.find((g) => g.name === "action")!;
    expect(action.cutReasons).toEqual(["scene_change", "focus_change", "bookmark"]);
    expect(action.cutReasons).not.toContain("dwell_gap");
    expect(action.cutReasons).not.toContain("burst_gap");
    // A sub-window contains no keyframe, so subdividing by clock reintroduces
    // exactly the caption-extent defect this design removes.
    expect(action.subdivide).toBe(false);
  });

  it("leaves task cutting only at the big semantic switches", () => {
    const task = BASE_GRANULARITIES.find((g) => g.name === "task")!;
    expect(task.cutReasons).toEqual(["focus_change", "bookmark"]);
    expect(task.subdivide).toBeUndefined(); // undefined means subdivide
  });
});
```

Make sure `BASE_GRANULARITIES` is in the file's import list from `../src/segment/types.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/segment.test.ts -t "scene"`
Run: `npx vitest run test/segment.test.ts -t "subdivide"`
Run: `npx vitest run test/segment.test.ts -t "BASE_GRANULARITIES"`
Expected: FAIL — `computeBoundaries` takes no 5th argument, `GranularityConfig` has no `subdivide`, and `action` has no `cutReasons`.

- [ ] **Step 3: Update `src/segment/types.ts`**

Add `scene_change` to the union:

```ts
export type BoundaryReason =
  | "session_start"
  | "focus_change" // app/window focus changed
  | "scene_change" // the screen itself changed — a kept keyframe (mpdecimate)
  | "dwell_gap" // activity resumed after a long input-idle gap (any event, including mouse_move)
  | "burst_gap" // activity resumed after a shorter gap between MEANINGFUL input (click/key/scroll)
  | "bookmark" // explicit user hotkey marker
  | "session_end"
  | "window"; // time-driven subdivision inside a span (no semantic boundary)
```

Add `subdivide` to `GranularityConfig`, after `cutReasons`:

```ts
  /**
   * Subdivide a span longer than `targetMs` into `targetMs` chunks. Defaults to
   * true (undefined means true), which is what "task" wants.
   *
   * `action` sets it FALSE. A sub-window is a slice of clock with no boundary
   * behind it and therefore no keyframe of its own, so a caption or a digest
   * attached to it is draped over time nothing distinguishes — exactly the
   * defect this design removes. An action span's length is bounded by
   * mpdecimate's `max` heartbeat instead, at capture time.
   */
  subdivide?: boolean;
```

Replace `BASE_GRANULARITIES`:

```ts
export const BASE_GRANULARITIES: GranularityConfig[] = [
  {
    name: "action",
    targetMs: 10_000,
    strideMs: 10_000,
    boundaryAware: true,
    // Inactivity indicates INTENT, not a change of state, so it does not cut
    // here — it is surfaced as its own rail lane instead.
    cutReasons: ["scene_change", "focus_change", "bookmark"],
    subdivide: false,
  },
  {
    name: "task",
    targetMs: 180_000,
    strideMs: 90_000,
    boundaryAware: true,
    cutReasons: ["focus_change", "bookmark"],
  },
];
```

- [ ] **Step 4: Update `src/segment/boundaries.ts`**

Replace the doc comment's bullet list, `PRIORITY`, the `MEANINGFUL_KINDS` constant, and the signature:

```ts
/**
 * Event-driven boundary detection. Candidate boundaries:
 *  - session_start (t=0) and session_end (endTMono) always bracket the timeline,
 *  - focus_change / bookmark events (semantic switches the user made),
 *  - scene_change: a kept keyframe, i.e. the screen itself changed. Passed
 *    SEPARATELY from `events` and never merged into them, because a frame is
 *    not input: merging would let a screen changing by itself close a dwell gap,
 *    which means the opposite of what dwell_gap asserts.
 *  - dwell_gap: activity resuming after ANY input-idle gap > dwellGapMs — the
 *    "nothing happened at all, not even mouse movement" signal,
 *  - burst_gap: activity resuming after a gap > burstGapMs between MEANINGFUL
 *    input (mouse_down, key_down, scroll) specifically. mouse_move is excluded:
 *    it samples every 12-100ms, so a check over ALL events almost never lets
 *    dwell_gap fire during active use — this is the finer signal that does.
 *
 * When several reasons land on the same t_mono, the most specific wins
 * (bookmark > focus_change > scene_change > dwell_gap > burst_gap); the
 * endpoints always stay session_start / session_end.
 */

import type { Boundary, BoundaryReason, SegEvent } from "./types.js";
import { DEFAULT_BURST_GAP_MS, DEFAULT_DWELL_GAP_MS } from "./types.js";

const PRIORITY: Record<BoundaryReason, number> = {
  session_start: 100,
  session_end: 100,
  bookmark: 30,
  focus_change: 20,
  scene_change: 15,
  dwell_gap: 10,
  burst_gap: 5,
  window: 0,
};

/**
 * Input that means the user DID something, as opposed to moving the pointer.
 *
 * Exported because the app's track rail draws the same gaps this detector cuts
 * at, and two readers of one rule is the drift hazard that already bit
 * ax-dump/ax-exec.
 */
export const MEANINGFUL_INPUT_KINDS: ReadonlySet<string> = new Set([
  "mouse_down",
  "key_down",
  "scroll",
]);

export function computeBoundaries(
  events: readonly SegEvent[],
  endTMono: number,
  dwellGapMs: number = DEFAULT_DWELL_GAP_MS,
  burstGapMs: number = DEFAULT_BURST_GAP_MS,
  sceneTMonos: readonly number[] = [],
): Boundary[] {
```

Inside the function, replace the `MEANINGFUL_KINDS.has(...)` reference with `MEANINGFUL_INPUT_KINDS.has(...)`, and add the scene loop between the event loop and `add(endTMono, "session_end")`:

```ts
  for (const t of sceneTMonos) add(t, "scene_change");
  add(endTMono, "session_end");
```

- [ ] **Step 5: Add the `subdivide` branch to `src/segment/windowing.ts`**

In the `if (g.boundaryAware)` branch, insert the early case at the top of the loop body:

```ts
  if (g.boundaryAware) {
    for (let i = 0; i < effective.length - 1; i++) {
      const b0 = effective[i]!;
      const b1 = effective[i + 1]!;
      // One segment per span: the span is a visual state, and a clock-sliced
      // piece of it is not a smaller state, just a smaller piece.
      if (g.subdivide === false) {
        mk(b0.tMono, b1.tMono, b0.reason);
        continue;
      }
      let start = b0.tMono;
```

The rest of the loop body is unchanged.

- [ ] **Step 6: Feed frames into `Segmenter`**

In `src/segment/segmenter.ts`, replace the body of `segment()` down to the `computeBoundaries` call:

```ts
  async segment(sessionId: string): Promise<SegmentResult> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const events = this.store.getEventsBySession(sessionId);

    const endTMono = this.deriveEnd(session.startedAt, session.endedAt, events);
    // A kept frame IS a visual state change — mpdecimate decided that at
    // capture time and FrameIngestor only wrote a row for frames that survived
    // it. Passed as bare t_monos, not as events, so boundaries.ts still sees
    // only SegEvent and `segment/` stays a leaf that knows nothing about frames.
    const sceneTMonos = this.store.getFramesBySession(sessionId).map((f) => f.tMono);
    const boundaries = computeBoundaries(
      events,
      endTMono,
      this.dwellGapMs,
      this.burstGapMs,
      sceneTMonos,
    );
    const granularities = this.granularitiesOverride ?? resolveGranularities(endTMono);
```

The rest of the method is unchanged. Also update the module docstring's second sentence:

```ts
 * Pure event-driven boundaries plus the session's own keyframes, which are the
 * visual-state-change signal; speech boundaries plug in later the same way.
```

- [ ] **Step 7: Export `MEANINGFUL_INPUT_KINDS` from the barrel**

In `src/index.ts`, find the export from `./segment/boundaries.js` (it exports `computeBoundaries`) and add the constant to it:

```ts
export { computeBoundaries, MEANINGFUL_INPUT_KINDS } from "./segment/boundaries.js";
```

If `computeBoundaries` is exported from a different grouping, add `MEANINGFUL_INPUT_KINDS` to that same statement.

- [ ] **Step 8: Run the full suite and fix what the boundary change exposes**

Run: `npm test`

Expected new failures are in the **seven test files that ingest frames and then segment**: `test/assemble.test.ts`, `test/ax.test.ts`, `test/caption.test.ts`, `test/rerank.test.ts`, `test/sharp-cropper.test.ts`, `test/tier2.test.ts`, `test/tier3.test.ts`. Every frame they ingest is now a `scene_change` boundary, so `action` produces more segments than before.

For each failure, recompute the expected value by hand using the exact mechanics above:
1. List the test's own events and the `t_mono` of every frame it ingests.
2. `computeBoundaries(events, endTMono, 3000, 1500, frameTMonos)` — priority `bookmark(30) > focus_change(20) > scene_change(15) > dwell_gap(10) > burst_gap(5)`, endpoints always `session_start`/`session_end`.
3. Filter to `action`'s `cutReasons` (`scene_change`, `focus_change`, `bookmark`, plus the two endpoints), then one segment per adjacent pair — `subdivide: false`, so no windowing.
4. `task` is unchanged: filter to `focus_change`/`bookmark` plus endpoints, then subdivide by `resolveGranularities(endTMono)`'s `targetMs`.

**Do not weaken an assertion** to make it pass. Re-run `npm test` after each fix until green.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no errors. A missing `scene_change` key in any `Record<BoundaryReason, ...>` surfaces here — `PRIORITY` in `boundaries.ts` and `BOUNDARY_TONE` in `app/src/main/session-tracks.ts` are both such maps. `BOUNDARY_TONE` is indexed with a fallback (`?? "neutral"`) and is typed `Record<string, TrackTone>`, so it will not error; add `scene_change: "accent"` to it anyway, in the same edit, so the rail colours the new reason deliberately rather than by fallback.

- [ ] **Step 10: Commit**

```bash
git add src/segment src/index.ts app/src/main/session-tracks.ts test/
git commit -m "$(cat <<'EOF'
feat(segment): cut action at visual state change, not at inactivity

A kept keyframe is now a scene_change boundary, and action cuts at
scene_change/focus_change/bookmark only. dwell_gap and burst_gap are still
computed and still returned — they just stop producing segments, because
inactivity indicates intent rather than a change of state.

Scene times are a SEPARATE parameter to computeBoundaries, never merged
into the event list: a frame is not input, and merging would let a screen
changing by itself close a dwell gap, which asserts the opposite of what
dwell_gap means.

action also stops subdividing by clock (subdivide: false). A sub-window
has no boundary behind it and so no keyframe of its own, which is what
made a caption drape over time nothing distinguishes. Span length is
bounded by mpdecimate's max heartbeat instead. One segment now holds
exactly one keyframe, which makes caption extent exact for free.
EOF
)"
```

---

### Task 6: `transcript_clip` table and Store methods

**Files:**
- Modify: `src/store/sqlite/schema.ts` (after the `segment_app_caption` table)
- Modify: `src/store/types.ts`
- Modify: `src/store/store.ts`
- Modify: `src/index.ts`
- Test: `test/transcript-clip.store.test.ts` (new)

**Interfaces:**
- Produces: `interface TranscriptClipInsert { id: string; sessionId: string; tMonoStart: number; tMonoEnd: number; text: string }`; `type TranscriptClipRow = TranscriptClipInsert`; `Store.putTranscriptClips(rows: TranscriptClipInsert[]): Promise<void>`; `Store.getTranscriptClipsBySession(sessionId: string): TranscriptClipRow[]`.

- [ ] **Step 1: Write the failing test in `test/transcript-clip.store.test.ts`**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";

describe("transcript_clip (Store.putTranscriptClips / getTranscriptClipsBySession)", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-clip-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips clips in time order and cascade-deletes with the session", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    await store.endSession(sessionId, 10_000);

    // Inserted out of order on purpose: the read is what must be ordered.
    await store.putTranscriptClips([
      { id: ulid(), sessionId, tMonoStart: 4000, tMonoEnd: 6000, text: "plus one equals two" },
      { id: ulid(), sessionId, tMonoStart: 1000, tMonoEnd: 2500, text: "one plus one" },
    ]);

    const clips = store.getTranscriptClipsBySession(sessionId);
    expect(clips.map((c) => [c.tMonoStart, c.tMonoEnd, c.text])).toEqual([
      [1000, 2500, "one plus one"],
      [4000, 6000, "plus one equals two"],
    ]);

    await store.deleteSession(sessionId);
    expect(store.getTranscriptClipsBySession(sessionId)).toEqual([]);
  });

  it("writing an empty array is a no-op, not an error", async () => {
    await expect(store.putTranscriptClips([])).resolves.toBeUndefined();
  });

  it("returns an empty array for a session that has none", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    expect(store.getTranscriptClipsBySession(sessionId)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/transcript-clip.store.test.ts`
Expected: FAIL — `store.putTranscriptClips` / `store.getTranscriptClipsBySession` do not exist (TypeScript error), and there is no table behind them.

- [ ] **Step 3: Add the table to `src/store/sqlite/schema.ts`**

Insert immediately **after** the `segment_app_caption` table block (before `CREATE TABLE IF NOT EXISTS frame`):

```sql
-- Utterance-level speech, with the timings whisper.cpp's -oj output actually
-- reports. The segment-level `segment.transcript` column stays as it is: it is
-- what the Tier-1 transcript vector view embeds. These rows are the finer
-- record and exist because a segment's span is NOT the span of the speech
-- inside it — the rail drew a 10s bar for a two-second sentence, four times
-- over with the same text.
CREATE TABLE IF NOT EXISTS transcript_clip (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  t_mono_start REAL NOT NULL,
  t_mono_end   REAL NOT NULL,
  text         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcript_clip_session
  ON transcript_clip(session_id, t_mono_start);
```

- [ ] **Step 4: Add the types and Store methods to `src/store/types.ts`**

Add these interfaces near the other segment-related row types:

```ts
/** One utterance, with the timings the STT provider reported. */
export interface TranscriptClipInsert {
  id: string;
  sessionId: string;
  tMonoStart: number;
  tMonoEnd: number;
  text: string;
}

export type TranscriptClipRow = TranscriptClipInsert;
```

Add these declarations to the `Store` interface, immediately after `getAppCaption`:

```ts
  /**
   * Persist utterance-level speech. SQLite only — no vector space is keyed on a
   * clip, so there is no SQLite→Lance ordering hazard here, the same as the
   * trace_* tables.
   */
  putTranscriptClips(rows: TranscriptClipInsert[]): Promise<void>;
  /** A session's clips in t_mono order. */
  getTranscriptClipsBySession(sessionId: string): TranscriptClipRow[];
```

- [ ] **Step 5: Implement in `src/store/store.ts`**

Remember `grep -a` for this file. Add two prepared statements inside `prepare()`, immediately after `selectSegmentAppCaption`:

```ts
      insertTranscriptClip: db.prepare(
        `INSERT INTO transcript_clip(id, session_id, t_mono_start, t_mono_end, text)
         VALUES (@id, @sessionId, @tMonoStart, @tMonoEnd, @text)`,
      ),
      selectTranscriptClipsBySession: db.prepare(
        `SELECT id, session_id, t_mono_start, t_mono_end, text
           FROM transcript_clip WHERE session_id = ? ORDER BY t_mono_start`,
      ),
```

Add the two methods immediately after `getAppCaption`:

```ts
  async putTranscriptClips(rows: TranscriptClipInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      const tx = this.db.transaction((rs: TranscriptClipInsert[]) => {
        for (const r of rs) {
          this.stmts.insertTranscriptClip.run({
            id: r.id,
            sessionId: r.sessionId,
            tMonoStart: r.tMonoStart,
            tMonoEnd: r.tMonoEnd,
            text: r.text,
          });
        }
      });
      tx(rows);
    });
  }

  getTranscriptClipsBySession(sessionId: string): TranscriptClipRow[] {
    const rows = this.stmts.selectTranscriptClipsBySession.all(sessionId) as {
      id: string;
      session_id: string;
      t_mono_start: number;
      t_mono_end: number;
      text: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      // safeIntegers makes column reads BigInt; these are small and every
      // consumer does arithmetic on them, so coerce here like hydrateFrame does.
      tMonoStart: Number(r.t_mono_start),
      tMonoEnd: Number(r.t_mono_end),
      text: r.text,
    }));
  }
```

Add `TranscriptClipInsert` and `TranscriptClipRow` to the file's existing `import type { ... } from "./types.js"` list.

- [ ] **Step 6: Export the types from the barrel**

In `src/index.ts`, add to the existing export block from `./store/types.js`:

```ts
  type TranscriptClipInsert,
  type TranscriptClipRow,
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run test/transcript-clip.store.test.ts`
Expected: PASS — all three cases.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If any other class implements `Store`, it surfaces here and needs both methods.

- [ ] **Step 9: Commit**

```bash
git add src/store test/transcript-clip.store.test.ts src/index.ts
git commit -m "$(cat <<'EOF'
feat(store): transcript_clip — utterance timings become a persisted fact

The whisper offsets already existed; TranscriptRepresenter computed them
to slice text per segment and then threw them away, so the only record of
speech was a segment span. That is how the rail came to draw a 10s bar for
a two-second sentence, four times over with the same text.

SQLite only — no vector is keyed on a clip, so no dual-store ordering
hazard, the same as the trace_* tables. Nothing writes rows yet; that is
the next commit.
EOF
)"
```

---

### Task 7: `TranscriptRepresenter` writes the clips

**Files:**
- Modify: `src/represent/transcript/transcript-representer.ts`
- Test: `test/transcript.test.ts`

**Interfaces:**
- Consumes: `Store.putTranscriptClips`, `TranscriptClipInsert` (Task 6); `TranscriptionResult.segments` (already on this branch).
- Produces: `TranscriptRepresentResult` gains `clipCount: number`.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe("TranscriptRepresenter (transcript view)", ...)` block in `test/transcript.test.ts`:

```ts
  it("persists utterance clips at absolute t_mono, not segment spans", async () => {
    const sessionId = ulid();
    const mk = (t: number, kind: string): EventInsert => ({
      id: ulid(), sessionId, tMono: t, kind,
    });
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([mk(0, "mouse_move"), mk(5000, "focus_change"), mk(6000, "key_down")]);
    await store.endSession(sessionId, 9000); // endTMono 8000

    // A 10s blob that does NOT start at zero: the clip's absolute time is
    // blob.tMonoStart + offset, and an off-by-that is the bug to catch.
    const blob = await blobs.write(sessionId, "mic", Uint8Array.from([1, 2, 3, 4, 5]), {
      tMonoStart: 2000, tMonoEnd: 12_000, codec: "wav",
    });
    await store.putBlobs([blob]);

    await new Segmenter(store).segment(sessionId);

    const rep = new TranscriptRepresenter(store, {
      transcriber: new FakeTranscription({ withTimestamps: true, clipDurationMs: 10_000 }),
      transcriptEmbedder: fake,
      blobStore: blobs,
    });
    const result = await rep.represent(sessionId);

    const clips = store.getTranscriptClipsBySession(sessionId);
    expect(clips).toHaveLength(2); // FakeTranscription splits the text in half
    expect(result.clipCount).toBe(2);
    // Offsets 0..5000 and 5000..10000, shifted by the blob's own start.
    expect(clips.map((c) => [c.tMonoStart, c.tMonoEnd])).toEqual([
      [2000, 7000],
      [7000, 12_000],
    ]);
    // The clip carries the utterance's OWN text, never the whole blob's.
    expect(clips[0]!.text).not.toBe(clips[1]!.text);
    expect(clips[0]!.text.length).toBeGreaterThan(0);
  });

  it("writes no clips when the provider gives no timestamps, and says so in the count", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    await store.putEvents([{ id: ulid(), sessionId, tMono: 0, kind: "mouse_move" } as EventInsert]);
    await store.endSession(sessionId, 9000);
    const blob = await blobs.write(sessionId, "mic", Uint8Array.from([9, 9]), {
      tMonoStart: 0, tMonoEnd: 8000, codec: "wav",
    });
    await store.putBlobs([blob]);
    await new Segmenter(store).segment(sessionId);

    const rep = new TranscriptRepresenter(store, {
      transcriber: new FakeTranscription(), // no withTimestamps
      transcriptEmbedder: fake,
      blobStore: blobs,
    });
    const result = await rep.represent(sessionId);

    expect(result.clipCount).toBe(0);
    expect(store.getTranscriptClipsBySession(sessionId)).toEqual([]);
    // Segment-level text is unaffected — the Tier-1 view still works.
    expect(result.transcribedCount).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/transcript.test.ts -t "utterance clips"`
Expected: FAIL — `TranscriptRepresentResult` has no `clipCount`, and nothing writes to `transcript_clip`.

- [ ] **Step 3: Implement the clip write**

In `src/represent/transcript/transcript-representer.ts`, add `ulid` and the insert type to the imports:

```ts
import { ulid } from "ulid";
import type {
  BlobRow,
  SegmentVectorInsert,
  Store,
  TranscriptClipInsert,
} from "../../store/types.js";
```

Add the field to the result interface:

```ts
export interface TranscriptRepresentResult {
  segmentCount: number;
  transcribedCount: number;
  /** Utterance rows written. 0 when the provider reported no timestamps. */
  clipCount: number;
  namespace: string;
}
```

Update the early return for a session with no segments:

```ts
    if (segments.length === 0) {
      return { segmentCount: 0, transcribedCount: 0, clipCount: 0, namespace: this.namespace };
    }
```

Immediately **after** the `for (const b of audioBlobs)` transcription loop and **before** `const transcripts: string[] = [];`, add the clip write:

```ts
    // Utterance extent, persisted. These are the same offsets the per-segment
    // slicing below uses — the difference is that a clip keeps them, so the
    // rail can draw the speech rather than the segment that contains it.
    const clips: TranscriptClipInsert[] = [];
    for (const b of audioBlobs) {
      const r = resultByBlob.get(b.id);
      if (!r?.segments) continue;
      for (const s of r.segments) {
        const text = s.text.trim();
        if (!text) continue;
        clips.push({
          id: ulid(),
          sessionId,
          tMonoStart: b.tMonoStart + s.startMs,
          tMonoEnd: b.tMonoStart + s.endMs,
          text,
        });
      }
    }
    await this.store.putTranscriptClips(clips);
```

Update the final return:

```ts
    return {
      segmentCount: segments.length,
      transcribedCount: segIds.length,
      clipCount: clips.length,
      namespace: this.namespace,
    };
```

Finally, add a paragraph to the class's module docstring, after the first:

```ts
 * It ALSO persists utterance-level clips (transcript_clip) from the provider's
 * own timestamps. The segment-level text is what the Tier-1 vector view embeds
 * and is unchanged; the clips exist because a segment's span is not the span of
 * the speech inside it, and only the clips can say where a sentence actually
 * was. A provider that reports no timestamps writes no clips — never a guessed
 * interval spanning the whole blob.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/transcript.test.ts`
Expected: PASS — the two new cases plus every pre-existing one (they assert on segment-level text, which is untouched).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. Any caller destructuring `TranscriptRepresentResult` surfaces here; `app/src/main/deskrag-service.ts` reads it for the indexing progress label.

- [ ] **Step 6: Commit**

```bash
git add src/represent/transcript/transcript-representer.ts test/transcript.test.ts
git commit -m "$(cat <<'EOF'
feat(transcript): persist utterance clips at absolute t_mono

Same offsets the per-segment slicing already used; the difference is that
they are now kept. A provider with no timestamps writes no clips rather
than a guessed interval spanning the whole blob — the segment-level text
path, which is what the Tier-1 view embeds, is untouched either way.
EOF
)"
```

---

### Task 8: Rail projection — `showLabels`, clip-sourced transcript, idle lane

**Files:**
- Modify: `app/src/shared/types.ts:319-336`
- Modify: `app/src/main/session-tracks.ts`
- Modify: `app/src/main/deskrag-service.ts:985-999`
- Test: `test/session-tracks.test.ts`

**Interfaces:**
- Consumes: `MEANINGFUL_INPUT_KINDS`, `DEFAULT_DWELL_GAP_MS`, `DEFAULT_BURST_GAP_MS` from `deskrag` (Task 5); `Store.getTranscriptClipsBySession` (Task 6).
- Produces: `TrackLaneDTO.showLabels: boolean` (required, not optional); `LaneInput.transcriptClips: readonly TranscriptClipInput[]`; `interface TranscriptClipInput { tMonoStart: number; tMonoEnd: number; text: string }`; `idleLane(input: LaneInput): TrackLaneDTO`.

- [ ] **Step 1: Write the failing tests**

In `test/session-tracks.test.ts`, add `idleLane` to the import list from `session-tracks.js`, add `transcriptClips: []` to the `input()` helper's defaults, and append these tests:

```ts
describe("showLabels", () => {
  it("is true ONLY for apps — the one identity span lane", () => {
    const tracks = buildSessionTracks({
      ...input([ev("focus_change", 0, { data: { app: "Calculator" } })]),
      sessionId: "s1",
      anchoredToVideo: false,
    });
    const labelled = tracks.lanes.filter((l) => l.showLabels).map((l) => l.id);
    expect(labelled).toEqual(["apps"]);
  });
});

describe("idleLane", () => {
  it("spans a dwell gap from the last event to the one that resumed", () => {
    const lane = idleLane(input([ev("key_down", 0), ev("key_down", 5000)]));
    expect(lane.spans).toHaveLength(1);
    expect(lane.spans![0]!.startSec).toBe(0);
    expect(lane.spans![0]!.endSec).toBe(5);
    expect(lane.spans![0]!.tone).toBe("warn");
  });

  it("reports a burst pause between meaningful input, ignoring mouse_move", () => {
    const lane = idleLane(
      input([ev("mouse_down", 0), ev("mouse_move", 1000), ev("key_down", 2000)]),
    );
    // 2000ms since the last MEANINGFUL event, under the 3000ms dwell gap.
    expect(lane.spans).toHaveLength(1);
    expect(lane.spans![0]!.tone).toBe("neutral");
  });

  it("never reports one gap twice — a dwell gap is not also a pause", () => {
    const lane = idleLane(input([ev("key_down", 0), ev("key_down", 5000)]));
    expect(lane.spans).toHaveLength(1);
  });

  it("says so when nothing was idle", () => {
    const lane = idleLane(input([ev("key_down", 0), ev("key_down", 100)]));
    expect(lane.spans).toEqual([]);
    expect(lane.emptyReason).not.toBeNull();
  });
});

describe("transcriptLane", () => {
  it("draws the UTTERANCE when clips exist, not the segment containing it", () => {
    const lane = transcriptLane(
      input([], {
        segments: [seg("a1", "action", 0, 10_000, { transcript: "one plus one" })],
        transcriptClips: [{ tMonoStart: 1000, tMonoEnd: 2500, text: "one plus one" }],
      }),
    );
    expect(lane.spans).toEqual([
      { startSec: 1, endSec: 2.5, label: "one plus one", tone: "ok" },
    ]);
    expect(lane.warning).toBeNull();
  });

  it("falls back to segment spans WITH a warning when there are no clips", () => {
    const lane = transcriptLane(
      input([], {
        segments: [seg("a1", "action", 0, 10_000, { transcript: "one plus one" })],
      }),
    );
    expect(lane.spans).toHaveLength(1);
    expect(lane.spans![0]!.endSec).toBe(10); // the SEGMENT's span, overstated
    expect(lane.warning).toContain("SEGMENTS");
  });

  it("has no warning when there is simply nothing transcribed", () => {
    const lane = transcriptLane(input([]));
    expect(lane.emptyReason).not.toBeNull();
    expect(lane.warning).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/session-tracks.test.ts`
Expected: FAIL — `idleLane` is not exported, `TrackLaneDTO` has no `showLabels`, and `LaneInput` has no `transcriptClips`.

- [ ] **Step 3: Add `showLabels` to the DTO**

In `app/src/shared/types.ts`, add the field to `TrackLaneDTO`, after `shape`:

```ts
  /**
   * Whether this lane's spans may paint their label into the bar.
   *
   * `span` lanes ONLY — `mark` and `thumb` lanes carry labels in the DTO but the
   * renderer has never painted them, and `density` lanes have no label at all.
   *
   * Prose lanes are false. Adjacent segments each carrying a caption made the
   * rail one run-on clipped paragraph; the text lives in the hover card, which
   * resolves every lane at the cursor at once. Only `apps` is true, and even
   * then the renderer paints the label only if it fits untruncated.
   */
  showLabels: boolean;
```

- [ ] **Step 4: Update every lane builder in `app/src/main/session-tracks.ts`**

Add the import at the top:

```ts
import {
  DEFAULT_BURST_GAP_MS,
  DEFAULT_DWELL_GAP_MS,
  MEANINGFUL_INPUT_KINDS,
  urlPrefix,
  type AxSnapshotRow,
  type EventRow,
  type FrameRow,
  type SegmentRow,
} from "deskrag";
```

Add `showLabels` to the object literal each builder returns. It is `true` in `appsLane` only; `false` in `webLane`, `markersLane`, `rateLane`, `clicksLane`, `axLane`, `framesLane`, `mouseSpeedLane`, `mouseXyLane`, `audioLanes` (both the no-audio lane and the mapped ones), `segmentLanes`, `presenceLane`, and the new `idleLane`.

Add `transcriptClips` to `LaneInput`, and the input type above it:

```ts
/** One utterance, projected from a `transcript_clip` row. */
export interface TranscriptClipInput {
  tMonoStart: number;
  tMonoEnd: number;
  text: string;
}
```

```ts
  /** Utterance-level speech. Empty for a session transcribed without timings. */
  transcriptClips: readonly TranscriptClipInput[];
```

Add `scene_change` to `BOUNDARY_TONE` if Task 5 Step 9 did not already:

```ts
const BOUNDARY_TONE: Record<string, TrackTone> = {
  session_start: "ok",
  session_end: "ok",
  focus_change: "accent",
  scene_change: "accent",
  dwell_gap: "warn",
  burst_gap: "warn",
  bookmark: "ok",
  window: "neutral",
};
```

- [ ] **Step 5: Replace `transcriptLane` and add `idleLane`**

Replace the existing `transcriptLane`:

```ts
/**
 * Speech, at the extent it was actually spoken.
 *
 * Clips carry the provider's own timings, so a two-second sentence is a
 * two-second bar. Without them the only record is the SEGMENT that contained
 * the speech — which is what this lane used to draw, giving a 10s bar for that
 * same sentence and repeating the text across every segment the blob touched.
 * That fallback is kept, because a transcript at the wrong extent still beats
 * no transcript, but it is DISCLOSED rather than smoothed over — the same rule
 * `observations` vs `sources` follows on the Flows screen.
 */
export function transcriptLane(input: LaneInput): TrackLaneDTO {
  if (input.transcriptClips.length > 0) {
    return {
      id: "transcript",
      title: "transcript",
      shape: "span",
      showLabels: false,
      spans: input.transcriptClips
        .slice()
        .sort((a, b) => a.tMonoStart - b.tMonoStart)
        .map((c) => ({
          startSec: secOf(c.tMonoStart, input.originMono),
          endSec: secOf(c.tMonoEnd, input.originMono),
          label: c.text,
          tone: "ok" as TrackTone,
        })),
      emptyReason: null,
      warning: null,
    };
  }
  const fallback = presenceLane(
    input,
    "transcript",
    "transcript",
    (s) => s.transcript,
    "nothing was transcribed — most likely no whisper model was configured when this was indexed",
  );
  return {
    ...fallback,
    warning:
      fallback.emptyReason === null
        ? "no utterance timings were recorded — these bars are the SEGMENTS that contain speech, not the speech itself"
        : null,
  };
}
```

Add `idleLane` in the `--- input ---` section, after `clicksLane`:

```ts
/**
 * Inactivity — the INTENT signal, shown as itself.
 *
 * It used to cut `action` segments, which conflated "the user paused" with
 * "the state changed". Those are different questions and only the second one
 * segments a recording, so the gaps live here now.
 *
 * The rule is imported from the boundary detector rather than restated:
 * MEANINGFUL_INPUT_KINDS and both gap constants come from `deskrag`, because
 * two readers of one rule is the drift hazard that already bit ax-dump/ax-exec.
 */
export function idleLane(input: LaneInput): TrackLaneDTO {
  const spans: TrackSpanDTO[] = [];
  let lastT: number | undefined;
  let lastMeaningfulT: number | undefined;
  for (const e of input.events) {
    const meaningful = MEANINGFUL_INPUT_KINDS.has(e.kind);
    if (lastT !== undefined && e.tMono - lastT > DEFAULT_DWELL_GAP_MS) {
      spans.push({
        startSec: secOf(lastT, input.originMono),
        endSec: secOf(e.tMono, input.originMono),
        label: `idle ${((e.tMono - lastT) / 1000).toFixed(1)}s`,
        tone: "warn",
      });
    } else if (
      // `else`, so a dwell gap is never ALSO reported as a pause: one stretch
      // of time is one fact, and the stronger name for it wins.
      meaningful &&
      lastMeaningfulT !== undefined &&
      e.tMono - lastMeaningfulT > DEFAULT_BURST_GAP_MS
    ) {
      spans.push({
        startSec: secOf(lastMeaningfulT, input.originMono),
        endSec: secOf(e.tMono, input.originMono),
        label: `pause ${((e.tMono - lastMeaningfulT) / 1000).toFixed(1)}s`,
        tone: "neutral",
      });
    }
    lastT = e.tMono;
    if (meaningful) lastMeaningfulT = e.tMono;
  }
  return {
    id: "idle",
    title: "idle",
    shape: "span",
    showLabels: false,
    spans,
    emptyReason:
      spans.length === 0 ? "no idle gaps — input was continuous throughout" : null,
    warning: null,
  };
}
```

Add it to `buildSessionTracks`'s lane list, immediately after `clicksLane(input)`:

```ts
      clicksLane(input),
      idleLane(input),
      scrollLane(input),
```

- [ ] **Step 6: Wire it in `app/src/main/deskrag-service.ts`**

In `sessionTracks`, add one line to the `buildSessionTracks({...})` call, after `keyframes: detail.keyframes,`:

```ts
      transcriptClips: this.store.getTranscriptClipsBySession(sessionId),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/session-tracks.test.ts`
Expected: PASS. Pre-existing tests in this file that assert a whole lane object with `toEqual` will now fail on the missing `showLabels` key — add `showLabels: false` (or `true` for `apps`) to those expected objects. That is a real assertion tightening, not a weakening.

- [ ] **Step 8: Typecheck both packages**

Run: `npm run typecheck`
Run: `npm --prefix app run typecheck`
Expected: no errors in either. `showLabels` is required, so any lane builder that forgot it surfaces here.

- [ ] **Step 9: Commit**

```bash
git add app/src/shared/types.ts app/src/main/session-tracks.ts app/src/main/deskrag-service.ts test/session-tracks.test.ts
git commit -m "$(cat <<'EOF'
feat(app): transcript lane draws utterances; idle becomes its own lane

The transcript lane is built from transcript_clip rows, so a two-second
sentence is a two-second bar. A session with no clips still renders
segment spans and now WARNS that they are the segments containing speech
rather than the speech — disclosed, not smoothed over.

dwell/burst gaps get their own lane. They stopped cutting action segments
in the segment commit; this is where they become visible as the intent
signal they actually are, using MEANINGFUL_INPUT_KINDS and both gap
constants imported from the detector rather than restated.

showLabels is decided here, in the projection, so the renderer never makes
an editorial call. Only `apps` is true.
EOF
)"
```

---

### Task 9: Rail rendering — true extent, padded hit rect, no ellipsis

**Files:**
- Modify: `app/src/renderer/src/screens/track-view.ts`
- Modify: `app/src/renderer/src/screens/TrackLane.tsx:62-83`
- Modify: `app/src/renderer/src/styles.css:1510-1532`
- Test: `test/track-view.test.ts`

**Interfaces:**
- Consumes: `TrackLaneDTO.showLabels` (Task 8).
- Produces: `labelFits(spanSec: number, totalSec: number, axisWidth: number, text: string): boolean`; `spanRects(startSec: number, endSec: number, totalSec: number, axisWidth: number, minHitPx: number): SpanRects`; `interface SpanRects { leftPct: number; widthPct: number; hit: { leftPx: number; widthPx: number } | null }`.

- [ ] **Step 1: Write the failing tests**

Add to `test/track-view.test.ts`, importing `labelFits` and `spanRects` alongside the existing imports:

```ts
describe("labelFits", () => {
  it("refuses a label the bar cannot hold untruncated", () => {
    // 1s of a 100s axis on a 1000px rail is 10px — nothing fits.
    expect(labelFits(1, 100, 1000, "Calculator")).toBe(false);
  });

  it("allows a short label in a wide bar", () => {
    expect(labelFits(50, 100, 1000, "Calculator")).toBe(true);
  });

  it("depends on DURATION, never position — the rule cannot flip under translation", () => {
    // spanRects moves; labelFits must not. Same duration, same answer.
    expect(labelFits(50, 100, 1000, "Calculator")).toBe(labelFits(50, 100, 1000, "Calculator"));
    expect(labelFits(5, 100, 1000, "Calculator")).toBe(false);
  });

  it("is false before the axis has been measured, and for empty text", () => {
    expect(labelFits(50, 100, 0, "Calculator")).toBe(false);
    expect(labelFits(50, 100, 1000, "")).toBe(false);
  });
});

describe("spanRects", () => {
  it("gives the bar the signal's TRUE extent as percentages", () => {
    const r = spanRects(2, 4, 10, 1000, 12);
    expect(r.leftPct).toBeCloseTo(20);
    expect(r.widthPct).toBeCloseTo(20);
  });

  it("pads a hair-thin bar's HIT rect without widening the bar", () => {
    const r = spanRects(5, 5.01, 10, 1000, 12);
    expect(r.widthPct).toBeCloseTo(0.1); // the bar stays honest: 1px
    expect(r.hit!.widthPx).toBe(12); // the target does not
    // Centred on the bar: 500.5px centre, 12px wide.
    expect(r.hit!.leftPx).toBeCloseTo(494.5);
  });

  it("clamps the hit rect INTO the axis at both ends", () => {
    // A keyframe at t=0 would otherwise put its target over the title gutter,
    // which is the transport's column too.
    expect(spanRects(0, 0, 10, 1000, 12).hit!.leftPx).toBe(0);
    expect(spanRects(10, 10, 10, 1000, 12).hit!.leftPx).toBe(988);
  });

  it("moves the hit rect by exactly the shift under a uniform translation", () => {
    const a = spanRects(2, 4, 10, 1000, 12);
    const b = spanRects(3, 5, 10, 1000, 12);
    expect(b.hit!.leftPx - a.hit!.leftPx).toBeCloseTo(100);
    expect(b.hit!.widthPx).toBe(a.hit!.widthPx);
  });

  it("returns a null hit rect before the axis is measured", () => {
    // The bar still renders from its percentages, so nothing flashes empty on
    // the frame before the ResizeObserver first fires.
    const r = spanRects(2, 4, 10, 0, 12);
    expect(r.leftPct).toBeCloseTo(20);
    expect(r.hit).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/track-view.test.ts`
Expected: FAIL — neither `labelFits` nor `spanRects` is exported from `track-view.ts`.

- [ ] **Step 3: Add both rules to `app/src/renderer/src/screens/track-view.ts`**

Append to the file:

```ts
/**
 * Average glyph advance for `.tracks__span-label` (11px system stack), in px,
 * plus its horizontal padding (5px each side).
 *
 * A constant rather than a DOM measurement, deliberately: this module is pure
 * and root-tested, and measuring text would put the rule behind a canvas or a
 * layout pass. The cost of the approximation is that a borderline label may be
 * withheld when it would just have fitted, which is the safe direction — the
 * text is one hover away either way.
 */
const LABEL_CH_PX = 6.2;
const LABEL_PAD_PX = 10;

/**
 * May this span paint its label into the bar?
 *
 * Only when it fits UNTRUNCATED. The rail used to stamp a caption into every
 * 10s segment and clip it, so adjacent bars read as one run-on paragraph and
 * every one of them ended in an ellipsis. Nothing truncates now: a label either
 * fits or it is not drawn.
 *
 * It depends on the span's DURATION and never its position, so — like
 * thumbPlacement — the answer cannot flip under a uniform time shift.
 */
export function labelFits(
  spanSec: number,
  totalSec: number,
  axisWidth: number,
  text: string,
): boolean {
  if (totalSec <= 0 || axisWidth <= 0 || text.length === 0) return false;
  const spanPx = (spanSec / totalSec) * axisWidth;
  return spanPx >= text.length * LABEL_CH_PX + LABEL_PAD_PX;
}

export interface SpanRects {
  /** The visual bar, as percentages — no measurement needed, so it never flashes. */
  leftPct: number;
  widthPct: number;
  /** The hit target in px, padded to `minHitPx`. Null until the axis is measured. */
  hit: { leftPx: number; widthPx: number } | null;
}

/**
 * The bar and its hit target, which are NOT the same rectangle.
 *
 * The bar is the signal's true extent, down to a sub-pixel sliver. Widening it
 * so it can be clicked is exactly the overstatement this rail was rebuilt to
 * remove — a bar that claims two seconds for an instantaneous click is a lie
 * told for the mouse's benefit. So the target is a separate transparent rect,
 * padded to `minHitPx` and centred on the bar. Same principle as the Flows
 * canvas drawing every wire twice with a fat transparent stroke underneath.
 *
 * The target is CLAMPED into the axis: centred on a span at t=0 it would hang
 * into the title gutter, which is the transport's column.
 */
export function spanRects(
  startSec: number,
  endSec: number,
  totalSec: number,
  axisWidth: number,
  minHitPx: number,
): SpanRects {
  const frac = totalSec > 0 ? 1 / totalSec : 0;
  const leftPct = startSec * frac * 100;
  const widthPct = Math.max(0, (endSec - startSec) * frac * 100);
  if (axisWidth <= 0) return { leftPct, widthPct, hit: null };

  const left = startSec * frac * axisWidth;
  const width = Math.max(0, (endSec - startSec) * frac * axisWidth);
  const widthPx = Math.max(width, minHitPx);
  const leftPx = Math.max(
    0,
    Math.min(axisWidth - widthPx, left + width / 2 - widthPx / 2),
  );
  return { leftPct, widthPct, hit: { leftPx, widthPx } };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/track-view.test.ts`
Expected: PASS — all cases in both new blocks, plus the pre-existing `thumbPlacement`, `densityPath` and `readoutAt` blocks.

- [ ] **Step 5: Render it in `app/src/renderer/src/screens/TrackLane.tsx`**

Add to the imports:

```ts
import { densityPath, labelFits, spanRects, thumbPlacement } from "./track-view.js";
```

Add the constant beside `THUMB_PX`:

```ts
/**
 * Minimum width of a span's HIT target, in px. The bar itself is never widened
 * — see `spanRects`.
 */
const MIN_HIT_PX = 12;
```

Replace the whole `if (lane.shape === "span") { ... }` block in `LaneBody`:

```tsx
  if (lane.shape === "span") {
    return (
      <>
        {lane.spans?.map((s, i) => {
          const r = spanRects(s.startSec, s.endSec, totalSec, axisWidth, MIN_HIT_PX);
          const showLabel =
            lane.showLabels && labelFits(s.endSec - s.startSec, totalSec, axisWidth, s.label);
          return (
            <React.Fragment key={i}>
              <div
                className="tracks__span"
                data-tone={s.tone}
                style={{ left: `${r.leftPct}%`, width: `${r.widthPct}%` }}
              >
                {showLabel && <span className="tracks__span-label">{s.label}</span>}
              </div>
              <div
                className="tracks__span-hit"
                style={
                  r.hit
                    ? { left: r.hit.leftPx, width: r.hit.widthPx }
                    : { left: `${r.leftPct}%`, width: `${r.widthPct}%` }
                }
              />
            </React.Fragment>
          );
        })}
      </>
    );
  }
```

- [ ] **Step 6: Update `app/src/renderer/src/styles.css`**

Replace the `.tracks__span` and `.tracks__span-label` rules (currently at 1510-1532):

```css
/* Centred at a fixed height rather than inset from the lane's edges: at 48px an
   edge-inset bar fills the lane and the rail reads as a stack of blocks.

   `pointer-events: none` because the bar is the signal's TRUE extent and must
   never be widened to be clickable — .tracks__span-hit below is the target. */
.tracks__span {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  height: 26px;
  min-width: 1px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--tone);
  pointer-events: none;
}

/* No `text-overflow: ellipsis`, on purpose. Nothing in this rail truncates:
   `labelFits` withholds a label that would not fit, so an ellipsis could only
   ever mean that rule had broken — and hiding that is how the run-on paragraph
   this replaced went unnoticed. The parent's `overflow: hidden` (for the
   rounded corners) is the backstop. */
.tracks__span-label {
  display: block;
  padding: 6px 5px;
  color: var(--ink);
  font-size: 11px;
  line-height: 14px;
  white-space: nowrap;
}

/* The hit target: transparent, padded to MIN_HIT_PX, centred on its bar. Same
   principle as the Flows wire's fat transparent stroke under a 2px path — a
   2px-wide thing cannot be hit with a mouse, and the fix belongs in the target
   rather than in the drawing. */
.tracks__span-hit {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  height: 26px;
  background: transparent;
  pointer-events: auto;
}
```

- [ ] **Step 7: Typecheck both packages**

Run: `npm run typecheck`
Run: `npm --prefix app run typecheck`
Expected: no errors.

- [ ] **Step 8: Run the full renderer-adjacent tests**

Run: `npx vitest run test/track-view.test.ts test/session-tracks.test.ts test/track-buckets.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add app/src/renderer/src/screens/track-view.ts app/src/renderer/src/screens/TrackLane.tsx app/src/renderer/src/styles.css test/track-view.test.ts
git commit -m "$(cat <<'EOF'
feat(app): rail bars carry true extent; text moves to the hover card

Two pure rules, root-tested like thumbPlacement.

labelFits withholds a label that would not fit untruncated, so nothing in
the rail ends in an ellipsis any more — an ellipsis could now only mean the
rule had broken, and hiding that is how the run-on paragraph of clipped
captions went unnoticed. It depends on the span's duration, never its
position, so it cannot flip under a uniform time shift.

spanRects separates the bar from its hit target. The bar keeps the signal's
true extent down to a sub-pixel sliver; the target is a transparent rect
padded to 12px and clamped into the axis. Widening the bar so it could be
clicked would be the same overstatement, told for the mouse's benefit.
EOF
)"
```

---

### Task 10: Update CLAUDE.md and validate against a real recording

**Files:**
- Modify: `CLAUDE.md`
- No test file. The deliverable is a recording, read out of the store.

**Interfaces:**
- Consumes: everything from Tasks 1-9.

This repo's two worst bugs were both invisible to `npm test` and obvious within minutes of driving a real session. This task is the one that would catch a third.

- [ ] **Step 1: Run the full suite and both typechecks**

Run: `npm test`
Run: `npm run typecheck`
Run: `npm --prefix app run typecheck`
Expected: all green. Do not proceed past a failure.

- [ ] **Step 2: Build and reset the data dir**

```bash
npm run build
rm -rf ~/Library/Application\ Support/deskrag-app/DeskRAG
```

The schema changed and there is no migration. Deleting the directory is the intended and only path.

- [ ] **Step 3: Record a real session**

```bash
npm run app:dev
```

Record roughly 30-60 seconds that exercises all four changes:
1. A **Calculator** sequence — several button presses. This is the case that produced 1 keyframe in 16s.
2. **Speak** while doing it, so there is a transcript with real utterances.
3. **Switch apps** at least once, so `focus_change` and `task` are exercised.
4. **Sit still** for more than 3 seconds at some point, so the idle lane has something to draw.

Let indexing finish, then open the recording in Library.

- [ ] **Step 4: Read what actually landed, in the store — not only on screen**

```bash
sqlite3 ~/Library/Application\ Support/deskrag-app/DeskRAG/app.db \
  "SELECT (SELECT count(*) FROM frame) AS frames,
          (SELECT count(*) FROM segment WHERE granularity='action') AS actions,
          (SELECT count(*) FROM segment WHERE granularity='task') AS tasks,
          (SELECT count(*) FROM transcript_clip) AS clips;"

sqlite3 ~/Library/Application\ Support/deskrag-app/DeskRAG/app.db \
  "SELECT boundary_reason, count(*) FROM segment WHERE granularity='action' GROUP BY 1;"

sqlite3 ~/Library/Application\ Support/deskrag-app/DeskRAG/app.db \
  "SELECT round(t_mono_start), round(t_mono_end), substr(text,1,40) FROM transcript_clip ORDER BY t_mono_start;"
```

Check every one of these, and record the numbers in the commit message:
- **`frames` is many more than 1** for a Calculator session. This is the defect that started the work; if it is still small, the mpdecimate parameters are wrong and Task 4 needs re-running with the dump inspected.
- **`actions` ≈ `frames`**, give or take the `focus_change` and `bookmark` cuts. A large mismatch means `subdivide: false` or `cutReasons` did not take.
- **No `action` row has `boundary_reason` of `dwell_gap`, `burst_gap` or `window`.** Any of the three means inactivity or the clock is still cutting.
- **`clips` > 0 and each clip's span is SHORTER than the segments around it.** A clip spanning a whole 10s blob means the provider gave no timestamps — check whether whisper actually ran.

- [ ] **Step 5: Read the rail on screen**

Open the recording in Library and confirm by eye:
- No text is clipped anywhere; no ellipsis appears in any lane.
- The `apps` lane shows app names in wide bars and nothing in narrow ones.
- `action`, `task`, `transcript` and `caption` show bars with no text; hovering shows the text in the card.
- The `transcript` lane's bars are short and separated, not a contiguous run of repeated text, and the lane carries **no** warning triangle.
- The `idle` lane shows the pause from Step 3.
- A hair-thin bar can still be hovered.
- The `keyframes` lane has many thumbnails.

- [ ] **Step 6: Update `CLAUDE.md`**

Four edits, each replacing a statement this work falsified:

1. In **"Non-obvious invariants"**, the frozen-schema rule. Replace the assertion that an existing table's shape can never change with: the schema is still `CREATE TABLE IF NOT EXISTS` with no migration mechanism, and the resolution is now to **delete the data dir** rather than to add a table — record that `transcript_clip` was added under that rule and that there is deliberately no version guard.

2. In the **Pipeline** section, the `FfmpegScreenProducer` paragraph. It currently says the `fps` filter sits on the two sampling branches. Replace with the single sampling branch, `mpdecimate` before the split, and the reason index pairing survives (`tMono` is arrival-stamped, not index-derived). State the disclosed pHash consequence.

3. In the **Pipeline** section, the `KeyframeGate` references — there are two, one in the AX-at-boundaries paragraph and one implied by "the gate drops dupes". Replace with `KeyframeBudget`, and record why: a 32×32 thumbnail's 64-bit hash cannot represent a Calculator digit, measured at 1 keyframe per 16 seconds.

4. Add a new bullet to the **Pipeline** section for the segmentation rule: `action` cuts at `scene_change`/`focus_change`/`bookmark` and does not subdivide; inactivity is an intent signal with its own rail lane; one segment holds one keyframe, which is what makes caption extent exact.

Include the measured numbers from Step 4 in edits 3 and 4 — this file's value is that its claims are measurements.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: record what the visual-state keyframe work changed

Measured on a real recording after the change:
<frames / actions / tasks / clips from Step 4, and the boundary_reason
breakdown — the before figure was 1 keyframe in 16 seconds>

Four CLAUDE.md claims were falsified by this work and are rewritten: the
frozen-schema invariant (the resolution is now deleting the data dir, and
transcript_clip was added under that rule), the ffmpeg branch topology,
KeyframeGate as the keyframe decider, and what cuts an action segment.
EOF
)"
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: capture graph + budget + probe → Tasks 1-4; segmentation → Task 5; store + represent → Tasks 6-7; rail projection → Task 8; rail rendering → Task 9; the CLAUDE.md rewrite and real-recording validation the spec's testing section demands → Task 10. The spec's "caption extent needs no code change" is deliberately absent as a task and asserted in Task 10 Step 4 instead (`actions ≈ frames`), which is the only place it can be checked.

**Known deviation from the spec, deliberate.** The spec described scene changes reaching `computeBoundaries` as synthetic `SegEvent`s merged into the event list. Task 5 passes them as a separate `sceneTMonos` parameter instead: merging would let a screen changing by itself close a `dwell_gap`, which asserts the opposite of what `dwell_gap` means. `segment/` stays a leaf either way. Task 5 Step 1 has a test pinning this.

**Ordering constraint.** Tasks 1-2 must precede 3 (the graph change assumes the budget is what limits rate). Task 5 must precede 8 (`MEANINGFUL_INPUT_KINDS` and `BOUNDARY_TONE`). Task 6 must precede 7 and 8. Task 8 must precede 9 (`showLabels`). Task 4 may be deferred but not skipped — Task 3's defaults are marked provisional and Task 10 Step 4 will fail against a real recording if they are wrong.
