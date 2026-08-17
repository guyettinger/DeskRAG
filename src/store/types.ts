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
  /**
   * The `t_mono` of the boundary this walk was taken FOR, when there was one.
   *
   * Write-only on this row: it is stored in `ax_snapshot_boundary` and read back
   * via `getAxForBoundary`. It exists because `tMono` above is the walk's own
   * start, which is ALWAYS later than the boundary (settle delay + walk budget),
   * so a "latest at-or-before the boundary" lookup returns the previous state's
   * tree — which paired every focus_change node with the outgoing app's UI.
   */
  boundaryTMono?: number;
}

/**
 * The device-timebase calibration for one session: a reading from
 * `ax-dump --clock` paired with the `t_mono` at which it was taken.
 *
 * Frames and audio are stored on `t_mono` by converting their capture-device
 * timestamps through this offset. A session with NO row predates the bridge and
 * carries the old per-producer conventions, so its timestamps are not
 * comparable with a calibrated recording's.
 */
export interface SessionClockRow {
  sessionId: string;
  deviceEpochMs: number;
  monoEpochMs: number;
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
}

/** A vector destined for one namespaced Lance table. */
export interface VectorInsert {
  namespace: string;
  vector: Float32Array;
}

/**
 * One utterance, with the timings the STT provider reported.
 *
 * Finer than a segment on purpose: a segment's span is not the span of the
 * speech inside it, and only a clip can say where a sentence actually was.
 */
export interface TranscriptClipInsert {
  id: string;
  sessionId: string;
  tMonoStart: number;
  tMonoEnd: number;
  text: string;
}

export type TranscriptClipRow = TranscriptClipInsert;

/**
 * Which producer wrote a composed summary — see `segment_summary.source`.
 *
 * Disclosure, not bookkeeping: a hierarchy composed structurally (no text model
 * configured) must not be able to masquerade as one a model summarized.
 */
export type SummarySource = "llm" | "template";

/** One parent -> child edge of the compositional segment hierarchy. */
export interface SegmentTreeInsert {
  sessionId: string;
  parentId: string;
  childId: string;
}

/** The composed summary of a level >= 1 segment. Leaves never have one. */
export interface SegmentSummaryInsert {
  segmentId: string;
  text: string;
  source: SummarySource;
}

export type SegmentSummaryRow = SegmentSummaryInsert;

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

/**
 * A SQLite row that has no vector in its namespace's Lance table.
 *
 * SEGMENT-ONLY since the single-vector image lane was removed. `frame_patches`
 * is regenerated wholesale rather than row-by-row, so it never reports missing;
 * `entity` is kept as a field rather than dropped because it is what tells a
 * re-embed callback what `id` refers to.
 */
export interface MissingVector {
  namespace: string;
  view: View;
  entity: "segment";
  id: string;
  /** Retained relational content for re-embedding. */
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

/**
 * Where a unit of indexing work is in its life.
 *
 * `running` is the one state that can be WRONG on disk: a process that dies
 * mid-stage leaves it behind, which is exactly what makes it useful — see
 * `Store.requeueRunningJobs`.
 */
export type IndexJobState = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * One unit of indexing work, durable across quits and crashes.
 *
 * **`kind`, `payload` and `progress` are opaque to the store**, deliberately.
 * What a stage is — the plan table, the gates, which provider skips what — is an
 * app concept, and `store/` must not learn it, the same seam that keeps `store/`
 * free of `represent/`. This layer owns identity, lifecycle and ordering only.
 *
 * `sessionId` is null for library-scoped work: a trace graph accretes across
 * every recording and so belongs to none of them.
 */
export interface IndexJobRow {
  id: string;
  sessionId: string | null;
  kind: string;
  state: IndexJobState;
  /** Wall-clock ms. Ordering is by this, so the queue is FIFO within a state. */
  enqueuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Incremented each time the job is claimed, so a crash loop is bounded. */
  attempts: number;
  error: string | null;
  /** App-defined JSON. Parsed by the app, never by the store. */
  payload: string;
  /** App-defined JSON, last write wins. Null until the job first reports. */
  progress: string | null;
}

/** What `enqueueIndexJob` needs; everything else is stamped by the store. */
export interface IndexJobInput {
  id: string;
  sessionId: string | null;
  kind: string;
  payload: string;
}

/**
 * One AUTHORED skill: a SKILL.md the user chose to keep, written from a route
 * their recordings actually walked.
 *
 * **`state` and `doc` are opaque to the store**, the `IndexJobRow` seam. What a
 * skill IS — frontmatter, prose, which route it was bound to, whether recorded
 * values are printed — is an app concept, and `store/` must not learn it. This
 * layer owns identity, lifecycle and ordering only.
 *
 * Unlike everything else here it is neither captured nor derived: no purge,
 * re-index or trace rebuild may touch it, because nothing can recompute prose a
 * person wrote. See `AUTHORED_TABLES`.
 */
export interface SkillRow {
  id: string;
  /** App-defined. Today: `active | archived | dismissed`. */
  state: string;
  pinned: boolean;
  /** Wall-clock ms, stamped once and never moved again. */
  createdAt: number;
  updatedAt: number;
  /** App-defined JSON. Parsed by the app, never by the store. */
  doc: string;
}

/**
 * A whole-row upsert. There is deliberately no partial update: two write paths
 * into one row is how a screen comes to show a half-applied edit, and the caller
 * already holds the whole document.
 */
export interface SkillInput {
  id: string;
  state: string;
  pinned: boolean;
  doc: string;
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
  /**
   * Attach the focused-app-window caption text to a segment. Lives in
   * segment_app_caption (a new table — see the schema comment) rather than a
   * `SegmentPatch` field, since `segment`'s columns are frozen.
   */
  updateSegmentAppCaption(segmentId: string, text: string): Promise<void>;
  /** Read back a segment's app_caption text, or undefined if none was written. */
  getAppCaption(segmentId: string): string | undefined;
  /**
   * Persist utterance-level speech. SQLite only — no vector space is keyed on a
   * clip, so there is no SQLite→Lance ordering hazard here, the same as the
   * trace_* tables.
   */
  putTranscriptClips(rows: TranscriptClipInsert[]): Promise<void>;
  /** A session's clips in t_mono order. */
  getTranscriptClipsBySession(sessionId: string): TranscriptClipRow[];

  // the compositional hierarchy (represent/compose/) — SQLite only, like trace_*

  /**
   * Parent -> child edges for composed levels. Idempotent: re-inserting an edge
   * is a no-op, so the composing stage can run twice.
   */
  putSegmentTree(rows: SegmentTreeInsert[]): Promise<void>;
  /** The direct children of a composed segment, or [] for a leaf. */
  getSegmentChildren(parentId: string): string[];
  /** The composed parent of a segment, or undefined for a root / a stray leaf. */
  getSegmentParent(childId: string): string | undefined;
  /**
   * Every LEAF beneath a segment — the segment itself when it has no children.
   *
   * This is what Tier-2 scoping uses. Frame vectors denormalize `segment_ids` at
   * represent time, long before composing runs, so a composed level can never
   * appear in that field: scoping a parent hit directly would match zero frames
   * and return empty with no error at all.
   */
  getDescendantLeaves(segmentId: string): string[];
  /** Persist composed summaries, replacing any existing row for the same id. */
  putSegmentSummaries(rows: SegmentSummaryInsert[]): Promise<void>;
  /** One composed summary, or undefined for a leaf / an unknown id. */
  getSegmentSummary(segmentId: string): SegmentSummaryRow | undefined;
  /** Every composed summary in a session. */
  getSegmentSummariesBySession(sessionId: string): SegmentSummaryRow[];
  /**
   * Delete segments by id — Lance vectors first, then the SQLite rows, the same
   * order `deleteSession` uses.
   *
   * Composing may run twice, and a second root would make "the session's
   * purpose" ambiguous with nothing able to say which was stale.
   */
  deleteSegments(ids: readonly string[]): Promise<void>;
  /** Add segment vectors, after their source text is already committed to SQLite. */
  putSegmentVectors(rows: SegmentVectorInsert[]): Promise<void>;
  /**
   * Replace segment vectors by id. `putSegmentVectors` is a bare add, so
   * re-running a represent stage would leave TWO vectors under one id — and
   * neither is an orphan, so reconcile() cannot clean it up. Any path that may
   * run twice over the same segments must use this.
   */
  replaceSegmentVectors(rows: SegmentVectorInsert[]): Promise<void>;

  // enrich existing frames (Tier-2 represent/): association first (SQLite
  // frame_segment), then the patch set (Lance) with segment_ids denormalized.

  /**
   * Associate a frame with the segments covering it. Segments are detected after
   * capture, so this is set lazily at represent time — it must land before the
   * patch set, which denormalizes these ids for scoped ANN.
   */
  associateFrameSegments(frameId: string, segmentIds: string[]): Promise<void>;
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
  /** The snapshot captured FOR this boundary. Prefer it over `getAxAt` at a
   *  boundary: the walk lands after the boundary, so `getAxAt` returns the
   *  previous state. Undefined for snapshots recorded before stamping existed. */
  getAxForBoundary(sessionId: string, tMono: number): AxSnapshotRow | undefined;
  /** Read back a keyframe's stored AX snapshot (what `StoredAxProvider` serves). */
  getFrameAx(frameId: string): UIElement[];
  /** Every AX snapshot for a session, oldest first — including empty ones. */
  getAxSnapshotsBySession(sessionId: string): AxSnapshotRow[];
  /** Point a stored walk at the frame it describes (see `associateFrameAx`). */
  setAxSnapshotFrame(snapshotId: string, frameId: string | null): Promise<void>;
  /** Record the device-timebase calibration for a session. */
  putSessionClock(row: SessionClockRow): Promise<void>;
  /** The calibration, or undefined for a session recorded before it existed. */
  getSessionClock(sessionId: string): SessionClockRow | undefined;

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

  // indexing work queue (SQLite only — no vector space, no Lance)

  /**
   * Add one job, or return the job already holding this slot.
   *
   * **Idempotent per (kind, sessionId) while a job is live** (`queued` or
   * `running`), which is what keeps a double-stop or a double-pressed rebuild
   * from indexing one recording twice. That guarantee used to be bought by a
   * synchronous state claim in the app; making it a property of the queue means
   * every future caller inherits it. Returns the EXISTING row when it collides,
   * so a caller can tell that its job was folded in.
   */
  enqueueIndexJob(input: IndexJobInput): Promise<IndexJobRow>;
  /** Every job, newest-enqueued last. `states` filters when given. */
  listIndexJobs(states?: readonly IndexJobState[]): IndexJobRow[];
  /** One job row, or undefined if the id is unknown. */
  getIndexJob(jobId: string): IndexJobRow | undefined;
  /**
   * Claim the oldest `queued` job, flipping it to `running` and incrementing
   * `attempts` in one transaction. Returns undefined when the queue is empty.
   */
  claimIndexJob(): Promise<IndexJobRow | undefined>;
  /** Overwrite a job's opaque progress payload. Cheap; called per stage. */
  updateIndexJobProgress(jobId: string, progress: string): Promise<void>;
  /** Move a job to a terminal state, stamping `ended_at` and any error. */
  finishIndexJob(
    jobId: string,
    state: "done" | "failed" | "cancelled",
    error?: string,
  ): Promise<void>;
  /**
   * Re-queue every `running` job, because a job in that state at open time is
   * one a previous process died inside.
   *
   * Returns the rows it touched. Anything past `maxAttempts` goes to `failed`
   * instead — a job that crashes the app on every attempt must not resurrect
   * itself forever. **Resuming mid-plan is not offered and must not be added**:
   * the stage bodies append rather than replace (`putRegions` mints a fresh
   * ULID per region), so only a purge makes a second pass safe.
   */
  requeueRunningJobs(maxAttempts: number): Promise<IndexJobRow[]>;
  /** Drop terminal jobs beyond the newest `keep`, so the table cannot grow forever. */
  pruneIndexJobs(keep: number): Promise<number>;

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

  // authored skills — SQLite only, no vector space, and never purged

  /**
   * Insert or replace a whole skill. Stamps `created_at` once and `updated_at`
   * on every write.
   *
   * Nothing else in the system writes this table: it is not derived, so no
   * indexing stage produces it, and `purgeDerived` and `deleteSession` both
   * leave it alone. Every call here is a user's own act.
   */
  putSkill(input: SkillInput): Promise<SkillRow>;
  /** Every skill, newest-touched first. States are the app's to filter. */
  listSkills(): SkillRow[];
  getSkill(id: string): SkillRow | undefined;
  /** User-initiated forgetting, and the only path that loses authored text. */
  deleteSkill(id: string): Promise<void>;

  // scoped search (retrieval tiers)

  /**
   * Tier 0: frame ids within `maxHamming` of a 64-bit perceptual hash. Runs the
   * Hamming distance in JS, not a SQL UDF — `safeIntegers` does not reach UDF
   * arguments, so a 64-bit value would arrive truncated.
   */
  phashPrefilter(phash: bigint, maxHamming: number): string[];
  /** Tier 1: ANN over one segment view. **Throws on an unregistered namespace.** */
  searchSegments(namespace: string, vector: Float32Array, k: number): Promise<SearchHit[]>;
  /** MaxSim search over a frame_patches space; `query` is one vector per token. */
  searchFramePatches(
    namespace: string,
    query: Float32Array[],
    k: number,
    scope?: FrameScope,
  ): Promise<SearchHit[]>;
  /** A frame's stored patch set, for highlights without re-running the model. */
  getFramePatches(namespace: string, frameId: string): Promise<Float32Array[] | null>;
  /**
   * Tier 3's text half: FTS5 over stored AX role/label, so regions are
   * searchable by UI role. Best first (bm25); `scope.frameIds` PRE-filters, the
   * same rule the ANN half follows — post-filtering a global top-N returns
   * nothing as soon as the library is bigger than the limit.
   */
  ftsRegions(query: string, limit?: number, scope?: { frameIds: string[] }): string[];
  /**
   * Tier 1's LEXICAL half: FTS5 over a segment's combined view text, best first
   * (bm25). Fused into the same RRF as the dense views — a rare literal token is
   * exactly where an embedding is weakest and an inverted index is strongest.
   */
  ftsSegments(query: string, limit?: number): string[];
  /** Replace one segment's lexical index entry. Idempotent; empty text writes no row. */
  indexSegmentText(segmentId: string, text: string): void;

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
