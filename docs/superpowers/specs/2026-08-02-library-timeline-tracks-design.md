# Timeline tracks under the Library player

**Date:** 2026-08-02
**Status:** Design approved, pending spec review

## Context

The Library player shows one signal on the time axis: keyframes, as Vidstack
chapter cues and hover thumbnails. Everything else a session recorded — audio,
typing, pointer motion, focus changes, AX walks, transcripts, captions — is
either invisible or reachable only by opening a single frame in `DetailView`.

A recording is a multimodal capture. The player presents it as a video with
bookmarks.

This spec adds a **track rail**: a stack of time-scaled lanes beneath the player,
one per recorded signal, sharing the player's time axis. It **replaces** the
`KeyframeStrip` contact sheet, so the screen has exactly one time axis and one
mental model.

It serves four purposes at once, which is why the lane set is broad rather than
curated:

1. **Navigate** — find the moment. Spot the burst of typing, the loud stretch,
   the app switch; jump there.
2. **Audit capture health** — did this recording actually get everything? Gaps in
   audio, AX walks that returned nothing, a session with no keymap.
3. **Understand the behavior** — read the session as a story: dragged here, typed
   there, attention moved between these apps.
4. **Verify the index** — see what retrieval will see. Where captions exist,
   where regions were proposed, which stretches are dark.

Purposes 2 and 4 impose a requirement the other two do not: **a lane must show
absence as clearly as presence.** A dark stretch is information.

Nothing in `src/` changes except one new pure function (`wavPeaks`) beside its
existing inverse. No schema change — the repo has no migration mechanism, and
every lane here is derivable from rows already on disk.

## What the data actually looks like

Measured against the only recording on disk, 39.7 seconds
(`01KZ1YS35FEZP0CAA6VC447EY7`):

```
events   243  (mouse_move 84, key_down 65, key_up 65, mouse_down 11,
               mouse_up 11, focus_change 4, url_change 1,
               keymap_change 1, display_change 1)
frames     1
segments   9  (8 granularity "action", 1 "task")
ax         5  (4 focus_change, 1 keyframe; walk 77–90ms; all non-empty,
               4.0–5.5 KB of JSON each)
regions   14  (all source="ax", all on the single keyframe)
blobs         mic 4 × ~270 KB = 1.08 MB · screen 2.6 MB · keyframe 275 KB
transcript    on 6 of 8 action segments
caption       on 1 of 8 action segments
```

Four facts from that shaped the design:

**Keyframes are sparse, not 1 fps.** `KeyframeGate` de-duplicates by pHash, so a
settled screen emits nothing — one frame in forty seconds here. The frames lane
can therefore be actual thumbnails placed on the time axis, not tick marks. An
earlier draft of this design assumed ~600 keyframes for a ten-minute session and
specified ticks; that was wrong by more than two orders of magnitude.

**Segments come in two granularities and overlap by construction.** `action` and
`task` are both present. The lane set is generated from the granularities found
in the data, so a third one appears without a code change.

**`url_change` is a real event kind not declared in `EventKind`.** `event.kind` is
free-form TEXT and `trace/url.ts` emits it. The rail reads it, which is why a web
lane exists at all.

**Volume is not a problem.** Extrapolating linearly, thirty minutes is ~11k
events and ~50 MB of mic audio at 16 kHz mono s16le. The events are a single
indexed SQLite read; the audio is a sequential file read and a min/max loop.
Neither justifies a persisted cache. Both justify bucketing before crossing IPC.

## Architecture

### Every lane is one of four shapes

This is the observation the whole design rests on. The renderer implements
**four** lane components, not one per signal, and a future signal is a data
change in `main` with no new component.

The lane *count* depends on the data — fifteen for the session measured above,
because segment granularities and audio media each generate a lane apiece.

| Shape | Payload | Lanes |
|---|---|---|
| `density` | `values: (number \| null)[]` of length 1000, normalized 0–1, plus `peak` in real units and a `unit` label | audio (per media), typing, scroll, mouse speed, mouse x/y |
| `span` | `{ startSec, endSec, label, tone }[]` | apps, segments (one lane per granularity), transcript, caption |
| `mark` | `{ atSec, label, tone }[]` | clicks, AX walks, web, markers |
| `thumb` | `{ atSec, frameId, url, label }[]` | keyframes |

### Density values are `(number | null)[]`

`null` means **no coverage**, and it is a different fact from zero.

Silence during recorded audio is a flat line at zero. A stretch where no audio
blob exists is `null`. Collapsing the two would make a dead microphone
indistinguishable from a quiet room — which defeats purpose 2 outright.

For event-sourced lanes absence genuinely is zero: nobody typed. Only audio
emits `null`.

### A lane can carry data and still be compromised

Alongside `emptyReason` there is `warning`. The case that forces it:

A session with `key_down` events but no `keymap_change` event has a completely
healthy-looking typing lane, and **every character it recorded was silently
dropped at lift.** `UiohookInputProducer` writes `{ keycode, modifiers }` and
`resolveKeys` resolves the character from the session's own keymap; with no
keymap there is no character, and a key event without a resolved `char` emits no
text gesture by design. The lane has to say so. `emptyReason` cannot express it,
because the lane is not empty.

### Data flow

```
DualStore  (events, segments, frames, ax_snapshot, region)   ─┐
BlobStore.read(mic/desktop_audio blobs) → wavPeaks()         ─┤
video.tMonoStart · session t_mono span                       ─┘
                              │
                              ▼
             main/session-tracks.ts   ← PURE. rows in, DTO out.
                              │
                              ▼
       SessionTracksDTO  over IPC channel "session:tracks"
                              │
                              ▼
              TrackRail.tsx → 4 lane components (SVG/DOM)
```

### Placements

**`main/session-tracks.ts` is pure and lives in the ROOT suite**, exactly like
`main/plan-view.ts` and `renderer/src/screens/graph-layout.ts`. It takes rows and
audio peaks *as arguments* and returns the DTO — no store, no filesystem, no
Electron. `DeskRagService` performs the reads and owns the memoization. This puts
every piece of bucketing arithmetic in the fast, deterministic suite.

Both `tsconfig.json` and `vitest.config.ts` already map `@shared/types` and
`deskrag` for exactly this reason; the new test needs no new configuration.

**`wavPeaks()` goes in `src/capture/producers/wav.ts`, beside `encodeWav`, and is
barrel-exported.** It is the exact inverse of a function already there, pure,
synchronous, and loads no native module — so the barrel rule (native module, not
subprocess) permits it, and the app stays a consumer of the public barrel.
Duplicating the 44-byte header layout in `app/` is how the two AX readers drifted
into a one-element disagreement that stopped nodes verifying.

**Rendering is DOM/SVG, not canvas.** The argument for canvas is density, and it
evaporates once each dense lane is a single `<path>`: 1000 buckets is one DOM
node, not a thousand. What canvas costs is exactly what the navigate purpose
needs — hover readout, click-to-seek, keyboard focus, devtools inspection — all
of which would have to be rebuilt on hand-rolled hit-testing.

### Bucket count is fixed at 1000 in main

Not the renderer's pixel width. The width changes on every frame of a resize
drag, and re-bucketing per frame would be absurd, while an SVG `<path>` scales to
any width for free. 1000 over a ~900px rail is mild super-sampling, which is the
right side to err on.

### Memoization, and the one case that must not be cached

Results are memoized in `DeskRagService` keyed by session id, **only when
`endedAt !== null`.** A live session is still growing; caching it would freeze
the rail at whatever the recording had reached when it was first opened.

No new SQLite table. A persisted summary would be a second source of truth for
something fully derivable from SQLite, and it would need an invalidation rule for
every table the rail reads. If a long session measures slow in practice, that is
when a cache earns its way in.

## The lanes

Reading order runs *screen → attention → index → hands → sound*. Lanes whose
count depends on the data are generated from what is present.

```
frames    [▣]      [▣]        [▣][▣]              thumb
apps      ███TextEdit███│████Chrome██████│██Term   span
web              │──── github.com/…/pull ────      mark
seg:action ▏sess│─focus─│──focus──│─win─│─win─│    span
seg:task  ▏─────────────────────────────────▏     span
transcript      ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░      span
caption         ▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░      span
ax         ╵      ╵ ╵                    ╵ ╵      mark
typing        ▁▃█▇▃▁    ▁▂▆█▅▂▁                   density
clicks      ╵ ╵╵      ╵        ╵╵ ╵               mark
scroll              ▁▄▂▁                          density
mouse:speed ▁▂▇▃▁▁▄█▅▂▁▁▁▂▃▁▁▁▁▂▅▃▁▁▁             density
mouse:xy   x ___/‾‾\__/‾‾‾‾\___                   density
           y ‾‾\___/‾‾\____/‾‾
audio:mic ▁▂▅▇▆▂▁▁▁▁▁▃▆▇▅▂▁┄┄┄┄▁▂▃▁▁▁            density
markers     ⌘keymap        ⚑bookmark              mark
```

| Lane | Source | Shape | Notes |
|---|---|---|---|
| `frames` | `frame` rows | thumb | `deskrag://frame/<blobId>`; label from `keyframeLabel()` (caption → digest → timecode), **with the region count appended** |
| `apps` | `focus_change` events | span | Each event opens a span closed by the next or by session end. Tone from a stable hash of the app name, so one app is one colour across lanes and sessions |
| `web` | `url_change` events | mark | Label is the URL prefix, using the same drop-id-segments/cap-at-3 rule as `trace/url.ts` |
| `seg:<granularity>` | `segment` rows | span | **One lane per granularity found in the data.** Tone from `boundary_reason`; label from caption → digest |
| `transcript` | `segment.transcript IS NOT NULL` | span | Hover reveals the text |
| `caption` | `segment.caption IS NOT NULL` | span | |
| `ax` | `ax_snapshot` rows | mark | Tone by `reason`; label `"<reason> · N elements · Wms"`. **A walk with zero elements gets the alarm tone** — that is the measurement `reason` exists for |
| `typing` | `key_down` count/bucket | density | Carries the no-keymap `warning` |
| `clicks` | `mouse_down` events | mark | A `mouse_down`/`mouse_up` pair with movement between is labelled `"drag 340ms"` rather than promoted to its own span lane |
| `scroll` | `scroll` count/bucket | density | |
| `mouse:speed` | `mouse_move` deltas | density | **Max** speed per bucket, not mean — a fast flick must not average away. Peak in px/s |
| `mouse:xy` | `mouse_move` x, y | density | Two traces in one lane, each normalized to screen bounds. A drag reads as a smooth ramp, a jump as a step |
| `audio:<media>` | `mic` / `desktop_audio` blobs | density | One lane per media present. Peak envelope from `wavPeaks`; blob gaps are `null` |
| `markers` | `bookmark`, `keymap_change`, `display_change` | mark | Rare, high signal |

### Regions get no lane

They exist only at keyframes, so a regions lane would be a second copy of the
frames lane's x-positions. The count folds into the frame's hover label
(`"14 regions · ax 14"`), which serves purpose 4 without a redundant axis.

Reversible in one line if it reads thin against a longer recording.

## Interaction and layout

```
 ├── gutter ──┤├────────── time axis: 0 → total ──────────┤
 │            ││                    ╷                     │
 │ frames     ││  [▣]      [▣]      ╷   [▣][▣]            │
 │ apps       ││ ███TextEdit███│████╷hrome████│██Term      │
 │ audio:mic  ││ ▁▂▅▇▆▂▁▁▁▁▁▃▆▇▅▂▁┄╷┄┄▁▂▃▁▁▁              │
 │ typing     ││    ▁▃█▇▃▁     ▁▂▆█╷▂▁                     │
 └────────────┘└────────────────────╷─────────────────────┘
                                 playhead
  12.4s · Chrome · "opened the PR" · 4 keys/s · mic 0.42 · action seg 3/8
```

**The rail always spans the whole session. There is no zoom.** Rail width is
scrubber width, always, so alignment with the playhead is structural rather than
computed. At two seconds per pixel a thirty-minute session hides short bursts;
the hover readout and the span lanes still place you, and a zoom viewport would
bring its own state, its own re-bucketing, and a horizontal scroll axis fighting
the vertical one.

**The rail scrolls vertically** in its own bounded box (`overflow-y: auto`).
Fifteen lanes do not fit above a video frame in a 900×600 window, and cutting
lanes to fit would sacrifice the audit purpose to the navigate one.

**The shared readout is the feature, not per-lane tooltips.** A `title` on every
lane would make you hover fifteen times to answer one question. One crosshair
and one line of text resolving *every* lane at that instant is what turns the
rail into "understand the behavior", and it costs an array index per lane on
mousemove.

**The playhead is imperative, never React state.** `player.subscribe` fires every
animation frame; the playhead is one absolutely-positioned element whose
`transform: translateX()` is written directly in the subscription callback.
Routing it through state would re-render every lane at 60fps. `KeyframeStrip`
already encodes this lesson by setting state only when the *nearest keyframe*
changes.

**The rail owns its own time axis and does not depend on the scrubber's
geometry.** Visual alignment with Vidstack's slider is cosmetic and achieved by
sharing one `--rail-inset` custom property with the control bar's horizontal
padding. Correctness comes from the rail computing `currentTime / total` itself.
Given this repo's history with Vidstack's `:where()` rules and the
`minmax(0, 1fr)` column trap, the rail's correctness must not depend on the
control bar's box.

**Click anywhere on the rail seeks** to that time. A keyframe thumb click seeks;
double-click opens `DetailView` — preserving the filmstrip's interaction exactly,
since the rail replaces it.

**No video still gets a rail.** The axis comes from the session `t_mono` span.
There is no playhead and no seeking, and clicking a keyframe opens `DetailView` —
which is what the filmstrip did in that case today, so that path stays covered.

Lane heights: marks and spans 18px, density 24px, audio 32px. The gutter is a
fixed left column holding lane titles; time starts after it. The rail joins the
existing `.page--fill → .library → .library__stage → .player` height chain, so
every link needs `min-height: 0` and the chain then needs its explicit floor back
at the end — one omission silently restores page scroll.

**`styles.css` is one global sheet with no scoping, so every new base class is a
repo-wide identifier.** Grep before minting `.rail`, `.lane`, `.gutter` or any
other name; `.drawer` exists because `.sheet` was already SearchScreen's
contact-sheet grid, and a base rule that does not restate `display` silently
inherits the colliding one's.

## Contract

New in `app/src/shared/types.ts` — the file both sides depend on, changed first:

```ts
export type TrackShape = "density" | "span" | "mark" | "thumb";

export interface TrackSpanDTO  { startSec: number; endSec: number; label: string; tone: string }
export interface TrackMarkDTO  { atSec: number; label: string; tone: string }
export interface TrackThumbDTO { atSec: number; frameId: string; url: string | null; label: string }

/** Bucket count, fixed. Exported so the renderer never assumes a length. */
export const TRACK_BUCKETS = 1000;

export interface TrackDensityDTO {
  /** Length TRACK_BUCKETS, normalized 0–1. null = NO COVERAGE, which is not zero. */
  values: (number | null)[];
  /** The real-world value 1.0 corresponds to. */
  peak: number;
  unit: string;            // "keys/s" | "px/s" | "amplitude" | ...
  /** A second trace in the same lane, same length. Only mouse:xy uses it. */
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
  /** Non-null when the lane is legitimately empty; the reason IS the payload. */
  emptyReason: string | null;
  /** Non-null when the lane HAS data but that data is compromised. */
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

One IPC channel: `IPC.sessionTracks = "session:tracks"`, `(sessionId) => SessionTracksDTO | null`.

## Testing

`test/session-tracks.test.ts` in the **root** suite, against the pure projection:

- bucket boundary arithmetic — an event exactly on a boundary lands in one bucket
- `null`-vs-zero coverage: an audio gap is `null`, recorded silence is `0`
- the thumb-vs-tick collision rule is deterministic under a pure time shift
- granularity discovery: two granularities produce two lanes, three produce three
- span derivation from `focus_change`, including the final span closing at session end
- **no `keymap_change` ⇒ the typing lane carries `warning`, not `emptyReason`**
- an `ax_snapshot` with zero elements gets the alarm tone
- a zero-length session produces an empty rail rather than dividing by zero

`test/wav.test.ts`, extended: `wavPeaks(encodeWav(pcm, fmt))` round trip.
Testing an inverse against the function it inverts is stronger than any fixture,
and both live in the same file.

`npm run typecheck` and `npm --prefix app run typecheck` are the gates, as always.

**Then drive the real recording through it.** Both of this repo's worst bugs — the
AX role prefix and the stale sidecar — were invisible to `npm test` and obvious
within minutes against a real session. The specific things a real recording will
falsify that a fixture will not: whether sparse keyframes really do fit as
thumbnails, whether the mic envelope has usable dynamic range at 16 kHz mono,
and whether fifteen lanes in a scrolling box is a rail or a wall.

## Out of scope

- Zoom or a horizontal viewport
- A persisted track cache in SQLite
- Editing anything from the rail — it is an inspection surface, like the player
- Trace graph nodes/edges as a lane; the Replay screen owns that projection
- Live tracks during recording. Tracks are computed on demand and not memoized
  for an open session, but nothing pushes updates while it grows.
