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
import { Field, FixedSizeList, Float32, List, Schema, Utf8 } from "apache-arrow";
import { parseNamespace } from "../../embed/types.js";

/** Which physical row shape a namespace's view maps to. */
export type TableKind = "segment" | "frame" | "region";

export function kindForView(view: string): TableKind {
  switch (view) {
    case "frame_image":
      return "frame";
    case "region_image":
      return "region";
    default:
      return "segment"; // caption | digest | transcript | behavior
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
  deleteByIds(namespace: string, ids: string[]): Promise<void>;
  allIds(namespace: string): Promise<string[]>;
  close(): Promise<void>;
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

  /** Frame search scoped by segment membership (array column) and/or frame ids. */
  async searchFrame(
    namespace: string,
    vector: Float32Array,
    k: number,
    scope?: { segmentIds?: string[]; frameIds?: string[] },
  ): Promise<SearchResult[]> {
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
    const filter = clauses.length ? clauses.join(" AND ") : undefined;
    return this.search(namespace, vector, k, filter);
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

  async deleteByIds(namespace: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
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
