<p align="center">
  <img src="../assets/deskrag-mark.svg" alt="DeskRAGApp" width="112" height="112">
</p>

<h1 align="center">DeskRAGApp</h1>

A simple Electron desktop app over the [DeskRAG](../README.md) library: configure
providers, grant macOS permissions, toggle capture signals, record an experience,
then search your sessions as a contact sheet of keyframes and drill into any hit.

- **electron-vite + React + TypeScript.** `src/main` owns the library (store,
  capture, pipeline, providers); `src/preload` is a typed contextBridge; `src/renderer`
  is the UI. The renderer never touches Node or native code.
- **Local-first.** Text + behavioral search and keyframe thumbnails work offline
  with Ollama. Image-example search + region highlights need a Voyage/Gemini key.
- **Auto-index after Stop.** Stopping a recording runs segment → represent
  (digest/behavior always; frame/caption/region and transcript when configured).
- **Keys** are stored encrypted in the OS keychain (`safeStorage`), never sent to
  the renderer in plaintext.
- **Keyframes stream over a `deskrag://frame/<blobId>` protocol** rather than being
  marshalled through IPC as base64.

## Screens

| Screen | What's there |
| --- | --- |
| **Record** | Signal switchboard (screen · input · active window · microphone · accessibility tree) with a status LED each, inline notes for a missing permission (Grant / Open Settings) or a missing tool (`ffmpeg`, `ax-dump`), elapsed timecode, and stage-by-stage indexing progress after Stop. |
| **Search** | Text query, or an image file as a visual example (needs an image provider). Hits render as a contact sheet of keyframes — timecode, wall-clock, segment digest, score, highlight count — and open into a detail view with the full keyframe, region highlight boxes, the captured AX elements, and the segment's digest / caption / transcript. |
| **Settings** | Embeddings (Ollama host + model, image provider, caption provider, Tier-4 rerank), API keys, local Whisper binary + model, and capture defaults (frame rate, keyframe max width, audio device, chunk seconds). |

Closing the window hides the app to a menu-bar tray — **recording keeps running**,
and the tray menu can start/stop it. Only Quit closes the store.

## Setup (dev)

From the **repo root**:

```bash
npm install            # installs the library (root) — native modules for the test suite
npm run app:install    # installs this app into app/node_modules
```

### Native modules and Electron's ABI — handled for you

This app is a **separate package with its own `app/node_modules`**, not an npm
workspace member. That's deliberate: it lets the app's Electron-ABI
`better-sqlite3` coexist with the library's Node-ABI copy at the repo root, so
neither install ever breaks the other. `npm run app:install` (i.e.
`cd app && npm install`) runs a `postinstall` that rebuilds `better-sqlite3` for
Electron — no manual step, no switching.

> `better-sqlite3` is the only ABI-fragile module (a raw Node addon). `sharp`,
> `@lancedb/lancedb`, `uiohook-napi`, and `active-win` are N-API/prebuilt
> (ABI-stable) and are never rebuilt.

### External tools (optional, per signal)

Each is best-effort — a missing one only disables its signal:

| Signal / feature | Needs |
| --- | --- |
| Screen, Microphone | `ffmpeg` on `PATH` |
| Accessibility tree | the `ax-dump` sidecar — build with `npm run build:ax` (repo root) |
| Transcripts | a `whisper.cpp` binary + model, set in **Settings → Transcription** |

## Run

```bash
npm run app:dev        # from repo root: builds the library, then launches the app
```

Or, after `npm run build` (and `npm run app:install` once):

```bash
npm --prefix app run dev
npm --prefix app run typecheck   # the app's gate (renderer + node tsconfigs)
```

For a production build (`app/out/`): `npm run app:build` from the repo root.

> The app imports the library from `dist/`, not `src/` — rebuild the library
> (`npm run build`) after changing library code. `npm run app:dev` / `app:build` do
> that for you.

> Packaging: `npm run app:dist` builds and packages with `electron-builder`.
> Because the app has its own `app/node_modules` (with `electron` and the native
> deps as real dependencies), `electron-builder` resolves and rebuilds them from
> the app's own tree.

## macOS permissions

The app reads live permission status and deep-links to the right System Settings
pane. **Screen Recording** and **Accessibility** can't be granted programmatically
(grant them in System Settings, then relaunch); **Microphone** can be prompted in
app from the Record screen.

## Data

Everything lives under `<userData>/DeskRAG/` — in dev that's
`~/Library/Application Support/deskrag-app/DeskRAG/`: `app.db` (SQLite),
`lance/` (vectors), `blobs/` (keyframes + audio), `settings.json`, `keys.enc`,
`sessions.json`. (`<userData>` follows Electron's app name, so a packaged build
with a `productName` set will use a different parent directory.)
