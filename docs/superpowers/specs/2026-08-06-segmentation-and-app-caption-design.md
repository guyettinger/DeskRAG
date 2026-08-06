# Finer segmentation, transcript de-duplication, and a focused-app caption view

**Date:** 2026-08-06
**Status:** Design approved, pending spec review

## Context

A real recording (~90s, `app focus: Electron → Calculator → Electron`, 6 clicks,
spoken narration) exposed three problems when read back through a debug
timeline view:

1. **The `task` granularity collapses a whole short recording into one blob.**
   `task` is a flat 180s-target / 90s-stride sliding window
   (`segment/types.ts`, `DEFAULT_GRANULARITIES`), ignoring boundaries entirely.
   On a 90s session that produces exactly one window, so its digest text reads
   `app focus: Electron → Calculator → Electron. 6 clicks. clicked in
   Electron, clicked in Calculator.` — three distinct app spans flattened into
   one summary.

2. **The transcript row shows near-duplicate text across adjacent segments.**
   `TranscriptRepresenter` transcribes each raw audio blob **once** (fixed
   10s chunks, clocked from session start in `FfmpegAudioProducer`), then
   assigns the blob's **entire** text to every store segment whose time range
   merely overlaps the blob (`overlaps()` in `transcript-representer.ts`).
   Because `action` segments are cut at `focus_change`/`dwell_gap` — not
   aligned to the fixed 10s audio-chunk clock — a single audio blob routinely
   straddles two adjacent action segments, and both receive the full blob
   text. Confirmed by reading `whisper-cli`'s invocation: it runs with `-nt`
   (no timestamps), so `TranscriptRepresenter` has no sub-blob timing
   information at all — a blob is one opaque string.

3. **`action` segmentation is a flat 10s clock, not behavior-driven.**
   `computeBoundaries` only cuts on `focus_change`, `bookmark`, and
   `dwell_gap` (activity resuming after **any** event-idle gap, including
   `mouse_move`, which samples every 12–100ms and so almost never lets
   `dwell_gap` fire). Within one focus span, `action` segments are therefore
   just `targetMs`-wide clock slices, not aligned to bursts of actual input.

Separately: the user wants a **second caption signal**, cropped to the
focused application's window, alongside the existing whole-desktop caption —
so retrieval and review can distinguish "what's on screen" from "what's in
the app the user was actually looking at."

This spec covers all four pieces together since they touch the same two
directories (`segment/`, `represent/`) and the granularity work directly
affects how the transcript fix behaves at each scale.

## 1. Burst boundaries (`segment/boundaries.ts`, `segment/types.ts`)

Add a new boundary reason:

```ts
export type BoundaryReason =
  | "session_start"
  | "focus_change"
  | "dwell_gap"
  | "burst_gap"   // NEW
  | "bookmark"
  | "session_end"
  | "window";
```

`computeBoundaries` gains a second idle tracker, `lastMeaningfulT`, updated
only by `mouse_down`, `key_down`, and `scroll` — explicitly **not**
`mouse_move`, whose continuous sampling is what currently masks `dwell_gap`
from ever firing during active use. A gap between two such events beyond a
new `burstGapMs` (default **1500ms**, distinct from and shorter than the
existing `dwellGapMs` default of 3000ms) adds a `burst_gap` boundary.

`dwell_gap` is unchanged — it stays the "nothing happened at all, not even
mouse movement" signal, which is a real and rarer condition (e.g. the user
stepped away).

Priority order (`PRIORITY` map) becomes:

```
session_start / session_end : 100
bookmark                    : 30
focus_change                : 20
dwell_gap                   : 10
burst_gap                   : 5    // NEW
window                      : 0
```

`SegmenterOptions` gains `burstGapMs?: number`, threaded the same way
`dwellGapMs` is today.

## 2. Per-granularity boundary filtering + adaptive task sizing

(`segment/types.ts`, `segment/windowing.ts`, `segment/segmenter.ts`)

Today every granularity that is `boundaryAware` cuts on the *entire* shared
boundary list. That's wrong once `burst_gap` exists: `action` should react to
it, `task` should not — a burst-level pause is noise at task scale.

`GranularityConfig` gains a `cutReasons` field:

```ts
export interface GranularityConfig {
  name: string;
  targetMs: number;
  strideMs: number;
  boundaryAware: boolean;
  /** Boundary reasons that count as a cut for this granularity. session_start/
   *  session_end always apply regardless of this list. */
  cutReasons: BoundaryReason[];
}
```

`windowSegments` filters the incoming `boundaries` array to
`cutReasons ∪ {session_start, session_end}` before running its existing
boundary-aware loop — the loop itself (subdivide any span still longer than
`targetMs`) is unchanged.

**`action`**: `cutReasons = [focus_change, bookmark, dwell_gap, burst_gap]`
(everything). `targetMs: 10_000` stays as-is — now a subdivision cap for
spans that go uncut between real behavior changes, rather than the primary
driver of where cuts land.

**`task`**: `cutReasons = [focus_change, bookmark]` only. `targetMs` and
`strideMs` become **adaptive** instead of fixed constants, computed once
`endTMono` is known:

```ts
targetMs = clamp(sessionLenMs / 2, 30_000, 180_000);
strideMs = targetMs / 2;
```

`DEFAULT_GRANULARITIES` (a static array) is replaced by a function
`resolveGranularities(endTMono: number): GranularityConfig[]`, called from
`Segmenter.segment()` after `deriveEnd()`. The static shape
(`cutReasons`, non-adaptive `targetMs`/`strideMs` for `action`) stays
importable as `BASE_GRANULARITIES` for anything that wants the config shape
without resolving against a session length (e.g. a test fixture).

**Effect on the reference recording** (~90s,
`Electron → Calculator → Electron`): `task` resolves to ~45s windows with
cuts at each app-focus change, producing three task segments instead of one
180s blob covering the whole session. `action` segments break on click/key
bursts within a focus span instead of a flat 10s clock.

## 3. Transcript timestamp slicing

(`embed/types.ts`, `represent/transcript/whisper-cpp.ts`,
`represent/transcript/transcript-representer.ts`,
`represent/transcript/fake.ts`)

`TranscriptionResult` gains an optional field:

```ts
export interface TranscriptionResult {
  text: string;
  /** Sub-clip timing, when the provider can give it. Absent means the
   *  caller must treat `text` as one opaque span (whole-blob attribution). */
  segments?: { text: string; startMs: number; endMs: number }[];
}
```

`WhisperCppTranscription` switches its invocation from `-nt` (no timestamps)
to `-oj` (JSON output to `<out>.json`), and parses whisper.cpp's per-segment
`{text, offsets: {from, to}}` entries into `{text, startMs, endMs}` (offsets
are already milliseconds relative to the clip). `text` (the flat, joined
string) is still returned unchanged for anything that doesn't care about
segments. A JSON-parse failure, missing file, or empty `segments` array
degrades to `segments: undefined` — the same best-effort contract as a
missing binary (`{ text: "" }` today); it does not fail the represent pass.

`TranscriptRepresenter.represent()` changes its per-blob-per-segment
attribution:

- For each audio blob whose transcription returned `segments`, convert each
  whisper segment's `startMs`/`endMs` to absolute `t_mono`
  (`blob.tMonoStart + startMs`, `blob.tMonoStart + endMs`).
- For each store segment, join the text of every whisper segment (across all
  overlapping blobs) whose absolute `[startMs, endMs)` range overlaps the
  store segment's `[tMonoStart, tMonoEnd)` — not the whole blob's text.
- **Fallback, per blob:** if a blob's transcription has no `segments` (fake
  transcriber in tests, or a whisper build that ignores `-oj`), that blob
  reverts to today's whole-blob-per-overlap join. This is a known, accepted
  degradation (duplication can return) rather than a hard failure — a
  provider that can't give timestamps still produces *a* transcript.

`FakeTranscription` gains an option to emit synthetic `segments` (e.g. one
segment per input line, evenly spaced across the clip's declared duration) so
`transcript-representer.test.ts` can exercise the slicing path
deterministically without needing real whisper output.

## 4. `app_caption` — a focused-app caption view

(`represent/caption/`, `embed/types.ts`, `store/sqlite/schema.ts`,
`store/types.ts`, `retrieve/`, `app/src/main/deskrag-service.ts`)

### Data source — already captured

`focus_change` events already carry an optional `bounds: {x, y, w, h}`
(`capture/producers/active-window.ts`), in the same global screen-coordinate
space as AX bboxes and region bboxes. `Box` (`represent/regions/geometry.ts`)
is exactly `{x, y, w, h}` — no shape conversion needed. Cropping reuses
`SharpRegionCropper.crop(image, frame.width, frame.height, box)` unmodified,
the same call `RegionRepresenter` already makes. **No capture-side change is
needed at all** — this is entirely a represent-time addition.

### Bounds resolution

New small module `represent/caption/focus-bounds.ts`: given a session's
`focus_change` events and a `t_mono`, return the latest-at-or-before window
`bounds`, or `undefined` if none precede it. Same "environment facts resolved
by latest at-or-before" rule the display-topology and keymap resolvers use.

### `AppCaptionRepresenter`

A new class, not a modification of `CaptionRepresenter` — separate,
single-purpose, same shape. Per segment: sample keyframes the same way
`CaptionRepresenter` does, resolve `bounds` for each sampled frame's
`t_mono`, crop, caption the crops, join into one caption string, persist.

**A frame with no resolvable bounds is dropped from the sample, never
falls back to the full frame** — falling back would silently turn
`app_caption` into a duplicate of `caption`, defeating the point of a
second signal. If *every* sampled frame in a segment lacks bounds, that
segment gets no `app_caption` at all (same "absence is meaningful"
principle used elsewhere, e.g. the track rail's `null` audio-coverage rule).

### Storage — new table, not a new column

`segment.caption` is a fixed column in an existing
`CREATE TABLE IF NOT EXISTS segment` (`store/sqlite/schema.ts`). The repo has
no migration mechanism, so an existing install's `segment` table can never
gain a column. `app_caption` text goes in a new table, the same pattern
`ax_snapshot`/`trace_node_source` used for the same reason:

```sql
CREATE TABLE IF NOT EXISTS segment_app_caption (
  segment_id TEXT PRIMARY KEY REFERENCES segment(id) ON DELETE CASCADE,
  text       TEXT NOT NULL
);
```

`Store` gains `updateSegmentAppCaption(segmentId, text)` and
`getAppCaption(segmentId)` / a bulk `getAppCaptionsBySession(sessionId)`,
mirroring the existing `updateSegment({ caption })` write-order rule: SQLite
text write happens before the vector write, so reconciliation can re-embed
from persisted text after a crash.

Vectors need **no** schema change — `segment_vector` is already keyed by
`(segmentId, namespace)`, so a new namespace is free.

### View + retrieval wiring

`View` (`embed/types.ts`) gains `"app_caption"`; `VIEWS` array updated.
`namespaceFor` and LanceDB's one-table-per-namespace already handle a new
view with no further change.

`DeskRagService.buildRetriever`'s text-view loop
(`["digest", "caption", "transcript"]`) becomes
`["digest", "caption", "transcript", "app_caption"]` — a fourth
`TextViewSearcher(prov.textEmbedder, "app_caption")`, fused into Tier-1 RRF
the same way, guarded by the same `store.listVectorSpaces()` registered-check
so it's silently absent until something has actually indexed it.

### App wiring

New indexing stage in `DeskRagService`, gated the same way the existing
caption stage is (`p.captionProvider !== "none"`), **and** additionally
requiring a `RegionCropper` (sharp) to be available — mirrors the region
stage's gating. Runs alongside the existing caption stage, not in place of
it. `Capabilities` gains an `appCaption` flag for UI gating, following the
existing pattern (`caption`, `transcript`, etc.).

## Testing

Tests live flat under `test/`, matching the repo's existing convention
(`test/segment.test.ts`, `test/caption.test.ts`, `test/transcript.test.ts`
already exist and gain cases rather than spawning per-module subdirectories):

- `test/segment.test.ts`: `burst_gap` fires on a click→(long pause with mouse
  movement in between)→click sequence where a naive all-events `dwell_gap`
  check would not fire; priority ordering when a `burst_gap` and
  `focus_change` land on the same `t_mono`; a granularity with a restricted
  `cutReasons` ignores boundaries outside that set; adaptive `task` sizing
  against a short synthetic session (assert `targetMs`/`strideMs` scale down,
  with the floor and ceiling both exercised).
- `test/transcript.test.ts`: two adjacent action segments no longer both
  receive a blob's full text when the blob straddles their shared boundary
  and the fake transcriber returns `segments`; the no-`segments` fallback
  still reproduces today's whole-blob-join behavior.
- `test/caption.test.ts`: a segment whose sampled frames all have resolvable
  bounds gets a distinct crop-based `app_caption` from the whole-frame
  `caption`; a segment with no resolvable bounds gets no `app_caption` row at
  all (not a copy of `caption`).
- `test/app-caption.store.test.ts` (new, mirroring `ax-snapshot.store.test.ts`
  for the same "new table, not a new column" reason): `segment_app_caption`
  write/read round-trip, cascade-deletes with its `segment` row.

**Validate against a real recording before trusting the fix** (this repo's
own rule, and how all three problems were found in the first place): re-run
the same Electron/Calculator recording through the pipeline and confirm,
by reading the actual rows, that (a) `task` segments no longer flatten the
whole session into one summary, (b) adjacent transcript segments no longer
repeat the same sentence, and (c) `app_caption` text for the Calculator span
actually differs from the whole-desktop `caption` text for the same segment.
