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

export function openDb(path: string): Db {
  const db = new Database(path);
  db.exec(PRAGMA_SQL);
  db.exec(SCHEMA_SQL);
  return db;
}
