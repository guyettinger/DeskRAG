/**
 * LanceDB wrapper: one physical table PER NAMESPACE (view:provider:model:dims),
 * so two models physically cannot share a table — the namespacing discipline is
 * structural, not conventional.
 *
 * Each vector row carries denormalized scope columns (segment_ids on frames,
 * frame_id/segment_id on regions) so each retrieval tier pre-filters WITHOUT a
 * cross-engine round-trip mid-ANN.
 */

import * as lancedb from "@lancedb/lancedb";
import {
  Field,
  FixedSizeList,
  Float16,
  Float32,
  List,
  Schema,
  Utf8,
} from "apache-arrow";
import { parseNamespace } from "../../embed/types.js";

/** Which physical row shape a namespace's view maps to. */
export type TableKind = "segment" | "frame" | "region" | "frame_patches";

export function kindForView(view: string): TableKind {
  switch (view) {
    case "frame_image":
      return "frame";
    case "region_image":
      return "region";
    case "frame_patches":
      return "frame_patches";
    default:
      return "segment"; // caption | app_caption | digest | summary | transcript | behavior
  }
}

/**
 * Namespaces contain ':' which is unsafe in filesystem table names. Map ':' to a
 * token that validated namespace components (no ':') can never themselves produce.
 */
export function tableNameFor(namespace: string): string {
  return namespace.replace(/:/g, "__");
}

function vectorField(dims: number): Field {
  return new Field(
    "vector",
    new FixedSizeList(dims, new Field("item", new Float32(), true)),
    true,
  );
}

/**
 * Multivector column: a variable-length list of fixed-width vectors, one per
 * image patch. Stored as float16 — half the bytes of f32 for ~448 vectors per
 * frame, and LanceDB scores multivector in f16/f32/f64 alike.
 */
function patchesField(dims: number): Field {
  return new Field(
    "patches",
    new List(
      new Field(
        "item",
        new FixedSizeList(dims, new Field("item", new Float16(), true)),
        true,
      ),
    ),
    true,
  );
}

function schemaFor(kind: TableKind, dims: number): Schema {
  const utf8 = () => new Utf8();
  switch (kind) {
    case "segment":
      return new Schema([
        new Field("id", utf8(), false),
        new Field("session_id", utf8(), false),
        vectorField(dims),
      ]);
    case "frame":
      return new Schema([
        new Field("id", utf8(), false),
        new Field("session_id", utf8(), false),
        new Field(
          "segment_ids",
          new List(new Field("item", utf8(), true)),
          true,
        ),
        vectorField(dims),
      ]);
    case "region":
      return new Schema([
        new Field("id", utf8(), false),
        new Field("frame_id", utf8(), false),
        new Field("segment_id", utf8(), false),
        new Field("session_id", utf8(), false),
        vectorField(dims),
      ]);
    case "frame_patches":
      return new Schema([
        new Field("id", utf8(), false),
        new Field("session_id", utf8(), false),
        new Field("segment_ids", new List(new Field("item", utf8(), true)), true),
        patchesField(dims),
      ]);
  }
}

/** Row payloads (vector as plain number[] as LanceDB expects for FixedSizeList). */
export interface SegmentVecRow {
  id: string;
  session_id: string;
  vector: number[];
}
export interface FrameVecRow {
  id: string;
  session_id: string;
  segment_ids: string[];
  vector: number[];
}
export interface RegionVecRow {
  id: string;
  frame_id: string;
  segment_id: string;
  session_id: string;
  vector: number[];
}
export type VecRow = SegmentVecRow | FrameVecRow | RegionVecRow;

/** A frame's late-interaction patch set. Row counts differ between frames. */
export interface FramePatchRow {
  id: string;
  session_id: string;
  segment_ids: string[];
  patches: number[][];
}

export interface SearchResult {
  id: string;
  distance: number;
}

/**
 * The vector-side surface DualStore depends on. Extracting it lets tests inject a
 * layer that fails/kills mid-`add` (to exercise the SQLite-first crash gap) while
 * the real {@link LanceStore} is the production implementation.
 */
export interface VectorSide {
  ensureTable(namespace: string): Promise<void>;
  add(namespace: string, rows: VecRow[]): Promise<void>;
  searchSegment(namespace: string, vector: Float32Array, k: number): Promise<SearchResult[]>;
  searchFrame(
    namespace: string,
    vector: Float32Array,
    k: number,
    scope?: { segmentIds?: string[]; frameIds?: string[] },
  ): Promise<SearchResult[]>;
  searchRegion(
    namespace: string,
    vector: Float32Array,
    k: number,
    frameIds: string[],
  ): Promise<SearchResult[]>;
  // --- late interaction (frame_patches) -------------------------------------
  addPatches(namespace: string, rows: FramePatchRow[]): Promise<void>;
  /** MaxSim search; `query` is one vector per query token. */
  searchFramePatches(
    namespace: string,
    query: Float32Array[],
    k: number,
    scope?: { segmentIds?: string[]; frameIds?: string[] },
  ): Promise<SearchResult[]>;
  /** Build the cosine index once the table can train one. False if too small. */
  ensurePatchIndex(namespace: string, minRows?: number): Promise<boolean>;
  /** A frame's stored patch set, for deriving highlights without re-embedding. */
  getFramePatches(namespace: string, frameId: string): Promise<Float32Array[] | null>;

  deleteByIds(namespace: string, ids: string[]): Promise<void>;
  allIds(namespace: string): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * Arrow hands nested lists back as Vector-like objects, not plain arrays, and the
 * exact shape depends on how the column was read. Normalize defensively to
 * Float32Array rows so callers never depend on Arrow's internals.
 *
 * NEVER call `.toArray()` on the INNER vector. These patches are stored as
 * **float16** (see the schema below), and Arrow's `Vector.toArray()` for a
 * Float16 column returns the raw **uint16 BIT PATTERNS** — 11569 where 0.0811
 * was written. Nothing errors: the row count is right, the vector length is
 * right, and every downstream cosine is a plausible-looking number, so the only
 * symptom is that patch highlight boxes land on arbitrary parts of the frame.
 * That shipped, and the round-trip test that "covered" this asserted only
 * `length`. ITERATING the vector decodes properly, which is what
 * `Float32Array.from` does with an iterable.
 */
function toVectorList(value: unknown): Float32Array[] | null {
  if (value == null) return null;
  const outer = Array.isArray(value)
    ? value
    : typeof (value as { toArray?: () => unknown[] }).toArray === "function"
      ? (value as { toArray: () => unknown[] }).toArray()
      : null;
  if (!outer) return null;
  return outer.map((row) => {
    if (row instanceof Float32Array) return row;
    if (Array.isArray(row)) return Float32Array.from(row as number[]);
    // Iterate — see above. An Arrow Vector is iterable and yields decoded
    // numbers; its own toArray() would hand back the undecoded buffer.
    return Float32Array.from(row as Iterable<number>);
  });
}

/** SQL string literal for an id list: id IN ('a','b'). ULIDs are quote-free. */
function idInClause(column: string, ids: string[]): string {
  const quoted = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
  return `${column} IN (${quoted})`;
}

export class LanceStore implements VectorSide {
  private constructor(private readonly conn: lancedb.Connection) {}

  static async open(dir: string): Promise<LanceStore> {
    const conn = await lancedb.connect(dir);
    return new LanceStore(conn);
  }

  /** Create the namespace's table if it does not yet exist. Idempotent. */
  async ensureTable(namespace: string): Promise<void> {
    const name = tableNameFor(namespace);
    const existing = await this.conn.tableNames();
    if (existing.includes(name)) return;
    const { view, dimensions } = parseNamespace(namespace);
    const schema = schemaFor(kindForView(view), dimensions);
    await this.conn.createEmptyTable(name, schema);
  }

  private open(namespace: string): Promise<lancedb.Table> {
    return this.conn.openTable(tableNameFor(namespace));
  }

  async add(namespace: string, rows: VecRow[]): Promise<void> {
    if (rows.length === 0) return;
    const tbl = await this.open(namespace);
    await tbl.add(rows as unknown as Record<string, unknown>[]);
  }

  async searchSegment(
    namespace: string,
    vector: Float32Array,
    k: number,
  ): Promise<SearchResult[]> {
    return this.search(namespace, vector, k);
  }

  /** Shared scope predicate for frame-shaped tables (single- and multi-vector). */
  private frameFilter(scope?: {
    segmentIds?: string[];
    frameIds?: string[];
  }): string | undefined {
    const clauses: string[] = [];
    if (scope?.frameIds && scope.frameIds.length > 0) {
      clauses.push(idInClause("id", scope.frameIds));
    }
    if (scope?.segmentIds && scope.segmentIds.length > 0) {
      const list = scope.segmentIds
        .map((id) => `'${id.replace(/'/g, "''")}'`)
        .join(", ");
      // DataFusion list-membership: keep a frame if ANY of its segment_ids is in
      // the scope. Prefilter (the default) restricts the ANN to survivors.
      clauses.push(`array_has_any(segment_ids, [${list}])`);
    }
    return clauses.length ? clauses.join(" AND ") : undefined;
  }

  /** Frame search scoped by segment membership (array column) and/or frame ids. */
  async searchFrame(
    namespace: string,
    vector: Float32Array,
    k: number,
    scope?: { segmentIds?: string[]; frameIds?: string[] },
  ): Promise<SearchResult[]> {
    return this.search(namespace, vector, k, this.frameFilter(scope));
  }

  /** Region search scoped to a set of frames (Tier-3). */
  async searchRegion(
    namespace: string,
    vector: Float32Array,
    k: number,
    frameIds: string[],
  ): Promise<SearchResult[]> {
    if (frameIds.length === 0) return [];
    return this.search(namespace, vector, k, idInClause("frame_id", frameIds));
  }

  private async search(
    namespace: string,
    vector: Float32Array,
    k: number,
    filter?: string,
  ): Promise<SearchResult[]> {
    const tbl = await this.open(namespace);
    let q = tbl.search(Array.from(vector)).limit(k);
    if (filter) q = q.where(filter); // prefilter is the default in the JS SDK
    const rows = (await q.toArray()) as Array<{ id: string; _distance: number }>;
    return rows.map((r) => ({ id: r.id, distance: r._distance }));
  }

  // --- late interaction (frame_patches) ---------------------------------------

  async addPatches(namespace: string, rows: FramePatchRow[]): Promise<void> {
    if (rows.length === 0) return;
    const tbl = await this.open(namespace);
    await tbl.add(rows as unknown as Record<string, unknown>[]);
  }

  /**
   * Late-interaction frame search. `query` is one vector per query token; LanceDB
   * scores by MaxSim.
   *
   * `.distanceType("cosine")` is mandatory and unconditional: multivector supports
   * ONLY cosine, but an UNINDEXED table silently brute-forces with metric=l2 and
   * still returns plausible ordering — so omitting it fails quietly in dev and
   * only surfaces later, when index creation rejects l2 outright.
   */
  async searchFramePatches(
    namespace: string,
    query: Float32Array[],
    k: number,
    scope?: { segmentIds?: string[]; frameIds?: string[] },
  ): Promise<SearchResult[]> {
    if (query.length === 0) return [];
    if (scope?.frameIds && scope.frameIds.length === 0) return [];
    const tbl = await this.open(namespace);
    let q = tbl
      .vectorSearch(query.map((v) => Array.from(v)))
      .distanceType("cosine")
      .limit(k);
    const filter = this.frameFilter(scope);
    if (filter) q = q.where(filter); // prefilter is the default in the JS SDK
    const rows = (await q.toArray()) as Array<{ id: string; _distance: number }>;
    return rows.map((r) => ({ id: r.id, distance: r._distance }));
  }

  /**
   * Build the cosine IVF-PQ index once the table is big enough to train one.
   * Returns false (without throwing) when there are too few rows — brute-force
   * search stays correct, just slower.
   */
  async ensurePatchIndex(namespace: string, minRows = 256): Promise<boolean> {
    const tbl = await this.open(namespace);
    if ((await tbl.countRows()) < minRows) return false;
    const existing = await tbl.listIndices();
    if (existing.some((i) => i.columns.includes("patches"))) return true;
    try {
      await tbl.createIndex("patches", {
        config: lancedb.Index.ivfPq({
          distanceType: "cosine", // multivector supports ONLY cosine
          numPartitions: 16,
          numSubVectors: 8,
        }),
      });
      return true;
    } catch {
      return false; // not enough distinct vectors to train yet
    }
  }

  async getFramePatches(
    namespace: string,
    frameId: string,
  ): Promise<Float32Array[] | null> {
    const tbl = await this.open(namespace);
    const rows = (await tbl
      .query()
      .where(idInClause("id", [frameId]))
      .select(["patches"])
      .limit(1)
      .toArray()) as Array<{ patches: unknown }>;
    const row = rows[0];
    if (!row) return null;
    return toVectorList(row.patches);
  }

  /**
   * Delete rows by id. A namespace with NO TABLE is a no-op, not an error.
   *
   * A space can be registered in SQLite while its table has never existed —
   * `registerVectorSpace` writes the row, and on a real store the two had drifted
   * apart: 12 registered spaces against 11 directories in `lance/`. Deleting from
   * a table that is not there has already achieved what it was asked to do, so
   * throwing serves nobody: it took down a whole library re-index, and it takes
   * `deleteSession` down the same way, since both walk EVERY registered space
   * rather than only the ones a session happens to have vectors in.
   */
  async deleteByIds(namespace: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const name = tableNameFor(namespace);
    if (!(await this.conn.tableNames()).includes(name)) return;
    const tbl = await this.open(namespace);
    await tbl.delete(idInClause("id", ids));
  }

  /** All ids currently in the namespace's table (for reconciliation). */
  async allIds(namespace: string): Promise<string[]> {
    const tbl = await this.open(namespace);
    const rows = (await tbl.query().select(["id"]).toArray()) as Array<{
      id: string;
    }>;
    return rows.map((r) => r.id);
  }

  async close(): Promise<void> {
    this.conn.close();
  }
}
