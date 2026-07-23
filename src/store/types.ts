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
  registerVectorSpace(space: VectorSpaceInsert): Promise<void>;
  listVectorSpaces(): VectorSpaceInsert[];

  // relational + vector writes (each: SQLite tx commit, THEN Lance add)
  putSession(row: SessionInsert): Promise<void>;
  putEvents(rows: EventInsert[]): Promise<void>; // batched, SQLite only
  putBlobs(rows: BlobInsert[]): Promise<void>; // SQLite only
  putSegments(rows: SegmentInsert[]): Promise<void>;
  putFrames(rows: FrameInsert[]): Promise<void>;
  putRegions(rows: RegionInsert[]): Promise<void>;

  // enrich existing segments (represent/): text first (SQLite), then vectors (Lance)
  updateSegment(id: string, patch: SegmentPatch): Promise<void>;
  putSegmentVectors(rows: SegmentVectorInsert[]): Promise<void>;

  // enrich existing frames (Tier-2 represent/): association first (SQLite frame_segment),
  // then the frame_image vector (Lance) with segment_ids denormalized.
  associateFrameSegments(frameId: string, segmentIds: string[]): Promise<void>;
  putFrameVectors(rows: FrameVectorInsert[]): Promise<void>;

  // accessibility-tree snapshot for a keyframe (captured live; read at represent time)
  putFrameAx(frameId: string, elements: UIElement[]): Promise<void>;
  getFrameAx(frameId: string): UIElement[];

  // session lifecycle + relational reads (capture, segment, retrieve)
  endSession(sessionId: string, endedAt: number): Promise<void>;
  getSession(sessionId: string): SessionRow | undefined;
  getEventsBySession(sessionId: string): EventRow[];
  getSegmentsBySession(sessionId: string): SegmentRow[];
  getSegment(segmentId: string): SegmentRow | undefined;
  getFramesBySession(sessionId: string): FrameRow[];
  getFramesBySegment(segmentId: string): FrameRow[];
  getFrame(frameId: string): FrameRow | undefined;
  getRegion(regionId: string): RegionRow | undefined;
  getBlob(blobId: string): BlobRow | undefined;
  getBlobsBySession(sessionId: string): BlobRow[];

  // deletes (gather ids -> delete Lance -> delete SQLite)
  deleteSession(sessionId: string): Promise<void>;

  // scoped search (retrieval tiers)
  phashPrefilter(phash: bigint, maxHamming: number): string[];
  searchSegments(namespace: string, vector: Float32Array, k: number): Promise<SearchHit[]>;
  searchFrames(
    namespace: string,
    vector: Float32Array,
    k: number,
    scope?: FrameScope,
  ): Promise<SearchHit[]>;
  searchRegions(
    namespace: string,
    vector: Float32Array,
    k: number,
    scope: RegionScope,
  ): Promise<SearchHit[]>;
  ftsRegions(query: string, limit?: number): string[];

  // reconciliation (SQLite is truth)
  reconcile(): Promise<ReconcileResult>;
  reconcileAndReembed(reembed: Reembedder): Promise<ReconcileResult>;

  close(): void;
}
