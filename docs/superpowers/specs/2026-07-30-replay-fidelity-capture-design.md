# Replay-fidelity capture — making the trace IR's inputs real

**Date:** 2026-07-30
**Status:** Design approved, pending spec review

## Context

`src/trace/` shipped (PR #17). It lifts recorded sessions into a manipulable
graph, and it works — against the data capture produces today. That data is
missing seven things the IR needs, enumerated as derived requirements at the end
of `docs/superpowers/specs/2026-07-30-experience-trace-ir-design.md`.

The most visible consequence: **typed content is currently dropped entirely.**
`UiohookInputProducer` records `{ keycode }`, `groupGestures` needs a resolved
character, so every text gesture warns and emits nothing. Slots exist, are
tested, and can never be populated.

This spec is subsystem #1 of the four-way decomposition (capture → IR → executor
→ AI-in-the-loop). The IR was deliberately specified first so these requirements
would be a derivation rather than a guess.

### What already exists and is thrown away

Four of the seven need no new data source — the producers read it and discard it:

- **`active-win` returns `bounds`, `owner.bundleId`, and `url`** (for supported
  browsers). `ActiveWindowProducer` keeps only `name`, `title`, `id`.
- **uiohook events carry `altKey` / `ctrlKey` / `metaKey` / `shiftKey`.**
  `UiohookInputProducer` records only `keycode`.
- **Adaptive mouse sampling needs no new data at all** — `mouse_down`/`mouse_up`
  already bound the interval; only the throttle decision changes.

### What needs design

Three: character resolution, display topology, and AX capture cadence.

### What changed shape during design

Requirement #5 (AX element path) turned out to need no capture work — `axPathOf`
already derives it from the sidecar's existing `parent` back-references. It is
replaced here by something better: the sidecar does not read **`AXIdentifier`**,
an app-assigned stable id that is a far stronger anchor than a positional path
wherever it exists.

## Decisions taken during design

- **Environment facts are events, not configuration.** Display topology and
  keyboard layout can both change mid-session, and both fail *silently* when they
  do. Both become `t_mono`-stamped events resolved at lift time by "latest
  at-or-before" — the rule every other signal already uses. There is no
  session-metadata concept in this spec.
- **Characters resolve at lift time, not capture time.** Capture stores raw
  `{keycode, modifiers}` plus a keymap snapshot; `lift` resolves. Same shape as
  `StoredAxProvider`: capture raw, resolve later, re-derivable.
- **AX is captured at boundaries *in addition to* keyframes**, not instead.
- **One new `ax_snapshot` table**, not a generalized `frame_ax`.
- **`AXIdentifier` is read by the sidecar** and recorded on `Anchor.ax`.

### Why characters resolve at lift time

uiohook gives keycode plus modifier booleans and **no character**. macOS layout
translation needs `UCKeyTranslate` (Carbon), which Node cannot reach.

The deciding constraint: **the mapping is needed in both directions.** Capture
goes keycode → char; the executor, replaying `type $recipient` with an
AI-substituted value, must go char → keycode. One keymap serves both. Two
mechanisms would drift.

A static US-QWERTY table was rejected: it is silently wrong for every non-US
layout and for Dvorak/Colemak on US hardware, and wrong text that looks right is
the worst available failure mode.

### Why AX cadence needed both

The alternative in the IR spec — keep per-keyframe AX and accept a staleness
bound — is worse than it looks. `KeyframeGate` de-duplicates by pHash, so a
**static screen produces no keyframes and therefore no AX**. "Static" is what a
settled UI looks like, and settled is precisely when a boundary fires. The
staleness option does not merely degrade at boundaries; it systematically has
nothing to offer at the moments that matter most.

Boundary-triggered capture is feasible despite `computeBoundaries` running
post-hoc, because all three boundary reasons are live-detectable:

| Reason | Live signal |
| --- | --- |
| `focus_change` | `ActiveWindowProducer` already detects it |
| `bookmark` | a user hotkey — live by definition |
| `dwell_gap` | detectable when activity *resumes*, which is the right instant: the tree wanted is the settled one after the pause |

And there are two consumers with different needs: region proposal reads AX per
*frame* (`StoredAxProvider`, keyed by `frameId`); node predicates need AX per
*boundary*. Same data, different cadence, different key. Replacing one with the
other breaks region proposal.

### Why a new table rather than generalizing `frame_ax`

**This repo has no migration mechanism.** `openDb` applies
`CREATE TABLE IF NOT EXISTS` on every open, so an existing table's shape can
never change — altering `frame_ax` would silently do nothing on any database that
already has it. Adding a table is free; generalizing one is not.

Introducing `PRAGMA user_version` migrations was considered and deferred. The
repo will want it eventually, but adding a migration mechanism as a side effect
of shipping one table is a load-bearing decision made casually; it deserves its
own change.

## Architecture

```
native/ax-dump.swift      + --keymap, + --displays, + AXIdentifier in the walk
src/capture/env/          NEW — KeymapSource / DisplaySource, Swift impls, fakes
src/capture/producers/    uiohook-input: modifiers + adaptive sampling
                          active-window: bounds, bundleId, url, display-union check
src/capture/session.ts    taps the event stream, drives boundary AX capture
src/store/                + ax_snapshot table, putAxSnapshot / getAxAt
src/trace/lift.ts         + resolveKeys() pre-pass
```

`src/capture/env/` follows the `capture/ax/` precedent exactly: an interface, a
subprocess-backed implementation, a deterministic fake, and **not** re-exported
from `src/index.ts` — importing the package must never force-load a subprocess
adapter.

### Boundary AX capture lives in `CaptureSession`

It is the only component that sees every producer's events, because
`CaptureContext.emitEvent` funnels through it. Producers still never touch the
store, and cross-signal triggering sits in the one place that can do it.

The capture is **coalesced** (one walk in flight; later triggers collapse into
the pending one) and fires after a **settle delay** so the UI has painted rather
than being caught mid-transition. Each snapshot records the `t_mono` at which the
walk *started*, plus its duration, so staleness is measurable rather than
assumed.

Cost justifies both: the sidecar walk is budgeted at 800ms and measured ~0.5ms
per node for Finder, ~8ms for Mail. Unthrottled triggering on a flurry of app
switches would queue walks faster than they complete.

### The seam that keeps `gestures.ts` untouched

Characters are filled in by a `resolveKeys(events, keymapAt)` pre-pass in
`lift.ts`, which rewrites `data.char` before `groupGestures` ever sees the
events. Gesture grouping stays pure and unchanged, and its known-degraded path —
no `char`, no text gesture, warn — now fires only when a key genuinely cannot be
resolved rather than always.

### The scancode / virtual-keycode translation

uiohook keycodes are PC set-1 scancodes (`Space: 57`, `Escape: 1`); macOS
`UCKeyTranslate` wants virtual keycodes (`Space: 49`, `Escape: 53`). They are
different spaces, so a fixed translation table is unavoidable.

This does *not* reintroduce the static-table problem, and the distinction is the
whole point: **the static table maps physical keys, which are layout-independent;
only key → character is layout-dependent, and that comes from the sidecar.** A US
user and a Dvorak user have identical scancode↔virtual-keycode mappings and
completely different characters.

## Events, types, and schema

### Event changes

```ts
type EventKind = … | "display_change" | "keymap_change";

key_down/key_up  { keycode, modifiers: string[] }   // cmd|ctrl|alt|shift, sorted
focus_change     { app, title, windowId, bundleId?, url?, bounds? }
display_change   { displays: DisplayInfo[] }
keymap_change    { layoutId, entries }
mouse_move       unchanged shape; adaptive cadence
```

Adaptive cadence: `dragSampleMs` (default 12) while any button is down,
`mouseMoveThrottleMs` (default 100) otherwise. Required by `Path` fitting, which
cannot recover a drag curve from 100ms samples.

### Environment types (`src/capture/env/types.ts`)

```ts
export interface DisplayInfo {
  /** Stable for the boot; the NSScreen display id as a string. */
  id: string;
  /** Global screen coordinates, top-left origin — the same space as AX and mouse. */
  x: number; y: number; w: number; h: number;
  scale: number;
  primary: boolean;
}

export interface Keymap {
  /** e.g. "com.apple.keylayout.US" */
  layoutId: string;
  /** macOS virtual keycode -> [plain, shift, alt, altShift] */
  entries: Record<number, [string, string, string, string]>;
}

export interface DisplaySource { query(): Promise<DisplayInfo[]>; close?(): void }
export interface KeymapSource  { query(): Promise<Keymap | undefined>; close?(): void }
```

Both are best-effort by contract, exactly like `AxSource`: a missing binary,
non-zero exit, timeout, or malformed output resolves to empty/undefined and never
throws.

### Pure resolution (`src/capture/env/keymap.ts`)

```ts
/** Fixed physical-key mapping. Layout-independent by construction. */
export function macKeycodeFor(uiohookKeycode: number): number | undefined;

export function resolveChar(
  km: Keymap,
  uiohookKeycode: number,
  mods: readonly string[],
): { char?: string; modifiers: string[] };
```

### Pure helpers (`src/capture/env/displays.ts`)

```ts
/** The display containing `p`, or the primary display when none does. */
export function displayIdAt(displays: readonly DisplayInfo[], p: Vec2): string;

/** True when `bounds` lies wholly outside the union of `displays` — the signal
 *  that topology changed and must be re-queried. */
export function outsideKnownDisplays(
  displays: readonly DisplayInfo[],
  bounds: Rect,
): boolean;
```

### Pure helpers elsewhere

```ts
// src/capture/producers/sampling.ts — extracted so it is testable without the
// native hook, which is the only reason it is its own module.
export interface SampleState { lastMoveTMono: number; buttonsDown: number }
export function shouldSampleMove(
  state: SampleState,
  tMono: number,
  opts: { mouseMoveThrottleMs: number; dragSampleMs: number },
): boolean;

// src/trace/lift.ts — the pre-pass. `keymapAt` resolves the latest
// `keymap_change` at-or-before a t_mono, so a mid-session layout switch applies
// from the moment it happened.
export function resolveKeys(
  events: readonly TraceEvent[],
  keymapAt: (tMono: number) => Keymap | undefined,
): TraceEvent[];
```

### The modifier rule

`resolveChar` discriminates chord from text:

- **cmd or ctrl present** → a command, not text. No character is produced; all
  modifiers are kept.
- **otherwise** → resolve the character, **consuming** shift/alt into the column
  choice and stripping them from `modifiers`.

This fixes a live bug rather than merely avoiding one. `gestures.ts` ships
`if (mods.length > 0) → chord`. Under a naive reading, typing a capital `A`
arrives as `modifiers: ["shift"]` and becomes **a chord `shift+A` instead of the
text "A"** — every capital letter and every shifted symbol. Consume-and-strip
makes the existing gesture code correct without touching it.

`⌥⌘S` keeps `alt`, because cmd is present so no character is produced and alt was
never consumed.

### Schema

```sql
CREATE TABLE IF NOT EXISTS ax_snapshot (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  t_mono      REAL NOT NULL,
  frame_id    TEXT REFERENCES frame(id) ON DELETE CASCADE,  -- NULL for boundary captures
  reason      TEXT NOT NULL,        -- keyframe | focus_change | bookmark | dwell_resume
  walk_ms     REAL NOT NULL,
  elements    TEXT NOT NULL         -- JSON-encoded UIElement[]
);
CREATE INDEX IF NOT EXISTS idx_ax_snapshot_session ON ax_snapshot(session_id, t_mono);
```

Note the cascade is from `session`, not `frame` — a boundary snapshot has no
frame, so it cannot inherit `frame_ax`'s delete path.

Store gains, over this row shape:

```ts
export interface AxSnapshotRow {
  id: string;
  sessionId: string;
  tMono: number;
  frameId: string | null;
  reason: "keyframe" | "focus_change" | "bookmark" | "dwell_resume";
  walkMs: number;
  elements: UIElement[];
}
```

- `putAxSnapshot(row): Promise<void>`
- `getAxAt(sessionId, tMono): AxSnapshotRow | undefined` — nearest at-or-before.
  This backs `liftTrace`'s `axAt` callback, which currently has nothing behind
  it. The nearest-at-or-before rule lives in the store, in one place.
- `getFrameAx(frameId)` — reads `ax_snapshot` by `frame_id`, falling back to
  legacy `frame_ax` for sessions recorded before this change.

### `AXIdentifier`

The sidecar reads it; `UIElement` gains `identifier?: string`; `buildAnchor`
records it on `Anchor.ax`. Purely additive. How the executor ranks
identifier-versus-path is that spec's concern, not this one's.

### Display topology change detection

Captured at session start, and re-queried when an observed window's `bounds` fall
outside the union of known displays. `ActiveWindowProducer` already polls every
500ms and (once `bounds` is plumbed) already has the data, so this costs nothing
in the common case and re-queries only when the change can actually affect a
coordinate.

It has a useful property: a monitor plugged in but not yet used needs no
detection, because nothing being recorded lands there.

### Keymap change detection

Session start, plus a 60-second poll emitting `keymap_change` only when
`layoutId` differs.

**The asymmetry with displays is deliberate.** A display change has a free
observable signal in data already collected; a layout change has no side effect
on anything recorded. Watching `kTISNotifySelectedKeyboardInputSourceChanged`
properly would require a long-running sidecar process instead of one-shot
`execFile` — a larger architectural change than this spec should make. One spawn
per minute is the cheap, correct-enough answer.

## Failure handling

Everything degrades along paths that already exist.

| Failure | Behavior |
| --- | --- |
| `--keymap` unavailable | No `keymap_change` → `resolveKeys` leaves `char` absent → gestures warn and drop text. Today's degraded state, unchanged. |
| `--displays` unavailable | No `display_change` → `displayIdAt` returns `"D0"`, which `lift` already does. Anchors keep their point layer. |
| Display re-query fails | Keep the previous topology and warn. Stale beats empty. |
| AX walk exceeds budget | Partial tree — existing sidecar contract, unchanged. |
| AX returns `[]` | **Write the snapshot row anyway.** |
| Unknown keycode | No `char`; the key is skipped with a warning, as today. |

The empty-row case is a deliberate behavior change. `AxCapturer.capture`
currently does `if (elements.length > 0) await putFrameAx(...)`, so an AX-blind
app writes nothing and is indistinguishable from "no capture was attempted." The
`reason` column exists precisely to tell those apart and cannot unless the empty
row lands.

## Testing

Pure where possible; native tests skip cleanly, as the suite already does.

- **`env.keymap.test.ts`** — pure `resolveChar` over checked-in US and Dvorak
  fixtures: consume-and-strip, cmd/ctrl passthrough, `⌥⌘S` keeping alt, unknown
  keycode → undefined.
- **`env.displays.test.ts`** — pure point→display resolution and out-of-union
  detection.
- **`capture.ax-cadence.test.ts`** — `CaptureSession` + fake `AxSource` +
  `SyntheticInputProducer`: triggers fire on focus_change / bookmark /
  dwell_resume; N rapid triggers coalesce to one walk; an empty result still
  writes a row carrying its `reason`.
- **`capture.input-sampling.test.ts`** — the throttle decision extracted as a
  pure `shouldSampleMove(state, tMono)`, testable without the native hook.
- **Store** — `ax_snapshot` round trip, `getAxAt` nearest-at-or-before,
  `getFrameAx` falling back to legacy `frame_ax`, cascade on session delete.
- **`trace.lift`** — the `resolveKeys` pre-pass fills `char`, **and a capital
  letter lifts to text rather than a chord** (the regression guard for the bug
  found during design).
- **Sidecar** — `--keymap` and `--displays` tests skip when `swiftc` is absent,
  matching `ax-swift.test.ts`.

## Honest limits

- **This does not retroactively fix existing recordings.** Sessions already on
  disk have no modifiers, no characters, no bounds. Re-lifting one still drops
  its typed text. Lifting is a projection and the inputs are simply absent — no
  migration can invent them.
- **Adaptive sampling raises event volume during drags**: a 2-second drag goes
  from ~20 to ~166 `mouse_move` rows. Drags are a small fraction of session time
  and the batcher already coalesces writes, so this is a note, not a concern.
- **Secure-field content is still recorded verbatim**, per the explicit decision
  in the trace IR spec. Adding resolved characters to the event log makes that
  decision more consequential, not less: passwords move from "keycodes on disk"
  to "plaintext on disk". Unchanged by choice, restated here so it is visible at
  the point where it starts to matter.
- **macOS only.** Both new sidecar modes are Carbon/AppKit. The interfaces admit
  other implementations; no others are planned.

## Out of scope

- The executor (driving macOS from a graph). Separate spec.
- The AI intervention runtime. Separate spec.
- A schema migration mechanism. Wanted eventually; deliberately not introduced
  as a side effect of this work.
- Retro-fitting old recordings.
