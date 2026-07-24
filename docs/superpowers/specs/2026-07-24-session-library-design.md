# Session library — browse, view, play, and remove recordings

**Date:** 2026-07-24
**Status:** Design approved, pending spec review

## Context

Recordings are write-only from the user's point of view. You press record, the
app indexes on stop, and the only way back into a session is search — which
returns individual frames, never the recording as a thing you can look at. There
is no way to see what you have recorded, replay it, or reclaim the disk it uses.

The IPC contract already carries `sessions.list()` and `SessionSummaryDTO`
(`app/src/shared/types.ts`), but no renderer screen consumes them, and the
underlying data comes from an app-maintained `sessions.json` sidecar rather than
the store.

Three gaps have to close:

1. **There is no video.** `FfmpegScreenProducer` samples the screen at ~1 fps,
   runs each sample through `KeyframeGate` (pHash de-duplication), and stores
   only the survivors as discrete JPEGs. Playback of those would be a slideshow
   with irregular gaps, not a recording.
2. **There is no authoritative session list.** The library has no list-all read,
   so the app keeps `sessions.json`, appended after each indexed recording.
3. **There is no delete path.** `DualStore.deleteSession` exists and is correct
   (Lance → SQLite), but nothing calls it, blob files on disk are never removed,
   and no UI reaches it.

The goal: **record the session as real video, browse recordings in a Library
tab, play them back with the indexed keyframes marked on the timeline, and
delete a recording completely.**

### Decisions taken during design

- **Video is always recorded when the Screen signal is enabled.** No separate
  toggle. Accepted cost: ~50–150 MB/hour, and the screen input framerate rises
  from 1 fps to 10 fps (higher avfoundation CPU load). Both are tunable through
  `FfmpegScreenOptions` but not surfaced in the UI.
- **Browsing lives in a new "Library" tab**, fourth in the left rail, keeping the
  Record screen focused on the transport and signal toggles.
- **Remove deletes the whole session permanently** behind one explicit
  confirmation — video, keyframes, vectors, events, AX. No undo, no trash.

### Non-goals

- Audio playback synced to the video. Mic audio is captured as separate WAV
  chunks; stitching and syncing them is a follow-up, not part of this work.
- Exporting or sharing a recording.
- Trimming, editing, or re-indexing a subrange of a session.
- Remuxing the fragmented MP4 to a `faststart` MP4 for perfect seeking (see
  "Fragmented MP4" below).

## Architecture

The work crosses both packages and follows the repo's dependency direction:
`store/` → `capture/` → app main → app shared contract → app renderer.

```
src/store/blob-store.ts      reserve() + removeSession()      ← new file seam
src/store/store.ts           listSessions()                   ← new read
src/capture/types.ts         CaptureContext.reserveBlob/commitBlob
src/capture/session.ts       implements those two
src/capture/producers/ffmpeg-screen.ts   third output branch → screen.mp4
        │
        ▼
app/src/main/protocol.ts     deskrag://media/<blobId> with Range support
app/src/main/deskrag-service.ts   listSessions / sessionDetail / removeSession
app/src/shared/types.ts      DTOs + IPC channel names  ← changes here FIRST
app/src/main/ipc.ts, app/src/preload/index.ts
        │
        ▼
app/src/renderer/src/screens/LibraryScreen.tsx  (new)
```

### 1. Capture the session video (`src/capture/producers/ffmpeg-screen.ts`)

The producer already fans one ffmpeg input into two aligned outputs with
`-filter_complex ... split=2`. Add a third branch that encodes H.264 **directly
to a file** — ffmpeg writes it, no video bytes pass through Node.

Current filter graph (input at `fps`, both branches at full input rate):

```
[0:v]fps=1,split=2[g][c];
[g]scale=32:32,format=gray[gg];   -> pipe:1   rawvideo (pHash)
[c]scale=1280:-2[cc]              -> pipe:3   MJPEG    (keyframes)
```

New filter graph (input at `videoFps`, sampling branches decimated to `fps`):

```
[0:v]split=3[v][g][c];
[v]                                -> screen.mp4  H.264   (new)
[g]fps=1,scale=32:32,format=gray[gg]  -> pipe:1   rawvideo (unchanged behaviour)
[c]fps=1,scale=1280:-2[cc]            -> pipe:3   MJPEG    (unchanged behaviour)
```

The `fps` filter moves off the input and onto the two sampling branches, so the
pHash/keyframe pipeline observes exactly the same 1 fps stream it does today
while the video branch gets the full `videoFps` rate.

New `FfmpegScreenOptions` fields, all optional with defaults:

| Option        | Default | Notes                                             |
| ------------- | ------- | ------------------------------------------------- |
| `recordVideo` | `true`  | Third branch on/off (library-level escape hatch)  |
| `videoFps`    | `10`    | Input framerate; also the video's framerate       |
| `videoCrf`    | `28`    | x264 quality; higher = smaller                    |
| `videoPreset` | `veryfast` | x264 speed/size tradeoff                       |
| `videoMaxWidth` | `1920` | Scale cap on the video branch, aspect preserved   |

Encoder args: `-c:v libx264 -preset <preset> -crf <crf> -pix_fmt yuv420p -g
<videoFps*2> -movflags +frag_keyframe+empty_moov+default_base_moof`.

`-pix_fmt yuv420p` is required for Chromium playback. `-g` sets a ~2 s keyframe
interval, which is also the fragment and therefore seek granularity.

**Fragmented MP4.** A regular MP4 only becomes playable when ffmpeg writes the
trailer at clean exit; a hard crash leaves an unplayable file. Fragmented MP4 is
playable at any truncation point, at the cost of fragment-granular seeking
rather than an exact index. Crash-safety wins — a recording that survives a
crash matters more than sub-2-second seek precision. A remux pass could be added
later if seeking proves annoying in practice.

**`stop()` must await process exit.** Today it fires `SIGINT` and returns
immediately. For video the file must be finalized before the blob row is
written, so `stop()` gains a `once("exit")` await with a timeout (5 s, then
`SIGKILL`) before committing the blob.

### 2. A seam for producer-written files (`src/store/blob-store.ts`, `src/capture/`)

Producers never touch the store (`src/capture/types.ts` header), and ffmpeg
needs its output path before it starts. `BlobStore.write()` takes bytes, which
is wrong for a multi-hundred-megabyte file the subprocess writes itself.

`BlobStore` gains two methods alongside `write()`:

```ts
/** Mint a path for a file another process will write. Creates the dir; writes nothing. */
reserve(sessionId: string, media: Media, codec: string): Promise<{ id: string; path: string }>;

/** Remove every blob file for a session (the whole <root>/<sessionId> dir). */
removeSession(sessionId: string): Promise<void>;
```

`reserve` reuses the existing `EXT` map and `ulid()`-based naming, so reserved
files sit next to written ones under `<root>/<sessionId>/`.

`CaptureContext` gains the matching pair:

```ts
/** Reserve a blob path for a file this producer will write itself. Null without a blob store. */
reserveBlob(media: Media, codec: string): Promise<{ blobId: string; path: string } | null>;
/** Register a reserved file as a blob row (stats it for byteLength). */
commitBlob(blobId: string, meta: { tMonoStart: number; tMonoEnd: number }): Promise<void>;
```

`CaptureSession` implements both against `opts.blobStore`, mirroring how
`ingestAudio` degrades: without a blob store, `reserveBlob` returns `null` and
the producer skips video entirely.

Lifecycle inside the producer: `start()` reserves the path and stamps
`tMonoStart = ctx.clock.now()`; `stop()` awaits ffmpeg's exit, then calls
`commitBlob` with `tMonoEnd`. `Media` already declares an unused `"screen"`
member (`src/store/types.ts:39`) — that is the slot. The codec is `"mp4"` (the
container, which is what both the file extension and the MIME lookup need), so
`EXT` gains `mp4: "mp4"`. The unused `h264: "h264"` entry is left alone.

**Orphan file on crash.** If the app dies between `reserve` and `commitBlob`,
the `.mp4` exists with no blob row. It is inert (nothing reads blobs except by
id) and is cleaned up whenever the session is deleted, since deletion removes
the whole session directory. Not worth a reconciliation pass.

### 3. An authoritative session list (`src/store/store.ts`)

`sessions.json` exists solely because the library has no list-all read. Once
delete is in play, a JSON sidecar that must stay consistent with SQLite is
exactly the drift this codebase's dual-store rules exist to prevent.

Add to the `Store` interface and `DualStore`:

```ts
listSessions(): SessionSummaryRow[];

interface SessionSummaryRow extends SessionRow {
  frameCount: number;
  segmentCount: number;
  eventCount: number;
  /** Bytes across all blobs for the session. */
  byteLength: number;
  /** The `screen` video blob id, when one exists. */
  videoBlobId: string | null;
}
```

One prepared statement: `session` left-joined against grouped counts from
`frame`, `segment`, `event`, and `blob`, ordered by `started_at DESC`. Counts
come from SQL rather than `getFramesBySession(id).length` per session, which
would load every row of every session to produce a number.

`safeIntegers` is enabled **per statement** in this store (only `phashScan` and
the three frame selects turn it on, because `phash` is 64-bit). A new statement
defaults to it off, so the aggregate columns come back as plain `number` and no
`BigInt` coercion is needed — unlike `hydrateFrame`, which does need it.

**`sessions.json` is deleted** — the file, `loadSessionLog`, `recordSession`,
`sessionLog`, and `sessionLogPath`. `DeskRagService.listSessions()` reads the
store instead. Existing sessions are unaffected: their rows have always been in
SQLite, so the list is if anything more complete than the sidecar. Stale
`sessions.json` files are simply ignored and left on disk.

### 4. Streaming video to the renderer (`app/src/main/protocol.ts`)

`deskrag://frame/<blobId>` reads the whole blob into memory and returns it — fine
for a JPEG, wrong for a video, and Chromium will not seek a `<video>` whose
server does not honour `Range`.

Add a second host, `deskrag://media/<blobId>`:

- Parse `Range: bytes=<start>-<end>`; absent → `200` with the full body and
  `accept-ranges: bytes`.
- Present → `206` with `content-range`, `content-length`, and a body streamed
  from `createReadStream(path, { start, end })` converted to a web
  `ReadableStream`.
- Honour the blob's `byteOffset`/`byteLength` window, so packed blobs stay
  correct.
- MIME from the `MIME` map, extended with `h264`/`mp4` → `video/mp4`.

`frame` keeps its simple full-buffer path. The scheme is already registered with
`stream: true` and `supportFetchAPI: true`, so no privilege change is needed.

### 5. The contract (`app/src/shared/types.ts`)

Changed first, per the repo rule. `SessionSummaryDTO` gains:

```ts
durationMs: number;        // endedAt - startedAt, or last frame tMono when still open
hasVideo: boolean;
posterUrl: string | null;  // deskrag://frame/<first keyframe blobId>
sizeBytes: number;
eventCount: number;
```

New shapes:

```ts
export interface SessionVideoDTO {
  blobId: string;
  url: string;         // deskrag://media/<blobId>
  tMonoStart: number;
  tMonoEnd: number;
  sizeBytes: number;
}

export interface KeyframeMarkerDTO {
  frameId: string;
  tMono: number;
  /** Position within the video: (tMono - video.tMonoStart) / 1000. */
  offsetSec: number;
  thumbUrl: string | null;
  segmentDigest: string | null;
}

export interface SessionDetailDTO {
  id: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  video: SessionVideoDTO | null;
  keyframes: KeyframeMarkerDTO[];
  frameCount: number;
  segmentCount: number;
  eventCount: number;
  sizeBytes: number;
}
```

`DeskRagApi.sessions` grows `detail(id)` and `remove(id)`; `IPC` grows
`sessionsDetail: "sessions:detail"` and `sessionsRemove: "sessions:remove"`.

Marker positions fall out of `t_mono` with no new correlation logic — frames and
the video blob are already stamped on the same monotonic clock, which is the
whole reason `t_mono` exists.

### 6. Service methods (`app/src/main/deskrag-service.ts`)

```ts
listSessions(): SessionSummaryDTO[]
sessionDetail(id: string): SessionDetailDTO | null
removeSession(id: string): Promise<void>
```

`sessionDetail` reads the session row, finds the `media === "screen"` blob among
`getBlobsBySession(id)`, and maps `getFramesBySession(id)` (already ordered by
`t_mono`) to markers, joining the shortest containing segment for the digest —
the same "most specific segment wins" rule `detail()` uses at
`deskrag-service.ts:480`.

`removeSession` throws if `this.state.sessionId === id` and the state is not
`idle` (never delete the recording in progress), then
`store.deleteSession(id)` → `blobs.removeSession(id)`. Store first: a deleted
row with orphan files is recoverable disk waste; surviving rows pointing at
deleted files are broken reads. This mirrors the existing delete-order rule.

### 7. The Library screen (`app/src/renderer/src/screens/LibraryScreen.tsx`)

New fourth entry in the `NAV` array in `App.tsx`, with a new `IconLibrary` in
`icons.tsx`. Two-pane layout:

```
┌──────────────┬─────────────────────────────────────┐
│ ▢ Today      │  <video src="deskrag://media/…">    │
│   11:03 · 2.1GB                                    │
│ ▢ Yesterday  ├─────────────────────────────────────┤
│ ▢ Mon        │ ▶ ⏮ ⏭  00:04:12 / 00:11:03   1x ▾  │
│              │ ──────────●───────────────────────  │
│              │ ▪▪ ▪  ▪▪▪▪ ▪   ▪▪  ▪  ← keyframes  │
└──────────────┴─────────────────────────────────────┘
```

- Ticks positioned at `offsetSec / video.duration` (the element's real duration,
  falling back to the `tMonoEnd - tMonoStart` span before metadata loads).
- Clicking a tick seeks; hovering shows that keyframe's thumbnail.
- Play/pause, ±1 keyframe stepping, speed select (0.5/1/2/4×), space and arrow
  keys.
- **The keyframe nearest the playhead opens the existing `DetailView`.** It
  already accepts a `frameId` and renders digest, caption, transcript, AX tags,
  and region boxes — playback gets the full inspector with no new component.
- Sessions with `video === null` (recorded before this change, or with Screen
  disabled) render a keyframe filmstrip in the same pane instead of the player.
- Delete: a button per session opening a confirm dialog naming the session's
  date and size, then `api.sessions.remove(id)` and a list refresh.

Styling extends `styles.css` with the existing vocabulary (`.page`, `.sheet`,
`.frame`, `.empty`, `.btn`, `.bar`) rather than introducing a new system.

## Error handling

| Failure                                   | Behaviour                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| ffmpeg cannot encode H.264                | `onError` logs; keyframe/pHash branches are unaffected; `commitBlob` skipped, session simply has no video |
| No `blobStore` on the session             | `reserveBlob` returns `null`; producer skips the video branch entirely        |
| App killed mid-recording                  | fMP4 is playable up to the truncation; the blob row is missing, so the session shows as videoless |
| `commitBlob` on a missing/zero-byte file  | Logged and skipped; no blob row is written                                    |
| Range request beyond blob length          | `416` with `content-range: bytes */<len>`                                     |
| Delete of the in-progress recording       | Rejected with an explanatory error; the UI disables the button for that row   |
| `blobs.removeSession` fails after the store delete | Logged; rows are already gone, files are reclaimable manually        |

## Testing

Extending existing files wherever the coverage already lives:

- **`test/ffmpeg-screen.test.ts`** — the real-ffmpeg `lavfi testsrc` test that
  skips cleanly without ffmpeg. Extend to assert a `media: "screen"` blob lands
  with a valid `ftyp` box, nonzero `byteLength`, and `tMonoStart <= tMonoEnd`,
  while the existing keyframe assertions still hold (proving the sampling
  branches are unchanged by the new filter graph).
- **`test/dual-store.reconcile.test.ts`** — `deleteSession` is already covered at
  line 116; add that the session's blob directory is gone afterwards.
- **New `test/blob-store.test.ts`** — `reserve` creates the dir and returns a
  non-existent path with the right extension; `removeSession` removes everything
  and is idempotent on a missing dir.
- **New `test/session-list.test.ts`** — `listSessions` returns sessions newest
  first with correct counts and `byteLength`, returns plain `number` aggregates
  (not `BigInt`), reports `videoBlobId` only when a `screen` blob exists, and
  drops a deleted session from the list.
- **`test/capture-session.test.ts`** — `reserveBlob`/`commitBlob` write a blob
  row with the statted byte length, and `reserveBlob` returns `null` without a
  blob store.

Gates: `npm run typecheck`, `npm test`, then `npm run build && npm --prefix app
run typecheck`.

Manual verification: `npm run app:dev`, record ~30 s with Screen on, stop and
let it index, open Library — the session appears with a poster and duration,
plays, shows ticks that seek and open `DetailView`, and deleting it empties the
list and removes `blobs/<sessionId>/` from disk.

## Consequences for CLAUDE.md

Two documented invariants change and must be updated when this lands:

- "The library has no 'list all sessions' read, so the app keeps its own
  `sessions.json` log" — no longer true; `listSessions()` exists and the sidecar
  is gone.
- The pipeline description of `capture/` should note that the screen producer now
  emits three outputs, the third being a continuous H.264 file registered as a
  `screen` blob, distinct from the sampled `keyframe` blobs.
