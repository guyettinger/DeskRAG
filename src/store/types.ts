/**
 * The Store interface — the ONLY place both SQLite and LanceDB are known.
 *
 * Callers (capture, retrieve) never see both engines. This interface enforces the
 * dual-store consistency rules:
 *   1. WRITE ORDER  — SQLite transaction commits first, then Lance add.
 *   2. SHARED IDS   — the SQLite primary key IS the Lance row key, verbatim.
 *   3. DELETE ORDER — gather ids from SQLite, delete Lance by id set, then SQLite.
 *   4. RECONCILE    — one direction: SQLite is truth. Orphans pruned; missing
 *                     vectors returned for re-embedding from retained content.
 */

import type { UIElement, View } from "../embed/types.js";
// The dependency runs ONE way: store/ knows the Graph type, trace/ never imports
// store/. `trace/` stays a pure leaf; persistence lives here because `trace/`
// owns no database.
import type { Graph as TraceGraph } from "../trace/types.js";

export type { TraceGraph };

export type AxSnapshotReason = "keyframe" | "focus_change" | "bookmark" | "dwell_resume";

/**
 * One AX tree snapshot. `frameId` is null for boundary-triggered captures, which
 * have no keyframe to attach to. `walkMs` makes staleness measurable rather than
 * assumed.
 */
export interface AxSnapshotRow {
  id: string;
  sessionId: string;
  tMono: number;
  frameId: string | null;
  reason: AxSnapshotReason;
  walkMs: number;
  elements: UIElement[];
}

export interface TraceGraphSummary {
  id: string;
  nodes: number;
  edges: number;
  createdAt: number;
}

// --- relational insert shapes (mirror the SQLite entities) --------------------

export interface SessionInsert {
  id: string;
  /** Wall-clock ms, for human "last Tuesday" display ONLY. Never used in joins. */
  startedAt: number;
  /** performance.now() offset that defines t_mono=0 for this session. */
  epochMono: number;
  endedAt?: number;
  deviceId?: string;
  meta?: unknown;
}

export interface EventInsert {
  id: string;
  sessionId: string;
  /** Monotonic time within the session. All correlation is on t_mono. */
  tMono: number;
  kind: string;
  x?: number;
  y?: number;
  data?: unknown;
}

export type Media = "screen" | "desktop_audio" | "mic" | "input" | "keyframe";

export interface BlobInsert {
  id: string;
  sessionId: string;
  media: Media;
  path: string;
  byteOffset: number;
  byteLength: number;
  tMonoStart: number;
  tMonoEnd: number;
  codec?: string;
}

export interface SegmentInsert {
  id: string;
  sessionId: string;
  /** e.g. "action" (~10s) or "task" (~3min); overlapping granularities. */
  granularity: string;
  tMonoStart: number;
  tMonoEnd: number;
  boundaryReason?: string;
  transcript?: string;
  digest?: string;
  caption?: string;
  meta?: unknown;
  /** Optional vectors to co-write (SQLite-first, then each namespace's table). */
  vectors?: VectorInsert[];
}

export interface FrameInsert {
  id: string;
  sessionId: string;
  tMono: number;
  width: number;
  height: number;
  /** 64-bit perceptual hash stored as a SQLite INTEGER. */
  phash: bigint;
  /** Source blob (nullable: a frame may outlive/predate its blob row). */
  blobId?: string;
  /** Frame index into the source blob (not a byte offset). */
  frameOffset: number;
  /** Denormalized onto the Lance frame-vector row for Tier-2 scoping. Set lazily
   *  at/after segmentation; may be empty at capture time. */
  segmentIds: string[];
  /** Optional whole-frame image vector to co-write. */
  vector?: VectorInsert;
}

export interface RegionInsert {
  id: string;
  frameId: string;
  segmentId: string;
  sessionId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  source: string; // "ax" | "hotspot" | "grid"
  role?: string;
  label?: string;
  priority: number;
  /** The region image vector, co-written after the SQLite commit. */
  vector: VectorInsert;
}

/** A vector destined for one namespaced Lance table. */
export interface VectorInsert {
  namespace: string;
  vector: Float32Array;
}

/** Patch the text columns of an already-persisted segment (represent/ fills these). */
export interface SegmentPatch {
  digest?: string;
  caption?: string;
  transcript?: string;
  meta?: unknown;
}

/** A vector for an EXISTING segment (row already committed); Lance-only add. */
export interface SegmentVectorInsert {
  segmentId: string;
  sessionId: string;
  namespace: string;
  vector: Float32Array;
}

/** A whole-frame image vector for an EXISTING frame; Lance-only add, with the
 *  denormalized segment_ids baked in for Tier-2 scoping. */
export interface FrameVectorInsert {
  frameId: string;
  sessionId: string;
  segmentIds: string[];
  namespace: string;
  vector: Float32Array;
}

// --- registry -----------------------------------------------------------------

/** A frame's late-interaction patch set. Many vectors, one row. */
export interface FramePatchInsert {
  frameId: string;
  sessionId: string;
  segmentIds: string[];
  namespace: string;
  patches: Float32Array[];
}

export interface VectorSpaceInsert {
  namespace: string;
  view: View;
  providerId: string;
  model: string;
  dimensions: number;
  sharedTextSpace: boolean;
}

// --- search shapes ------------------------------------------------------------

export interface SearchHit {
  id: string;
  /** Cosine/L2 distance from Lance (lower = closer). */
  distance: number;
}

export interface FrameScope {
  /** Restrict to frames belonging to any of these segments (Tier-2 scoping). */
  segmentIds?: string[];
  /** Restrict to these frame ids (∩ pHash Tier-0 survivors). */
  frameIds?: string[];
}

export interface RegionScope {
  /** Restrict to regions on any of these frames (Tier-3 scoping). */
  frameIds: string[];
}

// --- reconciliation -----------------------------------------------------------

/** A SQLite row that has no vector in its namespace's Lance table. */
export interface MissingVector {
  namespace: string;
  view: View;
  entity: "segment" | "frame" | "region";
  id: string;
  /** Retained relational content for re-embedding, by entity. */
  region?: RegionRow;
  frame?: FrameRow;
  segment?: SegmentRow;
}

export interface ReconcileResult {
  /** Lance rows whose id has no matching SQLite row — pruned. */
  orphansPruned: number;
  /** SQLite rows with no vector — for the injected re-embed callback. */
  missing: MissingVector[];
}

/** Re-embed callback: given missing rows, return the vectors to insert. */
export type Reembedder = (
  missing: MissingVector[],
) => Promise<Array<{ namespace: string; id: string; vector: Float32Array }>>;

// --- retained relational rows (subset, what reconciliation needs) -------------

export interface RegionRow {
  id: string;
  frameId: string;
  segmentId: string;
  sessionId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  source: string;
  role: string | null;
  label: string | null;
  priority: number;
}

export interface FrameRow {
  id: string;
  sessionId: string;
  tMono: number;
  width: number;
  height: number;
  phash: bigint;
  blobId: string | null;
  frameOffset: number;
  segmentIds: string[];
}

export interface SegmentRow {
  id: string;
  sessionId: string;
  granularity: string;
  tMonoStart: number;
  tMonoEnd: number;
  boundaryReason: string | null;
  transcript: string | null;
  digest: string | null;
  caption: string | null;
}

export interface SessionRow {
  id: string;
  startedAt: number;
  epochMono: number;
  endedAt: number | null;
  deviceId: string | null;
  meta: unknown;
}

/** A session plus the aggregate counts the Library UI lists. */
export interface SessionSummaryRow extends SessionRow {
  frameCount: number;
  segmentCount: number;
  eventCount: number;
  /** Total bytes across every blob for the session. */
  byteLength: number;
  /** The continuous `screen` video blob, when the session recorded one. */
  videoBlobId: string | null;
}

export interface BlobRow {
  id: string;
  sessionId: string;
  media: string;
  path: string;
  byteOffset: number;
  byteLength: number;
  tMonoStart: number;
  tMonoEnd: number;
  codec: string | null;
}

export interface EventRow {
  id: string;
  sessionId: string;
  tMono: number;
  kind: string;
  x: number | null;
  y: number | null;
  data: unknown;
}

// --- the interface ------------------------------------------------------------

export interface Store {
  // registry (SQLite row first, then create the Lance table)

  /** Declare a `view:provider:model:dims` namespace and create its Lance table. */
  registerVectorSpace(space: VectorSpaceInsert): Promise<void>;
  /**
   * Every registered namespace. A `ViewSearcher` may only be handed to a
   * `Retriever` if its namespace appears here — `searchSegments` throws otherwise,
   * and caption/transcript spaces don't exist until something has been indexed
   * with those providers.
   */
  listVectorSpaces(): VectorSpaceInsert[];

  // relational + vector writes (each: SQLite tx commit, THEN Lance add)

  /** Open a session row. Relational only — a session has no vector. */
  putSession(row: SessionInsert): Promise<void>;
  /** Append to the event firehose. Batched, SQLite only. */
  putEvents(rows: EventInsert[]): Promise<void>;
  /** Record where a blob's bytes live. SQLite only — the files are not ours. */
  putBlobs(rows: BlobInsert[]): Promise<void>;
  /** Insert segments. Relational at this point; represent/ fills the views later. */
  putSegments(rows: SegmentInsert[]): Promise<void>;
  /** Insert keyframe rows (pHash + blob reference), before any frame vector exists. */
  putFrames(rows: FrameInsert[]): Promise<void>;
  /**
   * Insert regions with their vectors — the template every vector-write follows:
   * the SQLite transaction commits first, then the Lance add, so a crash between
   * the two leaves a re-embeddable row rather than an orphan vector.
   */
  putRegions(rows: RegionInsert[]): Promise<void>;

  // enrich existing segments (represent/): text first (SQLite), then vectors (Lance)

  /** Attach represent/ output (digest, caption, transcript text) to a segment. */
  updateSegment(id: string, patch: SegmentPatch): Promise<void>;
  /** Add segment vectors, after their source text is already committed to SQLite. */
  putSegmentVectors(rows: SegmentVectorInsert[]): Promise<void>;

  // enrich existing frames (Tier-2 represent/): association first (SQLite frame_segment),
  // then the frame_image vector (Lance) with segment_ids denormalized.

  /**
   * Associate a frame with the segments covering it. Segments are detected after
   * capture, so this is set lazily at represent time — it must land before the
   * frame vector, which denormalizes these ids for scoped ANN.
   */
  associateFrameSegments(frameId: string, segmentIds: string[]): Promise<void>;
  /** Add whole-frame image vectors, carrying the denormalized `segment_ids` scope. */
  putFrameVectors(rows: FrameVectorInsert[]): Promise<void>;
  /** Late-interaction patch sets (frame_patches view). Replaces any existing row. */
  putFramePatches(rows: FramePatchInsert[]): Promise<void>;

  // accessibility-tree snapshot for a keyframe (captured live; read at represent time)

  /** Store the AX snapshot taken with a keyframe. Captured live — the UI moves on. */
  putFrameAx(frameId: string, elements: UIElement[]): Promise<void>;
  /**
   * Persist one AX snapshot, keyframe- or boundary-triggered. An empty
   * `elements` array is still written — the distinction between "captured
   * nothing" and "never captured" is what `reason` exists to record.
   */
  putAxSnapshot(row: AxSnapshotRow): Promise<void>;
  /**
   * The snapshot nearest at-or-before `tMono`, or undefined if none precedes it.
   * Backs `liftTrace`'s `axAt` callback; the nearest-at-or-before rule lives here
   * so callers cannot each re-implement it differently.
   */
  getAxAt(sessionId: string, tMono: number): AxSnapshotRow | undefined;
  /** Read back a keyframe's stored AX snapshot (what `StoredAxProvider` serves). */
  getFrameAx(frameId: string): UIElement[];

  // session lifecycle + relational reads (capture, segment, retrieve)

  /** Close a session by stamping its end. */
  endSession(sessionId: string, endedAt: number): Promise<void>;
  /** One session row, or undefined if the id is unknown. */
  getSession(sessionId: string): SessionRow | undefined;
  /**
   * Every session, newest first, with the counts the Library UI shows. This is the
   * authoritative session list, so the UI cannot drift from what delete removes.
   */
  listSessions(): SessionSummaryRow[];
  /** A session's raw events in `t_mono` order — the input to segmentation. */
  getEventsBySession(sessionId: string): EventRow[];
  /** A session's segments, including the overlapping multi-granularity windows. */
  getSegmentsBySession(sessionId: string): SegmentRow[];
  /** One segment row, or undefined if the id is unknown. */
  getSegment(segmentId: string): SegmentRow | undefined;
  /** A session's keyframes in `t_mono` order. */
  getFramesBySession(sessionId: string): FrameRow[];
  /** The keyframes associated with a segment (via `frame_segment`). */
  getFramesBySegment(segmentId: string): FrameRow[];
  /** One frame row, or undefined if the id is unknown. */
  getFrame(frameId: string): FrameRow | undefined;
  /** One region row, or undefined if the id is unknown. */
  getRegion(regionId: string): RegionRow | undefined;
  /** A frame's regions, highest priority first. Backs `liftTrace`'s `regionsAt`. */
  getRegionsByFrame(frameId: string): RegionRow[];
  /** Where a blob's bytes are, or undefined if the id is unknown. */
  getBlob(blobId: string): BlobRow | undefined;
  /** Every blob recorded for a session — keyframes, audio chunks, screen video. */
  getBlobsBySession(sessionId: string): BlobRow[];

  // deletes (gather ids -> delete Lance -> delete SQLite)

  /**
   * Delete a session and everything under it: gather ids from SQLite, delete the
   * Lance rows by id set, then delete the SQLite rows. Does **not** remove blob
   * files — call `BlobStore.removeSession` after this, in that order.
   */
  deleteSession(sessionId: string): Promise<void>;

  // experience trace graphs (src/trace/) — SQLite only, no vector space

  /**
   * Upsert a whole graph in one transaction. Delete-then-insert of the child
   * rows, so the write is idempotent and a graph that shrank actually shrinks.
   * Registers **no** vector space: visual corroboration reuses the region/frame
   * vectors already in Lance by id, so there is no ordering hazard here.
   */
  putGraph(graph: TraceGraph): Promise<void>;
  /** One graph with its nodes, edges and slots, or undefined if the id is unknown. */
  getGraph(id: string): TraceGraph | undefined;
  /** Every graph with its counts, newest first. */
  listGraphs(): TraceGraphSummary[];
  /** Delete a graph; nodes, edges and slots cascade. */
  deleteGraph(id: string): Promise<void>;

  // scoped search (retrieval tiers)

  /**
   * Tier 0: frame ids within `maxHamming` of a 64-bit perceptual hash. Runs the
   * Hamming distance in JS, not a SQL UDF — `safeIntegers` does not reach UDF
   * arguments, so a 64-bit value would arrive truncated.
   */
  phashPrefilter(phash: bigint, maxHamming: number): string[];
  /** Tier 1: ANN over one segment view. **Throws on an unregistered namespace.** */
  searchSegments(namespace: string, vector: Float32Array, k: number): Promise<SearchHit[]>;
  /** Tier 2: frame ANN, exactly pre-filtered to `scope` (LanceDB pre-filters by default). */
  searchFrames(
    namespace: string,
    vector: Float32Array,
    k: number,
    scope?: FrameScope,
  ): Promise<SearchHit[]>;
  /** MaxSim search over a frame_patches space; `query` is one vector per token. */
  searchFramePatches(
    namespace: string,
    query: Float32Array[],
    k: number,
    scope?: FrameScope,
  ): Promise<SearchHit[]>;
  /** A frame's stored patch set, for highlights without re-running the model. */
  getFramePatches(namespace: string, frameId: string): Promise<Float32Array[] | null>;
  /** Tier 3: region ANN, scoped to the frames Tier 2 returned. */
  searchRegions(
    namespace: string,
    vector: Float32Array,
    k: number,
    scope: RegionScope,
  ): Promise<SearchHit[]>;
  /** Tier 3's text half: FTS5 over stored AX role/label, so regions are searchable by UI role. */
  ftsRegions(query: string, limit?: number): string[];

  // reconciliation (SQLite is truth)

  /**
   * Run one direction only: prune vectors with no SQLite row, and report rows whose
   * vector is missing but whose source content is still on hand.
   */
  reconcile(): Promise<ReconcileResult>;
  /**
   * `reconcile()`, then re-embed the missing rows through a caller-supplied
   * callback — which is how `store/` recovers vectors without depending on
   * `represent/`.
   */
  reconcileAndReembed(reembed: Reembedder): Promise<ReconcileResult>;

  /** Close both engines. */
  close(): void;
}
