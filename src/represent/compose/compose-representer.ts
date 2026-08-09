/**
 * The composing stage: read a session's level-0 segments, build the tree, write
 * it back.
 *
 * Runs AFTER Digest, Caption and Transcript — it reads their text — and BEFORE
 * the `segment_fts` stage, so composed summaries reach the lexical lane. It is
 * ALWAYS ON: the structural path needs no provider.
 *
 * It cannot fail the run. A provider error, a timeout, an unparseable reply or
 * no daemon at all each degrade that block to the structural grouping, which is
 * `composeLevels`' own contract; nothing here rethrows.
 */

import { ulid } from "ulid";
import type { SummaryProvider } from "../../embed/summary.js";
import { namespaceFor, type EmbeddingProvider } from "../../embed/types.js";
import type {
  EventRow,
  SegmentInsert,
  SegmentRow,
  SegmentSummaryInsert,
  SegmentTreeInsert,
  Store,
} from "../../store/types.js";
import { composeLevels } from "./levels.js";
import type { ChildSummary, ComposedLevel, ComposeGroup, Partitioner } from "./types.js";

/** Level 0 — the only granularity segmentation itself produces. */
export const LEAF_GRANULARITY = "action";
/** Composed levels below the root: `level:1`, `level:2`, … */
export const LEVEL_PREFIX = "level:";
/** The one node covering the whole recording. Its summary IS the session's purpose. */
export const ROOT_GRANULARITY = "session";

export interface ComposeRepresenterOptions {
  summarizer?: SummaryProvider;
  /**
   * Embeds composed summaries into the `summary` view, making a level
   * retrievable at its own altitude.
   *
   * The SAME embedder digest uses — `view` is part of the namespace, so this is
   * a distinct physical table at no extra provider cost. Omit it and the tree is
   * still built and still reaches the lexical lane; only the dense lane is lost.
   */
  summaryEmbedder?: EmbeddingProvider;
  mintId?: () => string;
  batchCap?: number;
}

export interface ComposeResult {
  /** Composed levels, excluding level 0. */
  levels: number;
  /** Composed segments written. */
  nodes: number;
  /** Of those, named by a model rather than rolled up. */
  llmNodes: number;
  rootSummary: string | null;
}

export class ComposeRepresenter {
  private readonly summarizer: SummaryProvider | undefined;
  private readonly summaryEmbedder: EmbeddingProvider | undefined;
  private readonly mintId: () => string;
  private readonly batchCap: number | undefined;
  /** The `summary` space, or null when no embedder was given. */
  readonly namespace: string | null;
  private spaceReady = false;

  constructor(
    private readonly store: Store,
    opts: ComposeRepresenterOptions = {},
  ) {
    this.summarizer = opts.summarizer;
    this.summaryEmbedder = opts.summaryEmbedder;
    this.mintId = opts.mintId ?? (() => ulid());
    this.batchCap = opts.batchCap;
    this.namespace =
      this.summaryEmbedder === undefined
        ? null
        : namespaceFor("summary", this.summaryEmbedder);
  }

  async represent(sessionId: string): Promise<ComposeResult> {
    const all = this.store.getSegmentsBySession(sessionId);
    const leaves = all
      .filter((s) => s.granularity === LEAF_GRANULARITY)
      .sort((a, b) => a.tMonoStart - b.tMonoStart);
    if (leaves.length === 0) {
      return { levels: 0, nodes: 0, llmNodes: 0, rootSummary: null };
    }

    // Re-running must REPLACE, never accumulate: a second root would make "the
    // session's purpose" ambiguous, and no reconcile pass could tell which was
    // stale, since neither would be an orphan.
    const stale = all.filter((s) => s.granularity !== LEAF_GRANULARITY).map((s) => s.id);
    if (stale.length > 0) await this.store.deleteSegments(stale);

    const children = this.leafChildren(leaves, this.store.getEventsBySession(sessionId));

    const composed = await composeLevels(children, {
      ...(this.summarizer !== undefined ? { partitioner: this.partitioner() } : {}),
      ...(this.batchCap !== undefined ? { batchCap: this.batchCap } : {}),
    });

    // Write bottom-up, so a parent's span comes from rows that already exist.
    let below = leaves.map((s) => ({
      id: s.id,
      tMonoStart: s.tMonoStart,
      tMonoEnd: s.tMonoEnd,
    }));
    const segments: SegmentInsert[] = [];
    const edges: SegmentTreeInsert[] = [];
    const summaries: SegmentSummaryInsert[] = [];
    let llmNodes = 0;
    let rootSummary: string | null = null;

    for (let i = 0; i < composed.length; i++) {
      const level = composed[i]!;
      const isRoot = i === composed.length - 1;
      const next: typeof below = [];
      for (const node of level.nodes) {
        const kids = below.slice(node.range.start, node.range.end);
        const nodeId = this.mintId();
        // A parent's span IS its children's union — never computed some other
        // way, or a node could claim time nothing was recorded in.
        const tMonoStart = kids[0]!.tMonoStart;
        const tMonoEnd = kids[kids.length - 1]!.tMonoEnd;
        segments.push({
          id: nodeId,
          sessionId,
          granularity: isRoot ? ROOT_GRANULARITY : `${LEVEL_PREFIX}${level.level}`,
          tMonoStart,
          tMonoEnd,
          boundaryReason: "window",
        });
        for (const k of kids) edges.push({ sessionId, parentId: nodeId, childId: k.id });
        summaries.push({ segmentId: nodeId, text: node.summary, source: node.source });
        if (node.source === "llm") llmNodes += 1;
        if (isRoot) rootSummary = node.summary;
        next.push({ id: nodeId, tMonoStart, tMonoEnd });
      }
      below = next;
    }

    // NAME THE ROOT, when composing did not.
    //
    // The root's summary is the session's PURPOSE — the one string a reader
    // sees in the Library — and partitioning never produces it: the final
    // collapse asks the model to split a two-item list, which it answers with
    // two groups every time (3 of 3 trials on a real recording), and two does
    // not shrink so it is correctly rejected. Naming is a different question,
    // so it gets its own call rather than a looser acceptance rule.
    const rootSummaryRow = summaries[summaries.length - 1];
    if (
      this.summarizer !== undefined &&
      rootSummaryRow !== undefined &&
      rootSummaryRow.source === "template" &&
      children.length > 1
    ) {
      const named = await this.nameRoot(composed);
      if (named !== undefined) {
        rootSummaryRow.text = named;
        rootSummaryRow.source = "llm";
        rootSummary = named;
        llmNodes += 1;
      }
    }

    // SQLite rows first, then the edges that reference them, then the text.
    await this.store.putSegments(segments);
    await this.store.putSegmentTree(edges);
    await this.store.putSegmentSummaries(summaries);
    await this.embedSummaries(summaries, sessionId);
    await this.linkFrames(segments.map((s) => s.id));

    return { levels: composed.length, nodes: segments.length, llmNodes, rootSummary };
  }

  /**
   * Turn level-0 segments into the composer's input.
   *
   * `app` and `url` are resolved from the session's own event stream by
   * "latest at-or-before", the rule every other environment fact uses — NOT by
   * parsing `buildDigest`'s prose back out, which has four different shapes and
   * would silently mistake a window title for an application.
   */
  private leafChildren(leaves: readonly SegmentRow[], events: readonly EventRow[]): ChildSummary[] {
    const focus = events
      .filter((e) => e.kind === "focus_change")
      .sort((a, b) => a.tMono - b.tMono);
    const urls = events.filter((e) => e.kind === "url_change").sort((a, b) => a.tMono - b.tMono);

    const latestAtOrBefore = (rows: readonly EventRow[], tMono: number, field: string) => {
      let found: string | null = null;
      for (const e of rows) {
        if (e.tMono > tMono) break;
        const v = (e.data as Record<string, unknown> | null | undefined)?.[field];
        if (typeof v === "string" && v.length > 0) found = v;
      }
      return found;
    };

    // Lane offsets are relative to the FIRST leaf, so the composer's times are
    // differences throughout and a uniform shift cannot change a grouping.
    const origin = leaves[0]!.tMonoStart;
    return leaves.map((s, i) => ({
      index: i,
      // Caption first, for the same reason `keyframeLabel` prefers it: the VLM
      // describes the pixels, the digest is a template over events.
      text: s.caption ?? s.digest ?? s.boundaryReason ?? "segment",
      app: latestAtOrBefore(focus, s.tMonoStart, "app"),
      url: latestAtOrBefore(urls, s.tMonoStart, "url"),
      startSec: (s.tMonoStart - origin) / 1000,
      endSec: (s.tMonoEnd - origin) / 1000,
      barrier: s.boundaryReason === "bookmark",
    }));
  }

  /**
   * The `summary` view — a level retrievable at its OWN altitude, so "when did
   * I file the expense report" can return the task rather than a 900ms action.
   *
   * Text is already committed above, so a crash here leaves a re-embeddable row
   * rather than an orphan vector. `replaceSegmentVectors`, never
   * `putSegmentVectors`: this stage runs again on every re-index, and a bare add
   * would leave two vectors under one id that `reconcile()` can never prune.
   */
  private async embedSummaries(
    summaries: readonly SegmentSummaryInsert[],
    sessionId: string,
  ): Promise<void> {
    const embedder = this.summaryEmbedder;
    if (embedder === undefined || this.namespace === null || summaries.length === 0) return;
    if (!this.spaceReady) {
      await this.store.registerVectorSpace({
        namespace: this.namespace,
        view: "summary",
        providerId: embedder.id,
        model: embedder.model,
        dimensions: embedder.dimensions,
        sharedTextSpace: false,
      });
      this.spaceReady = true;
    }
    const vectors = await embedder.embed(summaries.map((s) => s.text));
    await this.store.replaceSegmentVectors(
      summaries.map((s, i) => ({
        segmentId: s.segmentId,
        sessionId,
        namespace: this.namespace!,
        vector: vectors[i]!,
      })),
    );
  }

  /**
   * One call asking what the whole session WAS, from the summaries of the level
   * directly beneath the root.
   *
   * Returns undefined on any failure, so the rollup already written stands —
   * composing still cannot fail the run, and the root still says `template`
   * when nothing named it.
   */
  private async nameRoot(composed: readonly ComposedLevel[]): Promise<string | undefined> {
    const below = composed[composed.length - 2];
    if (below === undefined || this.summarizer === undefined) return undefined;
    const kids: ChildSummary[] = below.nodes.map((n, i) => ({
      index: i,
      text: n.summary,
      app: null,
      url: null,
      startSec: 0,
      endSec: 0,
      barrier: false,
    }));
    try {
      const groups = await this.summarizer.compose(kids, {
        level: composed.length,
        single: true,
      });
      const text = groups[0]?.summary.trim();
      return text !== undefined && text.length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Adapts the provider to `composeLevels`' block-at-a-time contract: slice the
   * block, let the model see 0..n-1, shift the answer back.
   */
  private partitioner(): Partitioner {
    const summarizer = this.summarizer;
    if (summarizer === undefined) throw new Error("partitioner() with no summarizer");
    return async (children, block, level): Promise<ComposeGroup[]> => {
      const slice = children.slice(block.start, block.end).map((c, i) => ({ ...c, index: i }));
      const groups = await summarizer.compose(slice, { level });
      return groups.map((g) => ({
        start: g.start + block.start,
        end: g.end + block.start,
        summary: g.summary,
      }));
    };
  }

  /**
   * A parent's frames are exactly the union of its children's.
   *
   * Derived from the tree rather than by re-applying `segmentIdsForFrame`, so
   * the window rule keeps its single implementation — the drift hazard that
   * `ax-dump`/`ax-exec` already paid for.
   */
  private async linkFrames(nodeIds: readonly string[]): Promise<void> {
    // Grouped by frame so this is one write per frame rather than one per
    // (frame, level). `associateFrameSegments` is INSERT OR IGNORE, so it
    // appends and re-running costs nothing.
    const byFrame = new Map<string, string[]>();
    for (const nodeId of nodeIds) {
      for (const leaf of this.store.getDescendantLeaves(nodeId)) {
        for (const f of this.store.getFramesBySegment(leaf)) {
          const list = byFrame.get(f.id) ?? [];
          if (!list.includes(nodeId)) list.push(nodeId);
          byFrame.set(f.id, list);
        }
      }
    }
    for (const [frameId, ids] of byFrame) {
      await this.store.associateFrameSegments(frameId, ids);
    }
  }
}
