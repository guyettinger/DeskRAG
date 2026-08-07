# Visual-State Keyframes and Track-Rail Readability — Design

**Date:** 2026-08-06
**Status:** approved design, not yet planned
**Supersedes nothing.** Extends `2026-08-02-library-timeline-tracks-design.md` and
builds on the branch work in `2026-08-06-segmentation-and-app-caption.md`.

---

## Problem

Reading a real 16-second Calculator recording in the Library's track rail exposed
four defects, three of which turn out to be the same defect.

1. **The rail is a wall of clipped text.** `TrackLane.tsx` paints
   `.tracks__span-label` inside *every* span. Adjacent 10s `action` windows each
   carry a caption or a digest, so the lane reads as one run-on paragraph and
   every label is truncated. The information is already available on hover —
   `readoutAt` resolves all fifteen lanes at the cursor into one card — it is
   simply also being stamped into the boxes.

2. **Bars claim more time than their signal occupies.** `presenceLane` draws the
   *segment's* span for transcript and caption. A caption describes up to three
   sampled keyframes; a transcript utterance is a couple of seconds inside a 10s
   window. The measured recording showed the same transcript text repeated across
   four consecutive bars.

3. **One keyframe in sixteen seconds.** `KeyframeGate` compares a 64-bit dHash of
   a **32×32** grayscale thumbnail (`ffmpeg-screen.ts` `grayW`/`grayH` default 32),
   which `dHash` then reduces to 9×8. A Calculator digit on a 2560×1440 screen is
   sub-pixel by that point. A whole-frame hash physically cannot represent it;
   lowering the threshold would only make it fire on compression noise.

4. **Idle drives segmentation.** `dwell_gap` / `burst_gap` are inactivity signals,
   and `action` currently cuts on every boundary reason. Inactivity indicates
   *intent*, not a change of visual state, so it is the wrong thing to key state
   segmentation off of.

Defects 1, 2 and 4 all follow from the same root: **nothing in the store knows
when the screen actually changed**, so every surface that wants to show content
ends up draped over a time window instead.

## Goal

Make "the screen changed" a real, well-detected, persisted fact, and let it be the
spine: it decides keyframes, it decides `action` boundaries, and — because a
segment then holds exactly one keyframe — a caption's extent becomes correct
without anyone computing it. Then stop the rail from painting prose into bars.

## Non-goals

- No migration mechanism. The schema changes and the data dir is deleted by hand
  (`~/Library/Application Support/deskrag-app/DeskRAG/`). **This deliberately
  relaxes the frozen-schema invariant recorded in CLAUDE.md**; that file must be
  updated in the same change, or it will keep asserting the opposite.
- No change to Tier-0/1/2/3 retrieval, to `trace/`, or to `replay/`.
- No change to `readoutAt` or the hover card's markup. It already does the job.
  (What it *reports* changes, because the lanes feeding it change.)
- No new dependency. Everything here is ffmpeg flags, SQLite, and pure TS.

---

## Design

### 1. Capture — visual state change is detected by ffmpeg

**`mpdecimate` is the right tool, and `select='gt(scene,N)'` / `scdet` are not.**
Both of the latter score a whole-frame average, which is exactly the blindness
that produced defect 3. `mpdecimate` is block-based: it divides each frame into
8×8 blocks, computes SAD per block against the **last kept frame** — the same
semantics `KeyframeGate.lastKept` implements — and keeps the frame when any block
exceeds `hi` (default 64×12 = 768), or when more than `frac` of blocks exceed `lo`
(default 64×5 = 320, `frac` default 0.33). `max` forces a keep after N consecutive
drops, which is a heartbeat for free.

**It can be offloaded into the existing graph without breaking frame pairing.**
`FfmpegScreenProducer` pairs the gray and MJPEG branches *by index*, which looked
like a blocker until the timestamp source was checked: `enqueue()` stamps
`tMono: ctx.clock.now()` — arrival time, not frame index. There is no
index→timestamp mapping to protect. So the decimator goes on the shared sampling
branch, **before** the split:

```
[0:v]split=2[v][s];
[v]scale='min(1920,iw)':-2[vv];                          ← video branch, 10fps, untouched
[s]fps=N,scale=1280:-2,mpdecimate=hi=…:lo=…:frac=…:max=…[d];
[d]split=2[g][c];
[g]scale=32:32,format=gray[gg];
[c]null[cc]
```

Both sampling branches are downstream of one decimator, so `pair()` stays aligned
by construction.

**One scale, at `imageMaxWidth`, feeds the decimator and both branches.**
Decimating at native resolution and then encoding at 1280 would mean two scale
passes and maximal sensitivity to tiny artifacts; at the JPEG's own width a
Calculator digit is still several 8×8 blocks.

*Disclosed consequence:* the gray branch now downscales 1280→32 rather than
native→32, so stored `phash` values shift slightly for new recordings. Old and new
pHashes are therefore not Tier-0-comparable — which the data-dir reset already
settles, but which must not be discovered later as a mystery.

**`KeyframeGate` is retired as the decider, replaced by `KeyframeBudget`** — a pure
`consider(tMono): boolean` enforcing a minimum interval, keeping the **first**
frame of a burst and dropping the rest. That is the allowance for rapid changes,
and it is what stops a playing video or animation from flooding captioning and
embedding. It is the only cost lever in the design.

**`dHash` stays exactly as it is.** Tier-0 still needs a hash on every stored
frame; it simply no longer decides which frames are stored. `FrameIngestor`
already wrote a `frame` row only for *kept* frames, so Tier-0's population
semantics are unchanged — only the criterion is.

**`scripts/decimate-probe.mjs`** — a read-only calibration harness in the spirit of
`scripts/replay-probe.mjs`. It runs parameter sets over the H.264 session videos
already on disk, reports survivor counts, and dumps thumbnails to a scratch
directory. `hi`, `lo`, `frac`, `fps` and `minIntervalMs` are chosen from its output.
**No constant in this area is guessed in the implementation plan.**

*Known risk this probe exists to settle:* a blinking text caret is roughly one 8×8
block and easily clears `hi`, which on screen content would fire every sample.
The mitigation is to disable the single-block path (raise `hi`) and gate on `lo`
plus a small `frac`, so a change must span several blocks — a caret is one block,
a Calculator digit is several. Whether that is necessary, and at what values, is a
measurement, not an argument.

### 2. Segment — visual state change cuts, inactivity does not

- New `BoundaryReason: "scene_change"`, priority **15** — below `focus_change`
  (20), above `dwell_gap` (10). Priorities otherwise unchanged.
- **`segment/` stays a leaf.** `boundaries.ts` learns nothing about frames.
  `Segmenter.segment()`, which already reads events from the store, additionally
  reads `getFramesBySession(sessionId)` and merges them into the event list as
  synthetic `SegEvent{ tMono, kind: "scene_change" }` before calling
  `computeBoundaries`. The boundary detector still sees only `SegEvent`.
- **`action` gets an explicit `cutReasons: ["scene_change", "focus_change",
  "bookmark"]`.** It is currently `undefined`, which means *every* reason. That
  one line is what stops inactivity from cutting state segments.
- **`task` is unchanged** (`cutReasons: ["focus_change", "bookmark"]`, adaptive
  sizing from `resolveGranularities`).
- `dwell_gap` / `burst_gap` are still computed and still returned in `boundaries`.
  They stop producing segments and become a rail lane of their own.
- **`action`'s time subdivision is dropped.** `targetMs = 10_000` currently splits
  any span longer than 10s into `window` segments, and those sub-windows contain
  no keyframe — which would reintroduce the caption-extent defect. One segment per
  visual state, full stop. Segment length is instead bounded by `mpdecimate:max`,
  the heartbeat. This moves the bound from a segment-side parameter to a
  capture-side one, deliberately and with the trade named.

### 3. Represent and store — utterance extent becomes a persisted fact

**New `transcript_clip` table:**

```sql
CREATE TABLE IF NOT EXISTS transcript_clip (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  t_mono_start INTEGER NOT NULL,
  t_mono_end   INTEGER NOT NULL,
  text         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcript_clip_session ON transcript_clip(session_id);
```

Written by `TranscriptRepresenter.represent()` from offsets it **already computes
and then discards** (`b.tMonoStart + s.startMs`, `transcript-representer.ts`). No
new transcription work, no new provider surface, no change to the whisper adapter.
Store methods: `putTranscriptClips(rows)`, `getTranscriptClipsBySession(id)`.
Pure SQLite — no vectors, so no dual-store write-ordering hazard, the same shape
as the `trace_*` tables.

The segment-level `transcript` text is **unchanged**; it still feeds the Tier-1
`transcript` vector view. Clips are an additional, finer record, not a
replacement.

**Caption extent needs no code change.** A segment now holds exactly one keyframe,
so the segment's span *is* that visual state's dwell and the caption's extent is
exact by construction. `maxFramesPerSegment: 3` stays — a heartbeat segment can
legitimately hold more than one frame.

### 4. Rail projection — `app/src/main/session-tracks.ts`

- **`TrackLaneDTO` gains `showLabels: boolean`.** Editorial policy is decided here
  (identity lanes `true`, prose lanes `false`); geometry is decided in
  `track-view.ts`. The split keeps the projection root-testable and stops the
  renderer from making content decisions.
  - It applies to **`span` lanes only** — `mark` and `thumb` lanes carry labels in
    the DTO but `TrackLane.tsx` has never painted them, and `density` lanes have no
    label at all. The field is still declared on `TrackLaneDTO` rather than a
    span-only sub-type, matching how `spans`/`marks`/`thumbs`/`density` already
    coexist optionally on the one lane shape.
  - `true`: `apps` — the only identity span lane.
  - `false`: `seg-action`, `seg-task`, `transcript`, `caption`, `idle`.
- **`transcriptLane` stops using `presenceLane`** and is built from
  `transcript_clip` rows — real utterance bars carrying the real utterance text.
  `LaneInput` gains `transcriptClips`.
- **Clip-less sessions disclose rather than pretend.** A session with segment
  transcript text but no clips (recorded before this change, or transcribed by a
  provider that gives no timestamps) renders segment-derived spans **and sets
  `warning`** stating the extent is approximate. This is the `observations` /
  `sources` precedent from Flows: both facts shown, neither smoothed over.
- **`captionLane` keeps `presenceLane`**, which is now exact.
- **New `idleLane`** — `dwell_gap` / `burst_gap` intervals as spans, tone by kind.
  The intent signal, now visible as itself instead of silently shaping segments.
  Derived from the event stream; no new store read. Ordered with the input group,
  after `clicks`.

### 5. Rail rendering — `track-view.ts`, `TrackLane.tsx`, `styles.css`

Two new pure rules in `track-view.ts`, root-tested like `thumbPlacement`:

- **`labelFits(spanSec, totalSec, axisWidth, text): boolean`** — a span paints its
  label only when it fits untruncated, measured against a per-character width
  constant rather than the DOM, so the rule stays pure and testable. Consequence:
  **no ellipsis appears anywhere in the rail.** A lane with `showLabels: false`
  never asks.
- **`spanRects(startSec, endSec, totalSec, axisWidth, minHitPx)`** →
  `{ left, width, hitLeft, hitWidth }`. The visual bar is the signal's true
  extent; the hit rect is padded to `minHitPx` and centred on it. Widening the
  *bar* to be clickable is exactly the overstatement this design removes, so the
  hit area is a separate rect — the same principle as the Flows wire's fat
  transparent stroke.

`TrackLane.tsx` renders `.tracks__span-label` only when
`showLabels && labelFits(...)`, and adds a sibling `.tracks__span-hit`
(transparent, `pointer-events: auto`, with `.tracks__span` itself
`pointer-events: none`).

`styles.css`: add `.tracks__span-hit`; **delete `text-overflow: ellipsis` from
`.tracks__span-label`** — nothing truncates any more, and leaving it would let a
future regression hide behind it.

`readoutAt` and the hover card are unchanged. They already resolve every lane at
the cursor; that becomes the only place prose is read.

---

## Data flow

```
ffmpeg  fps=N → scale=1280 → mpdecimate ──┬── gray 32×32 → dHash → frame.phash (Tier-0)
   (visual state change decided here)     └── MJPEG      → keyframe blob
                                              ↓
                                     KeyframeBudget (min interval)
                                              ↓
                                     FrameIngestor → frame row
                                              ↓
Segmenter: events + frames-as-scene_change → computeBoundaries
                                              ↓
              action cuts at scene_change / focus_change / bookmark
                                              ↓
                        one segment == one visual state
                                              ↓
              CaptionRepresenter → caption extent exact for free
              TranscriptRepresenter → transcript_clip rows (true utterance extent)
                                              ↓
                     session-tracks.ts → lanes (+ showLabels, + idle)
                                              ↓
                     TrackLane.tsx → bar = true extent, hit = padded, text on hover
```

## Error handling and degradation

- **No `mpdecimate` in the installed ffmpeg** — it is a core filter present in
  every mainstream build, so this is not defended against; if the filter string
  fails, ffmpeg errors on stderr and `onError` reports it, which is the existing
  path for every other graph mistake.
- **A provider with no timestamps** — `TranscriptRepresenter` writes no clips, the
  segment-level text path is unchanged, and the lane discloses approximate extent
  via `warning`.
- **A session with no frames** — `Segmenter` merges an empty scene-change list;
  `action` then cuts only at `focus_change`/`bookmark`, which is degraded but
  correct rather than broken.
- **A stale data dir** — not handled by design. The schema changes and the user
  deletes the directory by hand; there is no version guard.

## Testing strategy

Fast root suite (`npm test`):

- `test/segment.test.ts` — `scene_change` priority ordering; `action`'s
  `cutReasons` excluding `dwell_gap`/`burst_gap`; no time subdivision of a long
  span; frames merged as synthetic scene-change events.
- `test/session-tracks.test.ts` — clip-sourced transcript lane; the clip-less
  `warning`; the `idle` lane; `showLabels` policy per lane.
- `test/track-view.test.ts` — `labelFits`; `spanRects`, **including translation
  invariance**, which is the trap both `thumbPlacement` and `Path.curve` span
  splitting hit.
- `test/transcript-clip.store.test.ts` (new) — round-trip and session cascade.
- `test/capture-frames.test.ts` — `KeyframeBudget` min-interval rule, first-of-burst.
- `test/ffmpeg-screen.test.ts` — the filter-graph string. `args()` is pure, so the
  `split=2 → fps → scale → mpdecimate → split=2` shape is assertable without a
  spawn; that the *filter* behaves is the probe's job, that the *graph* is well
  formed is the suite's.

Gates: `npm run typecheck`, `npm test`, `npm --prefix app run typecheck`.

**Explicitly not coverable by the suite:** every mpdecimate parameter. Those come
from `scripts/decimate-probe.mjs` run over recordings already on disk, and are
then confirmed by a fresh Calculator recording read straight out of the store —
keyframe count, keyframes per segment, and the rail itself. Both of this repo's
worst bugs were invisible to `npm test` and obvious within minutes of driving a
real session, so this work ends on a recording, not on green.

## Risks

- **Caret sensitivity.** A blinking text caret may clear `hi` on its own. Settled
  by the probe, not by argument; the mitigation (`hi` raised, `lo` + small `frac`)
  is known but its necessity and values are measurements.
- **Cost.** Keyframe count now drives captioning and embedding.
  `KeyframeBudget.minIntervalMs` is the only lever, and it must be set from real
  footage that includes a moving/animated screen, not only a static one.
- **Cross-process change.** `showLabels` crosses the main/renderer boundary, so
  `app/src/shared/types.ts` moves first; both typechecks must pass.
- **Schema reset.** Every existing recording is lost. Accepted explicitly by the
  user. CLAUDE.md's frozen-schema invariant must be rewritten in the same change.

## Build order

Dependency direction, each step independently verifiable:

1. `KeyframeBudget` + the ffmpeg graph change + `scripts/decimate-probe.mjs`;
   calibrate against existing videos.
2. `segment/` — `scene_change`, `action.cutReasons`, drop the subdivision.
3. `store/` + `represent/` — `transcript_clip` table, methods, representer write.
4. `app/src/shared/types.ts` — `showLabels`, then `session-tracks.ts` lanes.
5. `track-view.ts` rules, then `TrackLane.tsx` and `styles.css`.
6. Delete the data dir, record a real session, read the rail, update CLAUDE.md.
