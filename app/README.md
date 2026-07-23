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
```

## macOS permissions

The app reads live permission status and deep-links to the right System Settings
pane. **Screen Recording** and **Accessibility** can't be granted programmatically
(grant them in System Settings, then relaunch); **Microphone** can be prompted in
app from the Record screen.

## Data

Everything lives under `~/Library/Application Support/DeskRAG/DeskRAG/`:
`app.db` (SQLite), `lance/` (vectors), `blobs/` (keyframes + audio),
`settings.json`, `keys.enc`, `sessions.json`.
