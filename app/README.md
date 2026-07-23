# DeskRAGApp

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
npm install            # installs the library + this app (workspace)
npm run build          # compile the library to dist/ (the app imports it)
```

### Native modules must match Electron's ABI

The library's native deps (`better-sqlite3`, `sharp`, `@lancedb/lancedb`) are
built for your system Node when you run the library's tests. Electron ships its
own Node ABI, so before launching the app you must rebuild them for Electron:

```bash
npm --workspace deskrag-app run rebuild:native
```

> Trade-off: this rebuilds `better-sqlite3` for Electron, which will break the
> library's native `npm test` until you rebuild it back for system Node
> (`npm rebuild better-sqlite3`). Package-time isolation (app-local native
> copies) is future work — this version targets dev use.
>
> `sharp` and `@lancedb/lancedb` are N-API/prebuilt (ABI-stable), so only
> `better-sqlite3` needs the Electron rebuild.

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

Or, after `npm run build` + the native rebuild:

```bash
npm --workspace deskrag-app run dev
npm --workspace deskrag-app run typecheck   # the app's gate (renderer + node tsconfigs)
```

For a production build (`app/out/`): `npm run app:build` from the repo root.

> The app imports the library from `dist/`, not `src/` — rebuild the library
> (`npm run build`) after changing library code. `npm run app:dev` / `app:build` do
> that for you.

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
