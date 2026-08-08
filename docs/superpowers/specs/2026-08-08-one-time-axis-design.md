# One time axis: making `t_mono` universal instead of nominal

**Date:** 2026-08-08
**Status:** Design approved, pending spec review
**Supersedes the residual section of:** `2026-08-08-keyframe-capture-time-design.md`

## Context

CLAUDE.md opens its timeline rule with "EVERYTHING correlates on t_mono". That
is not true today, and driving the Library's track rail is what shows it: a
`focus_change` at `t_mono` 3.021 draws at lane 2.647s while the video shows that
moment at media 1.76s — the APPS lane sits ~0.9s right of the picture it
describes.

The keyframe PTS work (2026-08-08) made frames agree with the video exactly and
shrank frame↔event error from ~3s to ~1s. It did not put frames and events on a
**shared** axis; it moved frames from "the event clock, 3s late" onto a
different clock. This spec finishes that job.

### Every signal, and the clock it is on

Read out of the code, not assumed:

| signal | clock | how |
| --- | --- | --- |
| events (mouse, key, focus, display, keymap, bookmark) | true `t_mono` | `clock.now()` at emit — accurate, in-process |
| AX walks | true `t_mono` | `now()` at walk start |
| frames | **media** | `video.tMonoStart + pts` (`SampleClock`) |
| audio blobs | **arrival-anchored + exact byte rate** | `anchorMono = clock.now()` at first chunk, then `bytesEmitted / bytesPerSecond` |
| video blob | neither end is media 0 | `tMonoStart` stamped before spawn; `tMonoEnd` at stop |
| **segments** | **mixed** | `sceneTMonos` from frames (media), other boundaries from events (`t_mono`) |
| transcript clips | the audio blob's clock | `blob.tMonoStart + s.startMs` |

Five conventions in the data. The renderer then adds three more: keyframes at
`pts`, the playhead at `(media / mediaSec) × totalSec`, event lanes at
`true − V`.

`Segmenter` is the sharpest symptom: one segment's start can be a
`scene_change` measured on the media clock and its end a `focus_change`
measured on `t_mono`. Since a real recording cuts ~38 `scene_change` against 6
`focus_change`, most spans are mostly-media with occasional true-time edges.

### The two errors, measured

On one real recording, reading the recorder's own millisecond clock out of the
video:

| media time | recorder clock |
| --- | --- |
| 5.000 | 00:00:06.303 |
| 12.000 | 00:00:13.403 |

So `true = 1.0143 × media + 1.232`:

- an **offset** of ~0.86s (media 0 happens after `video.tMonoStart`), and
- a **rate** divergence of ~1.4% — 7.100s of real time per 7.000s of media —
  because the MP4 is encoded CFR at `videoFps` while avfoundation delivers at a
  slightly different real rate. The video is time-compressed.

The gap therefore grows: 0.93s at media 5, 1.03s at media 12.

### Why Node cannot fix this alone

avfoundation timestamps are on `mach_absolute_time` (verified: ffmpeg's
`-copyts` output tracks python's `time.monotonic()`). Node's clock —
`performance.now()` via `uv_hrtime` — is `mach_continuous_time`, which includes
sleep and sat **4.78 days** away on the development machine. Nothing in Node
reads the other base.

`kern.monotonicclock_usecs` was investigated and rejected: it advances at
exactly real-time rate but sits a constant 125011967.742s from the
`mach_absolute` base, and that constant is itself unobtainable from Node.

## Goal

**`t_mono` becomes universal.** Every signal is stored on it, so segments,
search hits, trace node times and the rail are correct together rather than
each approximately right in its own way.

## Design

### 1. The device-clock bridge

`ax-dump` grows a `--clock` mode printing
`clock_gettime_nsec_np(CLOCK_UPTIME_RAW)` in milliseconds. Permission-free: it
exits above the `AXIsProcessTrusted()` gate *and* above the `--self-test` block,
like `--displays` and `--keymap`.

Verified on the development machine: Swift reports 3477946316.602ms against
python's 3477946330.555ms taken 14ms later — the same base ffmpeg's `-copyts`
uses, and 4.78 days from Node's.

`CaptureSession.start()` reads it once beside `clock.now()`. That pair is the
calibration. `MonotonicClock` gains:

```ts
fromDeviceMs(deviceMs: number): number   // device base -> t_mono
```

and it is the **only** place a device timestamp becomes session time. A clock
with no calibration throws rather than guessing.

**`timeline/` must not learn to spawn anything.** `CaptureSession` runs the
sidecar and passes the reading in as a number, exactly as producers receive
their world through `CaptureContext`. A `spawn` reached from `timeline/clock.ts`
would put a subprocess under the one module every other module imports.

### 2. Producers report device time, not arrival

Both ffmpeg producers pass `-copyts` and hand the session device-base
timestamps:

- **Screen.** `frame.tMono = clock.fromDeviceMs(ptsAbs)`. This **deletes
  `SampleClock`**: the video blob stops being an input to frame timing, which is
  exactly what put frames on the media clock.
- **Audio.** `anchorMono` becomes `fromDeviceMs(firstPacketPts)`. The byte-count
  offsets stay — they were always exact; only the anchor was contaminated.
- **Video blob.** `tMonoStart` becomes the true `t_mono` of media 0, from the
  video branch's first absolute PTS, instead of a pre-spawn stamp.

**To verify before building on it:** that `-copyts` gives avfoundation *audio*
the same device base it gives video. Confirmed for video only.

Two consequences need no code of their own:

- **`Segmenter`'s mixed cut resolves itself.** `sceneTMonos` and event
  boundaries land on one clock; nothing in `segment/` changes.
- **`laneOriginOf` becomes true.** Lane offset 0 is genuinely media 0.

### 3. The video's own clock becomes real time

The bridge places signals on `t_mono`; it does not make the *video's* timeline
true. That needs the encode to stop being CFR: the mp4 output takes
`-fps_mode passthrough`, carrying capture timestamps.

**This REVERSES yesterday's rule.** CLAUDE.md currently says `-fps_mode
passthrough` goes on the three sampling outputs and "never on the mp4, which
stays CFR at `videoFps`". That was right when the mp4's job was to be a
watchable file and nothing depended on its timeline being true; it is wrong once
the rail's axis *is* the video's timeline. Update that line rather than leaving
two documents disagreeing.

Then media seconds **are** lane seconds, and the conversions collapse rather
than becoming more careful:

- `TrackRail`'s playhead divisor stops being `(media / mediaSec) × totalSec` and
  becomes `media / totalSec` — position, not rescale.
- `seek(laneSec)` becomes identity.
- The "Media seconds are NOT lane seconds" rule is **deleted**, not adjusted.

**Gate:** a VFR fragmented MP4 must seek correctly and report a real duration in
Vidstack/Chromium. If it does not, the fallback is to store the measured rate
per session and convert on read — which works, and keeps two clocks. Decide by
measuring, not by reading.

### 4. Refusal, and the packaging it requires

`startRecording` fails with a clear message when the bridge cannot be read.
That guarantee is dishonest until the sidecar always exists, because today
**the packaged app does not ship it**: `electron-builder.yml` bundles only
`out/**`, `build/**` and `package.json`, the dev path resolution points at
`<repo>/native/ax-dump`, and the fallback is `ax-dump` on `PATH`.

So packaging lands first:

- `npm run build:ax` runs before packaging; `native/ax-dump` goes into
  `extraResources`.
- `app/src/main/index.ts` resolves `process.resourcesPath` when packaged, the
  repo path in dev, with `ERAG_AX_BIN` still winning.
- Signing needs checking: under hardened runtime a spawned binary inside the
  bundle must be signed, and may need listing for notarization. Verify with
  `codesign -d --entitlements -` against a packaged build, not by reading the
  yml — the same rule the mic entitlements already carry.

**Side benefit worth naming:** this makes AX capture work in packaged builds,
which it does not today, for exactly this reason.

### 5. Existing recordings

Calibration is stored in a new **`session_clock`** table `(session_id,
device_epoch_ms, mono_epoch_ms)` — the sanctioned schema move, since
`CREATE TABLE IF NOT EXISTS` runs on every open and an existing table's shape can
never change.

Its **absence** is what marks a session as uncalibrated. Every existing
recording has no row, so the rail says the axis is uncalibrated rather than
pretending. Old sessions keep their old conventions and are **not comparable**
with new ones — the same disclosure as the `phash` note, and not repairable:
the delivery latency of a past session was never recorded.

## Testing

Pure, offline:

- `fromDeviceMs` — conversion, and that an uncalibrated clock throws instead of
  falling back.
- Parsing `--clock` output.
- A guard that no producer stamps a frame from `clock.now()`.

**The synthetic bench cannot test the bridge at all** — lavfi has no device
clock, so `-copyts` has nothing real to report. That is a structural limit, not
a gap to fill with a better fixture.

The real gate is a recording against a millisecond reference clock, asserting:

1. `frame.tMono` matches the recorder's clock — not merely the video, which is
   the weaker check the previous spec settled for.
2. The APPS lane transition and the video agree on screen.
3. Audio blob spans line up with speech in the recording.

## Out of scope

- Repairing existing recordings.
- The executor and Flows, which read stored graphs and are unaffected.

## Sequencing

Three pieces, in dependency order: **sidecar packaging** (the refusal guarantee
is dishonest without it) → **the capture clock bridge** → **the video timeline
and rail simplification**. One plan, sequenced; each is independently testable.
