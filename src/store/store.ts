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
  SegmentRow,
  SegmentVectorInsert,
  SessionInsert,
  SessionRow,
  Store,
  VectorSpaceInsert,
} from "./types.js";

function jsonOrNull(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

function parseJson(s: string | null): unknown {
  return s === null ? null : JSON.parse(s);
}

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
      selectRegionById: db.prepare("SELECT * FROM region WHERE id = ?"),
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
    const r = this.stmts.selectFrameAx.get(frameId) as { elements: string } | undefined;
    if (!r) return [];
    const parsed = JSON.parse(r.elements) as unknown;
    return Array.isArray(parsed) ? (parsed as UIElement[]) : [];
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
      for (const space of this.spaces.values()) {
        const kind = kindForView(space.view);
        const ids =
          kind === "segment" ? segIds : kind === "frame" ? frameIds : regionIds;
        await this.lance.deleteByIds(space.namespace, ids);
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
      if (kind === "region") {
        expected = allRegionIds; // regions always carry a vector at write time
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
          : kind === "frame"
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

  close(): void {
    this.db.close();
    void this.lance.close();
  }
}
