# Architecture

How DeskRAG is put together, and which seams are load-bearing. For the
invariants that constrain changes to this design, see [CLAUDE.md](../CLAUDE.md).

## Highlights

- **Dual-store, crash-safe** — SQLite (`better-sqlite3`, WAL) is the relational source of truth + event firehose; LanceDB owns all vectors + scoped ANN. A strict write-order + reconciliation protocol survives crashes between the two engines (proven by a real kill-the-process recovery test).
- **Structural vector discipline** — every embedding is namespaced `view:provider:model:dims`, with one physical LanceDB table per namespace, so incomparable vector spaces *cannot* be mixed in a search.
- **Monotonic timeline** — all correlation is on a monotonic `t_mono` clock, immune to wall-clock/NTP/DST jumps.
- **Six embeddable views** per experience — transcript (local whisper.cpp STT), VLM caption, structured-event digest, behavioral feature vector, whole-frame image, and region image.
- **Coarse-to-fine retrieval** — pHash → segment RRF → frame ANN → region ANN + accessibility-label full-text search → optional cross-encoder rerank — returning **highlights**: the matched region bounding boxes + labels to outline *where* on the recalled frame the match is.
- **The PixelRAG edge, grounded** — region proposals fuse the accessibility tree, interaction hotspots (weighted DBSCAN over clicks/dwell — a signal video RAG can't have), and grid tiling.
- **Recorded behavior as a graph** — sessions lift into a **trace IR** of verified states and action edges that merges across recordings, so a task recorded twice discovers its own variable slots instead of being told them.
- **An executor that acts only on an approved plan** — layered anchors resolve a route against the live accessibility tree, and a plan stops where resolution stops working rather than guessing past it. It is a library subsystem only: nothing in the desktop app can reach it.

## The pipeline

Each stage narrows scope; retrieval never widens.

```
 capture/                 segment/            represent/                         retrieve/
 ─────────                ────────            ──────────                         ────────
 uiohook  (input)     ┐   event-driven    ┐   transcript   digest   ┐   Tier0 pHash prefilter
 active-win (focus)   │   boundaries      │   caption      behavior │   Tier1 segment ANN + RRF
 ffmpeg  (screen→JPEG)├─▶ + multi-        ├─▶ frame-image  region-  ├─▶ Tier2 frame ANN  (scoped)
 ax-dump (AX tree)    │   granularity     │   image                 │   Tier3 region ANN + AX-FTS
 (mic/desktop audio)  ┘   overlapping     ┘   (each → a namespaced  ┘   Tier4 rerank (optional)
                          windows              vector space)             → assemble → ranked frames
                                                                            + region highlights

        store/  ──  SQLite (relational truth + event firehose)  ⇄  LanceDB (vectors + scoped ANN)
                    shared ULID keys · SQLite-first writes · one-directional reconciliation
```

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

## The other direction: trace and replay

Retrieval reads sessions back. The trace IR (`src/trace/`) turns them into something
executable, and the executor (`src/replay/`) runs it.

```
 session ──▶ lift ──▶ Trace (a linear chain) ──▶ merge ──▶ Graph ──▶ plan ──▶ [approve] ──▶ execute
                      nodes: verified states             one graph    dry run    explicit,     CGEvent
                      edges: action sequences            per install  by default per segment
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
never derived from one another at replay time. The middle of that ladder is ordered by
measured trust rather than fixed: a shallow path outranks a label, a deep one doesn't,
because applications differ in how deep their trees are and in whether they publish
labels at all.

**The safety story is structural, not procedural.** `replay/` depends only on an
injected actuator, and a test asserts that no file in it but the sidecar wrapper even
mentions `spawn` — so the suite is *incapable* of posting a real event. Actuation
lives in its own binary (`native/ax-exec`) separate from the read-only
`native/ax-dump`, and a plan stops at the first anchor that describes a state which
doesn't exist yet, disclosing the remainder as explicitly unresolved.

Both `trace/` and `replay/` are **leaves**: pure TypeScript that never imports
`store/`, `represent/` or `retrieve/`. External data arrives through injected
callbacks, which is what keeps graph persistence a one-directional dependency.

**The executor is not wired to the app.** `src/replay/` is complete and its whole
test suite is green, but DeskRAGApp reaches none of it — there is no plan DTO, no
arm channel, and the app never spawns `ax-exec`. The app's window onto the graph
is **Flows**, a reader. The executor is exercised by the suite and by the
read-only `scripts/replay-probe.mjs`; see [ROADMAP.md](../ROADMAP.md).

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

- [Setup and requirements](./setup.md)
- [Providers](./providers.md) — what runs where, and why every one is local
- [Library usage](./library-usage.md)
- [DeskRAGApp](../app/README.md) — the desktop client
- [Roadmap and known gaps](../ROADMAP.md) — what isn't built, and where a shipped
  subsystem stops short of its claim
