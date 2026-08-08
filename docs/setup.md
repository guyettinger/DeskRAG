# Setup

## Requirements

- **Node ≥ 20**, macOS (native capture is macOS-focused today).
- Native npm modules build on install: `better-sqlite3`, `@lancedb/lancedb`, `sharp` (image crops).
- **macOS permissions** for live capture: Screen Recording, Accessibility, Input
  Monitoring, and Microphone — granted to the launching process (for the app in dev,
  that's Electron). Audio is read by a *child* `ffmpeg`, so the grant has to belong to
  the bundle; a packaged build gets there via `NSMicrophoneUsageDescription` plus the
  `com.apple.security.device.audio-input` entitlement in `app/build/entitlements.mac.plist`.
  **Those entitlements only apply to a *signed* build** — without an Apple Developer
  signing identity electron-builder skips signing, and the packaged app cannot record
  audio however the plist reads. Check the built app, not the config:
  `codesign -d --entitlements - app/dist-app/mac*/DeskRAG.app`.
- **Screen Recording is what makes the display visible to `ffmpeg` at all.** macOS hides
  the `Capture screen` avfoundation devices until it is granted, and DeskRAG refuses to
  record rather than falling back to a device index that would be a camera. Grant it,
  then press Record again — no restart needed.
- **The microphone follows your macOS Sound setting** (avfoundation `:default`). Set a
  specific one in Settings only if you need to; an index like `:2` is per-machine, and
  index 0 is often a *virtual* device that records silence with no error at all. List
  yours with `ffmpeg -f avfoundation -list_devices true -i ""`.

The **`ax-dump` sidecar is required to record at all**, not just for the
accessibility tree. Capture reads the device timebase from `ax-dump --clock`,
and without it a frame can only be stamped with the time it *arrived* — measured
3.05s later than the moment it was captured. A session refuses to start rather
than storing timestamps that mean something different from every other session.

A packaged build ships the binary in `Contents/Resources`; a dev checkout builds
it with `npm run build:ax`, which needs `swiftc` (Xcode Command Line Tools).

Optional, per feature — a missing one disables exactly that feature:

| Feature | Needs |
|---|---|
| Screen capture, audio chunks | **`ffmpeg` 5.1 or newer** on `PATH` |
| Mouse/keyboard + focused window | **`uiohook-napi`**, **`active-win`** (optionalDependencies) |
| Accessibility tree | the same **`ax-dump`** sidecar (see above) |
| Transcription | a **`whisper.cpp`** binary (`brew install whisper-cpp`) — the model downloads itself |
| Ollama-backed embeddings/captions | an **Ollama** daemon on localhost |

## Install

```bash
npm install
npm run typecheck
npm test
npm run build:ax   # compile both macOS sidecars (native/ax-dump, native/ax-exec).
                   # NOT optional in a dev checkout: capture reads the device
                   # timebase from `ax-dump --clock` and refuses to start without it.
```

> Rebuild the sidecars *and* the library together. `ax-dump`'s stdout shape is
> parsed by `dist/`, so a `native/` built against an older `dist/` makes every
> accessibility walk silently return nothing — no error, just empty results.

> **ffmpeg must be 5.1 or newer.** The screen producer rate-limits sampling with
> `select` so each frame keeps its own presentation timestamp, and that needs
> `-fps_mode passthrough` on the sampling outputs — `-fps_mode` arrived in 5.1.
> An older ffmpeg rejects the option and exits, so recording fails loudly rather
> than producing mistimed frames. `-vsync passthrough` is the older spelling and
> is deliberately not used: it prints a deprecation line on every run, and the
> producer routes ffmpeg's stderr straight to the user.

To run the desktop client instead of using the library directly, see
[DeskRAGApp](../app/README.md).

## Development

`npm run typecheck` is the primary gate. The test suite is deterministic and runs
offline — live/native tests skip cleanly when their dependency is absent (the Ollama
smoke needs `OLLAMA_SMOKE=1`, the real-weights ONNX smoke needs `ONNX_SMOKE=1` +
`DESKRAG_MODELS_DIR`, and the ffmpeg/Swift tests skip without `ffmpeg`/`swiftc`).
There is no credential any test could want — every provider is local.

```bash
npm test                                  # full suite
npx vitest run test/dual-store.crash.test.ts   # one file
npx vitest run -t "scoped ANN"            # by test name
npm run test:watch
```

The app has its own gate — `npm --prefix app run typecheck` (renderer + node
configs) — and imports the library from `dist/`, so run `npm run build` after
changing `src/` before launching it (`npm run app:dev` does both).

See [CLAUDE.md](../CLAUDE.md) for the load-bearing invariants behind these rules.

### Native modules and Electron's ABI

Electron ships its own Node ABI, which is why `app/` is **not** an npm workspace
member: it keeps its own `app/node_modules` with a `better-sqlite3` rebuilt for
Electron, while the library's root copy stays Node-ABI for `npm test`. Neither
rebuild touches the other. `sharp`, `@lancedb/lancedb`, `uiohook-napi` and
`active-win` are N-API/prebuilt and are never rebuilt.

Consequence: native version pins live in **both** `package.json` files
(`better-sqlite3`, `sharp`, `@lancedb/lancedb` + the platform optionals) — keep
them in sync.

**Checking the split needs `new Database()`, not `require()`.** `better-sqlite3`
loads its addon lazily at construction, so `require("better-sqlite3")` from
`app/` succeeds under system Node whatever ABI the binary was built for — it
proves nothing, and reads as "the Electron rebuild never ran". The mismatch only
surfaces when a database is opened:

```bash
# From the repo root. Mind the working directory — the two copies differ only
# by which node_modules the resolver walks into first.
(cd app && node -e "new (require('better-sqlite3'))(':memory:')")
# Correct: ERR_DLOPEN_FAILED, "compiled against ... NODE_MODULE_VERSION 148.
# This version of Node.js requires NODE_MODULE_VERSION 137" — Electron's, not Node's.

node -e "new (require('better-sqlite3'))(':memory:')"   # root copy: opens silently
node -p "process.versions.modules"                      # 137 on Node 24
grep node_module_version app/node_modules/better-sqlite3/build/config.gypi   # 148 on Electron 43
```

The root copy is the reverse and must open cleanly, since `npm test` runs on
system Node. If the app's copy really is Node-ABI, `npm --prefix app run
rebuild:native` fixes it — but confirm with the check above first, because
`app`'s `postinstall` already runs `electron-rebuild` on every `npm run
app:install` and its output scrolls past well before the summary.

**npm 11 prints an `allow-scripts` warning on every install, and it is expected
here.** It lists `better-sqlite3`, `uiohook-napi`, `active-win`,
`onnxruntime-node`, `esbuild` and `fsevents` as having install scripts "not yet
covered by allowScripts". No action is needed and you do **not** have to run
`npm approve-scripts`: each of those resolves its binary from the tarball or an
optional platform package rather than from the blocked script, so a gated
install still produces working modules. Verified on macOS arm64 by installing
the four natives into an empty directory and loading each one; `esbuild` and
`fsevents` are exercised by `npm test` and the app build.

## Maintainer tooling

```bash
npm run gen:brand            # regenerate assets/ + app/build/ icons from scripts/brand/geometry.ts
npm run gen:shots            # regenerate docs/images/*.png from the built app
npm run smoke:onnx-electron  # the ONNX allocator crash vitest structurally cannot reach
```

- **`assets/` and `app/build/` are generated, never hand-edited.** A drift guard in
  `test/brand.assets.test.ts` byte-compares committed output against a fresh render
  and fails on hand edits.
- **`gen:shots`** builds the app, then drives it with Playwright's Electron driver to
  capture the five screens plus the detail view. It opens the real app data dir, so
  **quit any running dev instance first**; screens with no indexed data capture as
  empty states with a warning rather than failing. Rail buttons are targeted by
  **label, not index** — inserting a screen renumbers every one below it, and an
  index silently drives the wrong screen instead of failing.
  - **Configure a caption provider and an image model first, or the shots degrade
    with no warning at all.** The warning only covers an empty *screen*; a screen
    that renders fine with data missing is captured as a clean ✓. With
    `captionProvider: "none"` the Detail view reads "no caption" and the Library
    chapter title falls back to a timecode; with `imageProvider: "none"` no region
    rows are written, so Search's highlight badge is 0 and never renders. **Look at
    the six PNGs after a run** — the script cannot tell a thin store from a rich one.
  - The Search shot uses a **fixed demo query**, so it needs recorded content that
    actually matches it; otherwise it captures "No matches".
- **`smoke:onnx-electron`** is the only thing that reproduces the ONNX allocator
  crashes — they need Chromium's allocator *and* a second run, and vitest gives
  neither. Any change to ORT session options, tile counts, or model exports wants
  this smoke, not the suite.
