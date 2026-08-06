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

Optional, per feature — a missing one disables exactly that feature:

| Feature | Needs |
|---|---|
| Screen capture, audio chunks | **`ffmpeg`** on `PATH` |
| Mouse/keyboard + focused window | **`uiohook-napi`**, **`active-win`** (optionalDependencies) |
| Accessibility tree | **`swiftc`** (Xcode Command Line Tools) — build the sidecars with `npm run build:ax` |
| Replay (acting on a trace graph) | the **`ax-exec`** sidecar, from the same `npm run build:ax` |
| Transcription | a **`whisper.cpp`** binary (`brew install whisper-cpp`) — the model downloads itself |
| Ollama-backed embeddings/captions | an **Ollama** daemon on localhost |

## Install

```bash
npm install
npm run typecheck
npm test
npm run build:ax   # optional: compile both macOS sidecars (native/ax-dump, native/ax-exec)
```

> Rebuild the sidecars *and* the library together. `ax-dump`'s stdout shape is
> parsed by `dist/`, so a `native/` built against an older `dist/` makes every
> accessibility walk silently return nothing — no error, just empty results.

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
npx vitest run test/store.crash.test.ts   # one file
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
- **`smoke:onnx-electron`** is the only thing that reproduces the ONNX allocator
  crashes — they need Chromium's allocator *and* a second run, and vitest gives
  neither. Any change to ORT session options, tile counts, or model exports wants
  this smoke, not the suite.
