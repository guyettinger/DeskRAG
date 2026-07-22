# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Experience RAG — a local-first system that captures desktop activity (screen, audio, mouse/keyboard, accessibility tree) into a searchable multimodal "experience memory," retrievable by text, visual example, or behavioral similarity. TypeScript/Node throughout, strict mode, ESM.

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

**The 6 views:** transcript (STT — schema/interfaces ready, producer is future work), caption (VLM), digest (templated event text), behavior (12-dim input-dynamics vector, a "builtin" namespace — not a network provider), frame-image, region-image. Tier-1 fuses views with **Reciprocal Rank Fusion**, not score averaging (scales differ).

**Region proposal (`represent/regions/`, the PixelRAG edge):** fuse three sources — AX tree (`axFilter`: real labeled bboxes, filtered hard), interaction hotspots (weighted DBSCAN over clicks/dwell — the signal video RAG lacks), and grid tiling — via NMS with a cross-source agreement priority bump, then a budget cut. AX role/label is also written to SQLite FTS5 so regions are text-searchable by UI role.

### Providers, adapters, and the "not in the barrel" rule
Anything that embeds/captions/reads-AX is behind an interface with swappable adapters (local Ollama, remote Voyage/Gemini/Anthropic) and a **deterministic fake** for tests. Adapters that load a native npm module or spawn a subprocess (`uiohook-napi`, `active-win`, `sharp`, the ffmpeg/Swift sidecars) are **deliberately NOT re-exported from `src/index.ts`** — import them from their own path — so importing the package never force-loads native code. The whole visual/native chain is real and tested; only query vectors are faked (a fake embedder maps identical input → identical vector, which lets tests place exact-match items deterministically).

## Non-obvious invariants (verified the hard way — don't regress)
- **`better-sqlite3` `safeIntegers` does NOT reach UDF arguments** (only column reads become BigInt). So the 64-bit pHash Hamming (Tier 0) runs in JS, not a SQL UDF, and `hydrateFrame` must `Number()`-coerce the small INTEGER columns that come back as BigInt under safeIntegers.
- **LanceDB `.where()` PRE-filters by default** in the JS SDK — that's what makes Tier-2/3 scoping exact. `array_has_any(segment_ids, [...])` is the segment-scope predicate.
- **Pinned deps for a reason:** `apache-arrow` is pinned to `18.1.0` (LanceDB peer-caps it `<=18.1.0`); `sharp` is `^0.35.3` (0.34.x had libvips CVEs). Don't bump these blind.
- **Coordinate spaces:** AX bboxes and mouse hotspots are both global **screen** coordinates (top-left origin); the stored JPEG keyframe may be downscaled, so `SharpRegionCropper` maps the bbox from frame space → image space via `sharp.metadata()`.
- **AX is captured live at capture time and stored** (`frame_ax` table), then read back at represent time via `StoredAxProvider` — never queried live during represent (the UI has moved on).

## Build order when extending
Follow the dependency direction: `embed/` + `store/` first (prove the seam with the crash-recovery and scoped-ANN tests), then `timeline/` → `capture/` → `segment/` → `represent/` → `retrieve/`. New embeddable views register a `vector_space`, write text/raw first then the vector, and slot into reconciliation and a Tier-1 `ViewSearcher`.
