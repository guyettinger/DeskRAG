# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DeskRAG — a local-first system that captures desktop activity (screen, audio, mouse/keyboard, accessibility tree) into a searchable multimodal "experience memory," retrievable by text, visual example, or behavioral similarity. TypeScript/Node throughout, strict mode, ESM.

Two packages, two independent installs: **`src/`** is the library (published as `deskrag`, root `package.json`), **`app/`** is **DeskRAGApp**, the Electron desktop client over it (`deskrag-app`, with its own `app/node_modules`). `app/` is intentionally NOT an npm workspace member — that's what lets its Electron-ABI `better-sqlite3` coexist with the library's Node-ABI copy (see invariants). `native/` holds the Swift AX sidecar. Default to working in the library; the app is a consumer of its public barrel.

## Commands

```bash
npm install            # native modules: better-sqlite3, @lancedb/lancedb, sharp
npm run typecheck      # tsc --noEmit (strict; run this after edits — it's the primary gate)
npm test               # vitest run (full suite)
npx vitest run test/store.crash.test.ts     # a single test file
npx vitest run -t "scoped ANN"              # tests matching a name
npm run test:watch     # vitest watch
npm run build:ax       # compile the macOS AX sidecar (swiftc) -> native/ax-dump (gitignored)
npm run gen:brand      # regenerate assets/ + app/build/ icons from scripts/brand/geometry.ts
npm run smoke:onnx-electron   # ColSmol x3 under the Electron allocator — the ONE crash vitest cannot reach
```

App (`app/`) — separate package, separate install, separate gate. The app is
NOT an npm workspace member: it owns its own `app/node_modules` so its
Electron-ABI `better-sqlite3` coexists with the library's Node-ABI copy (see
invariants).

```bash
npm run app:install                # cd app && npm install (postinstall builds better-sqlite3 for Electron)
npm run build                      # library -> dist/ (the app imports dist, not src)
npm run app:dev                    # build library, then electron-vite dev
npm run app:build                  # build library, then electron-vite build -> app/out/
npm --prefix app run typecheck     # the app's gate (renderer + node tsconfigs)
```

- **Tests are the source of truth for behavior.** Prefer running the relevant test file over reasoning about correctness; the suite is fast (~6s) and deterministic.
- **Live/native tests skip cleanly** without their dependency: provider smokes need `OLLAMA_SMOKE=1` / `VOYAGE_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`; the ffmpeg and Swift-sidecar tests skip when `ffmpeg`/`swiftc` are absent. CI-safe by default.
- **`npm test` structurally cannot catch the ONNX allocator crashes.** Both need Chromium's allocator (bare node's malloc satisfies the same request) AND a second run (ORT's mem-pattern block is only allocated from run #2). Vitest gives neither, so `SESSION_OPTIONS` has assertions that *pin* the flags but can never fail on the real symptom — `npm run smoke:onnx-electron` is what actually reproduces it. Any future change to ORT session options, tile counts, or model exports wants that smoke, not the suite.
- **`assets/` and `app/build/` are generated, never hand-edited.** They're derived from `scripts/brand/geometry.ts` by `npm run gen:brand`; a drift guard in `test/brand.assets.test.ts` byte-compares committed output against a fresh render and fails on hand edits.

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

**`FfmpegScreenProducer` emits THREE outputs from one ffmpeg process** (`split=3`): gray rawvideo → pHash, MJPEG → sampled `keyframe` blobs, and a continuous H.264 file → one `screen` blob per session. The `fps` filter sits on the two *sampling* branches, not the input, so the input runs at `videoFps` (default 10) for watchable video while pHash/keyframes still see 1 fps. The video is a **fragmented** MP4 (`+frag_keyframe+empty_moov+default_base_moof`) so a killed ffmpeg still leaves a playable file — verified by truncating one to 49% and decoding its first fragment. `stop()` therefore awaits ffmpeg's exit (SIGKILL after 5s) before the blob row is written. Playback maps a keyframe onto the video with `(frame.tMono − videoBlob.tMonoStart)/1000` — the markers fall straight out of `t_mono`.

**Producers never touch the store, including for files they write themselves.** A producer whose subprocess writes directly to disk calls `ctx.reserveBlob(media, codec)` before spawning and `ctx.commitBlob(blobId, {tMonoStart, tMonoEnd})` after it exits; the session stats the file for its byte length. `reserveBlob` returns `null` without a blob store, and a missing/zero-byte file writes no row — a video that never materialised must not sink the session.

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
- **Data dir:** `<userData>/DeskRAG/` (dev: `~/Library/Application Support/deskrag-app/DeskRAG/`) — `app.db`, `lance/`, `blobs/`, `settings.json`, `keys.enc`. `DualStore.listSessions()` is the authoritative session list (SQLite, with per-session counts + the `screen` video blob id), so the Library list can't drift from what delete actually removed. There is no `sessions.json` sidecar — an old one left on disk is ignored.
- **Deleting a recording is two calls, in order:** `store.deleteSession(id)` then `blobs.removeSession(id)`. The store records where blobs are; it does not own the files. Rows first — a row pointing at a deleted file is a broken read, whereas a file with no row is just reclaimable disk.
- **Video is served over a separate protocol host.** `deskrag://frame/<blobId>` buffers a keyframe whole; `deskrag://media/<blobId>` streams with `Range` → `206`. Chromium will not let a `<video>` seek without the 206 + `content-range` path.
- **Lifecycle:** window close hides to a menu-bar tray and recording keeps running; only Quit closes the store.

## Non-obvious invariants (verified the hard way — don't regress)
- **`better-sqlite3` `safeIntegers` does NOT reach UDF arguments** (only column reads become BigInt). So the 64-bit pHash Hamming (Tier 0) runs in JS, not a SQL UDF, and `hydrateFrame` must `Number()`-coerce the small INTEGER columns that come back as BigInt under safeIntegers.
- **LanceDB `.where()` PRE-filters by default** in the JS SDK — that's what makes Tier-2/3 scoping exact. `array_has_any(segment_ids, [...])` is the segment-scope predicate.
- **Pinned deps for a reason:** `apache-arrow` is pinned to `18.1.0` (LanceDB peer-caps it `<=18.1.0`); `sharp` is `^0.35.3` (0.34.x had libvips CVEs). Don't bump these blind.
- **`onnxruntime-node` is pinned to `1.27.0` with a known, accepted advisory.** It depends on `adm-zip <0.6.0` ([GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85), CVSS 7.5). Accepted deliberately: `adm-zip` appears only in `script/install-utils.js` (unpacking a NuGet package at install time), never in the runtime `dist/`, so nothing the app executes reaches it; the impact is availability-only (a crafted ZIP forces a 4GB allocation), not code execution; and npm's only "fix" is downgrading to `1.21.1`, a semver-major step backwards. `npm audit` will keep reporting it — that is expected, not a regression. Do NOT use `@huggingface/transformers` as a tokenizer source: it depends on `sharp ^0.34.5`, which conflicts with the pin above and would nest a CVE-era libvips copy. Use `@huggingface/tokenizers` (pure JS/TS, zero deps) instead.
- **Coordinate spaces:** AX bboxes and mouse hotspots are both global **screen** coordinates (top-left origin); the stored JPEG keyframe may be downscaled, so `SharpRegionCropper` maps the bbox from frame space → image space via `sharp.metadata()`.
- **AX is captured live at capture time and stored** (`frame_ax` table), then read back at represent time via `StoredAxProvider` — never queried live during represent (the UI has moved on).
- **Electron's Node ABI ≠ system Node's — solved by two isolated installs, not by switching.** `app/` is deliberately NOT an npm workspace member: it has its own `app/node_modules` with its own `better-sqlite3`, rebuilt for Electron by `app`'s `postinstall` (`electron-rebuild -f -w better-sqlite3`). The library's root copy stays Node-ABI for `npm test`; the two never share a binary, so neither rebuild touches the other. `better-sqlite3` is the only ABI-fragile module (raw Node addon); `sharp`, `@lancedb/lancedb`, `uiohook-napi`, and `active-win` are N-API/prebuilt and are never rebuilt. The runtime resolves the app's copy first because `app/out/main/index.js` externalizes `better-sqlite3` as a bare specifier and `app/` is nested inside the repo, so Node's upward walk hits `app/node_modules` before root. **Consequence:** native version pins now live in both `package.json`s (`better-sqlite3`, `sharp`, `@lancedb/lancedb` + the platform optionals) — keep them in sync.
- **`searchSegments` throws on an unregistered namespace**, so a `Retriever` must only be given `TextViewSearcher`s whose namespace appears in `store.listVectorSpaces()` — caption/transcript spaces don't exist until something has been indexed with those providers. `BehaviorViewSearcher` is always safe (it returns null without a behavior vector). See `DeskRagService.buildRetriever`.
- **The app imports `dist/`, not `src/`** — after changing library code, `npm run build` before launching (`npm run app:dev` does both). Library types changing means the app's typecheck can break without any file in `app/` changing.
- **`scripts/brand/emit-icons.ts` is macOS-only** — it shells out to `iconutil` to build the `.icns`. The rasterised PNG/ICNS/ICO binaries it and `emit-icons` produce are deliberately NOT drift-guarded byte-for-byte (unlike the SVG/Lottie emitters): libvips/librsvg output varies by version, so the test suite only checks the committed tray PNG isn't stale (alpha at a couple of geometry-derived pixels), not that it's byte-identical to a fresh render.

## Build order when extending
Follow the dependency direction: `embed/` + `store/` first (prove the seam with the crash-recovery and scoped-ANN tests), then `timeline/` → `capture/` → `segment/` → `represent/` → `retrieve/`. New embeddable views register a `vector_space`, write text/raw first then the vector, and slot into reconciliation and a Tier-1 `ViewSearcher`. The app comes last: a new capability surfaces as a `deskrag` barrel export → an indexing stage or searcher in `DeskRagService` → a `Capabilities` flag + DTO field in `shared/types.ts` → UI.
