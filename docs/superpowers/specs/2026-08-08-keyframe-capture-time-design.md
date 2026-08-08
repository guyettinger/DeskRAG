# Keyframe capture time: stamp a sampled frame from ffmpeg's PTS, not its arrival

**Date:** 2026-08-08
**Status:** Design approved, pending spec review

## Context

CLAUDE.md carried this as an open note:

> **Open, unrelated: the stored keyframe JPEG appears to LAG its own `t_mono`
> stamp by ~3.2s.** On one real recording, every result card showed a picture
> whose on-screen recorder clock ran 3.1–3.2s behind the card's timecode
> (21.909/18.710, 22.911/19.810, 23.901/20.710, …). The video is exactly right,
> so this points at the MJPEG branch's latency against `enqueue()`'s
> arrival-time stamp.

The MJPEG branch is not the cause, and the effect is not confined to
navigation. The cause is that **`FfmpegScreenProducer` discards ffmpeg's
capture timestamp and substitutes wall-clock arrival time.** The video branch
is correct precisely because it keeps PTS. Every millisecond of latency
anywhere in the capture chain therefore lands in `frame.t_mono` as error.

### Measurements

All against the app's exact filter graph (`fps=1`, `imageMaxWidth: 1280`,
`-q:v 5`, `DEFAULT_DECIMATE`, video on at 10fps), on an M-series Mac with
ffmpeg 8.0.1. Re-take them with `scripts/capture-latency-probe.mjs`, which this
work adds (see Testing) — it does not exist yet.

**The two sampling branches are not skewed relative to each other.** Grayscale
and MJPEG frames arrive within 1ms, one chunk per frame (1024B and ~46KB),
25/25 and 30/30 frames. `pair()` and pipe buffering are both exonerated — the
first hypothesis, and it was wrong.

**A synthetic bench with ground truth.** The source burns the input frame
number into the picture as an 8-stripe binary barcode, so the 32×32 grayscale
branch alone recovers which input frame a sample is, with no OCR and no JPEG
decode. With `-re`, input frame N is produced at `t0 + N/videoFps`, so the
picture's true time is known exactly. Results at `fps=1`:

| stamped from | error vs. true content time |
| --- | --- |
| arrival (`clock.now()`, as shipped) | **+0.64s**, after settling from +1.08s over ~8 samples |
| ffmpeg PTS with `fps=1` | **−0.400s**, zero variance |
| ffmpeg PTS with `select` + `-fps_mode passthrough` | **0.000s**, all 14 samples |

**The lag is the sampling period, not anything downstream.** Arrival lag was
0.35s at `fps=2`, 1.04s at `fps=1`, 2.55s at `fps=0.5`. Removing the video
branch and x264 entirely changed it from 1.037s to 1.038s.

**The real device is where the 3.2s comes from.** Against a live avfoundation
screen source, `arrival − pts` measured **3.050s median**, with 24 of 25
samples inside 3.040–3.061s. That reproduces the reported 3.1–3.2s on a
different day and without the app. Splitting it: the device takes **D ≈ 808ms**
to start capturing after spawn (`mach_absolute_time` of the first captured
frame minus monotonic time at spawn), leaving ~2.2s of genuine
capture-to-delivery latency inside avfoundation.

**PTS needs no absolute clock.** Normalized sampling PTS already equals video
media time: encoding the barcode source to mp4 and decoding frames back gives
`media 0s → N=0`, `1s → N=10`, `2s → N=20`, exact. (`3s → N=32` is
fragment-granular seeking on the fragmented MP4, which CLAUDE.md already
documents, not a timestamp offset.) The `select` bench above used no
`-copyts`. So `frame.tMono = video.tMonoStart + pts` requires no `-copyts`, no
second timestamp tap on the video branch, and no bridge between clock bases.

That last point killed an earlier direction. `-copyts` does expose
avfoundation's absolute `mach_absolute_time` base, per output, leaving the mp4
normalized — but Node's clock (`performance.now()` via `uv_hrtime`) is on
`mach_continuous_time`, which includes sleep and sat 4.8 days away on this
machine. Bridging them would need a `mach_absolute_time` reading Node cannot
make without new native code. None of it is necessary.

### Why it is wider than navigation

`frame.t_mono` is not only a seek target:

- A kept keyframe becomes a `scene_change` boundary (`segment/boundaries.ts:83`),
  which drives segment spans, digests, caption extents, transcript clip
  slicing, and trace node times. All of it is shifted ~3s later than the pixels.
- Keyframe AX is walked inside `ingestFrame` (`capture/session.ts:140`), so the
  stored tree describes a screen ~2.2s **newer** than the JPEG it is keyed to.
  Input events are stamped in real time, so region proposal fuses clicks and AX
  labels against a picture from seconds earlier.

The second one is structurally the same bug as the one `AxCapturer.boundaryTMono`
already exists to fix — a walk that post-dates what it describes, measured at
54% of nodes incoherent before that fix — one layer down, and unrecorded.

## Goal

**A keyframe, the video frame showing it, and the rail playhead land on the same
moment.** Achieved exactly from PTS, because both branches share one PTS base.

Explicitly *not* a goal: absolute agreement between frames and input events.
See "Disclosed residual".

## Design

### 1. Capture: stamp from PTS

**Rate limit by `select`, not `fps`.** In `FfmpegScreenProducer.args()`:

```
select='isnan(prev_selected_t)+gte(t-prev_selected_t\,${1 / fps})'
```

replaces `fps=${fps}` in the same position — before `scale`, before
`mpdecimate` — so decimation semantics and cost are unchanged. The
`FfmpegScreenOptions.fps` option keeps its name and meaning (samples per
second); only the filter implementing it changes.

This is not a cosmetic swap. `vf_fps` picks the last frame before each slot
boundary and **relabels it to the slot start**, which is the measured −0.400s:
PTS names the slot, the picture is up to one sampling period newer. `select`
keeps each frame's own PTS, measured at 0.000s error. It also picks the *first*
frame at least `1/fps` after the previous one, which matches `KeyframeBudget`'s
existing "keeps the FIRST frame of a burst" rule rather than fighting it.

`select` does not change the stream's frame-rate metadata, so the default CFR
mode duplicates frames back up to the input rate — measured, 139 frames where
14 were expected. **`-fps_mode passthrough` on each sampling output is
mandatory**, not tidiness. It goes on the sampling outputs only; the mp4 keeps
CFR at `videoFps`, verified in the same run.

`-fps_mode` requires ffmpeg 5.1+ (2022). `-vsync passthrough` is the older
spelling and still works, but prints a deprecation line on every run, and the
producer routes stderr straight to `onError` and the user — the same concern
that already tuned `-loglevel` to `warning`. So: `-fps_mode`, and a version
floor documented in `docs/setup.md`.

**A third tap.** `[d]split=3[g][c][t]` with
`-map "[t]" -fps_mode passthrough -f mkvtimestamp_v2 pipe:4`, emitting one
millisecond value per kept frame. It is downstream of the same decimator as the
other two, so it stays index-aligned by exactly the argument that already keeps
gray and MJPEG paired — the invariant extends rather than changes. `stdio`
becomes `["ignore", "pipe", "pipe", storeImages ? "pipe" : "ignore", "pipe"]`,
keeping fd 4 fixed so the timestamp pipe does not move when images are off.

**`TimestampLineSplitter`**, a new pure module beside `JpegStreamSplitter` and
`FrameChunker`: buffer until a newline before parsing, and drop the
`# timecode format v2` header. This is the AX-sidecar rule restated — a chunk
boundary lands mid-line, and per-chunk splitting works until the stream is long
enough that it doesn't.

**`pair()` goes three-way and `enqueue` stops reading the clock:**

```ts
tMono = origin + ptsMs   // computed at pair time, not inside ingestChain
```

This also removes a defect found by reading rather than measuring: today
`enqueue()` evaluates `ctx.clock.now()` *inside* the serialized `ingestChain`
continuation (`ffmpeg-screen.ts:376`), so the stamp is taken after every prior
frame's blob write and SQLite insert complete — not at arrival, which is what
CLAUDE.md documents. It is small in steady state, unbounded under backlog, and
never recovers. Sourcing `tMono` from PTS makes it moot rather than fixing it
separately: the stamp no longer reads a clock at all.

**Origin, and degradation.** `origin = video.tMonoStart` when a video blob
exists. Without one — no blob store, `recordVideo: false`, i.e. every test —
the origin is taken from the first paired frame as `clock.now() − pts₀`. One
code path, spacing still exact, absolute offset carrying that one frame's
latency. Degrades rather than branches.

### 2. Represent: associate AX by content time

**Capture writes keyframe walks with `frame_id = NULL`.** The triggering frame
is not the frame the walk describes; recording it as such is the error. No
schema change — `ax_snapshot.frame_id` is already nullable, because boundary
snapshots have no frame.

**A new always-on stage `associateFrameAx` (`represent/frame-ax.ts`)** assigns
each `keyframe`-reason snapshot to the kept frame nearest its `t_mono` and
writes `frame_id`. It runs between `Linking frames` and `Regions`, mirroring
`associateFrames` exactly: pure SQLite, no model, no provider gate, idempotent
on re-run.

**The association is computed walk → frame, not frame → walk.** Each walk goes
to the frame it best describes, so two walks cannot contend for one frame, and
"no walk near this frame" stays a real, visible outcome. Those frames keep
`NULL`, `getFrameAx` returns `[]`, and region proposal falls back to hotspots
and grid tiling — the documented best-effort path. Expect the first ~2
keyframes of a session to land there, since no walk has yet happened at their
content time.

**`StoredAxProvider`, `RegionRepresenter` and the `axProvider` seam are
unchanged.** That is the payoff of doing this as a stage: `getFrameAx(frame.id)`
keeps working and simply returns the right tree.

## Testing

Three pure units, all offline:

- `TimestampLineSplitter` — header line, a chunk boundary mid-number, a
  multi-line chunk, a trailing partial line.
- The three-way pairing, extracted from the producer into a pure helper
  precisely because the producer is documented as not unit-testable ("the
  testable parts are FrameChunker and JpegStreamSplitter").
- `associateFrameAx` — nearest wins, walk-side direction, unmatched frames stay
  NULL, idempotent on re-run.

`scripts/capture-latency-probe.mjs` carries the barcode bench and the real-device
mode, read-only like `decimate-probe.mjs`, so these numbers can be re-taken
rather than trusted.

**The suite cannot confirm this fix.** It has no ffmpeg PTS and no real device.
Closing it requires recording a real session and re-running the measurement in
the CLAUDE.md note: a search hit's keyframe should show a recorder clock
matching its card timecode, and seeking the video to `offsetSec` should land on
that same picture. Until that is done this is a well-measured hypothesis, not a
fixed bug.

## Disclosed residual

`video.tMonoStart` is stamped before spawn while media 0 happens **D ≈ 808ms**
later, so frames land ~0.8s *early* against input events. That is down from
+3.05s late and of the opposite sign, and it does not affect the goal above —
frame-to-video agreement is exact regardless of D, since D cancels in
`(frame.tMono − video.tMonoStart)`. Closing the last 0.8s would need a
`mach_absolute_time` reading at the session epoch, most plausibly a
permission-free `ax-dump --clock` mode in the grain of `--displays`/`--keymap`.
Out of scope.

## Out of scope

**Existing recordings keep the ~3s skew.** It is not recoverable from what was
stored, because the delivery latency of that session was never recorded. It
*is* re-derivable — the video is correct, so each stored keyframe JPEG could be
matched back to its true media time — but that is a separate piece of work.
Disclosed the way the `phash` incomparability and the un-repairable pre-stamp
trace graphs are, not silently smoothed over. New and old recordings are not
comparable on keyframe timing.
