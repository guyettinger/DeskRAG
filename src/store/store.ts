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
import {
  RETIRED_MODELS,
  RETIRED_VIEWS,
  VIEWS,
  type UIElement,
} from "../embed/types.js";
import type {
  BlobInsert,
  BlobRow,
  EventInsert,
  EventRow,
  FrameInsert,
  FramePatchInsert,
  FrameRow,
  FrameScope,
  MissingVector,
  ReconcileResult,
  Reembedder,
  RegionInsert,
  RegionRow,
  RegionScope,
  SearchHit,
  SegmentInsert,
  SegmentPatch,
  SegmentSummaryInsert,
  SegmentSummaryRow,
  SegmentTreeInsert,
  SummarySource,
  TranscriptClipInsert,
  TranscriptClipRow,
  SegmentRow,
  AxSnapshotReason,
  AxSnapshotRow,
  SegmentVectorInsert,
  SessionInsert,
  TraceGraph,
  TraceGraphSummary,
  SessionClockRow,
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
    const store = new DualStore(db, lance);
    // A store carried over from an older build can hold spaces nothing can
    // write or query any more. Dropping them here rather than on demand is what
    // keeps every later walk over `this.spaces` — reconcile, deleteSession,
    // purgeDerived — from having to know about them. The caller logs it;
    // `store/` prints nothing.
    store.retiredSpacesPurged = await store.purgeRetiredSpaces();
    return store;
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
      updateAxSnapshotFrame: db.prepare("UPDATE ax_snapshot SET frame_id = ? WHERE id = ?"),
      insertSessionClock: db.prepare(
        `INSERT INTO session_clock(session_id, device_epoch_ms, mono_epoch_ms)
         VALUES (@sessionId, @deviceEpochMs, @monoEpochMs)
         ON CONFLICT(session_id) DO UPDATE SET
           device_epoch_ms = excluded.device_epoch_ms,
           mono_epoch_ms   = excluded.mono_epoch_ms`,
      ),
      selectSessionClock: db.prepare("SELECT * FROM session_clock WHERE session_id = ?"),
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
      insertSegmentTreeEdge: db.prepare(
        `INSERT INTO segment_tree(session_id, parent_id, child_id) VALUES (?, ?, ?)
         ON CONFLICT(parent_id, child_id) DO NOTHING`,
      ),
      selectSegmentChildren: db.prepare(
        "SELECT child_id FROM segment_tree WHERE parent_id = ?",
      ),
      selectSegmentParent: db.prepare(
        "SELECT parent_id FROM segment_tree WHERE child_id = ?",
      ),
      // One recursive walk in SQL rather than N round-trips from the caller.
      // The NOT EXISTS is what makes it return LEAVES specifically — and a node
      // with no children satisfies it immediately, so a leaf resolves to itself.
      selectDescendantLeaves: db.prepare(
        `WITH RECURSIVE d(id) AS (
           SELECT ?
           UNION
           SELECT st.child_id FROM segment_tree st JOIN d ON st.parent_id = d.id
         )
         SELECT d.id AS id FROM d
         WHERE NOT EXISTS (SELECT 1 FROM segment_tree c WHERE c.parent_id = d.id)`,
      ),
      upsertSegmentSummary: db.prepare(
        `INSERT INTO segment_summary(segment_id, text, source) VALUES (?, ?, ?)
         ON CONFLICT(segment_id) DO UPDATE SET text = excluded.text, source = excluded.source`,
      ),
      selectSegmentSummary: db.prepare(
        "SELECT segment_id, text, source FROM segment_summary WHERE segment_id = ?",
      ),
      selectSegmentSummariesBySession: db.prepare(
        `SELECT ss.segment_id AS segment_id, ss.text AS text, ss.source AS source
           FROM segment_summary ss
           JOIN segment s ON s.id = ss.segment_id
          WHERE s.session_id = ?`,
      ),
      deleteSegmentRow: db.prepare("DELETE FROM segment WHERE id = ?"),
      insertTranscriptClip: db.prepare(
        `INSERT INTO transcript_clip(id, session_id, t_mono_start, t_mono_end, text)
         VALUES (@id, @sessionId, @tMonoStart, @tMonoEnd, @text)`,
      ),
      selectTranscriptClipsBySession: db.prepare(
        `SELECT id, session_id, t_mono_start, t_mono_end, text
           FROM transcript_clip WHERE session_id = ? ORDER BY t_mono_start`,
      ),
      deleteRegionFts: db.prepare(`DELETE FROM region_fts WHERE region_id = ?`),
      insertSegmentFts: db.prepare(
        `INSERT INTO segment_fts(segment_id, text) VALUES (?, ?)`,
      ),
      deleteSegmentFts: db.prepare(`DELETE FROM segment_fts WHERE segment_id = ?`),
      ftsSegmentMatch: db.prepare(
        "SELECT segment_id FROM segment_fts WHERE segment_fts MATCH ? ORDER BY rank LIMIT ?",
      ),
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
      // The two halves of a per-session purge. Deleting the segments cascades
      // segment_app_caption, segment_tree, segment_summary, frame_segment AND
      // region, which all declare `REFERENCES segment(id) ON DELETE CASCADE`.
      // transcript_clip does NOT — its foreign key is to session — so it has to
      // be named separately or a re-index would double every utterance.
      deleteSegmentsBySession: db.prepare("DELETE FROM segment WHERE session_id = ?"),
      deleteTranscriptClipsBySession: db.prepare(
        "DELETE FROM transcript_clip WHERE session_id = ?",
      ),
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
        "SELECT region_id FROM region_fts WHERE region_fts MATCH ? ORDER BY rank LIMIT ?",
      ),
      insertVectorSpace: db.prepare(
        `INSERT OR IGNORE INTO vector_space(namespace, view, provider_id, model, dimensions, shared_text_space, created_at)
         VALUES (@namespace, @view, @providerId, @model, @dimensions, @sharedTextSpace, @createdAt)`,
      ),
      selectAllSpaces: db.prepare("SELECT * FROM vector_space"),
      deleteVectorSpace: db.prepare("DELETE FROM vector_space WHERE namespace = ?"),
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

  /**
   * Namespaces dropped by {@link purgeRetiredSpaces} during `open()`. Empty on
   * every store that was not carried over from a build with the removed
   * providers. Reported rather than logged — see `open()`.
   */
  retiredSpacesPurged: string[] = [];

  listVectorSpaces(): VectorSpaceInsert[] {
    return [...this.spaces.values()];
  }

  /**
   * Drop a namespace entirely: its Lance table, then its `vector_space` row.
   *
   * Lance FIRST, which is the reverse of every other write here and is correct
   * for a delete for the same reason the delete order is: losing the row while
   * the table survives leaves an unreachable table nothing can ever name, where
   * losing the table while the row survives is the ordinary "registered but not
   * materialized" state the store already tolerates.
   *
   * NOT UNDOABLE. Callers are `purgeRetiredSpaces` and the migration path.
   */
  async dropVectorSpace(namespace: string): Promise<void> {
    await this.mutex.run(async () => {
      await this.lance.dropSpace(namespace);
      this.stmts.deleteVectorSpace.run(namespace);
      this.spaces.delete(namespace);
    });
  }

  /**
   * Drop every registered space that no build can write to any more, and report
   * what went. Run ONCE on open.
   *
   * Two families, and the second is why a view check alone is not enough:
   *   - a RETIRED view (`frame_image`, `region_image`) — the single-vector image
   *     lane, which no longer exists in `VIEWS`;
   *   - a live view under a RETIRED MODEL (`colsmol-256m`), whose view is
   *     `frame_patches` and therefore passes any view check while its vectors
   *     are in a space nothing can query.
   *
   * Left behind, deliberately: a namespace whose model is simply not configured
   * right now. That is a user choice and its vectors are still comparable the
   * moment the model is selected again — unlike these, which nothing can produce.
   */
  async purgeRetiredSpaces(): Promise<string[]> {
    const dead = [...this.spaces.values()].filter(
      (s) =>
        !(VIEWS as readonly string[]).includes(s.view) ||
        RETIRED_VIEWS.includes(s.view) ||
        RETIRED_MODELS.includes(s.model),
    );
    for (const s of dead) await this.dropVectorSpace(s.namespace);
    return dead.map((s) => s.namespace);
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
      // No Lance write: a frame's only vectors are its late-interaction patch
      // set, written separately by putFramePatches.
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
      // No Lance write: a region carries geometry and an AX role/label, which is
      // what `region_fts`, `Anchor.visual` and the digest read. Region CROPS were
      // the single-vector image lane and went with it.
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

  async putSegmentTree(rows: SegmentTreeInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      const tx = this.db.transaction((rs: SegmentTreeInsert[]) => {
        for (const r of rs) {
          this.stmts.insertSegmentTreeEdge.run(r.sessionId, r.parentId, r.childId);
        }
      });
      tx(rows);
    });
  }

  getSegmentChildren(parentId: string): string[] {
    return (this.stmts.selectSegmentChildren.all(parentId) as { child_id: string }[]).map(
      (r) => r.child_id,
    );
  }

  getSegmentParent(childId: string): string | undefined {
    const row = this.stmts.selectSegmentParent.get(childId) as
      | { parent_id: string }
      | undefined;
    return row?.parent_id;
  }

  getDescendantLeaves(segmentId: string): string[] {
    return (this.stmts.selectDescendantLeaves.all(segmentId) as { id: string }[]).map(
      (r) => r.id,
    );
  }

  async putSegmentSummaries(rows: SegmentSummaryInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
      const tx = this.db.transaction((rs: SegmentSummaryInsert[]) => {
        for (const r of rs) {
          this.stmts.upsertSegmentSummary.run(r.segmentId, r.text, r.source);
        }
      });
      tx(rows);
    });
  }

  getSegmentSummary(segmentId: string): SegmentSummaryRow | undefined {
    const row = this.stmts.selectSegmentSummary.get(segmentId) as
      | { segment_id: string; text: string; source: string }
      | undefined;
    if (row === undefined) return undefined;
    return { segmentId: row.segment_id, text: row.text, source: row.source as SummarySource };
  }

  getSegmentSummariesBySession(sessionId: string): SegmentSummaryRow[] {
    const rows = this.stmts.selectSegmentSummariesBySession.all(sessionId) as {
      segment_id: string;
      text: string;
      source: string;
    }[];
    return rows.map((r) => ({
      segmentId: r.segment_id,
      text: r.text,
      source: r.source as SummarySource,
    }));
  }

  async deleteSegments(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.mutex.run(async () => {
      // Lance first, then SQLite — the delete order rule. The reverse leaves a
      // vector whose id has no row, which is the orphan case reconcile() cannot
      // attribute to anything.
      const list = [...ids];
      for (const space of this.spaces.values()) {
        if (kindForView(space.view) !== "segment") continue;
        await this.lance.deleteByIds(space.namespace, list);
      }
      // segment_tree and segment_summary cascade off segment(id); segment_fts
      // has no foreign key, so it is cleared explicitly or a deleted level keeps
      // answering searches.
      const tx = this.db.transaction(() => {
        for (const sid of list) {
          this.stmts.deleteSegmentFts.run(sid);
          this.stmts.deleteSegmentRow.run(sid);
        }
      });
      tx();
    });
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

  /**
   * Like {@link putSegmentVectors}, but REPLACES any existing vector for each id
   * in its namespace.
   *
   * `putSegmentVectors` is a bare `lance.add`, so re-running a represent stage
   * writes a SECOND vector under the same id in the same table. Neither copy is
   * an orphan — both have a live SQLite row — so `reconcile()` would never clean
   * it up, and the duplicate would sit in every ANN result forever. That made
   * re-indexing structurally unsafe, which is why this exists before any
   * re-index path does.
   *
   * Lance-only, like its sibling: the text these vectors came from was already
   * written to SQLite, so the write-order rule is untouched and a crash between
   * the delete and the add leaves a re-embeddable gap `reconcile()` recovers.
   */
  async replaceSegmentVectors(rows: SegmentVectorInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutex.run(async () => {
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
      for (const [ns, list] of byNs) {
        await this.lance.deleteByIds(ns, list.map((v) => v.id));
        await this.lance.add(ns, list);
      }
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

  /**
   * The device-timebase calibration for a session.
   *
   * ABSENCE is meaningful: a session with no row was recorded before the clock
   * bridge existed, so its frames and audio are on the old per-producer
   * conventions and are NOT comparable with a calibrated recording.
   */
  async putSessionClock(row: SessionClockRow): Promise<void> {
    await this.mutex.run(async () => {
      this.stmts.insertSessionClock.run({
        sessionId: row.sessionId,
        deviceEpochMs: row.deviceEpochMs,
        monoEpochMs: row.monoEpochMs,
      });
    });
  }

  getSessionClock(sessionId: string): SessionClockRow | undefined {
    const r = this.stmts.selectSessionClock.get(sessionId) as
      | { session_id: string; device_epoch_ms: number; mono_epoch_ms: number }
      | undefined;
    return r === undefined
      ? undefined
      : {
          sessionId: r.session_id,
          deviceEpochMs: r.device_epoch_ms,
          monoEpochMs: r.mono_epoch_ms,
        };
  }

  /**
   * Point a stored walk at the frame it describes.
   *
   * Capture cannot know that frame: a walk starts when a frame ARRIVES, and the
   * frame arrives a whole capture latency after the pixels it shows (measured
   * ~2.2s), so the triggering frame is the wrong one by construction. See
   * `associateFrameAx`, which is the only caller.
   */
  async setAxSnapshotFrame(snapshotId: string, frameId: string | null): Promise<void> {
    await this.mutex.run(async () => {
      this.stmts.updateAxSnapshotFrame.run(frameId, snapshotId);
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

  /**
   * The first half of the delete order rule, shared by both deletes below:
   * gather the session's ids from SQLite, then clear every vector keyed by one.
   *
   * Lance goes FIRST. A vector whose SQLite row is gone is an orphan, which
   * `reconcile()` can find and prune; a SQLite row whose vector is gone is
   * detectable and re-embeddable. Deleting SQLite first would leave vectors
   * nothing can ever identify.
   */
  private async clearVectorsForSession(sessionId: string): Promise<{
    segIds: string[];
    frameIds: string[];
    regionIds: string[];
  }> {
    const segIds = (
      this.stmts.selectSegmentIdsBySession.all(sessionId) as { id: string }[]
    ).map((r) => r.id);
    const frameIds = (
      this.stmts.selectFrameIdsBySession.all(sessionId) as { id: string }[]
    ).map((r) => r.id);
    const regionIds = (
      this.stmts.selectRegionIdsBySession.all(sessionId) as { id: string }[]
    ).map((r) => r.id);

    // By entity kind per namespace. Exhaustive on purpose: a ternary chain here
    // silently sent any new kind to regionIds, which for frame_patches meant its
    // rows were never deleted.
    const idsForKind = (kind: ReturnType<typeof kindForView>): string[] => {
      switch (kind) {
        case "segment":
          return segIds;
        case "frame_patches": // keyed by FRAME id, not segment
          return frameIds;
      }
    };
    for (const space of this.spaces.values()) {
      await this.lance.deleteByIds(
        space.namespace,
        idsForKind(kindForView(space.view)),
      );
    }
    return { segIds, frameIds, regionIds };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.mutex.run(async () => {
      const { segIds, regionIds } = await this.clearVectorsForSession(sessionId);

      // Then SQLite. CASCADE clears event/blob/segment/frame/region/frame_segment;
      // the standalone FTS tables have no foreign key, so clear them explicitly
      // or a deleted recording keeps answering searches.
      const tx = this.db.transaction(() => {
        for (const rid of regionIds) this.stmts.deleteRegionFts.run(rid);
        for (const sid of segIds) this.stmts.deleteSegmentFts.run(sid);
        this.stmts.deleteSession.run(sessionId);
      });
      tx();
    });
  }

  /**
   * Discard everything the indexing pipeline derived for one recording, keeping
   * every row capture wrote. This is what makes "re-index" mean re-index.
   *
   * The rebuild used to be a text-side SUBSET of the record path, hand-written a
   * second time — and it went stale: composing was added to one list and not the
   * other, so a rebuilt lexical index carried no summary at all. Re-running the
   * whole pipeline instead is only possible because everything below is a pure
   * function of the captured rows: segments come from events, regions from the
   * AX tree and events, captions and transcripts from blobs still on disk.
   *
   * It also has to be a purge rather than a second pass. `putRegions` inserts
   * with a fresh `ulid()` per region and adds to Lance without deleting, so a
   * re-run APPENDS a whole second set of regions and vectors — and those
   * duplicate vectors still have SQLite rows, so they are not orphans and
   * `reconcile()` can never prune them. The same shape as the
   * `putSegmentVectors` double-write (8 vectors for 4 segments).
   *
   * Deliberately NOT touched:
   * - `frame`, `event`, `blob`, `ax_snapshot`, `session_clock` — captured, and
   *   unrecoverable. See `CAPTURED_TABLES`.
   * - `ax_snapshot.frame_id` — derived, but `associateFrameAx` re-points every
   *   walk on each run rather than filling in blanks, so it corrects itself.
   * - the `trace_*` tables — derived, but LIBRARY-scoped. A graph accretes across
   *   recordings, so it is discarded and replayed whole by `rebuildGraph`, never
   *   per session. See `DERIVED_LIBRARY_TABLES`.
   */
  async purgeDerived(sessionId: string): Promise<void> {
    await this.mutex.run(async () => {
      const { segIds, regionIds } = await this.clearVectorsForSession(sessionId);

      const tx = this.db.transaction(() => {
        // Neither FTS table has a foreign key, so nothing cascades them.
        for (const rid of regionIds) this.stmts.deleteRegionFts.run(rid);
        for (const sid of segIds) this.stmts.deleteSegmentFts.run(sid);
        // Cascades segment_app_caption, segment_tree, segment_summary,
        // frame_segment and region.
        this.stmts.deleteSegmentsBySession.run(sessionId);
        // Keyed on session, not segment — no cascade reaches it.
        this.stmts.deleteTranscriptClipsBySession.run(sessionId);
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

  /**
   * Tier 3's text half. Best first (`ORDER BY rank` — FTS5's bm25), because the
   * caller scores a region by its POSITION here: an unordered list would make
   * "which part of this frame matches" arbitrary.
   *
   * `scope.frameIds` PRE-filters, exactly as LanceDB's `.where()` does for the
   * ANN half. Fetching a global top-N and intersecting afterwards is the bug
   * this replaces: with 1,200 regions across a library, the global best matches
   * are usually all outside the frames Tier 2 selected, so the scoped result
   * came back empty while matching regions sat inside the scope unseen.
   */
  ftsRegions(query: string, limit = 50, scope?: { frameIds: string[] }): string[] {
    // Sanitize arbitrary text (digests, NL queries) into a safe FTS5 expression:
    // quoted alphanumeric terms OR-joined. Avoids MATCH syntax errors from ':' '.'
    // '→' etc., and matches a region whose role/label contains ANY query term.
    const terms = query.match(/[A-Za-z0-9]+/g);
    if (!terms || terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"`).join(" OR ");
    if (scope === undefined) {
      return (this.stmts.ftsMatch.all(match, limit) as { region_id: string }[]).map(
        (r) => r.region_id,
      );
    }
    if (scope.frameIds.length === 0) return [];
    // Prepared per call because the IN arity varies with the scope size. The
    // join is against `region`, not the FTS table, since region_id is UNINDEXED.
    const holes = scope.frameIds.map(() => "?").join(",");
    const stmt = this.db.prepare(
      `SELECT f.region_id FROM region_fts f
         JOIN region r ON r.id = f.region_id
        WHERE region_fts MATCH ? AND r.frame_id IN (${holes})
        ORDER BY rank LIMIT ?`,
    );
    return (
      stmt.all(match, ...scope.frameIds, limit) as { region_id: string }[]
    ).map((r) => r.region_id);
  }

  /**
   * Replace one segment's lexical index entry. Delete-then-insert, so it is
   * idempotent and a re-index cannot accumulate duplicate rows — the hazard
   * `putSegmentVectors` had. An empty text writes NO row: a segment with nothing
   * to say must not be reachable by every query that happens to match nothing.
   */
  indexSegmentText(segmentId: string, text: string): void {
    const tx = this.db.transaction(() => {
      this.stmts.deleteSegmentFts.run(segmentId);
      const trimmed = text.trim();
      if (trimmed.length > 0) this.stmts.insertSegmentFts.run(segmentId, trimmed);
    });
    tx();
  }

  /**
   * Tier 1's lexical lane: segments whose indexed text matches ANY query term,
   * BEST FIRST (`ORDER BY rank` — FTS5's bm25). The order is the whole point:
   * RRF fuses by position, so an unordered list would contribute noise.
   *
   * Shares `ftsRegions`'s sanitizer, and for the same reason — arbitrary text
   * (a natural-language query, a pasted URL) contains ':' '.' '→' and would
   * otherwise raise an FTS5 MATCH syntax error rather than simply not matching.
   */
  ftsSegments(query: string, limit = 50): string[] {
    const terms = query.match(/[A-Za-z0-9]+/g);
    if (!terms || terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"`).join(" OR ");
    return (this.stmts.ftsSegmentMatch.all(match, limit) as { segment_id: string }[]).map(
      (r) => r.segment_id,
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
        kind === "frame_patches"
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
        missing.push(this.describeMissing(space, id));
      }
    }

    return { orphansPruned, missing };
  }

  private describeMissing(space: VectorSpaceInsert, id: string): MissingVector {
    return {
      namespace: space.namespace,
      view: space.view,
      id,
      entity: "segment",
      segment: this.segmentRow(id),
    };
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
    const s = m.segment!;
    return { id: s.id, session_id: s.sessionId, vector: Array.from(vector) };
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
