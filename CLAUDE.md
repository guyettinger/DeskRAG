# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DeskRAG — a local-first system that captures desktop activity (screen, audio, mouse/keyboard, accessibility tree) into a searchable multimodal "experience memory," retrievable by text, visual example, or behavioral similarity. TypeScript/Node throughout, strict mode, ESM.

Two packages in one npm workspace: **`src/`** is the library (published as `deskrag`), **`app/`** is **DeskRAGApp**, the Electron desktop client over it (workspace `deskrag-app`). `native/` holds the Swift AX sidecar. Default to working in the library; the app is a consumer of its public barrel.

## Commands

```bash
npm install            # native modules: better-sqlite3, @lancedb/lancedb, sharp
npm run typecheck      # tsc --noEmit (strict; run this after edits — it's the primary gate)
npm test               # vitest run (full suite)
npx vitest run test/store.crash.test.ts     # a single test file
npx vitest run -t "scoped ANN"              # tests matching a name
npm run test:watch     # vitest watch
npm run build:ax       # compile the macOS AX sidecar (swiftc) -> native/ax-dump (gitignored)
```

App (`app/`) — separate build, separate gate:

```bash
npm run build                                  # library -> dist/ (the app imports dist, not src)
npm --workspace deskrag-app run rebuild:native # better-sqlite3 -> Electron ABI (one time; see invariants)
npm run app:dev                                # build library, then electron-vite dev
npm run app:build                              # build library, then electron-vite build -> app/out/
npm --workspace deskrag-app run typecheck      # the app's gate (renderer + node tsconfigs)
```

- **Tests are the source of truth for behavior.** Prefer running the relevant test file over reasoning about correctness; the suite is fast (~6s) and deterministic.
- **Live/native tests skip cleanly** without their dependency: provider smokes need `OLLAMA_SMOKE=1` / `VOYAGE_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`; the ffmpeg and Swift-sidecar tests skip when `ffmpeg`/`swiftc` are absent. CI-safe by default.

## Architecture — the load-bearing seams

The two rules below are enforced structurally and are non-negotiable; most bugs come from violating them.

### 1. Dual-store consistency (`src/store/`)
SQLite (`better-sqlite3`, WAL) is the relational **source of truth** + high-volume event firehose; LanceDB owns **all vectors** + scoped ANN. They share app-minted **ULID** string keys and are joined application-side. `DualStore` (`store/store.ts`) is the ONLY place both engines are known — callers never see both. Rules it enforces:
- **Write order: SQLite transaction commits FIRST, then Lance add.** A crash in between leaves a relational row with no vector — detectable and re-embeddable. The reverse creates undetectable orphan vectors. `putRegions` is the template every vector-write follows; all writes serialize through a `Mutex` so the commit→add pair can't interleave.
- **Shared ids:** the SQLite primary key IS the Lance row key, verbatim.
- **Delete order:** gather ids from SQLite → delete Lance by id set → delete SQLite.
- **Reconciliation runs one direction (SQLite is truth):** prune orphan vectors, and return *missing* rows (SQLite row present, blob/text available, vector absent) for a caller-injected re-embed callback — so `store/` never depends on `represent/`.

### 2. Vector namespacing discipline (`src/embed/types.ts`)
Embeddings from different models are NOT comparable. Every vector is namespaced `view:provider:model:dimensions` via `namespaceFor()`, and LanceDB keys **one physical table per namespace** — two models physically cannot land in one similarity search. `dimensions` is part of the namespace, so a truncated model is a distinct space. Always store the raw text/frames/AX so vectors can be regenerated if a provider changes.

### Pipeline (each stage narrows scope; retrieval never widens)
```
capture/  → per-signal producers stamp events on a MONOTONIC clock (t_mono, never wall-clock)
segment/  → event-driven boundaries (focus change, dwell gap, bookmark) + multi-granularity overlapping windows
represent/→ 6 embeddable views per segment/frame/region (below)
retrieve/ → Tier0 pHash · Tier1 segment RRF · Tier2 frame ANN (scoped to Tier1 segments) ·
            Tier3 region ANN + AX-label FTS (scoped to Tier2 frames) · Tier4 optional LLM rerank
            → assemble.ts fuses into ranked frames + `highlights` (region bboxes+labels)
```

**Correlate on `t_mono`** (monotonic offset from a session epoch, `timeline/clock.ts`) — never wall-clock; `started_at` exists only for human display. Segments are detected *after* capture, so frame↔segment association and the denormalized `segment_ids` on frame vectors are set lazily at represent time.

**The 6 views:** transcript (STT — `FfmpegAudioProducer` captures chunks, `TranscriptRepresenter` + `WhisperCppTranscription` turn them into text; a `FakeTranscription` keeps the tests pure), caption (VLM), digest (templated event text), behavior (12-dim input-dynamics vector, a "builtin" namespace — not a network provider), frame-image, region-image. Tier-1 fuses views with **Reciprocal Rank Fusion**, not score averaging (scales differ).

**Region proposal (`represent/regions/`, the PixelRAG edge):** fuse three sources — AX tree (`axFilter`: real labeled bboxes, filtered hard), interaction hotspots (weighted DBSCAN over clicks/dwell — the signal video RAG lacks), and grid tiling — via NMS with a cross-source agreement priority bump, then a budget cut. AX role/label is also written to SQLite FTS5 so regions are text-searchable by UI role.

### Providers, adapters, and the "not in the barrel" rule
Anything that embeds/captions/reads-AX is behind an interface with swappable adapters (local Ollama, remote Voyage/Gemini/Anthropic) and a **deterministic fake** for tests. Adapters that load a native npm module or spawn a subprocess (`uiohook-napi`, `active-win`, `sharp`, the ffmpeg/Swift sidecars) are **deliberately NOT re-exported from `src/index.ts`** — import them from their own path — so importing the package never force-loads native code. The whole visual/native chain is real and tested; only query vectors are faked (a fake embedder maps identical input → identical vector, which lets tests place exact-match items deterministically).

### The desktop app (`app/`) — one more seam: the process boundary
electron-vite + React + TS. Three source roots with a hard rule between them: **`src/main` is the only process that may touch the library, the store, native modules, or API keys.** `src/preload` is a typed `contextBridge` exposing `window.deskrag`; `src/renderer` sees only plain serializable DTOs.

- **`src/shared/types.ts` is the contract** — DTOs (`FrameHitDTO`, `ResultDetailDTO`, `SettingsView`, …) plus the `IPC` channel-name map, so main and preload can't drift. It imports nothing from Node or `deskrag`; both sides depend on it. Changing an IPC shape means changing it here first.
- **`DeskRagService` (`main/deskrag-service.ts`) is the single owner of the library** — opens the `DualStore` + `BlobStore` under the app data dir, builds providers from settings, runs the record lifecycle, auto-indexes (segment → represent) on stop with per-stage progress events, and hydrates search hits into DTOs.
- **Everything optional is gated, never assumed.** Indexing stages are pushed only when their provider is configured (frame/region need an image embedder, captions a captioner, transcripts a whisper model path); native producers (`uiohook-napi`, `active-win`, `sharp`) are `await import()`ed with `/* @vite-ignore */` inside try/catch so a missing module disables one signal instead of failing startup. `capabilities()` mirrors this to the renderer for UI gating.
- **Bytes don't go over IPC.** Keyframes are served by blob id through the privileged `deskrag://frame/<blobId>` protocol (`main/protocol.ts`), registered *before* `app.whenReady`.
- **API keys stay in main.** `SettingsStore` persists them encrypted via Electron `safeStorage` (`keys.enc`); the renderer receives presence booleans only, never plaintext. If `safeStorage` is unavailable it declines to write rather than falling back to plaintext.
- **Data dir:** `<userData>/DeskRAG/` (dev: `~/Library/Application Support/deskrag-app/DeskRAG/`) — `app.db`, `lance/`, `blobs/`, `settings.json`, `keys.enc`, `sessions.json`. The library has no "list all sessions" read, so the app keeps its own `sessions.json` log, appended after each indexed recording.
- **Lifecycle:** window close hides to a menu-bar tray and recording keeps running; only Quit closes the store.

## Non-obvious invariants (verified the hard way — don't regress)
- **`better-sqlite3` `safeIntegers` does NOT reach UDF arguments** (only column reads become BigInt). So the 64-bit pHash Hamming (Tier 0) runs in JS, not a SQL UDF, and `hydrateFrame` must `Number()`-coerce the small INTEGER columns that come back as BigInt under safeIntegers.
- **LanceDB `.where()` PRE-filters by default** in the JS SDK — that's what makes Tier-2/3 scoping exact. `array_has_any(segment_ids, [...])` is the segment-scope predicate.
- **Pinned deps for a reason:** `apache-arrow` is pinned to `18.1.0` (LanceDB peer-caps it `<=18.1.0`); `sharp` is `^0.35.3` (0.34.x had libvips CVEs). Don't bump these blind.
- **Coordinate spaces:** AX bboxes and mouse hotspots are both global **screen** coordinates (top-left origin); the stored JPEG keyframe may be downscaled, so `SharpRegionCropper` maps the bbox from frame space → image space via `sharp.metadata()`.
- **AX is captured live at capture time and stored** (`frame_ax` table), then read back at represent time via `StoredAxProvider` — never queried live during represent (the UI has moved on).
- **Electron's Node ABI ≠ system Node's.** `npm --workspace deskrag-app run rebuild:native` rebuilds `better-sqlite3` for Electron, which **breaks the library's `npm test` until you `npm rebuild better-sqlite3` back**. If native tests suddenly fail with a NODE_MODULE_VERSION error, that's why. `sharp` and `@lancedb/lancedb` are N-API/prebuilt and unaffected. (App-local native copies are future work.)
- **`searchSegments` throws on an unregistered namespace**, so a `Retriever` must only be given `TextViewSearcher`s whose namespace appears in `store.listVectorSpaces()` — caption/transcript spaces don't exist until something has been indexed with those providers. `BehaviorViewSearcher` is always safe (it returns null without a behavior vector). See `DeskRagService.buildRetriever`.
- **The app imports `dist/`, not `src/`** — after changing library code, `npm run build` before launching (`npm run app:dev` does both). Library types changing means the app's typecheck can break without any file in `app/` changing.

## Build order when extending
Follow the dependency direction: `embed/` + `store/` first (prove the seam with the crash-recovery and scoped-ANN tests), then `timeline/` → `capture/` → `segment/` → `represent/` → `retrieve/`. New embeddable views register a `vector_space`, write text/raw first then the vector, and slot into reconciliation and a Tier-1 `ViewSearcher`. The app comes last: a new capability surfaces as a `deskrag` barrel export → an indexing stage or searcher in `DeskRagService` → a `Capabilities` flag + DTO field in `shared/types.ts` → UI.
