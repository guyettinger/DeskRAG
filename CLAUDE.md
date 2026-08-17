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
npx vitest run test/dual-store.crash.test.ts  # a single test file
npx vitest run -t "scoped ANN"              # tests matching a name
npm run test:watch     # vitest watch
npm run build:ax       # compile BOTH Swift sidecars -> native/ax-dump + native/ax-exec (gitignored)
                       # REQUIRED TO RECORD AT ALL now, not just for AX: the capture clock comes
                       # from `ax-dump --clock` and a session refuses to start without it. A
                       # packaged build ships the binary (extraResources); a dev checkout builds it.
                       # a STALE binary fails silently: ax-dump ignored --keymap/--displays for two days
                       # and every recording lost its typed text. Rebuild after touching native/.
                       # THE REVERSE IS ALSO FATAL AND WAS ALSO PAID FOR: ax-dump's stdout is an
                       # OBJECT ({elements, url}), and a dist/ built before that change parses it as
                       # nothing. Rebuilding native/ therefore REQUIRES `npm run build` + restarting
                       # the app, or every AX walk silently returns [] — measured: one whole recording
                       # with 14 snapshots and 0 elements. `parseAxResult` tolerates the old bare
                       # array so a stale BINARY degrades; a stale dist/ cannot be made to degrade.
npm run gen:brand      # regenerate assets/ + app/build/ icons from scripts/brand/geometry.ts
npm run gen:shots      # regenerate docs/images/*.png by driving the built app (quit any dev instance first)
npm run smoke:onnx-electron   # ColModernVBERT x3 under the Electron allocator — the ONE crash vitest cannot reach
npm run probe:latency         # capture delivery latency: --device for the real screen,
                              # default is a synthetic barcode bench with ground truth.
                              # Read-only; the device mode counts gray bytes, never reads them.
npm run probe:mcp             # drive the real app and call all six MCP tools over a real
                              # socket, plus the three guard checks. The ONLY place the tools
                              # meet a real store — the app-side integration test uses a fake
                              # reader. Read-only; every tool it calls is a read.
npm run probe:highlight       # sweep the patch-highlight FLOOR over real frames + known answers
npm run probe:embed           # which TEXT model retrieves better on the real store.
                              # Read-only (SQLite readonly, stdout only); drives the real
                              # OnnxTextEmbedding from dist/. Ground truth is caption ->
                              # its own digest. The haystack is DISTINCT TEXT, not segments
                              # -- a desktop digest corpus is mostly repeats (LIB-14: 750
                              # digests, 144 distinct), so scoring by segment id caps top-1
                              # at 1/85 and measures noise. See docs/internals/models.md.
npm run probe:patchgeom       # is the patch->box map DISPLACED? paints a marker at a known cell,
                              # re-embeds, and reports signed delta in cells. Read-only (SQLite
                              # readonly, writes only PNGs). Run this BEFORE touching geometry.ts.
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
- **Live/native tests skip cleanly** without their dependency: the Ollama smoke needs `OLLAMA_SMOKE=1`, the real-weights ONNX smoke needs `ONNX_SMOKE=1` + `DESKRAG_MODELS_DIR`; the ffmpeg and Swift-sidecar tests skip when `ffmpeg`/`swiftc` are absent. CI-safe by default — and there is no credential any test could want, since every provider is local.
- **`npm test` structurally cannot catch the ONNX allocator crashes.** Both need Chromium's allocator (bare node's malloc satisfies the same request) AND a second run (ORT's mem-pattern block is only allocated from run #2). Vitest gives neither, so `SESSION_OPTIONS` has assertions that *pin* the flags but can never fail on the real symptom — `npm run smoke:onnx-electron` is what actually reproduces it. Any future change to ORT session options, tile counts, or model exports wants that smoke, not the suite.
- **Prose docs live in `docs/`, not the README.** `README.md` is a landing page
  (pitch, screenshots, quick start, index); the detail is in `docs/architecture.md`,
  `docs/setup.md`, `docs/providers.md`, `docs/library-usage.md`, and `app/README.md`.
  This file stays the invariants reference. `docs/images/*.png` are generated by
  `npm run gen:shots` (`scripts/shots.mjs`) — it launches the app *directory* so
  Electron reads `app/package.json` and opens the real data dir, not an empty
  `~/Library/Application Support/Electron`.
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
segment/  → event-driven boundaries (focus change, dwell gap, bookmark) → ONE granularity, `action` (level 0)
represent/→ 6 embeddable views per segment/frame/region (docs/internals/represent-and-retrieve.md)
retrieve/ → Tier0 pHash · Tier1 segment RRF over text views + behavior + a LEXICAL lane ·
            Tier2 frame ANN (scoped to Tier1 segments) · Tier3 region ANN + AX-label FTS
            (scoped to Tier2 frames; the FTS half runs for TEXT queries and needs no model) ·
            Tier4 optional rerank
            → assemble.ts fuses into ranked frames + `highlights` (region bboxes+labels)
```

**Correlate on `t_mono`** (monotonic offset from a session epoch, `timeline/clock.ts`) — never wall-clock; `started_at` exists only for human display. Segments are detected *after* capture, so frame↔segment association and the denormalized `segment_ids` on frame vectors are set lazily at represent time.

## The detail lives in `docs/internals/` — READ THE FILE BEFORE TOUCHING THE CODE

This file is auto-loaded; those are not. Each line below states a rule. The file behind it
carries the **measurement that produced the rule**, and the measurement is the part you need
before you change anything — most of them were paid for twice, and several were invisible to
`npm test`. Treat a pointer as an instruction, not a footnote.

| file | covers | read before touching |
| --- | --- | --- |
| [capture.md](docs/internals/capture.md) | ffmpeg producers, the device-clock bridge, keyframe decimation, AX walks, where `action` cuts | `src/capture/`, `src/segment/`, `native/ax-dump`, anything with a timestamp |
| [represent-and-retrieve.md](docs/internals/represent-and-retrieve.md) | the 6 views, region proposal, RRF, evidence lanes, FTS | `src/represent/`, `src/retrieve/`, anything that ranks |
| [hierarchy.md](docs/internals/hierarchy.md) | the fixed Action → Task → Process → Session ladder | `src/represent/compose/`, any compose prompt |
| [trace-and-replay.md](docs/internals/trace-and-replay.md) | Trace IR, node identity, anchors, the executor | `src/trace/`, `src/replay/`, `native/ax-exec` |
| [models.md](docs/internals/models.md) | local providers, ONNX/tiling, patch highlights | `src/embed/`, any adapter, any highlight box |
| [app-main.md](docs/internals/app-main.md) | the process boundary, the indexing pipeline table, whisper, MCP | `app/src/main/` |
| [app-ui.md](docs/internals/app-ui.md) | the Library player, the track rail, Flows, `styles.css` | `app/src/renderer/`, any pixel |

### Capture and segmentation → [capture.md](docs/internals/capture.md)
- **A SAMPLE IS TIMED BY WHEN IT WAS CAPTURED, NEVER BY WHEN IT ARRIVED.** Arrival stamping measured **3.050s late** on a real device. `ctx.deviceClock` is the only conversion from device pts to `t_mono`; a wall-clock read in either ffmpeg producer needs an inline `arrival-ok:` note or `test/capture.no-arrival-stamp.test.ts` fails.
- **A SESSION REFUSES TO START WITHOUT `ax-dump --clock`.** avfoundation and Node are on different monotonic bases — measured **4.78 days apart**. The calibration pair is stored in `session_clock`; its **absence marks every pre-2026-08-08 recording**, whose lanes sit ~1s from the video, unrecoverably.
- **One ffmpeg process, FOUR outputs, ONE decimator.** The rate limit is `select`, never `fps` (`fps` relabels frames **−0.400s**); `-fps_mode passthrough` on all four, or CFR duplicates frames back up (**139 where 14 were expected**) and compresses the mp4 against real time by 1.4%.
- **The avfoundation device index is DISCOVERED, never defaulted, and there is NO numeric fallback for the screen.** A camera at index 1 fails as a framerate error, which reads as a pipeline bug. Audio defaults to `:default` — an index recorded **digital silence at −91 dB for a whole session** with no error anywhere.
- **A keyframe is a VISUAL STATE CHANGE decided by `mpdecimate`, not by a whole-frame hash.** `lo=1280` is the load-bearing parameter (ffmpeg's 320 keeps everything). **DeskRAG's own Recorder window defeats decimation entirely** — its millisecond timer changes every sampled frame, so any keyframe measurement taken with it visible is meaningless.
- **AX is captured at boundaries as well as keyframes**, both into `ax_snapshot`; a keyframe walk is assigned to a frame at **represent** time (`associateFrameAx`), because a frame arrives a capture latency after its own pixels.
- **`action` cuts at visual state change and does not subdivide by clock** — one segment holds exactly one keyframe, which is what makes caption extent exact. Scene times reach `computeBoundaries` as a separate parameter so `segment/` stays a leaf.
- **Characters are resolved at LIFT time** from the session's own `keymap_change`, never at capture. A command consumes no modifiers; the keymap excludes command keys. No keymap means every text gesture is silently dropped.
- **Environment facts (display topology, keyboard layout) are EVENTS, resolved latest-at-or-before** — never configuration.
- **Producers never touch the store**, even for files their own subprocess writes: `ctx.reserveBlob` before spawning, `ctx.commitBlob` after exit.
- **`CaptureSessionOptions.onActivity` is a TEE, and it can never fail a capture.** The session is already the only component that sees every producer, so a live per-signal readout needs no producer change and no store poll — it is emitted from the four points signals converge on, and every call is wrapped and swallows what it throws. A recording is real-time and unrepeatable; a meter is decoration.

### Represent and retrieve → [represent-and-retrieve.md](docs/internals/represent-and-retrieve.md)
- **FRAME↔SEGMENT LINKS ARE WHAT MAKE TEXT SEARCH RETURN ANYTHING, and must never be gated on a provider.** Once gated on an image provider defaulting to `"none"`, **2 of 4 real recordings returned nothing at all**, with no error. `associateFrames` is its own always-on stage.
- **`DEFAULT_RRF_K` is 5, not the published 60** — swept four times against known answers, and the margin widens as the library grows. It reaches the fusion **only** as `RetrieverOptions.tier1.rrfK`; passed at the top level it is silently ignored, which looks exactly like an inert sweep.
- **`FrameResult.score` IS AN ORDERING, NOT A CONFIDENCE.** All three maxima are taken over the current candidate set, so the top hit of every query sits at the weight ceiling — 1.000 on a default install. **The UI and the MCP tool show RANK and `FrameEvidence` lanes, never the number.** An empty `lanes` is meaningful: recalled with its segment.
- **Tier 1 has a lexical lane and Tier 3's FTS half needs no model** — on a default install that is the only route from a query to an exact term. Region FTS **pre**-filters by frame scope; post-filtering a global top-N returns nothing once the library grows.
- **`putSegmentVectors` is a bare `lance.add`** — a second pass writes a duplicate that `reconcile()` can never prune. Any path that may run twice uses `replaceSegmentVectors`. The FTS tables have no foreign key, so `deleteSession` clears them by name.
- **Regions run BEFORE Digest**, and the digest is a retrieval surface, not a tally: window title, URL, typed text, and the label of what was clicked (identical-string rate **86% → 4%**). Typed text is coalesced at **session** scope with backspace applied.

### The compositional hierarchy → [hierarchy.md](docs/internals/hierarchy.md)
- **`segment/` produces ONE granularity, `action`.** Above it sits a **FIXED three-level ladder** — Task, Process, Session — each asking its own question. A bigger box cannot produce a higher altitude; that was the open recursion this replaced, and it collapsed to fan-out 1.6.
- **Process is MODEL-ONLY**, so a default install produces Action → Task → Session with no Process level. **A level that fails admission is SKIPPED, never created-and-hidden**, and a node that would hold exactly one child is **elided** (the root is exempt). Elision compounds across hops and nothing bounds how far — a 286-action recording put **95 bare actions directly on its root**.
- **TIER-2 SCOPING MUST EXPAND A PARENT HIT TO ITS LEAVES** (`getDescendantLeaves`). Frame vectors denormalize `segment_ids` before composing runs, so scoping a composed level directly matches zero frames and returns empty **with no error**.
- **A composed level is under-ranked by construction and no `k` fixes it** — it participates in one dense lane where a leaf participates in three or four, and RRF is a sum.
- **A malformed partition is REJECTED WHOLESALE, never repaired**, and the model states **cut points**, not ranges. **Prompt tweaks against composition quality have twice measured as noise — require 3+ runs** before believing an A/B.
- **`source` (`llm` vs `template`) is disclosure, not bookkeeping**, and composing can never fail the run.

### Trace IR and the executor → [trace-and-replay.md](docs/internals/trace-and-replay.md)
- **`trace/` and `replay/` are LEAVES.** `test/replay.barrel.test.ts` asserts no file in `replay/` except `sidecar.ts` mentions `spawn` — **that guard is the whole safety story**: the suite is structurally incapable of posting a real event. Never widen it.
- **A node's identity is WHAT THE TASK DOES NEXT, not what is on screen.** `reach` is **denormalized into every stored predicate**, so editing `REACH_BY_KIND` changes nothing about a graph on disk — it needs a rebuild.
- **Merging uses exact set equality; verifying and locating use a SUBSET check.** A live screen that gained anything would never match exactly. A zero-predicate node is never a locate candidate.
- **Dry-run is the default, arming is one gate, and a plan STOPS where resolution stops working** — the remainder is disclosed unresolved, cut at an edge boundary. Planning may call `runningApps()` but never `activate()`.
- **AS OF 2026-08-06 THE EXECUTOR HAS NO UI.** It is reached only from the suite and `scripts/replay-probe.mjs` (read-only by proxy). **DeskRAGApp never spawns `ax-exec`.** Re-wiring it is a deliberate act, not a refactor.

### Providers, models, and highlights → [models.md](docs/internals/models.md)
- **Every provider is local. A network call to a third party is a regression, not a feature.** There are no API keys anywhere in this repo.
- **Adapters that load a NATIVE npm module are deliberately NOT in the barrel** (`onnxruntime-node`, `uiohook-napi`, `active-win`, `sharp`); anything that merely spawns a binary is. The line is native module, not subprocess.
- **There is ONE image provider: `colmodernvbert`, or `none`.** Standardizing removed the entire single-vector image lane. `DualStore` **drops retired spaces on open** — destructive, and rehearsed against a copy of the real store.
- **TEXT EMBEDDING IS ONNX-ONLY, and the model is a PINNED MENU, never free text.** The Ollama text lane is retired (Ollama still does captions and summaries), so a default install searches text with no daemon. The free-text box it replaced is not a hypothetical hazard: a 30B chat model typed into it left `digest:ollama:muse-glimmer:768` registered with a 0-row Lance table on the author's real library (LIB-14, since reset — see docs/internals/models.md), and `OllamaTextEmbedding` hardcodes `dimensions: 768`, so every 1024-dim model would have done the same. A dropdown over `/api/tags` would have shipped that bug wearing a `<select>` — the dimension has to be **declared**, which is why the menu is pinned.
- **A text model's quirks are DATA (`src/embed/text-profiles.ts`), not branches**, and all three fail silently when guessed: task prefixes, whether `token_type_ids` is required (nomic **requires** it, Gemma3 **rejects** it), and which output tensor holds the embedding. **EmbeddingGemma's export emits BOTH `last_hidden_state` and `sentence_embedding`** — only the second has been through its two Dense heads. Mean-pooling the first gives a 768-wide, unit-length, deterministic vector measuring **cosine −0.02** against the real embedding. Nothing structural catches that; `test/onnx.smoke.test.ts` compares against Ollama's build of the same weights instead.
- **`npm run probe:embed` decides the text model, and its first version measured nothing.** It scored "return this exact segment id" over LIB-14, which had 750 digests and **144 distinct** ones (one appeared 85 times), capping top-1 at 1/85 and reporting a 28.6% "lift" that was pure noise. Identical documents are one document, and the ratio is durable even though that store is gone — a digest is a window title plus a gesture. Corrected, over four seeds: EmbeddingGemma leads nomic by 18–27% MRR at **3.3x** the indexing cost and +370MB RSS — which is why **nomic is still the shipped default**.
- **The highlighter reads the PROVIDER's geometry, never `DEFAULT_TILE_CONFIG`**, keeps only content query vectors, and **draws no boxes at all on a grid disagreement** — a wrong box is worse than no box.
- **ITERATE an Arrow vector, never `.toArray()` it.** float16 `.toArray()` returns raw uint16 bit patterns: right row count, plausible cosines, boxes on arbitrary parts of the frame.
- **The patch geometry is EXACT — measured, and the probe is committed.** Run `npm run probe:patchgeom` before "fixing" `patchIndexToBox`; a visible offset is the model's own 60x45px resolution.

### The app's main process → [app-main.md](docs/internals/app-main.md)
- **`src/main` is the ONLY process that may touch the library, the store, or native modules.** `src/shared/types.ts` is the contract; the renderer sees plain serializable DTOs. Changing an IPC shape means changing it there first.
- **The indexing pipeline is a TABLE, not a `push()` order** (`index-plan.ts`) — **the array IS the order**, and `needs` is checked, never obeyed. A second hand-written copy of it went stale and shipped a rebuild with no summaries.
- **INDEXING IS A DURABLE QUEUE, and `RecordingState` has TWO values, not three.** `stopRecording` enqueues and returns — measured at **148ms**, where it used to await the whole pipeline (about **22 minutes** on a real recording: Captions 14m16s, Frame patches 5m). `"indexing"` was a value of the recording state, which is precisely what made the two mutually exclusive; **do not add it back.** The policy is pure (`index-queue.ts`), the drain loop is `index-worker.ts`, and `index_job` is the one **operational** table — a fourth `schema.ts` bucket, because a re-index must not delete the queue that is running it.
- **INDEXING YIELDS TO RECORDING, between stages and never inside one.** Capture is real-time and unrepeatable; an index rebuilds from the blobs. A stage abandoned halfway leaves exactly the half-written rows the purge exists to clean up — and the slowest stage measured **14m 16s**, so "paused" is *false* for as long as the stage already in flight takes. The screen says which of the two it is; saying only "Paused" is a lie, and saying nothing is what it did before it was measured on screen.
- **RE-INDEX MEANS RE-INDEX: purge everything derived, then run the whole plan.** It rebuilds with the providers configured **now**, which is destructive and disclosed. The bare write paths are why the purge is what makes a second pass safe. Purge-or-not is **derived** from `(kind, attempts)`, never stored, so no flag on disk can disagree with the situation it describes.
- **A `running` job row at startup is a CRASH — nothing else writes that state and stops.** It is re-queued with its attempt count intact (which is what makes the retry purge), and abandoned after 3. **`before-quit` must await `pendingStop()`**: it is synchronous, and closing the store inside the ~150ms tail of `stopRecording` left a real recording with no `ended_at` and no job. `adoptUnclosedSessions` recovers the ones already stranded that way.
- **An EMPTY whisper setting means "default", never "off".** Reading it as "off" made transcription unreachable *and* stopped the model download, presenting as a broken download.
- **`ensureToolPath()` runs before anything can spawn** — a packaged app inherits no Homebrew, so `ffmpeg` and `whisper-cli` appear uninstalled only in a packaged build.
- **Bytes don't go over IPC**: `deskrag://frame/<blobId>` buffers, `deskrag://media/<blobId>` streams with `Range` → `206`.
- **The MCP endpoint is READ-ONLY BY CONSTRUCTION**, guarded by `test/mcp.readonly.test.ts`. **The Host check is what closes DNS rebinding** — the Origin check cannot. There is deliberately no token, and it shows no score.

### The app's renderer → [app-ui.md](docs/internals/app-ui.md)
- **NOTHING TRUNCATES.** A label either fits or is withheld (`labelFits`), because an ellipsis hides a broken layout. There is no `text-overflow: ellipsis` in the rail.
- **A RECORD-SCREEN SIGNAL CARD SAYS WHAT IT CAPTURES AND WHAT IT HAS CAPTURED, and its lamp means ATTACHED, not configured.** `describe` is required (the `StageSpec.describe` precedent); the well always answers, in words when there is no figure. Green was derived from Settings plus permission while `activeSignals` sat unread, so a screen producer that found no display showed green. Digital silence (peak exactly 0) is called out — that is the −91 dB microphone that left a perfectly healthy-looking store.
- **The Indexing ladder's ROW is execution order**, because `runStages` is a strictly sequential loop and a free DAG layout would assert a concurrency the app does not have. **The dependency WIRES ARE GONE and the shape is carried by NAMED BANDS** (`StagePhase`): twelve stages declare 21 `needs` edges, and transitive reduction only reaches 14 because NINE of them fan out of `segment` and into `compose` — a hub cannot be drawn with parallel lines, and the 12-channel gutter was ~110px of thicket that every DOM assertion passed. A band is legal ONLY because phases are contiguous runs of the table; `stagePhaseViolations()` asserts it, and a split phase would put a band head mid-run with nothing failing.
- **A stage meter is DETERMINATE only where the stage counts its own units; everything else shimmers and SAYS SO.** `StageProgress` is threaded from `onProgress` hooks in `src/represent/*`, and Composing deliberately has none — its cost is inside `composeLadder`, whose model-call total is unknown until each frontier exists, so any total would be invented. The rate is measured against `StageProgress.at`, the clock the count was OBSERVED at: against a live clock a stage at 2/4 climbed "1.0s each" → "7.0s each" with nothing completing. There is no ETA.
- **The rollup's total is Σ STAGE TIME and the wall clock sits beside it**, because the worker holds between stages — collapsing them would contradict the queue row's own "took …" in one glance. A sliver is folded and COUNTED, never widened, and at most `MAX_SHARE_SEGMENTS` blocks draw because that is the size of the palette.
- **The queue snapshot must be emitted AFTER its write lands** (`persistAndEmit`): `indexQueue()` reads `store.listIndexJobs()`, so emitting first publishes the previous ladder. Measured — the screen ran a whole stage behind, with `captions` at 2/4 while the DOM still marked Frame patches running.
- **A running stage's clock is the RENDERER's** (`liveElapsedMs` + one interval): the snapshot is rebuilt only on transitions, so `elapsedMs` is frozen at `begin` and read "0ms" for a fourteen-minute stage.
- **A SKIPPED stage is drawn and STATES ITS REASON**, and a *queued* job previews its whole ladder with the gates already resolved. `StageSpec.skipReason` is required wherever a gate can reject, enforced by a test — a stage that merely never appears is indistinguishable from one nobody implemented.
- **THERE IS ONE RUNNING CLOCK AND IT IS THE RAIL'S, and media seconds ARE lane seconds** — the old rescale is gone because both the offset and the 1.4% rate error were removed at the source. Two clocks disagreeing in one glance is the screen contradicting itself.
- **A BAR IS THE SIGNAL'S TRUE EXTENT AND MUST NEVER BE WIDENED TO BE CLICKED** — the hit rect is separate. A bar clipped to the axis **declares** the cut and is hatched; `null` in a density lane means no coverage and is not zero.
- **Two chroma registers separated by lightness, and the data one is COMPUTED, not picked.** Re-derive `--data-0..7` with the validator; never hand-edit one slot. The set they replaced failed CVD checks at ΔE 1.6.
- **`styles.css` is ONE global sheet with no scoping — a class name is a repo-wide identifier.** Grep for a base class before minting one, and audit for **undefined tokens**, which fail silently (a stray `*/` once ate `--t-nano`). Use the `--s*`/`--t-*` scales; a raw `font-size: <n>px` is the regression.
- **Pure renderer modules must be `.ts`, never `.tsx`**, to stay reachable from the root suite.
- **Measure in the RUNNING APP.** Nearly every rule in that file — the notched seam, the covered Inspect button, the one-pixel playhead, the 1124x197 video — was found by driving the app with the `run-app` skill and reading `getBoundingClientRect()`, never by reading CSS.

## Non-obvious invariants (verified the hard way — don't regress)
- **The Swift sidecars emit AX roles WITHOUT the `AX` prefix** (`ax-dump.swift`: `rawRole.dropFirst(2)`), so real data carries `Button`, `Window`, `TextField`. Every consumer of `UIElement.role` must normalize — `axFilter` does (`r.replace(/^AX/i, "").toLowerCase()`) and `trace/predicates.ts` does (`canonicalRole`). Matching prefixed literals compiles, passes hand-written fixtures, and silently produces **zero predicates from every real recording**: that shipped once, and it collapsed the whole graph to one node with no waits and no slots. There is still **no checked-in fixture captured from the real sidecar**, which is exactly why it survived; adding one is an open derived requirement.
- **`ax-exec`'s attribute readers must match `ax-dump`'s exactly, and the empty-string rule is the one that bites.** Both treat an EMPTY attribute as absent (`if let s = value as? String, !s.isEmpty`), so `AXTitle: ""` falls through to `AXDescription`. `ax-exec` originally returned `value as? String` verbatim — a one-line difference that made it disagree with `ax-dump` on exactly one of 48 elements (the font-size stepper, whose AXTitle is empty), and that single label was enough to stop any node from verifying at replay. Two binaries reading one tree is a standing drift hazard: when changing either reader, diff both against a live app index-by-index, not just by element count.
- **A real AX dump exceeds 64KB, so sidecar stdout arrives in several chunks and a chunk boundary lands mid-JSON.** Buffer until a newline before parsing (`sidecar.ts` does). Splitting each chunk independently yields truncated "lines" that parse-error only on large trees — it works fine against every small test fixture.
- **Adding a TABLE is the sanctioned schema move, and it genuinely works on an existing install.** `CREATE TABLE IF NOT EXISTS` runs on every open, so a new table appears on a database that predates it while an existing table's *shape* still can never change. `transcript_clip` was added this way (after `ax_snapshot`, `ax_snapshot_boundary`, `trace_node_source`, `segment_app_caption`), and it was **verified rather than assumed**: a copy of a pre-change `app.db` was opened with the new code, gained the table, and lost nothing. So no data-dir reset is needed for a table addition — only a change that alters what an existing column *means* needs one (see the `phash` note in docs/internals/capture.md).
- **`grep` silently SKIPS `src/store/store.ts` — use `grep -a`.** It contains two deliberate NUL bytes, as the delimiter in composite map keys (`` `${namespace}\0${id}` ``, safe because neither part can contain one). `file` therefore reports it as `data`, and grep treats a binary file as a match-or-nothing: it prints *no* matching lines and *no* error, so a search over `src/` reads as "this symbol doesn't exist" for the one file where most of them live. `rg` is no better — it prints `binary file matches` and no lines. Both need the text flag: `grep -a` / `rg -a`. Verified on both.
- **`better-sqlite3` `safeIntegers` does NOT reach UDF arguments** (only column reads become BigInt). So the 64-bit pHash Hamming (Tier 0) runs in JS, not a SQL UDF, and `hydrateFrame` must `Number()`-coerce the small INTEGER columns that come back as BigInt under safeIntegers.
- **LanceDB `.where()` PRE-filters by default** in the JS SDK — that's what makes Tier-2/3 scoping exact. `array_has_any(segment_ids, [...])` is the segment-scope predicate.
- **Pinned deps for a reason:** `apache-arrow` is pinned to `18.1.0` (LanceDB peer-caps it `<=18.1.0`); `sharp` is `^0.35.3` (0.34.x had libvips CVEs). Don't bump these blind.
- **`@vidstack/react` (the Library player) must be installed as `^1.15.6` — npm's `latest` dist-tag is stale.** `latest` still points at `0.6.15`, an abandoned line that peers `react ^18` only and has a different API; the current release ships under the `next` tag. A bare `npm i @vidstack/react` silently installs the wrong major. It is a renderer-only devDependency (electron-vite bundles it), pure JS with no native module, so it needs no electron-rebuild and no root-package mirror. It is also local by construction: its theme CSS contains no `@import`/`url()`, its deps are `@floating-ui/dom` + `media-captions`, its icons are inline SVG, and its only CDN path — the hls.js/dash.js loader — is unreachable for an MP4 source and blocked by the renderer CSP (`script-src 'self'`) regardless. Keep the source typed `video/mp4` explicitly: `deskrag://media/<blobId>` has no file extension for Vidstack to infer from.
- **`onnxruntime-node` is pinned to `1.27.0` with a known, accepted advisory.** It depends on `adm-zip <0.6.0` ([GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85), CVSS 7.5). Accepted deliberately: `adm-zip` appears only in `script/install-utils.js` (unpacking a NuGet package at install time), never in the runtime `dist/`, so nothing the app executes reaches it; the impact is availability-only (a crafted ZIP forces a 4GB allocation), not code execution; and npm's only "fix" is downgrading to `1.21.1`, a semver-major step backwards. `npm audit` will keep reporting it — that is expected, not a regression. Do NOT use `@huggingface/transformers` as a tokenizer source: it depends on `sharp ^0.34.5`, which conflicts with the pin above and would nest a CVE-era libvips copy. Use `@huggingface/tokenizers` (pure JS/TS, zero deps) instead.
- **`ColModernVBertMultiVector` embeds ONE image per forward pass, and the reason survived the provider it was measured on.** Tile count varies with aspect ratio, so batching would need padding plus a mask over patch positions. The removed int8 single-vector export made the same point more sharply: it returned cosine 0.992 — not 1.0 — for one image at batch 1 vs batch 2, because onnxruntime selects a different kernel per batch dimension, so batching stored vectors while embedding a query as `[image]` would have put the two on different kernel paths permanently. Do not "optimize" per-image embedding away.
- **Coordinate spaces:** AX bboxes and mouse hotspots are both global **screen** coordinates (top-left origin); the stored JPEG keyframe may be downscaled, so `SharpRegionCropper` maps the bbox from frame space → image space via `sharp.metadata()`.
- **AX is captured live at capture time and stored** (`frame_ax` table), then read back at represent time via `StoredAxProvider` — never queried live during represent (the UI has moved on).
- **Electron's Node ABI ≠ system Node's — solved by two isolated installs, not by switching.** `app/` is deliberately NOT an npm workspace member: it has its own `app/node_modules` with its own `better-sqlite3`, rebuilt for Electron by `app`'s `postinstall` (`electron-rebuild -f -w better-sqlite3`). The library's root copy stays Node-ABI for `npm test`; the two never share a binary, so neither rebuild touches the other. `better-sqlite3` is the only ABI-fragile module (raw Node addon); `sharp`, `@lancedb/lancedb`, `uiohook-napi`, and `active-win` are N-API/prebuilt and are never rebuilt. The runtime resolves the app's copy first because `app/out/main/index.js` externalizes `better-sqlite3` as a bare specifier and `app/` is nested inside the repo, so Node's upward walk hits `app/node_modules` before root. **Consequence:** native version pins now live in both `package.json`s (`better-sqlite3`, `sharp`, `@lancedb/lancedb` + the platform optionals) — keep them in sync.
- **`searchSegments` throws on an unregistered namespace**, so a `Retriever` must only be given `TextViewSearcher`s whose namespace appears in `store.listVectorSpaces()` — caption/transcript spaces don't exist until something has been indexed with those providers. `BehaviorViewSearcher` is always safe (it returns null without a behavior vector). See `DeskRagService.buildRetriever`.
- **The app imports `dist/`, not `src/`** — after changing library code, `npm run build` before launching (`npm run app:dev` does both). Library types changing means the app's typecheck can break without any file in `app/` changing.
- **`scripts/brand/emit-icons.ts` is macOS-only** — it shells out to `iconutil` to build the `.icns`. The rasterised PNG/ICNS/ICO binaries it and `emit-icons` produce are deliberately NOT drift-guarded byte-for-byte (unlike the SVG/Lottie emitters): libvips/librsvg output varies by version, so the test suite only checks the committed tray PNG isn't stale (alpha at a couple of geometry-derived pixels), not that it's byte-identical to a fresh render.

## Validate against a real recording before trusting a measurement
Three of this repo's worst bugs were invisible to `npm test` and obvious within minutes of driving a real session through the pipeline: the AX role prefix (above), a stale sidecar, and text search returning nothing at all on the default provider configuration.

**And test the DEFAULT configuration, not the fully-configured one.** The zero-results bug survived because every retrieval test constructed the `Retriever` with an image embedder, while the shipped default is `imageProvider: "none"`. A suite that only exercises the richest setup cannot see the setup most users have.
 Synthetic fixtures agree with whatever the code assumes. **Before designing on top of captured data, record a real session and read what actually landed in the store** — and treat any number derived from one application as provisional, because the anchor ladder was falsified twice, each time by recording in one more app.

**And read the BYTES, not just the row counts.** The silent-microphone default (docs/internals/capture.md) produced a perfectly healthy-looking store — two `mic` blobs, exact byte counts, contiguous `t_mono` spans, no error from ffmpeg or anywhere else — and every sample in them was zero. Twelve seconds of recording found it; no assertion over the schema could have. When a signal is audio or pixels, measure the content (`ffmpeg -af volumedetect`, `ffprobe`) before believing it was captured.

## Build order when extending
Follow the dependency direction: `embed/` + `store/` first (prove the seam with the crash-recovery and scoped-ANN tests), then `timeline/` → `capture/` → `segment/` → `represent/` → `retrieve/`. New embeddable views register a `vector_space`, write text/raw first then the vector, and slot into reconciliation and a Tier-1 `ViewSearcher`. The app comes last: a new capability surfaces as a `deskrag` barrel export → an indexing stage or searcher in `DeskRagService` → a `Capabilities` flag + DTO field in `shared/types.ts` → UI.
