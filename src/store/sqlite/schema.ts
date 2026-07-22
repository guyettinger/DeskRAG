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
`;

/** Pragmas applied on every connection open. WAL = single-writer + concurrent reads. */
export const PRAGMA_SQL = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
`;
