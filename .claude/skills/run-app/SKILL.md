---
name: run-app
description: Launch and drive DeskRAGApp — the Electron client — to check a change in the real app rather than only in the suite. Covers the Playwright `_electron` launch that opens the REAL data dir, navigating the screens, and asserting against the live DOM. Use this whenever you need to run, start, open, screenshot, or click through the app; whenever you want to confirm a renderer, IPC, DTO, or store change actually works on screen; and whenever a claim about what the app *shows* would otherwise rest on reading the code. `npm test` cannot see any of this — the suite has no renderer and no Electron.
---

# Running DeskRAGApp

`npm test` proves the projection functions are right. It cannot tell you the
rail rendered, the IPC payload arrived, or the label is legible — there is no
renderer and no Electron in the suite. This is how you find out.

This repo's two worst bugs were both invisible to `npm test` and obvious within
minutes of driving a real session. Assume that pattern holds.

## Launch

`scripts/lib/launch.ts` in the REPO wraps the whole dance — one copy, shared
with the six `npm run probe:*` scripts that drive the app and with `gen:shots`,
so the launch contract cannot drift between this workbench and the checks that
ship. It is TypeScript, so run anything importing it under `npx tsx`, not `node`:

```bash
npx tsx .claude/skills/run-app/scripts/rail-report.mjs     # worked example
```

To write your own check, import the helpers:

```js
import { launchApp, gotoScreen } from "./scripts/lib/launch.js";
const { app, page } = await launchApp();
await gotoScreen(page, "Library");
// ... assert, screenshot ...
await app.close();
```

Four things about the launch are load-bearing, and each one fails *silently*
if you get it wrong:

- **Build both packages first.** The app imports `dist/`, not `src/`, and
  electron-vite builds to `app/out/`. `npm run build && npm --prefix app run build`.
  Skipping this drives the *previous* version of your change and everything
  looks fine.
- **Launch the app DIRECTORY, never `app/out/main/index.js`.** Electron derives
  `app.getName()` — and therefore `<userData>` — from the `package.json` next to
  the entry point. Point at the built file and the app silently becomes
  "Electron" and opens an empty `~/Library/Application Support/Electron/`
  instead of the real data dir. You get a working app with no recordings in it
  and no error anywhere.
- **Use the app's own Electron binary**, resolved through
  `createRequire(app/package.json)("electron")`. Playwright must not download a
  browser; the app's binary is the one with the right ABI for its
  `better-sqlite3`.
- **Quit any running dev instance.** A second process opening the same
  `DualStore`/LanceDB data dir will not share it.

The window is created with `show: false` and `firstWindow()` resolves *before*
`ready-to-show`, so set the size and show it yourself rather than trusting a
default — `launchApp()` does this.

## Navigate

Rail buttons are matched by **label, never index**. `scripts/gen/shots.ts` learned
this the hard way: inserting a screen shifted every index below it, and a shot
that meant "Search" silently drove a different screen and waited 8 seconds for a
selector that was never coming. `gotoScreen()` uses an anchored regex and throws
if the match is not exactly one.

Screens: `Record`, `Indexing`, `Library`, `Flows`, `Search`, `Settings`.

## Wait for CONTENT, not for a timer

This is the mistake most likely to waste your afternoon, and it produces a
*confident wrong answer* rather than an error.

The Library's rail is hydrated over IPC after the screen mounts. A probe 2.5s
after navigating reported the keyframes lane as empty — zero thumbnails, zero
ticks. The screenshot taken moments later plainly showed 21 thumbnails. Nothing
failed; the DOM was simply sampled before the data landed, and the number lied.

So wait on a *condition that means the data is here*, not on elapsed time:

```js
await page.waitForFunction(
  () => document.querySelectorAll(".tracks__lane").length > 0
     && [...document.querySelectorAll(".tracks__lane")]
          .some((l) => l.querySelector(".tracks__span, .tracks__thumb, .tracks__mark")),
  { timeout: 20_000 },
);
```

`waitForContent()` in `scripts/lib/launch.ts` does exactly this.

## Assert in the DOM *and* look at the screenshot

Do both. They fail in different directions, which is the point:

- A **screenshot alone** can't tell you a label is one pixel from truncating, or
  that a 5px bar has a 12px hit target. Geometry needs `getBoundingClientRect()`.
- A **DOM assertion alone** gave the "0 keyframes" reading above. It was the
  screenshot that caught it.

**Read the screenshot you took.** A blank frame means the launch failed, and an
unread screenshot proves nothing.

Useful predicates, all learned from real defects in this rail:

```js
// A label wider than its box is a TRUNCATED label. The rail's contract is that
// `labelFits` withholds a label that would not fit, so nothing truncates —
// an ellipsis reappearing means that rule broke.
labels.filter((l) => l.scrollWidth > l.clientWidth + 1).length === 0

// The bar is the signal's TRUE extent; the hit rect is padded separately.
// Widening the bar to make it clickable is the overstatement the rail exists
// to avoid, so these two numbers are SUPPOSED to differ.
minSpanPx  // e.g. 5.67 — honest
minHitPx   // e.g. 12.0 — clickable
```

Lane identity is **not** in the DOM as an id — `TrackLane.tsx` renders
`data-shape` and the title text. Match lanes by their `.tracks__title`.

## Nothing here spawns `ax-exec`

The Library and Flows screens read the store and never observe the live desktop.
Driving them cannot trigger an Accessibility permission prompt, and if you ever
see one, something has been wired that should not be — see CLAUDE.md on the
executor being deliberately unreachable from the app.

## When there is no data

Library, Flows and Search all depend on indexed recordings. Without them you get
legitimate empty states, not failures — `.empty`, or a lane's `.tracks__empty`
carrying its `emptyReason`. If your check needs real content, assert the empty
state is *absent* rather than letting a soft timeout pass silently.

To record one: launch the app and press Record. **The Recorder window's own
elapsed timer displays milliseconds**, so leaving it on screen makes every
sampled frame a visual change and defeats keyframe decimation entirely (measured:
18/18 and 22/22 frames kept at every threshold). Close it to the tray — recording
continues.

## Related

- `scripts/gen/shots.ts` in the repo root regenerates `docs/images/*.png` with the
  same launch pattern. If you change navigation or screen selectors, check
  whether it needs the same edit.
- `scripts/probes/decimate.ts` is the read-only harness for keyframe thresholds
  and needs no app at all.
- `scripts/indexing-report.mjs` measures the Indexing screen's stage ladder —
  bands, row geometry, truncation, the time rollup (including its COMPUTED block
  colours, because a palette collision is invisible to a structural assertion),
  and that the record button is not disabled. Read-only.
- `scripts/stage-meter-probe.mjs` is the only check that sees a meter MOVE. It
  records briefly, then samples the running row: that the fill actually grew,
  that the count names a unit, that the clock advances, and that a stage which
  cannot count says so rather than showing a stalled bar. Everything else on the
  Indexing screen can be checked against a finished job, where no meter exists —
  which is exactly how three ordering bugs survived a green suite here.
- `scripts/probes/merge.ts` is the one that WRITES HABITS, and it is the reason
  `launchApp` takes a `userDataDir`. It clones the real `<userData>` (APFS
  copy-on-write), drives the app against the clone, and deletes it — so it can
  stage two duplicate habits and archive one without touching a person's
  authored prose. Pass `userDataDir` only for a check that writes; a read-only
  check wants the REAL store, because a fixture agrees with whatever the code
  assumes.
- `scripts/probes/reflect.ts` also writes to a clone, and it is the only check
  that a real model writes a real reflection into a real store. It re-indexes
  ONE recording, which is minutes rather than hours only because it turns
  captions off **in the clone** first — 92% of a re-index on a real library, and
  Reflecting reads neither of them. It ends by reading the note out of the
  clone's `app.db` with `better-sqlite3` and checking no rendered `HABIT.md`
  contains it: a reflection is prompt input, never record.
- `scripts/probes/stability.ts` is the longest-running one, and also writes to a
  clone. It runs three FULL re-index + re-mine cycles and asks whether the route
  keys move — they are predicted not to, so a drift is a finding rather than
  noise. It must wait for the queue to be EMPTY, not for the per-session jobs:
  the trace rebuild is the last job of the batch and it is what re-mines the
  routes, so finishing early reads the routes off the previous graph.
- `scripts/queue-handoff-probe.mjs` is the one that RECORDS: it proves a second
  recording can start while the first indexes, and that the queue yields to it.
  Two short real captures land in the library.
- `scripts/habits-screen-probe.mjs` reads C2's three habit readings off the
  REAL store: the portrait band, the rhythm strip, and the "Not walked lately"
  band. Read-only — it navigates and clicks one row, and writes nothing. Two of
  its three subjects were expected to be SILENT on a young library, and it
  checks the silence rather than skipping it: the rhythm strip must state its
  reason, and the fade line must appear on exactly the banded rows and no
  others. Writing it that way has already paid — the spec predicted the strip
  would refuse (3 walks, 2 days) and the library grew to 4 walks across 3 days
  before the code shipped, so the grid drew and the OTHER branch is what ran.
  It prints the corpus FIRST, so every number below is read against the library
  that produced it.

**Do not write `page.waitForFunction(async () => ...)`.** An async predicate
returns a PROMISE, which is always truthy, so the wait resolves on its first
tick. It cost an afternoon here: the handoff probe reported "no job was
enqueued" against a store that had one moments later, and the confident wrong
answer looked exactly like a real bug in the app. Poll from node instead, where
`await` means what it says — `until()` in `queue-handoff-probe.mjs`.
