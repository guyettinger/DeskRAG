/**
 * SQLite connection setup: WAL pragmas + schema.
 *
 * pHash is a 64-bit value. SQLite stores signed i64, and better-sqlite3 needs
 * BigInts bound within i64 range, so we map the unsigned u64 pHash into i64
 * two's-complement on the way in and back out. Hamming distance is invariant to
 * that mapping (XOR + 64-bit mask + popcount).
 *
 * Tier-0 Hamming runs in JS, not as a SQL UDF: better-sqlite3 passes 64-bit
 * column values to registered functions as lossy `number` even under
 * `safeIntegers` (only column *reads* become exact BigInts), which would corrupt
 * the distance for any phash above 2^53. So `phashPrefilter` reads (id, phash)
 * with safeIntegers and filters with {@link hamming64} here. This is a linear
 * scan — an acknowledged v1 scaling limit (BK-tree / multi-index hashing later).
 */

import Database from "better-sqlite3";
import { PRAGMA_SQL, SCHEMA_SQL } from "./schema.js";

export type Db = Database.Database;

const U64 = 1n << 64n;
const I64_MAX = (1n << 63n) - 1n;
const MASK64 = U64 - 1n;

/** Map an unsigned u64 into signed i64 range for storage/binding. */
export function u64ToI64(x: bigint): bigint {
  const m = ((x % U64) + U64) % U64; // normalize into [0, 2^64)
  return m > I64_MAX ? m - U64 : m;
}

/** Inverse: signed i64 as stored -> unsigned u64. */
export function i64ToU64(x: bigint): bigint {
  return ((x % U64) + U64) % U64;
}

function popcount64(x: bigint): number {
  let v = x & MASK64;
  let count = 0;
  while (v) {
    v &= v - 1n; // clear lowest set bit
    count++;
  }
  return count;
}

/** Hamming distance between two 64-bit hashes, sign-mapping tolerant. */
export function hamming64(a: bigint, b: bigint): number {
  return popcount64((a ^ b) & MASK64);
}

/**
 * The one migration this schema has ever had, and the shape any future one takes.
 *
 * `schema.ts` is CREATE TABLE IF NOT EXISTS and nothing else — adding a table
 * works on an existing install, changing one never does. A rename is the narrow
 * exception: no column, no type and no meaning changes, so the rows that come
 * back out are byte-identical to the rows that went in. A shape change still
 * needs a new table and a copy.
 *
 * ORDER IS LOAD-BEARING: this runs BEFORE SCHEMA_SQL. SCHEMA_SQL contains
 * `CREATE TABLE IF NOT EXISTS habit`, so running it first on a pre-rename
 * install mints an EMPTY habit beside the populated skill, and the rename then
 * throws `there is already another table or index with this name: habit`. That
 * throw escapes openDb, so the failure is not "the habits are missing", it is
 * "DeskRAG cannot open its library at all", with every recording behind it.
 *
 * SQLite has no ALTER INDEX. A rename RE-POINTS idx_skill_state at the new table
 * and leaves its NAME alone — sqlite_master afterwards holds
 * `CREATE INDEX idx_skill_state ON "habit"(state, updated_at)`. SCHEMA_SQL then
 * creates idx_habit_state over identical columns, so the table would carry two
 * identical indexes forever, each paid for on every write. Nothing catches it:
 * test/store.purge-derived.test.ts classifies `type = 'table'` and never looks
 * at indexes. So the stale one is dropped here and SCHEMA_SQL rebuilds it.
 */
const TABLE_RENAMES = [
  { from: "skill", to: "habit", staleIndexes: ["idx_skill_state"] },
] as const;

function migrateRenamedTables(db: Db): void {
  const named = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)`,
  );
  for (const { from, to, staleIndexes } of TABLE_RENAMES) {
    const present = new Set((named.all(from, to) as { name: string }[]).map((r) => r.name));

    // Fresh install, or already migrated: the branch every open after the first
    // takes, and the only one a new install ever sees.
    if (!present.has(from)) continue;

    // BOTH present. Unreachable going forward — this runs before the CREATE that
    // could make `to` — but reachable by downgrade-then-upgrade: old code opens a
    // migrated library, its own CREATE TABLE IF NOT EXISTS mints an empty `skill`,
    // and new code opens it again. Renaming would throw and brick the store over
    // an empty table. Declining is the safe half of that trade: `to` already holds
    // the authored rows, and an unread `from` costs nothing. Deliberately NOT
    // dropped — this is AUTHORED_TABLES, and dropping a table nobody verified was
    // empty is the one mistake here with no undo.
    if (present.has(to)) continue;

    db.transaction(() => {
      for (const idx of staleIndexes) db.exec(`DROP INDEX IF EXISTS ${idx}`);
      db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
    })();
  }
}

export function openDb(path: string): Db {
  const db = new Database(path);
  db.exec(PRAGMA_SQL);
  migrateRenamedTables(db); // BEFORE SCHEMA_SQL — see the comment above.
  db.exec(SCHEMA_SQL);
  return db;
}
