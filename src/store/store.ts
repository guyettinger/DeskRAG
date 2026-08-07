/**
 * DualStore — the one place both SQLite and LanceDB are known. Enforces the
 * dual-store consistency rules (see ./types.ts). Every vector-bearing write
 * follows the putRegions template: SQLite transaction commits FIRST, then the
 * Lance add; if the process dies in between, the relational row survives without
 * a vector and reconciliation re-embeds it from retained content.
 */

import { hamming64, i64ToU64, openDb, u64ToI64, type Db } from "./sqlite/db.js";
import {
  kindForView,
  LanceStore,
  type FramePatchRow,
  type VecRow,
  type VectorSide,
} from "./lance/tables.js";
import { Mutex } from "./mutex.js";
import type { UIElement } from "../embed/types.js";
import type {
  BlobInsert,
  BlobRow,
  EventInsert,
  EventRow,
  FrameInsert,
  FramePatchInsert,
  FrameRow,
  FrameScope,
  FrameVectorInsert,
  MissingVector,
  ReconcileResult,
  Reembedder,
  RegionInsert,
  RegionRow,
  RegionScope,
  SearchHit,
  SegmentInsert,
  SegmentPatch,
  TranscriptClipInsert,
  TranscriptClipRow,
  SegmentRow,
  AxSnapshotReason,
  AxSnapshotRow,
  SegmentVectorInsert,
  SessionInsert,
  TraceGraph,
  TraceGraphSummary,
  SessionRow,
  SessionSummaryRow,
  Store,
  VectorSpaceInsert,
} from "./types.js";

function parseElements(json: string): UIElement[] {
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed) ? (parsed as UIElement[]) : [];
}

function jsonOrNull(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

function parseJson(s: string | null): unknown {
  return s === null ? null : JSON.parse(s);
}

/**
 * The only place SQLite and LanceDB are both known. Callers see one `Store`.
 *
 * Every vector-bearing write commits the SQLite transaction FIRST, then adds to
 * Lance, and all writes serialize through a mutex so that pair cannot interleave.
 * A crash in between leaves a relational row with no vector — detectable, and
 * re-embeddable by `reconcileAndReembed`. The reverse order would leave orphan
 * vectors that nothing can find.
 *
 * Open it with `DualStore.open()`; the constructor is private.
 */
export class DualStore implements Store {
  private readonly mutex = new Mutex();
  private readonly spaces = new Map<string, VectorSpaceInsert>();
  private readonly stmts: ReturnType<DualStore["prepare"]>;

  private constructor(
    private readonly db: Db,
    private readonly lance: VectorSide,
  ) {
    this.stmts = this.prepare();
    for (const s of this.stmts.selectAllSpaces.all() as VectorSpaceInsert[]) {
      this.spaces.set(s.namespace, {
        ...s,
        sharedTextSpace: Boolean((s as unknown as { shared_text_space: number }).shared_text_space),
      });
    }
  }

  /**
   * @param vectorSide  Injectable vector layer (defaults to a real LanceStore).
   *                    Tests pass a layer that fails/kills mid-`add`.
   */
  static async open(
    sqlitePath: string,
    lanceDir: string,
    vectorSide?: VectorSide,
  ): Promise<DualStore> {
    const db = openDb(sqlitePath);
    const lance = vectorSide ?? (await LanceStore.open(lanceDir));
    return new DualStore(db, lance);
  }

  private prepare() {
    const db = this.db;
    const phashScan = db.prepare("SELECT id, phash FROM frame");
    phashScan.safeIntegers(true);
    const selectFrameById = db.prepare("SELECT * FROM frame WHERE id = ?");
    selectFrameById.safeIntegers(true);
    const selectFramesBySession = db.prepare(
      "SELECT * FROM frame WHERE session_id = ? ORDER BY t_mono ASC",
    );
    selectFramesBySession.safeIntegers(true); // phash is 64-bit
    const selectFramesBySegment = db.prepare(
      `SELECT f.* FROM frame f
         JOIN frame_segment fs ON fs.frame_id = f.id
        WHERE fs.segment_id = ? ORDER BY f.t_mono ASC`,
    );
    selectFramesBySegment.safeIntegers(true);
    return {
      insertSession: db.prepare(
        `INSERT INTO session(id, started_at, epoch_mono, ended_at, device_id, meta)
         VALUES (@id, @startedAt, @epochMono, @endedAt, @deviceId, @meta)`,
      ),
      insertEvent: db.prepare(
        `INSERT INTO event(id, session_id, t_mono, kind, x, y, data)
         VALUES (@id, @sessionId, @tMono, @kind, @x, @y, @data)`,
      ),
      insertBlob: db.prepare(
        `INSERT INTO blob(id, session_id, media, path, byte_offset, byte_length, t_mono_start, t_mono_end, codec)
         VALUES (@id, @sessionId, @media, @path, @byteOffset, @byteLength, @tMonoStart, @tMonoEnd, @codec)`,
      ),
      insertSegment: db.prepare(
        `INSERT INTO segment(id, session_id, granularity, t_mono_start, t_mono_end, boundary_reason, transcript, digest, caption, meta)
         VALUES (@id, @sessionId, @granularity, @tMonoStart, @tMonoEnd, @boundaryReason, @transcript, @digest, @caption, @meta)`,
      ),
      insertFrame: db.prepare(
        `INSERT INTO frame(id, session_id, t_mono, width, height, phash, blob_id, frame_offset)
         VALUES (@id, @sessionId, @tMono, @width, @height, @phash, @blobId, @frameOffset)`,
      ),
      insertFrameSegment: db.prepare(
        `INSERT OR IGNORE INTO frame_segment(frame_id, segment_id) VALUES (?, ?)`,
      ),
      upsertFrameAx: db.prepare(
        `INSERT INTO frame_ax(frame_id, elements) VALUES (?, ?)
         ON CONFLICT(frame_id) DO UPDATE SET elements = excluded.elements`,
      ),
      selectFrameAx: db.prepare("SELECT elements FROM frame_ax WHERE frame_id = ?"),
      insertAxSnapshot: db.prepare(
        `INSERT INTO ax_snapshot(id, session_id, t_mono, frame_id, reason, walk_ms, elements)
         VALUES (@id, @sessionId, @tMono, @frameId, @reason, @walkMs, @elements)`,
      ),
      selectAxAt: db.prepare(
        `SELECT * FROM ax_snapshot
          WHERE session_id = ? AND t_mono <= ?
          ORDER BY t_mono DESC LIMIT 1`,
      ),
      selectAxSnapshotsBySession: db.prepare(
        "SELECT * FROM ax_snapshot WHERE session_id = ? ORDER BY t_mono ASC",
      ),
      selectAxByFrame: db.prepare(
        "SELECT elements FROM ax_snapshot WHERE frame_id = ? ORDER BY t_mono DESC LIMIT 1",
      ),
      insertAxBoundary: db.prepare(
        `INSERT INTO ax_snapshot_boundary(snapshot_id, session_id, t_mono)
         VALUES (@snapshotId, @sessionId, @tMono)
         ON CONFLICT(snapshot_id) DO UPDATE SET t_mono = excluded.t_mono`,
      ),
      // Exact match on the boundary's own t_mono. A boundary snapshot is written
      // later than the boundary it describes, so a timing lookup finds the
      // PREVIOUS state's tree instead.
      selectAxForBoundary: db.prepare(
        `SELECT s.* FROM ax_snapshot s
           JOIN ax_snapshot_boundary b ON b.snapshot_id = s.id
          WHERE b.session_id = ? AND b.t_mono = ?
          ORDER BY s.t_mono ASC LIMIT 1`,
      ),
      insertRegion: db.prepare(
        `INSERT INTO region(id, frame_id, segment_id, session_id, x, y, w, h, source, role, label, priority)
         VALUES (@id, @frameId, @segmentId, @sessionId, @x, @y, @w, @h, @source, @role, @label, @priority)`,
      ),
      insertRegionFts: db.prepare(
        `INSERT INTO region_fts(region_id, label, role) VALUES (?, ?, ?)`,
      ),
      updateSegment: db.prepare(
        `UPDATE segment SET
           digest     = COALESCE(@digest, digest),
           caption    = COALESCE(@caption, caption),
           transcript = COALESCE(@transcript, transcript),
           meta       = COALESCE(@meta, meta)
         WHERE id = @id`,
      ),
      upsertSegmentAppCaption: db.prepare(
        `INSERT INTO segment_app_caption(segment_id, text) VALUES (?, ?)
         ON CONFLICT(segment_id) DO UPDATE SET text = excluded.text`,
      ),
      selectSegmentAppCaption: db.prepare(
        "SELECT text FROM segment_app_caption WHERE segment_id = ?",
      ),
      insertTranscriptClip: db.prepare(
        `INSERT INTO transcript_clip(id, session_id, t_mono_start, t_mono_end, text)
         VALUES (@id, @sessionId, @tMonoStart, @tMonoEnd, @text)`,
      ),
      selectTranscriptClipsBySession: db.prepare(
        `SELECT id, session_id, t_mono_start, t_mono_end, text
           FROM transcript_clip WHERE session_id = ? ORDER BY t_mono_start`,
      ),
      deleteRegionFts: db.prepare(`DELETE FROM region_fts WHERE region_id = ?`),
      selectSegmentIdsBySession: db.prepare(
        "SELECT id FROM segment WHERE session_id = ?",
      ),
      selectFrameIdsBySession: db.prepare(
        "SELECT id FROM frame WHERE session_id = ?",
      ),
      selectRegionIdsBySession: db.prepare(
        "SELECT id FROM region WHERE session_id = ?",
      ),
      deleteSession: db.prepare("DELETE FROM session WHERE id = ?"),
      endSession: db.prepare("UPDATE session SET ended_at = ? WHERE id = ?"),
      selectSession: db.prepare("SELECT * FROM session WHERE id = ?"),
      // Each count is its own correlated scalar subquery: a multi-table JOIN
      // would multiply the per-table counts together.
      selectAllSessions: db.prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM frame   f WHERE f.session_id = s.id) AS frame_count,
                (SELECT COUNT(*) FROM segment g WHERE g.session_id = s.id) AS segment_count,
                (SELECT COUNT(*) FROM event   e WHERE e.session_id = s.id) AS event_count,
                (SELECT COALESCE(SUM(b.byte_length), 0) FROM blob b
                  WHERE b.session_id = s.id)                               AS byte_length,
                (SELECT b.id FROM blob b
                  WHERE b.session_id = s.id AND b.media = 'screen'
                  ORDER BY b.t_mono_start ASC LIMIT 1)                     AS video_blob_id
           FROM session s
          ORDER BY s.started_at DESC`,
      ),
      selectEventsBySession: db.prepare(
        "SELECT * FROM event WHERE session_id = ? ORDER BY t_mono ASC",
      ),
      selectSegmentsBySession: db.prepare(
        "SELECT * FROM segment WHERE session_id = ? ORDER BY granularity ASC, t_mono_start ASC",
      ),
      phashScan,
      ftsMatch: db.prepare(
        "SELECT region_id FROM region_fts WHERE region_fts MATCH ? LIMIT ?",
      ),
      insertVectorSpace: db.prepare(
        `INSERT OR IGNORE INTO vector_space(namespace, view, provider_id, model, dimensions, shared_text_space, created_at)
         VALUES (@namespace, @view, @providerId, @model, @dimensions, @sharedTextSpace, @createdAt)`,
      ),
      selectAllSpaces: db.prepare("SELECT * FROM vector_space"),
      // reconciliation
      selectAllRegionIds: db.prepare("SELECT id FROM region"),
      selectAllFrameIds: db.prepare("SELECT id FROM frame"),
      selectFrameIdsWithBlob: db.prepare(
        "SELECT id FROM frame WHERE blob_id IS NOT NULL",
      ),
      selectSegmentIdsWithCaption: db.prepare(
        "SELECT id FROM segment WHERE caption IS NOT NULL",
      ),
      selectSegmentIdsWithDigest: db.prepare(
        "SELECT id FROM segment WHERE digest IS NOT NULL",
      ),
      selectSegmentIdsWithTranscript: db.prepare(
        "SELECT id FROM segment WHERE transcript IS NOT NULL",
      ),
      selectSegmentIdsWithAppCaption: db.prepare(
        "SELECT segment_id AS id FROM segment_app_caption",
      ),
      selectRegionById: db.prepare("SELECT * FROM region WHERE id = ?"),
      selectRegionsByFrame: db.prepare(
        "SELECT * FROM region WHERE frame_id = ? ORDER BY priority DESC, id ASC",
      ),
      selectFrameById,
      selectFramesBySession,
      selectFramesBySegment,
      selectBlobById: db.prepare("SELECT * FROM blob WHERE id = ?"),
      selectBlobsBySession: db.prepare(
        "SELECT * FROM blob WHERE session_id = ? ORDER BY t_mono_start ASC",
      ),
      selectSegmentById: db.prepare("SELECT * FROM segment WHERE id = ?"),
      selectSegmentIdsByFrame: db.prepare(
        "SELECT segment_id FROM frame_segment WHERE frame_id = ?",
      ),
      // experience trace graphs (SQLite only — no Lance side)
      upsertTraceGraph: db.prepare(
        `INSERT INTO trace_graph(id, entry_node, created_at) VALUES (@id, @entryNode, @createdAt)
         ON CONFLICT(id) DO UPDATE SET entry_node = excluded.entry_node`,
      ),
      deleteTraceGraph: db.prepare("DELETE FROM trace_graph WHERE id = ?"),
      deleteTraceNodes: db.prepare("DELETE FROM trace_node WHERE graph_id = ?"),
      deleteTraceEdges: db.prepare("DELETE FROM trace_edge WHERE graph_id = ?"),
      deleteTraceSlots: db.prepare("DELETE FROM trace_slot WHERE graph_id = ?"),
      deleteTraceNodeSources: db.prepare("DELETE FROM trace_node_source WHERE graph_id = ?"),
      deleteTraceEdgeSources: db.prepare("DELETE FROM trace_edge_source WHERE graph_id = ?"),
      insertTraceNode: db.prepare(
        `INSERT INTO trace_node(id, graph_id, predicates, visual, intervene, observations, ord)
         VALUES (@id, @graphId, @predicates, @visual, @intervene, @observations, @ord)`,
      ),
      insertTraceEdge: db.prepare(
        `INSERT INTO trace_edge(id, graph_id, from_node, to_node, actions, guard, provenance,
                                observations, attempts, successes, lift_warnings, ord)
         VALUES (@id, @graphId, @fromNode, @toNode, @actions, @guard, @provenance,
                 @observations, @attempts, @successes, @liftWarnings, @ord)`,
      ),
      insertTraceSlot: db.prepare(
        `INSERT INTO trace_slot(graph_id, name, samples, ord)
         VALUES (@graphId, @name, @samples, @ord)`,
      ),
      insertTraceNodeSource: db.prepare(
        `INSERT INTO trace_node_source(graph_id, node_id, session_id, t_mono, ord)
         VALUES (@graphId, @nodeId, @sessionId, @tMono, @ord)`,
      ),
      insertTraceEdgeSource: db.prepare(
        `INSERT INTO trace_edge_source(graph_id, edge_id, session_id, t_mono_start, t_mono_end, ord)
         VALUES (@graphId, @edgeId, @sessionId, @tMonoStart, @tMonoEnd, @ord)`,
      ),
      selectSessionIds: db.prepare("SELECT id FROM session"),
      selectTraceGraph: db.prepare("SELECT id, entry_node FROM trace_graph WHERE id = ?"),
      selectTraceGraphs: db.prepare(
        `SELECT g.id, g.created_at,
                (SELECT COUNT(*) FROM trace_node n WHERE n.graph_id = g.id) AS nodes,
                (SELECT COUNT(*) FROM trace_edge e WHERE e.graph_id = g.id) AS edges
           FROM trace_graph g ORDER BY g.created_at DESC, g.id ASC`,
      ),
      selectTraceNodes: db.prepare("SELECT * FROM trace_node WHERE graph_id = ? ORDER BY ord ASC"),
      selectTraceEdges: db.prepare("SELECT * FROM trace_edge WHERE graph_id = ? ORDER BY ord ASC"),
      selectTraceSlots: db.prepare("SELECT * FROM trace_slot WHERE graph_id = ? ORDER BY ord ASC"),
      // Whole-graph, then grouped in JS: a per-node query would be one round
      // trip per card on a screen that renders every node at once.
      selectTraceNodeSources: db.prepare(
        "SELECT * FROM trace_node_source WHERE graph_id = ? ORDER BY node_id ASC, ord ASC",
      ),
      selectTraceEdgeSources: db.prepare(
        "SELECT * FROM trace_edge_source WHERE graph_id = ? ORDER BY edge_id ASC, ord ASC",
      ),
    };
  }

  // --- registry --------------------------------------------------------------

  async registerVectorSpace(space: VectorSpaceInsert): Promise<void> {
    await this.mutex.run(async () => {
      // Guard the ':' -> '__' table-name mapping stays injective.
      for (const existing of this.spaces.values()) {
        if (
          existing.namespace !== space.namespace &&
          existing.namespace.replace(/:/g, "__") ===
            space.namespace.replace(/:/g, "__")
        ) {
          throw new Error(
            `namespace ${space.namespace} collides with ${existing.namespace} after table-name sanitization`,
          );
        }
      }
      // SQLite first.
      this.stmts.insertVectorSpace.run({
        namespace: space.namespace,
        view: space.view,
        providerId: space.providerId,
        model: space.model,
        dimensions: space.dimensions,
        sharedTextSpace: space.sharedTextSpace ? 1 : 0,
        createdAt: Date.now(),
      });
      // Then the Lance table.
      await this.lance.ensureTable(space.namespace);
      this.spaces.set(space.namespace, space);
    });
  }

  listVectorSpaces(): VectorSpaceInsert[] {
    return [...this.spaces.values()];
  }

  private requireSpace(namespace: string): VectorSpaceInsert {
    const s = this.spaces.get(namespace);
    if (!s) {
      throw new Error(
        `unknown namespace ${namespace}: registerVectorSpace first`,
      );
    }
    return s;
  }

  // --- writes (SQLite tx commit, THEN Lance) ---------------------------------

  async putSession(row: SessionInsert): Promise<void> {
    await this.mutex.run(async () => {
      this.stmts.insertSession.run({
        id: row.id,
        startedAt: row.startedAt,
        epochMono: row.epochMono,
        endedAt: row.endedAt ?? null,
        deviceId: row.deviceId ?? null,
        meta: jsonOrNull(row.meta),
      });
    });
  }

  async putEvents(rows: EventInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      const tx = this.db.transaction((rs: EventInsert[]) => {
        for (const r of rs) {
          this.stmts.insertEvent.run({
            id: r.id,
            sessionId: r.sessionId,
            tMono: r.tMono,
            kind: r.kind,
            x: r.x ?? null,
            y: r.y ?? null,
            data: jsonOrNull(r.data),
          });
        }
      });
      tx(rows);
    });
  }

  async putBlobs(rows: BlobInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      const tx = this.db.transaction((rs: BlobInsert[]) => {
        for (const r of rs) {
          this.stmts.insertBlob.run({
            id: r.id,
            sessionId: r.sessionId,
            media: r.media,
            path: r.path,
            byteOffset: r.byteOffset,
            byteLength: r.byteLength,
            tMonoStart: r.tMonoStart,
            tMonoEnd: r.tMonoEnd,
            codec: r.codec ?? null,
          });
        }
      });
      tx(rows);
    });
  }

  async putSegments(rows: SegmentInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      // 1. SQLite transaction: segment rows, commit first.
      const tx = this.db.transaction((rs: SegmentInsert[]) => {
        for (const r of rs) {
          this.stmts.insertSegment.run({
            id: r.id,
            sessionId: r.sessionId,
            granularity: r.granularity,
            tMonoStart: r.tMonoStart,
            tMonoEnd: r.tMonoEnd,
            boundaryReason: r.boundaryReason ?? null,
            transcript: r.transcript ?? null,
            digest: r.digest ?? null,
            caption: r.caption ?? null,
            meta: jsonOrNull(r.meta),
          });
        }
      });
      tx(rows);
      // 2. Lance second, per namespace referenced by the segment's vectors.
      for (const r of rows) {
        for (const v of r.vectors ?? []) {
          this.requireSpace(v.namespace);
          await this.lance.add(v.namespace, [
            { id: r.id, session_id: r.sessionId, vector: Array.from(v.vector) },
          ]);
        }
      }
    });
  }

  async putFrames(rows: FrameInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      // 1. SQLite transaction: frame rows + frame_segment edges, commit first.
      const tx = this.db.transaction((rs: FrameInsert[]) => {
        for (const r of rs) {
          this.stmts.insertFrame.run({
            id: r.id,
            sessionId: r.sessionId,
            tMono: r.tMono,
            width: r.width,
            height: r.height,
            phash: u64ToI64(r.phash),
            blobId: r.blobId ?? null,
            frameOffset: r.frameOffset,
          });
          for (const sid of r.segmentIds) {
            this.stmts.insertFrameSegment.run(r.id, sid);
          }
        }
      });
      tx(rows);
      // 2. Lance second (whole-frame image vector), with denormalized segment_ids.
      for (const r of rows) {
        if (!r.vector) continue;
        this.requireSpace(r.vector.namespace);
        await this.lance.add(r.vector.namespace, [
          {
            id: r.id,
            session_id: r.sessionId,
            segment_ids: r.segmentIds,
            vector: Array.from(r.vector.vector),
          },
        ]);
      }
    });
  }

  async putRegions(rows: RegionInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      // 1. SQLite transaction: region rows + FTS, commit first.
      const tx = this.db.transaction((rs: RegionInsert[]) => {
        for (const r of rs) {
          this.stmts.insertRegion.run({
            id: r.id,
            frameId: r.frameId,
            segmentId: r.segmentId,
            sessionId: r.sessionId,
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            source: r.source,
            role: r.role ?? null,
            label: r.label ?? null,
            priority: r.priority,
          });
          this.stmts.insertRegionFts.run(r.id, r.label ?? "", r.role ?? "");
        }
      });
      tx(rows); // committed — relational truth persisted

      // 2. Lance second, into the namespaced table. On failure the region rows
      //    survive without vectors and reconciliation re-embeds them later.
      const byNs = new Map<string, VecRow[]>();
      for (const r of rows) {
        if (r.vector === undefined) continue; // proposed but not embedded
        this.requireSpace(r.vector.namespace);
        const list = byNs.get(r.vector.namespace) ?? [];
        list.push({
          id: r.id,
          frame_id: r.frameId,
          segment_id: r.segmentId,
          session_id: r.sessionId,
          vector: Array.from(r.vector.vector),
        });
        byNs.set(r.vector.namespace, list);
      }
      for (const [ns, list] of byNs) await this.lance.add(ns, list);
    });
  }

  // --- enrich existing segments (represent/) ---------------------------------

  async updateSegment(id: string, patch: SegmentPatch): Promise<void> {
    await this.mutex.run(async () => {
      this.stmts.updateSegment.run({
        id,
        digest: patch.digest ?? null,
        caption: patch.caption ?? null,
        transcript: patch.transcript ?? null,
        meta: patch.meta === undefined ? null : JSON.stringify(patch.meta),
      });
    });
  }

  async updateSegmentAppCaption(segmentId: string, text: string): Promise<void> {
    await this.mutex.run(async () => {
      this.stmts.upsertSegmentAppCaption.run(segmentId, text);
    });
  }

  getAppCaption(segmentId: string): string | undefined {
    const row = this.stmts.selectSegmentAppCaption.get(segmentId) as
      | { text: string }
      | undefined;
    return row?.text;
  }

  async putTranscriptClips(rows: TranscriptClipInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      const tx = this.db.transaction((rs: TranscriptClipInsert[]) => {
        for (const r of rs) {
          this.stmts.insertTranscriptClip.run({
            id: r.id,
            sessionId: r.sessionId,
            tMonoStart: r.tMonoStart,
            tMonoEnd: r.tMonoEnd,
            text: r.text,
          });
        }
      });
      tx(rows);
    });
  }

  getTranscriptClipsBySession(sessionId: string): TranscriptClipRow[] {
    const rows = this.stmts.selectTranscriptClipsBySession.all(sessionId) as {
      id: string;
      session_id: string;
      t_mono_start: number;
      t_mono_end: number;
      text: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      // safeIntegers makes column reads BigInt; these are small and every
      // consumer does arithmetic on them, so coerce here like hydrateFrame does.
      tMonoStart: Number(r.t_mono_start),
      tMonoEnd: Number(r.t_mono_end),
      text: r.text,
    }));
  }

  async putSegmentVectors(rows: SegmentVectorInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      // Segment rows already exist (SQLite truth persisted). This is a Lance-only
      // add per namespace — the text the vector came from was written first via
      // updateSegment, so a crash here leaves a re-embeddable gap.
      const byNs = new Map<string, VecRow[]>();
      for (const r of rows) {
        this.requireSpace(r.namespace);
        const list = byNs.get(r.namespace) ?? [];
        list.push({
          id: r.segmentId,
          session_id: r.sessionId,
          vector: Array.from(r.vector),
        });
        byNs.set(r.namespace, list);
      }
      for (const [ns, list] of byNs) await this.lance.add(ns, list);
    });
  }

  // --- enrich existing frames (Tier-2 represent/) ----------------------------

  async associateFrameSegments(
    frameId: string,
    segmentIds: string[],
  ): Promise<void> {
    if (segmentIds.length === 0) return;
    await this.mutex.run(async () => {
      const tx = this.db.transaction((ids: string[]) => {
        for (const sid of ids) this.stmts.insertFrameSegment.run(frameId, sid);
      });
      tx(segmentIds);
    });
  }

  async putFrameAx(frameId: string, elements: UIElement[]): Promise<void> {
    await this.mutex.run(async () => {
      this.stmts.upsertFrameAx.run(frameId, JSON.stringify(elements));
    });
  }

  getFrameAx(frameId: string): UIElement[] {
    // ax_snapshot supersedes frame_ax; the legacy table is read only for
    // sessions recorded before it existed.
    const fresh = this.stmts.selectAxByFrame.get(frameId) as { elements: string } | undefined;
    if (fresh !== undefined) return parseElements(fresh.elements);
    const legacy = this.stmts.selectFrameAx.get(frameId) as { elements: string } | undefined;
    return legacy === undefined ? [] : parseElements(legacy.elements);
  }

  async putAxSnapshot(row: AxSnapshotRow): Promise<void> {
    await this.mutex.run(async () => {
      this.stmts.insertAxSnapshot.run({
        id: row.id,
        sessionId: row.sessionId,
        tMono: row.tMono,
        frameId: row.frameId,
        reason: row.reason,
        walkMs: row.walkMs,
        elements: JSON.stringify(row.elements),
      });
      // Stamp which boundary this walk was taken FOR, so lift can match exactly
      // instead of inferring from a timestamp that is always later.
      if (row.boundaryTMono !== undefined) {
        this.stmts.insertAxBoundary.run({
          snapshotId: row.id,
          sessionId: row.sessionId,
          tMono: row.boundaryTMono,
        });
      }
    });
  }

  /** The snapshot captured FOR this boundary, or undefined if none was stamped. */
  getAxForBoundary(sessionId: string, tMono: number): AxSnapshotRow | undefined {
    return this.hydrateAxSnapshot(this.stmts.selectAxForBoundary.get(sessionId, tMono));
  }

  getAxAt(sessionId: string, tMono: number): AxSnapshotRow | undefined {
    return this.hydrateAxSnapshot(this.stmts.selectAxAt.get(sessionId, tMono));
  }

  /**
   * Every AX snapshot for a session, oldest first.
   *
   * `getAxForBoundary` and `getAxAt` both answer "which tree was in force at
   * this instant" — the question represent and lift ask. This one answers "what
   * was walked, and when", which is what a timeline needs, including the empty
   * results that exist precisely so "captured nothing" stays distinguishable
   * from "never captured".
   */
  getAxSnapshotsBySession(sessionId: string): AxSnapshotRow[] {
    return (this.stmts.selectAxSnapshotsBySession.all(sessionId) as unknown[]).flatMap((r) => {
      const row = this.hydrateAxSnapshot(r);
      return row ? [row] : [];
    });
  }

  private hydrateAxSnapshot(row: unknown): AxSnapshotRow | undefined {
    const r = row as
      | {
          id: string;
          session_id: string;
          t_mono: number;
          frame_id: string | null;
          reason: string;
          walk_ms: number;
          elements: string;
        }
      | undefined;
    if (r === undefined) return undefined;
    return {
      id: r.id,
      sessionId: r.session_id,
      tMono: r.t_mono,
      frameId: r.frame_id,
      reason: r.reason as AxSnapshotReason,
      walkMs: r.walk_ms,
      elements: parseElements(r.elements),
    };
  }

  async putFrameVectors(rows: FrameVectorInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      // Frame rows already exist; this is a Lance-only add with denormalized
      // segment_ids so Tier-2 can pre-filter frames by segment scope.
      const byNs = new Map<string, VecRow[]>();
      for (const r of rows) {
        this.requireSpace(r.namespace);
        const list = byNs.get(r.namespace) ?? [];
        list.push({
          id: r.frameId,
          session_id: r.sessionId,
          segment_ids: r.segmentIds,
          vector: Array.from(r.vector),
        });
        byNs.set(r.namespace, list);
      }
      for (const [ns, list] of byNs) await this.lance.add(ns, list);
    });
  }

  /**
   * Late-interaction patch sets. Association (SQLite) commits FIRST, then the
   * Lance add — a crash between leaves a detectable gap, never an orphan vector.
   *
   * Replaces any existing row for the same frame so a re-run of the representer
   * does not duplicate patch sets.
   */
  async putFramePatches(rows: FramePatchInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      const tx = this.db.transaction((batch: FramePatchInsert[]) => {
        for (const r of batch) {
          for (const sid of r.segmentIds) {
            this.stmts.insertFrameSegment.run(r.frameId, sid);
          }
        }
      });
      tx(rows);

      const byNs = new Map<string, FramePatchRow[]>();
      for (const r of rows) {
        this.requireSpace(r.namespace);
        const list = byNs.get(r.namespace) ?? [];
        list.push({
          id: r.frameId,
          session_id: r.sessionId,
          segment_ids: r.segmentIds,
          patches: r.patches.map((v) => Array.from(v)),
        });
        byNs.set(r.namespace, list);
      }
      for (const [ns, list] of byNs) {
        await this.lance.deleteByIds(
          ns,
          list.map((r) => r.id),
        );
        await this.lance.addPatches(ns, list);
        await this.lance.ensurePatchIndex(ns);
      }
    });
  }

  // --- session lifecycle + relational reads ----------------------------------

  async endSession(sessionId: string, endedAt: number): Promise<void> {
    await this.mutex.run(async () => {
      this.stmts.endSession.run(endedAt, sessionId);
    });
  }

  getSession(sessionId: string): SessionRow | undefined {
    const r = this.stmts.selectSession.get(sessionId) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      startedAt: r.started_at as number,
      epochMono: r.epoch_mono as number,
      endedAt: (r.ended_at as number | null) ?? null,
      deviceId: (r.device_id as string | null) ?? null,
      meta: parseJson(r.meta as string | null),
    };
  }

  listSessions(): SessionSummaryRow[] {
    return (this.stmts.selectAllSessions.all() as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      startedAt: r.started_at as number,
      epochMono: r.epoch_mono as number,
      endedAt: (r.ended_at as number | null) ?? null,
      deviceId: (r.device_id as string | null) ?? null,
      meta: parseJson(r.meta as string | null),
      frameCount: r.frame_count as number,
      segmentCount: r.segment_count as number,
      eventCount: r.event_count as number,
      byteLength: r.byte_length as number,
      videoBlobId: (r.video_blob_id as string | null) ?? null,
    }));
  }

  getEventsBySession(sessionId: string): EventRow[] {
    return (
      this.stmts.selectEventsBySession.all(sessionId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      tMono: r.t_mono as number,
      kind: r.kind as string,
      x: (r.x as number | null) ?? null,
      y: (r.y as number | null) ?? null,
      data: parseJson(r.data as string | null),
    }));
  }

  getSegmentsBySession(sessionId: string): SegmentRow[] {
    return (
      this.stmts.selectSegmentsBySession.all(sessionId) as Record<string, unknown>[]
    ).map((r) => this.hydrateSegment(r));
  }

  getSegment(segmentId: string): SegmentRow | undefined {
    const r = this.stmts.selectSegmentById.get(segmentId) as
      | Record<string, unknown>
      | undefined;
    return r ? this.hydrateSegment(r) : undefined;
  }

  getFramesBySession(sessionId: string): FrameRow[] {
    return (
      this.stmts.selectFramesBySession.all(sessionId) as Record<string, unknown>[]
    ).map((r) => this.hydrateFrame(r));
  }

  getFrame(frameId: string): FrameRow | undefined {
    const r = this.stmts.selectFrameById.get(frameId) as
      | Record<string, unknown>
      | undefined;
    return r ? this.hydrateFrame(r) : undefined;
  }

  getFramesBySegment(segmentId: string): FrameRow[] {
    return (
      this.stmts.selectFramesBySegment.all(segmentId) as Record<string, unknown>[]
    ).map((r) => this.hydrateFrame(r));
  }

  getRegion(regionId: string): RegionRow | undefined {
    const r = this.stmts.selectRegionById.get(regionId) as
      | Record<string, unknown>
      | undefined;
    return r ? this.hydrateRegion(r) : undefined;
  }

  getRegionsByFrame(frameId: string): RegionRow[] {
    const rows = this.stmts.selectRegionsByFrame.all(frameId) as Record<string, unknown>[];
    return rows.map((r) => this.hydrateRegion(r));
  }

  getBlob(blobId: string): BlobRow | undefined {
    const r = this.stmts.selectBlobById.get(blobId) as
      | Record<string, unknown>
      | undefined;
    return r ? this.hydrateBlob(r) : undefined;
  }

  getBlobsBySession(sessionId: string): BlobRow[] {
    return (
      this.stmts.selectBlobsBySession.all(sessionId) as Record<string, unknown>[]
    ).map((r) => this.hydrateBlob(r));
  }

  private hydrateBlob(r: Record<string, unknown>): BlobRow {
    return {
      id: r.id as string,
      sessionId: r.session_id as string,
      media: r.media as string,
      path: r.path as string,
      byteOffset: r.byte_offset as number,
      byteLength: r.byte_length as number,
      tMonoStart: r.t_mono_start as number,
      tMonoEnd: r.t_mono_end as number,
      codec: (r.codec as string | null) ?? null,
    };
  }

  // --- delete (gather ids -> Lance -> SQLite) --------------------------------

  async deleteSession(sessionId: string): Promise<void> {
    await this.mutex.run(async () => {
      const segIds = (
        this.stmts.selectSegmentIdsBySession.all(sessionId) as { id: string }[]
      ).map((r) => r.id);
      const frameIds = (
        this.stmts.selectFrameIdsBySession.all(sessionId) as { id: string }[]
      ).map((r) => r.id);
      const regionIds = (
        this.stmts.selectRegionIdsBySession.all(sessionId) as { id: string }[]
      ).map((r) => r.id);

      // Lance first (delete order rule), by entity kind per namespace.
      // Exhaustive on purpose: a ternary chain here silently sent any new kind
      // to regionIds, which for frame_patches meant its rows were never deleted.
      const idsForKind = (kind: ReturnType<typeof kindForView>): string[] => {
        switch (kind) {
          case "segment":
            return segIds;
          case "frame":
          case "frame_patches": // keyed by frame id, like frame_image
            return frameIds;
          case "region":
            return regionIds;
        }
      };
      for (const space of this.spaces.values()) {
        await this.lance.deleteByIds(
          space.namespace,
          idsForKind(kindForView(space.view)),
        );
      }

      // Then SQLite. CASCADE clears event/blob/segment/frame/region/frame_segment;
      // the standalone region_fts is not cascaded, so clear it explicitly.
      const tx = this.db.transaction(() => {
        for (const rid of regionIds) this.stmts.deleteRegionFts.run(rid);
        this.stmts.deleteSession.run(sessionId);
      });
      tx();
    });
  }

  // --- search ----------------------------------------------------------------

  phashPrefilter(phash: bigint, maxHamming: number): string[] {
    const target = u64ToI64(phash);
    const out: string[] = [];
    for (const row of this.stmts.phashScan.iterate() as Iterable<{
      id: string;
      phash: bigint;
    }>) {
      if (hamming64(target, row.phash) <= maxHamming) out.push(row.id);
    }
    return out;
  }

  async searchSegments(
    namespace: string,
    vector: Float32Array,
    k: number,
  ): Promise<SearchHit[]> {
    this.requireSpace(namespace);
    return this.lance.searchSegment(namespace, vector, k);
  }

  async searchFrames(
    namespace: string,
    vector: Float32Array,
    k: number,
    scope?: FrameScope,
  ): Promise<SearchHit[]> {
    this.requireSpace(namespace);
    return this.lance.searchFrame(namespace, vector, k, scope);
  }

  async searchFramePatches(
    namespace: string,
    query: Float32Array[],
    k: number,
    scope?: FrameScope,
  ): Promise<SearchHit[]> {
    this.requireSpace(namespace);
    return this.lance.searchFramePatches(namespace, query, k, scope);
  }

  async getFramePatches(
    namespace: string,
    frameId: string,
  ): Promise<Float32Array[] | null> {
    this.requireSpace(namespace);
    return this.lance.getFramePatches(namespace, frameId);
  }

  async searchRegions(
    namespace: string,
    vector: Float32Array,
    k: number,
    scope: RegionScope,
  ): Promise<SearchHit[]> {
    this.requireSpace(namespace);
    return this.lance.searchRegion(namespace, vector, k, scope.frameIds);
  }

  ftsRegions(query: string, limit = 50): string[] {
    // Sanitize arbitrary text (digests, NL queries) into a safe FTS5 expression:
    // quoted alphanumeric terms OR-joined. Avoids MATCH syntax errors from ':' '.'
    // '→' etc., and matches a region whose role/label contains ANY query term.
    const terms = query.match(/[A-Za-z0-9]+/g);
    if (!terms || terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"`).join(" OR ");
    return (this.stmts.ftsMatch.all(match, limit) as { region_id: string }[]).map(
      (r) => r.region_id,
    );
  }

  // --- reconciliation (SQLite is truth) --------------------------------------

  async reconcile(): Promise<ReconcileResult> {
    let orphansPruned = 0;
    const missing: MissingVector[] = [];

    const allRegionIds = new Set(
      (this.stmts.selectAllRegionIds.all() as { id: string }[]).map((r) => r.id),
    );
    const allFrameIds = new Set(
      (this.stmts.selectAllFrameIds.all() as { id: string }[]).map((r) => r.id),
    );

    for (const space of this.spaces.values()) {
      const kind = kindForView(space.view);
      const lanceIds = new Set(await this.lance.allIds(space.namespace));

      // Expected SQLite ids that SHOULD have a vector in this namespace.
      let expected: Set<string>;
      if (kind === "frame_patches") {
        // Late-interaction rows hold MANY vectors under a FRAME id. The
        // per-entity "one row, one vector" model does not apply: a patch set is
        // regenerated wholesale by FramePatchRepresenter, never row-by-row. So
        // nothing is ever "missing" here.
        //
        // Orphan pruning below still runs, and MUST compare against frame ids —
        // treating this as a segment space would find no matching segment row
        // and delete every patch row in the table.
        expected = new Set();
      } else if (kind === "region") {
        // Every region row is re-embeddable from its frame blob + bbox, whether
        // it lost its vector to a crash or was written by a proposal-only pass.
        expected = allRegionIds;
      } else if (kind === "frame") {
        // Only frames with a stored image (blob) can have a frame_image vector.
        // An imageless frame legitimately has none, so it is NOT "missing"; a
        // frame WITH a blob but no vector is genuinely re-embeddable from the blob.
        expected = new Set(
          (this.stmts.selectFrameIdsWithBlob.all() as { id: string }[]).map((r) => r.id),
        );
      } else {
        // segment view: expect a vector where the source text column is present.
        const stmt =
          space.view === "caption"
            ? this.stmts.selectSegmentIdsWithCaption
            : space.view === "digest"
              ? this.stmts.selectSegmentIdsWithDigest
              : space.view === "transcript"
                ? this.stmts.selectSegmentIdsWithTranscript
                : space.view === "app_caption"
                  ? this.stmts.selectSegmentIdsWithAppCaption
                  : null;
        expected = new Set(
          stmt ? (stmt.all() as { id: string }[]).map((r) => r.id) : [],
        );
      }

      // Orphans: Lance id with no matching SQLite entity row -> prune.
      // For segment kinds, entity existence = the segment row exists at all (a
      // segment may legitimately lack a caption vector but still be a real row).
      const entityExists =
        kind === "region"
          ? (id: string) => allRegionIds.has(id)
          : kind === "frame" || kind === "frame_patches"
            ? (id: string) => allFrameIds.has(id)
            : (id: string) => this.stmts.selectSegmentById.get(id) !== undefined;

      const orphanIds: string[] = [];
      for (const id of lanceIds) {
        if (!entityExists(id)) orphanIds.push(id);
      }
      if (orphanIds.length > 0) {
        await this.lance.deleteByIds(space.namespace, orphanIds);
        orphansPruned += orphanIds.length;
      }

      // Missing: expected SQLite id absent from Lance -> re-embed candidate.
      for (const id of expected) {
        if (lanceIds.has(id)) continue;
        missing.push(this.describeMissing(space, kind, id));
      }
    }

    return { orphansPruned, missing };
  }

  private describeMissing(
    space: VectorSpaceInsert,
    kind: ReturnType<typeof kindForView>,
    id: string,
  ): MissingVector {
    const base = {
      namespace: space.namespace,
      view: space.view,
      id,
    };
    if (kind === "region") {
      return { ...base, entity: "region", region: this.regionRow(id) };
    }
    if (kind === "frame") {
      return { ...base, entity: "frame", frame: this.frameRow(id) };
    }
    return { ...base, entity: "segment", segment: this.segmentRow(id) };
  }

  async reconcileAndReembed(reembed: Reembedder): Promise<ReconcileResult> {
    const result = await this.reconcile();
    if (result.missing.length === 0) return result;
    const vectors = await reembed(result.missing);
    const byId = new Map(result.missing.map((m) => [`${m.namespace} ${m.id}`, m]));
    await this.mutex.run(async () => {
      for (const { namespace, id, vector } of vectors) {
        const m = byId.get(`${namespace} ${id}`);
        if (!m) continue; // ignore vectors we didn't ask for
        await this.lance.add(namespace, [this.vecRowFor(m, vector)]);
      }
    });
    return result;
  }

  private vecRowFor(m: MissingVector, vector: Float32Array): VecRow {
    const v = Array.from(vector);
    if (m.entity === "region") {
      const r = m.region!;
      return {
        id: r.id,
        frame_id: r.frameId,
        segment_id: r.segmentId,
        session_id: r.sessionId,
        vector: v,
      };
    }
    if (m.entity === "frame") {
      const f = m.frame!;
      return { id: f.id, session_id: f.sessionId, segment_ids: f.segmentIds, vector: v };
    }
    const s = m.segment!;
    return { id: s.id, session_id: s.sessionId, vector: v };
  }

  // --- row hydration ---------------------------------------------------------

  private regionRow(id: string): RegionRow {
    return this.hydrateRegion(
      this.stmts.selectRegionById.get(id) as Record<string, unknown>,
    );
  }

  private hydrateRegion(r: Record<string, unknown>): RegionRow {
    return {
      id: r.id as string,
      frameId: r.frame_id as string,
      segmentId: r.segment_id as string,
      sessionId: r.session_id as string,
      x: r.x as number,
      y: r.y as number,
      w: r.w as number,
      h: r.h as number,
      source: r.source as string,
      role: (r.role as string | null) ?? null,
      label: (r.label as string | null) ?? null,
      priority: r.priority as number,
    };
  }

  private frameRow(id: string): FrameRow {
    return this.hydrateFrame(
      this.stmts.selectFrameById.get(id) as Record<string, unknown>,
    );
  }

  private hydrateFrame(r: Record<string, unknown>): FrameRow {
    const segIds = (
      this.stmts.selectSegmentIdsByFrame.all(r.id as string) as {
        segment_id: string;
      }[]
    ).map((x) => x.segment_id);
    // NOTE: these statements enable safeIntegers for the 64-bit phash, so every
    // INTEGER column arrives as BigInt — coerce the small ones back to number.
    return {
      id: r.id as string,
      sessionId: r.session_id as string,
      tMono: Number(r.t_mono),
      width: Number(r.width),
      height: Number(r.height),
      phash: i64ToU64(r.phash as bigint),
      blobId: (r.blob_id as string | null) ?? null,
      frameOffset: Number(r.frame_offset),
      segmentIds: segIds,
    };
  }

  private segmentRow(id: string): SegmentRow {
    return this.hydrateSegment(
      this.stmts.selectSegmentById.get(id) as Record<string, unknown>,
    );
  }

  private hydrateSegment(r: Record<string, unknown>): SegmentRow {
    return {
      id: r.id as string,
      sessionId: r.session_id as string,
      granularity: r.granularity as string,
      tMonoStart: r.t_mono_start as number,
      tMonoEnd: r.t_mono_end as number,
      boundaryReason: (r.boundary_reason as string | null) ?? null,
      transcript: (r.transcript as string | null) ?? null,
      digest: (r.digest as string | null) ?? null,
      caption: (r.caption as string | null) ?? null,
    };
  }

  // --- experience trace graphs (src/trace/) --------------------------------
  //
  // SQLite only. Visual corroboration reuses the region/frame vectors already in
  // Lance by id, so a graph registers no vector space and these writes have no
  // SQLite->Lance ordering hazard — the rule the rest of this class exists to
  // enforce simply does not apply here.

  async putGraph(graph: TraceGraph): Promise<void> {
    await this.mutex.run(async () => {
      const tx = this.db.transaction((g: TraceGraph) => {
        this.stmts.upsertTraceGraph.run({
          id: g.id,
          entryNode: g.entry,
          createdAt: Date.now(),
        });
        // Delete-then-insert, so the write is idempotent AND a graph that lost a
        // node actually loses it. A pure upsert would leave orphans behind.
        this.stmts.deleteTraceNodes.run(g.id);
        this.stmts.deleteTraceEdges.run(g.id);
        this.stmts.deleteTraceSlots.run(g.id);
        // The source tables have no FK to trace_node/trace_edge to cascade
        // from — node ids are graph-scoped, so the parent key is composite —
        // and re-inserting without clearing would double every source on the
        // second write of the same graph.
        this.stmts.deleteTraceNodeSources.run(g.id);
        this.stmts.deleteTraceEdgeSources.run(g.id);

        // A source whose recording is gone cannot be written: session_id is a
        // foreign key, and an FK violation aborts the WHOLE transaction
        // regardless of any ON CONFLICT clause — so one dangling source would
        // cost the entire graph. Dropping it here is not silent loss: it
        // applies exactly the rule ON DELETE CASCADE would have applied a
        // moment later. The window is real — a rebuild lifts every session in
        // a loop, and a delete can land inside it.
        const live = new Set(
          (this.stmts.selectSessionIds.all() as { id: string }[]).map((r) => r.id),
        );

        g.nodes.forEach((n, ord) => {
          this.stmts.insertTraceNode.run({
            id: n.id,
            graphId: g.id,
            predicates: JSON.stringify(n.predicates),
            visual: n.visual === undefined ? null : JSON.stringify(n.visual),
            intervene: n.intervene,
            observations: n.observations,
            ord,
          });
          (n.sources ?? [])
            .filter((s) => live.has(s.sessionId))
            .forEach((s, sourceOrd) => {
              this.stmts.insertTraceNodeSource.run({
                graphId: g.id,
                nodeId: n.id,
                sessionId: s.sessionId,
                tMono: s.tMono,
                ord: sourceOrd,
              });
            });
        });
        g.edges.forEach((e, ord) => {
          this.stmts.insertTraceEdge.run({
            id: e.id,
            graphId: g.id,
            fromNode: e.from,
            toNode: e.to,
            actions: JSON.stringify(e.actions),
            guard: e.guard === undefined ? null : JSON.stringify(e.guard),
            provenance: e.provenance,
            observations: e.observations,
            attempts: e.outcomes.attempts,
            successes: e.outcomes.successes,
            liftWarnings: e.liftWarnings === undefined ? null : JSON.stringify(e.liftWarnings),
            ord,
          });
          (e.sources ?? [])
            .filter((s) => live.has(s.sessionId))
            .forEach((s, sourceOrd) => {
              this.stmts.insertTraceEdgeSource.run({
                graphId: g.id,
                edgeId: e.id,
                sessionId: s.sessionId,
                tMonoStart: s.tMonoStart,
                tMonoEnd: s.tMonoEnd,
                ord: sourceOrd,
              });
            });
        });
        g.slots.forEach((s, ord) => {
          this.stmts.insertTraceSlot.run({
            graphId: g.id,
            name: s.name,
            samples: JSON.stringify(s.samples),
            ord,
          });
        });
      });
      tx(graph);
    });
  }

  getGraph(id: string): TraceGraph | undefined {
    const head = this.stmts.selectTraceGraph.get(id) as
      | { id: string; entry_node: string }
      | undefined;
    if (head === undefined) return undefined;

    // Grouped once, then looked up per node/edge. A graph rendered whole is the
    // only consumer, so two queries beat 2N.
    const nodeSources = groupBy(
      this.stmts.selectTraceNodeSources.all(id) as TraceNodeSourceRow[],
      (r) => r.node_id,
      (r) => ({ sessionId: r.session_id, tMono: r.t_mono }),
    );
    const edgeSources = groupBy(
      this.stmts.selectTraceEdgeSources.all(id) as TraceEdgeSourceRow[],
      (r) => r.edge_id,
      (r) => ({
        sessionId: r.session_id,
        tMonoStart: r.t_mono_start,
        tMonoEnd: r.t_mono_end,
      }),
    );

    const nodes = (this.stmts.selectTraceNodes.all(id) as TraceNodeRow[]).map((r) => ({
      id: r.id,
      predicates: JSON.parse(r.predicates) as TraceGraph["nodes"][number]["predicates"],
      // Absent stays absent: `exactOptionalPropertyTypes` means a materialized
      // `visual: undefined` is a different shape from no key at all.
      ...(r.visual !== null
        ? { visual: JSON.parse(r.visual) as NonNullable<TraceGraph["nodes"][number]["visual"]> }
        : {}),
      intervene: r.intervene as TraceGraph["nodes"][number]["intervene"],
      observations: r.observations,
      // No rows means no provenance — a graph built before the source tables
      // existed, or one whose recordings have all been deleted. Absent rather
      // than empty, so it stays distinguishable from a node that genuinely
      // observed nothing (which cannot happen, but the shapes should not lie).
      ...(nodeSources.has(r.id) ? { sources: nodeSources.get(r.id)! } : {}),
    }));

    const edges = (this.stmts.selectTraceEdges.all(id) as TraceEdgeRow[]).map((r) => ({
      id: r.id,
      from: r.from_node,
      to: r.to_node,
      actions: JSON.parse(r.actions) as TraceGraph["edges"][number]["actions"],
      ...(r.guard !== null
        ? { guard: JSON.parse(r.guard) as NonNullable<TraceGraph["edges"][number]["guard"]> }
        : {}),
      provenance: r.provenance as TraceGraph["edges"][number]["provenance"],
      observations: r.observations,
      outcomes: { attempts: r.attempts, successes: r.successes },
      ...(r.lift_warnings !== null ? { liftWarnings: JSON.parse(r.lift_warnings) as string[] } : {}),
      ...(edgeSources.has(r.id) ? { sources: edgeSources.get(r.id)! } : {}),
    }));

    const slots = (this.stmts.selectTraceSlots.all(id) as TraceSlotRow[]).map((r) => ({
      name: r.name,
      samples: JSON.parse(r.samples) as string[],
      secret: false as const,
    }));

    return { id: head.id, entry: head.entry_node, nodes, edges, slots };
  }

  listGraphs(): TraceGraphSummary[] {
    return (this.stmts.selectTraceGraphs.all() as TraceGraphSummaryRow[]).map((r) => ({
      id: r.id,
      nodes: r.nodes,
      edges: r.edges,
      createdAt: r.created_at,
    }));
  }

  async deleteGraph(id: string): Promise<void> {
    await this.mutex.run(async () => {
      // ON DELETE CASCADE clears node/edge/slot rows (PRAGMA foreign_keys = ON).
      this.stmts.deleteTraceGraph.run(id);
    });
  }

  close(): void {
    this.db.close();
    void this.lance.close();
  }
}

interface TraceNodeRow {
  id: string;
  predicates: string;
  visual: string | null;
  intervene: string;
  observations: number;
}

interface TraceEdgeRow {
  id: string;
  from_node: string;
  to_node: string;
  actions: string;
  guard: string | null;
  provenance: string;
  observations: number;
  attempts: number;
  successes: number;
  lift_warnings: string | null;
}

interface TraceSlotRow {
  name: string;
  samples: string;
}

interface TraceNodeSourceRow {
  node_id: string;
  session_id: string;
  t_mono: number;
}

interface TraceEdgeSourceRow {
  edge_id: string;
  session_id: string;
  t_mono_start: number;
  t_mono_end: number;
}

/** Rows already ordered by (key, ord), collected into per-key arrays. */
function groupBy<Row, Value>(
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  valueOf: (row: Row) => Value,
): Map<string, Value[]> {
  const out = new Map<string, Value[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = out.get(key);
    if (list === undefined) out.set(key, [valueOf(row)]);
    else list.push(valueOf(row));
  }
  return out;
}

interface TraceGraphSummaryRow {
  id: string;
  nodes: number;
  edges: number;
  created_at: number;
}
