# Setup

## Requirements

- **Node ≥ 20**, macOS (native capture is macOS-focused today).
- Native npm modules build on install: `better-sqlite3`, `@lancedb/lancedb`, `sharp` (image crops).
- **macOS permissions** for live capture: Screen Recording, Accessibility, and Input
  Monitoring — granted to the launching process (for the app in dev, that's Electron).

Optional, per feature — a missing one disables exactly that feature:

| Feature | Needs |
|---|---|
| Screen capture, audio chunks | **`ffmpeg`** on `PATH` |
| Mouse/keyboard + focused window | **`uiohook-napi`**, **`active-win`** (optionalDependencies) |
| Accessibility tree | **`swiftc`** (Xcode Command Line Tools) — build the sidecar with `npm run build:ax` |
| Transcription | a **`whisper.cpp`** binary + a `ggml-*.bin` model on disk |
| Ollama-backed embeddings/captions | an **Ollama** daemon on localhost |

## Install

```bash
npm install
npm run typecheck
npm test
npm run build:ax   # optional: compile the macOS accessibility sidecar (native/ax-dump)
```

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
  capture the four screens plus the detail view. It opens the real app data dir, so
  **quit any running dev instance first**; screens with no indexed data capture as
  empty states with a warning rather than failing.
- **`smoke:onnx-electron`** is the only thing that reproduces the ONNX allocator
  crashes — they need Chromium's allocator *and* a second run, and vitest gives
  neither. Any change to ORT session options, tile counts, or model exports wants
  this smoke, not the suite.
