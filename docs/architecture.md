# Architecture

How DeskRAG is put together, and which seams are load-bearing. For the
invariants that constrain changes to this design, see [CLAUDE.md](../CLAUDE.md);
for the measurements behind each one, [docs/internals/](./internals/).

## Highlights

- **Dual-store, crash-safe** — SQLite (`better-sqlite3`, WAL) is the relational source of truth + event firehose; LanceDB owns all vectors + scoped ANN. A strict write-order + reconciliation protocol survives crashes between the two engines (proven by a real kill-the-process recovery test).
- **Structural vector discipline** — every embedding is namespaced `view:provider:model:dims`, with one physical LanceDB table per namespace, so incomparable vector spaces *cannot* be mixed in a search.
- **Monotonic timeline** — all correlation is on a monotonic `t_mono` clock, immune to wall-clock/NTP/DST jumps.
- **Nine embeddable views** per experience — transcript (local whisper.cpp STT), VLM caption of the frame and of the focused window, structured-event digest, the summary of a composed level, behavioral feature vector, whole-frame image, region image, and late-interaction frame patches.
- **Coarse-to-fine, hybrid retrieval** — pHash → segment RRF (dense views *and* a lexical FTS lane) → frame ANN → region ANN + accessibility-label full-text search → optional cross-encoder rerank — returning **highlights**: the matched region bounding boxes + labels to outline *where* on the recalled frame the match is. The lexical lane and the region-label search both work with **no model configured at all**, which is what a default install has.
- **The PixelRAG edge, grounded** — region proposals fuse the accessibility tree, interaction hotspots (weighted DBSCAN over clicks/dwell — a signal video RAG can't have), and grid tiling.
- **A composed hierarchy** — actions group into tasks, tasks into phases, phases into a named session, each level asking its own question of a local model and falling back to structure when it declines.
- **Recorded behavior as a graph** — sessions lift into a **trace IR** of verified states and action edges that merges across recordings, so a task recorded twice discovers its own variable slots instead of being told them.

## The pipeline

Each stage narrows scope; retrieval never widens.

```
 capture/                 segment/            represent/                         retrieve/
 ─────────                ────────            ──────────                         ────────
 uiohook  (input)     ┐   event-driven    ┐   transcript, digest,   ┐   Tier0 pHash prefilter
 active-win (focus)   │   boundaries →    │   caption, app_caption, │   Tier1 segment ANN + FTS,
 ffmpeg  (screen→JPEG)├─▶ ONE granularity ├─▶ summary, behavior,    ├─▶      fused by RRF
 ax-dump (AX tree)    │   (`action`)      │   frame + region image, │   Tier2 frame ANN  (scoped)
 ffmpeg  (microphone) ┘                   ┘   frame patches         │   Tier3 region ANN + AX-FTS
                                              (each → a namespaced  ┘   Tier4 rerank (optional)
                                               vector space)            → assemble → ranked frames
                                                                           + region highlights

        store/  ──  SQLite (relational truth + event firehose)  ⇄  LanceDB (vectors + scoped ANN)
                    shared ULID keys · SQLite-first writes · one-directional reconciliation
```

`segment/` produces exactly one granularity, `action`. Altitude is *composed* from
what those actions mean together — action → task → phase → a named session — never
cut as a bigger window, because a bigger box cannot produce a higher altitude: ask a
captioner to describe 30 seconds and you get a longer screenshot description.

## The two rules that hold it together

**Dual-store consistency** (`src/store/`). SQLite and LanceDB share app-minted ULID
keys and are joined application-side. `DualStore` is the only place both engines are
known — callers never see both. The SQLite transaction commits **first**, then the
Lance add: a crash in between leaves a relational row with no vector, which is
detectable and re-embeddable. The reverse order would create undetectable orphan
vectors. Reconciliation runs one direction only, because SQLite is the truth.

**Vector namespacing** (`src/embed/types.ts`). Embeddings from different models are
not comparable, so every vector is namespaced `view:provider:model:dimensions` and
LanceDB keys one physical table per namespace. Two models physically cannot land in
one similarity search. `dimensions` is part of the namespace, so a truncated model is
a distinct space. Raw text/frames/AX are always stored so vectors can be regenerated
when a provider changes.

Correlation is on `t_mono` — a monotonic offset from a session epoch — never
wall-clock. `started_at` exists only for human display.

## How retrieval actually ranks

**Tier 1 is hybrid.** Each text view (digest, summary, caption, app_caption,
transcript) and the behavioral vector contribute one ranked list, and so does a
**lexical lane** — FTS5 over `segment_fts`, which holds every view's text for a
segment. Reciprocal Rank Fusion combines them by *rank*, never by score, because a
dense cosine distance and a bm25 score are not commensurable. Dense views are
weakest on exactly the terms a person is most certain about — a filename, an error
string, a URL — so the lexical lane is what answers those. It needs no provider,
which makes it the only Tier-1 lane guaranteed to exist.

**RRF's `k` is 5, not the usual 60.** With six lanes over a modest corpus, the
lane-*count* term spans 6× while the *rank* term at k=60 spans only ~2.6×, so
mediocre ubiquity outranks an exact match by construction. Measured on a real
library, a phrase ranked #1 by two independent lanes came 13th fused at k=60; a
sweep over 53 known-answer queries gives recall@5 of 58% at k=5 against 6% at k=60.

**A composed level is under-ranked by construction, and no `k` fixes it.** A task or
a session row has only a `summary`, so it joins one dense lane where a leaf joins
three or four — and RRF is a sum. Retrieval at altitude therefore finds a task but
rarely ranks it first; leaf retrieval is unaffected.

**Tier 2 recalls frames; Tier 3 explains them.** A visual query gets true per-frame
ANN distances. A *text* query does not — frames come back by segment membership —
so Tier 3's accessibility-label search is the only per-frame evidence available, and
it is what keeps frames sharing a segment from scoring identically. It also produces
the `highlights` a text result is drawn with. Both halves of Tier 3 pre-filter by
frame scope rather than intersecting a global top-N afterwards.

**Scope is always narrowed, never widened**, and every scoping filter is exact:
LanceDB's `.where()` pre-filters, and the FTS scope is a join, not a post-filter.

## The other direction: the trace graph

Retrieval reads sessions back. The trace IR (`src/trace/`) turns them into a graph of
what you did, which the **Flows** screen reads.

```
 session ──▶ lift ──▶ Trace (a linear chain) ──▶ merge ──▶ Graph
                      nodes: verified states             one graph per install
                      edges: action sequences            routes weighted by observation
```

**A node is a set of predicates**, extracted from the accessibility tree and filtered
to what the task actually touches: the app, the elements its outgoing edges target,
the focused element when it types, the waits its incoming edge established, and a URL
prefix. Not what was on screen — content the recording never touched is excluded by
construction, so no page-vs-chrome heuristic is needed.

**Variation comes from recording, not from invention.** Two recordings that differ
only in typed text merge into one edge with two slot samples; that's how slots are
discovered rather than declared. A revisited state collapses into a loop. Identity is
predicate-primary and **ambiguity declines to merge** — a redundant node is visible
and fixable, a wrong merge is silent corruption.

**Merging and locating want opposite things**, and conflating them is the trap this
design is shaped around. Merging asks "is this the same state?" and wants exact set
equality; locating and verification ask "does what this state claims still hold?" and
use a subset rule, because a live screen that has gained anything would never match
exactly.

**Targets are layered anchors** — `ax → visual → point`, recorded independently and
never derived from one another. The middle of that ladder is ordered by measured
trust rather than fixed: a shallow path outranks a label, a deep one doesn't, because
applications differ in how deep their trees are and in whether they publish labels at
all.

`trace/` is a **leaf**: pure TypeScript that never imports `store/`, `represent/` or
`retrieve/`. External data arrives through injected callbacks, which is what keeps
graph persistence a one-directional dependency.

**The graph is also an executable IR, and that half is not wired to the app.**
`src/replay/` resolves a route against a live accessibility tree and posts CGEvents
through its own binary (`native/ax-exec`), separate from the read-only `ax-dump`. It
is complete and green in the suite, but DeskRAGApp reaches none of it — there is no
plan DTO, no arm channel, and the app never spawns `ax-exec`. Flows is a reader.
See [ROADMAP.md](../ROADMAP.md) for what that subsystem does and where it stops.

## Repo layout

| Path | What it is |
|---|---|
| `src/` | the DeskRAG library — capture, store, represent, retrieve, trace, replay (published as `deskrag`) |
| `app/` | **DeskRAGApp**, the Electron desktop UI over the library (`deskrag-app`, its own install — not a workspace member) |
| `native/` | the macOS Swift sidecars — `ax-dump.swift` (read-only) and `ax-exec.swift` (actuation), both built with `npm run build:ax` |
| `test/` | the executable documentation — vitest suite, deterministic |
| `assets/` | the brand mark — generated from `scripts/brand/geometry.ts` via `npm run gen:brand` |
| `docs/` | this documentation set, plus design specs under `docs/superpowers/` |

## Build order when extending

Follow the dependency direction: `embed/` + `store/` first (prove the seam with the
crash-recovery and scoped-ANN tests), then `timeline/` → `capture/` → `segment/` →
`represent/` → `retrieve/`. New embeddable views register a `vector_space`, write
text/raw first then the vector, and slot into reconciliation and a Tier-1
`ViewSearcher`. The app comes last.

## See also

- [Internals](./internals/) — the measured detail behind every invariant, one
  file per subsystem. Written for someone about to change the code.
- [Setup and requirements](./setup.md)
- [Providers](./providers.md) — what runs where, and why every one is local
- [Agent access (MCP)](./mcp.md) — the read-only surface an external agent reads
  this index through
- [Library usage](./library-usage.md)
- [DeskRAGApp](../app/README.md) — the desktop client
- [Roadmap and known gaps](../ROADMAP.md) — what isn't built, and where a shipped
  subsystem stops short of its claim
