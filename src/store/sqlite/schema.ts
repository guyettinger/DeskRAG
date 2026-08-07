/**
 * Full SQLite DDL. SQLite is the relational source of truth + the high-volume
 * event firehose. Everything correlates on t_mono (monotonic); started_at exists
 * only for human-readable display.
 *
 * IDs are ULIDs minted app-side and are byte-identical to the Lance row keys.
 * phash is a signed 64-bit INTEGER (the full u64 pHash mapped into i64 range).
 */

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS session (
  id          TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL,          -- wall-clock ms, DISPLAY ONLY
  epoch_mono  REAL NOT NULL,             -- performance.now() offset = t_mono zero
  ended_at    INTEGER,
  device_id   TEXT,
  meta        TEXT                       -- JSON
);

CREATE TABLE IF NOT EXISTS event (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  t_mono      REAL NOT NULL,
  kind        TEXT NOT NULL,
  x           REAL,
  y           REAL,
  data        TEXT                       -- JSON
);
CREATE INDEX IF NOT EXISTS idx_event_session_tmono ON event(session_id, t_mono);

CREATE TABLE IF NOT EXISTS blob (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  media         TEXT NOT NULL,           -- screen | desktop_audio | mic | input | keyframe
  path          TEXT NOT NULL,
  byte_offset   INTEGER NOT NULL,
  byte_length   INTEGER NOT NULL,
  t_mono_start  REAL NOT NULL,
  t_mono_end    REAL NOT NULL,
  codec         TEXT
);
CREATE INDEX IF NOT EXISTS idx_blob_session ON blob(session_id, t_mono_start);

CREATE TABLE IF NOT EXISTS segment (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  granularity     TEXT NOT NULL,         -- e.g. "action" | "task"
  t_mono_start    REAL NOT NULL,
  t_mono_end      REAL NOT NULL,
  boundary_reason TEXT,
  transcript      TEXT,
  digest          TEXT,
  caption         TEXT,
  meta            TEXT                    -- JSON
);
CREATE INDEX IF NOT EXISTS idx_segment_session ON segment(session_id, granularity, t_mono_start);

-- The focused-app-window caption (app_caption view) — a SEPARATE table, not a
-- column on segment, because segment's shape is frozen: CREATE TABLE IF NOT
-- EXISTS with no migration step means a new column would never reach an
-- existing install. Same pattern as ax_snapshot/trace_node_source.
CREATE TABLE IF NOT EXISTS segment_app_caption (
  segment_id  TEXT PRIMARY KEY REFERENCES segment(id) ON DELETE CASCADE,
  text        TEXT NOT NULL
);

-- Utterance-level speech, with the timings whisper.cpp's -oj output actually
-- reports. The segment-level segment.transcript column stays as it is: it is
-- what the Tier-1 transcript vector view embeds. These rows are the finer
-- record and exist because a segment's span is NOT the span of the speech
-- inside it — the rail drew a 10s bar for a two-second sentence, four times
-- over with the same text.
CREATE TABLE IF NOT EXISTS transcript_clip (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  t_mono_start REAL NOT NULL,
  t_mono_end   REAL NOT NULL,
  text         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcript_clip_session
  ON transcript_clip(session_id, t_mono_start);

CREATE TABLE IF NOT EXISTS frame (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  t_mono        REAL NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  phash         INTEGER NOT NULL,        -- 64-bit perceptual hash
  blob_id       TEXT REFERENCES blob(id) ON DELETE SET NULL,
  frame_offset  INTEGER NOT NULL         -- frame index into the blob
);
CREATE INDEX IF NOT EXISTS idx_frame_session_tmono ON frame(session_id, t_mono);
CREATE INDEX IF NOT EXISTS idx_frame_phash ON frame(phash);

-- M:N frame<->segment (overlapping granularities: one frame in an action AND a task)
CREATE TABLE IF NOT EXISTS frame_segment (
  frame_id    TEXT NOT NULL REFERENCES frame(id) ON DELETE CASCADE,
  segment_id  TEXT NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
  PRIMARY KEY (frame_id, segment_id)
);
CREATE INDEX IF NOT EXISTS idx_frameseg_segment ON frame_segment(segment_id);

-- Accessibility-tree snapshot captured live alongside a keyframe (JSON UIElement[]).
-- The raw source for AX region proposals; read back at represent time. Cascades
-- with the frame (real FK, unlike the standalone region_fts).
CREATE TABLE IF NOT EXISTS frame_ax (
  frame_id  TEXT PRIMARY KEY REFERENCES frame(id) ON DELETE CASCADE,
  elements  TEXT NOT NULL              -- JSON-encoded UIElement[]
);

CREATE TABLE IF NOT EXISTS region (
  id          TEXT PRIMARY KEY,
  frame_id    TEXT NOT NULL REFERENCES frame(id) ON DELETE CASCADE,
  segment_id  TEXT NOT NULL REFERENCES segment(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  w           REAL NOT NULL,
  h           REAL NOT NULL,
  source      TEXT NOT NULL,             -- ax | hotspot | grid
  role        TEXT,
  label       TEXT,
  priority    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_region_frame ON region(frame_id);
CREATE INDEX IF NOT EXISTS idx_region_segment ON region(segment_id);

-- Tier-3 label path: AX roles/labels searchable by UI role ("save dialog").
-- Standalone FTS5 (not external-content): region_id is stored UNINDEXED so we can
-- read it straight back from a MATCH without a rowid join to a TEXT-keyed table.
CREATE VIRTUAL TABLE IF NOT EXISTS region_fts USING fts5(
  region_id UNINDEXED, label, role
);

-- Tier-1's LEXICAL half. Every text view (digest, caption, app_caption,
-- transcript) is dense-only, so a rare literal token — a filename, an error
-- string, a URL, a proper noun — has no exact-match route at all: embeddings are
-- weakest on exactly the terms a person is most certain about. RRF fuses by
-- RANK, so this list drops in beside the dense views with no scale problem;
-- hybrid dense+sparse is the canonical use of the fusion already in place.
--
-- Standalone FTS5, mirroring region_fts: segment_id UNINDEXED so a MATCH reads
-- back without a rowid join to a TEXT-keyed table. One row per segment, holding
-- the concatenation of every text view — it is a lexical index, not a record;
-- the views themselves remain the source of truth.
--
-- A new TABLE is the sanctioned schema move here (CREATE ... IF NOT EXISTS runs
-- on every open, so this appears on databases that predate it), which is exactly
-- how transcript_clip and ax_snapshot arrived.
CREATE VIRTUAL TABLE IF NOT EXISTS segment_fts USING fts5(
  segment_id UNINDEXED, text
);

-- Registry of which Lance tables (namespaces) exist. One row per namespace.
CREATE TABLE IF NOT EXISTS vector_space (
  namespace          TEXT PRIMARY KEY,   -- view:provider:model:dims
  view               TEXT NOT NULL,
  provider_id        TEXT NOT NULL,
  model              TEXT NOT NULL,
  dimensions         INTEGER NOT NULL,
  shared_text_space  INTEGER NOT NULL,   -- 0/1
  created_at         INTEGER NOT NULL
);

-- Experience trace graphs (src/trace/). Nodes are verified states, edges are
-- action sequences. SQLite ONLY: visual corroboration reuses the region/frame
-- vectors already in Lance by id, so a graph registers no vector_space and a
-- graph write has no SQLite->Lance ordering hazard.
CREATE TABLE IF NOT EXISTS trace_graph (
  id          TEXT PRIMARY KEY,
  entry_node  TEXT NOT NULL,
  created_at  INTEGER NOT NULL           -- wall-clock ms, DISPLAY ONLY
);

-- Node and edge ids are scoped to their graph, not global: Graph.entry and
-- Edge.from/to are resolved within one graph, so two graphs may each have an
-- "n0". Hence the composite key.
CREATE TABLE IF NOT EXISTS trace_node (
  id            TEXT NOT NULL,
  graph_id      TEXT NOT NULL REFERENCES trace_graph(id) ON DELETE CASCADE,
  predicates    TEXT NOT NULL,           -- JSON Predicate[]
  visual        TEXT,                    -- JSON {frameBlobId, phash}
  intervene     TEXT NOT NULL,           -- none | select | synthesize
  observations  INTEGER NOT NULL,
  ord           INTEGER NOT NULL,        -- preserves authored order on read
  PRIMARY KEY (graph_id, id)
);
CREATE INDEX IF NOT EXISTS idx_trace_node_graph ON trace_node(graph_id, ord);

CREATE TABLE IF NOT EXISTS trace_edge (
  id            TEXT NOT NULL,
  graph_id      TEXT NOT NULL REFERENCES trace_graph(id) ON DELETE CASCADE,
  from_node     TEXT NOT NULL,
  to_node       TEXT NOT NULL,
  actions       TEXT NOT NULL,           -- JSON Action[]
  guard         TEXT,                    -- JSON Predicate[]
  provenance    TEXT NOT NULL,           -- recorded | synthesized
  observations  INTEGER NOT NULL,
  attempts      INTEGER NOT NULL,
  successes     INTEGER NOT NULL,
  lift_warnings TEXT,                    -- JSON string[]
  ord           INTEGER NOT NULL,
  PRIMARY KEY (graph_id, id)
);
CREATE INDEX IF NOT EXISTS idx_trace_edge_graph ON trace_edge(graph_id, ord);
CREATE INDEX IF NOT EXISTS idx_trace_edge_from ON trace_edge(graph_id, from_node);

-- WHICH RECORDINGS A NODE/EDGE CAME FROM, and where within them.
--
-- Separate TABLES rather than columns on trace_node/trace_edge, for the reason
-- every schema change here is: the schema is CREATE TABLE IF NOT EXISTS with no
-- migration step, so a new column would never reach an existing install while a
-- new table is simply created empty. An existing graph therefore has no
-- provenance until it is rebuilt, and that state must stay legible rather than
-- looking like data loss.
--
-- session_id CASCADES ON PURPOSE. Provenance exists to be navigated back to, so
-- evidence pointing at a deleted recording is a dead link, not a record. The
-- consequence is that a node's source count can fall BELOW its observations
-- count, which is why the two are never derived from one another: observations
-- counts what was seen, sources names what can still be looked at.
CREATE TABLE IF NOT EXISTS trace_node_source (
  graph_id    TEXT NOT NULL REFERENCES trace_graph(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  t_mono      REAL NOT NULL,           -- the boundary's own t_mono
  ord         INTEGER NOT NULL,        -- preserves observation order on read
  PRIMARY KEY (graph_id, node_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_trace_node_source ON trace_node_source(graph_id, node_id);
CREATE INDEX IF NOT EXISTS idx_trace_node_source_session ON trace_node_source(session_id);

CREATE TABLE IF NOT EXISTS trace_edge_source (
  graph_id      TEXT NOT NULL REFERENCES trace_graph(id) ON DELETE CASCADE,
  edge_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  t_mono_start  REAL NOT NULL,
  t_mono_end    REAL NOT NULL,
  ord           INTEGER NOT NULL,
  PRIMARY KEY (graph_id, edge_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_trace_edge_source ON trace_edge_source(graph_id, edge_id);
CREATE INDEX IF NOT EXISTS idx_trace_edge_source_session ON trace_edge_source(session_id);

-- AX snapshots. Supersedes frame_ax, which stays readable for sessions recorded
-- before this table existed (there is no migration mechanism: every table is
-- CREATE TABLE IF NOT EXISTS, so an existing table's shape can never change).
--
-- Cascades from SESSION, not frame: a boundary-triggered snapshot has no frame
-- and so cannot inherit frame_ax's delete path. An empty elements array is a
-- real row - "captured nothing" must stay distinguishable from "never captured",
-- which is what reason exists to measure.
CREATE TABLE IF NOT EXISTS ax_snapshot (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  t_mono      REAL NOT NULL,
  frame_id    TEXT REFERENCES frame(id) ON DELETE CASCADE,  -- NULL for boundary captures
  reason      TEXT NOT NULL,        -- keyframe | focus_change | bookmark | dwell_resume
  walk_ms     REAL NOT NULL,
  elements    TEXT NOT NULL         -- JSON-encoded UIElement[]
);
CREATE INDEX IF NOT EXISTS idx_ax_snapshot_session ON ax_snapshot(session_id, t_mono);
CREATE INDEX IF NOT EXISTS idx_ax_snapshot_frame ON ax_snapshot(frame_id);

-- Which boundary a snapshot was captured FOR.
--
-- A boundary snapshot is always written LATER than the boundary it describes:
-- BoundaryAxTrigger waits out a settle delay and the walk is budgeted at 800ms.
-- So "latest at-or-before the boundary" systematically returns the PREVIOUS
-- state's tree — measured on a real recording, every focus_change boundary node
-- carried the new app's name alongside the old app's entire AX tree.
--
-- A separate table rather than a column on ax_snapshot, because the schema is
-- CREATE TABLE IF NOT EXISTS with no migration step: a new column would never
-- reach an existing install, whereas a new table is simply created empty and
-- older snapshots fall back to the timing lookup.
CREATE TABLE IF NOT EXISTS ax_snapshot_boundary (
  snapshot_id  TEXT PRIMARY KEY REFERENCES ax_snapshot(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  t_mono       REAL NOT NULL   -- the boundary's own t_mono, not the walk's
);
CREATE INDEX IF NOT EXISTS idx_ax_snapshot_boundary ON ax_snapshot_boundary(session_id, t_mono);

CREATE TABLE IF NOT EXISTS trace_slot (
  graph_id  TEXT NOT NULL REFERENCES trace_graph(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  samples   TEXT NOT NULL,               -- JSON string[]
  ord       INTEGER NOT NULL,
  PRIMARY KEY (graph_id, name)
);
`;

/** Pragmas applied on every connection open. WAL = single-writer + concurrent reads. */
export const PRAGMA_SQL = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
`;
