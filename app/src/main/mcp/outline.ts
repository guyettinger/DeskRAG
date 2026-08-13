/**
 * The composed hierarchy as something you can read top to bottom.
 *
 * The ladder exists on disk and is drawn as four lanes on the track rail, but
 * nothing renders it as text — and text is what an agent asking "what was that
 * recording for, and what happened in it" can actually use.
 *
 * Pure, so it lives in the ROOT suite: the caller supplies the rows, the
 * summaries and the parent→child edges, and gets back a tree plus its rendering.
 */

import { LEAF_GRANULARITY, ROOT_GRANULARITY } from "deskrag";
// One definition of a level's display name and of what a moment is. Both are
// pure and root-tested; two readers of one mapping is the drift hazard
// `ax-dump`/`ax-exec` already cost this repo once.
import { laneSec, levelTitle } from "../session-tracks.js";

/** The subset of `SegmentRow` an outline needs. */
export interface OutlineSegment {
  id: string;
  granularity: string;
  tMonoStart: number;
  tMonoEnd: number;
  digest: string | null;
  caption: string | null;
}

export interface OutlineInput {
  /** Every segment of the session, any granularity, any order. */
  segments: readonly OutlineSegment[];
  summaries: ReadonlyMap<string, { text: string; source: string }>;
  /** `segment_tree` edges: parent id → child ids. */
  children: ReadonlyMap<string, readonly string[]>;
  /** Lane offset 0 — the video's first frame, never `t_mono` zero. */
  laneOrigin: number;
}

export interface OutlineNode {
  id: string;
  /** `session` | `process` | `task` | `action`, from the row's own granularity. */
  level: string;
  /** Hops from the root. NOT a level index — elision means they differ. */
  depth: number;
  startSec: number;
  endSec: number;
  text: string;
  /** `llm` | `template` for a composed row; null for an action, which has no summary. */
  source: string | null;
}

export interface Outline {
  /** False when this recording was never run through the compose stage. */
  composed: boolean;
  /** Why there is no hierarchy. Null when there is one. */
  reason: string | null;
  nodes: OutlineNode[];
  /** Segments the root cannot reach. Normally empty; never silently dropped. */
  orphans: OutlineNode[];
}

/** An action's own text. Caption first, for the reason `keyframeLabel` prefers it. */
function leafText(s: OutlineSegment): string {
  return s.caption ?? s.digest ?? "(no description)";
}

export function buildOutline(input: OutlineInput): Outline {
  const byId = new Map(input.segments.map((s) => [s.id, s]));
  const nodeOf = (s: OutlineSegment, depth: number): OutlineNode => {
    const summary = input.summaries.get(s.id);
    return {
      id: s.id,
      level: levelTitle(s.granularity) ?? s.granularity,
      depth,
      startSec: laneSec(s.tMonoStart, input.laneOrigin),
      endSec: laneSec(s.tMonoEnd, input.laneOrigin),
      // A composed row IS its summary. Falling back to a caption keeps a row
      // readable if composing wrote the tree but not the prose.
      text: summary?.text ?? leafText(s),
      source: summary?.source ?? null,
    };
  };

  const root = input.segments.find((s) => s.granularity === ROOT_GRANULARITY);
  if (root === undefined) {
    // `composeLadder` writes a root on every run where composing executed at
    // all, even a one-action session — so its ABSENCE marks a recording indexed
    // before that stage existed, the same way `session_clock`'s absence marks a
    // pre-calibration one. Three states must stay distinguishable here: no
    // segments, segments but no hierarchy, and a real tree.
    const actions = input.segments
      .filter((s) => s.granularity === LEAF_GRANULARITY)
      .sort((a, b) => a.tMonoStart - b.tMonoStart)
      .map((s) => nodeOf(s, 0));
    return {
      composed: false,
      reason:
        input.segments.length === 0
          ? "This recording has no segments — it was never indexed."
          : "This recording was never composed: it has actions but no session root, " +
            "which means it was indexed before the compose stage existed. " +
            "Re-index it to get a hierarchy.",
      nodes: actions,
      orphans: [],
    };
  }

  const nodes: OutlineNode[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number): void => {
    // A cycle cannot arise from a correct tree, but the edges are STORED rather
    // than derived from spans, so a corrupt row must not hang the server.
    if (seen.has(id)) return;
    seen.add(id);
    const s = byId.get(id);
    if (s === undefined) return;
    nodes.push(nodeOf(s, depth));
    const kids = [...(input.children.get(id) ?? [])]
      .map((cid) => byId.get(cid))
      .filter((c): c is OutlineSegment => c !== undefined)
      .sort((a, b) => a.tMonoStart - b.tMonoStart);
    // Depth is a HOP COUNT, not a level index: a node holding exactly one child
    // is elided, so a child may be two levels below its parent. Each row prints
    // the level it actually is, and the two are allowed to disagree.
    for (const kid of kids) walk(kid.id, depth + 1);
  };
  walk(root.id, 0);

  const orphans = input.segments
    .filter((s) => !seen.has(s.id))
    .sort((a, b) => a.tMonoStart - b.tMonoStart)
    .map((s) => nodeOf(s, 0));

  return { composed: true, reason: null, nodes, orphans };
}

/** `m:ss.s` — minutes unbounded, so a long recording still reads correctly. */
export function stamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function line(n: OutlineNode): string {
  const when = `${stamp(n.startSec)}–${stamp(n.endSec)}`;
  // The source rides on the row rather than a footnote: a template summary is
  // structural prose, and a reader deciding on it needs to know at the point of
  // reading it.
  const src = n.source === null ? "" : ` [${n.source}]`;
  return `${" ".repeat(n.depth * 2)}${when}  ${n.level.toUpperCase()}  ${n.text}${src}`;
}

export function renderOutline(outline: Outline): string {
  const out: string[] = [];
  if (!outline.composed && outline.reason !== null) out.push(outline.reason, "");
  out.push(...outline.nodes.map(line));
  if (outline.orphans.length > 0) {
    out.push(
      "",
      `${outline.orphans.length} segment(s) the session root cannot reach — ` +
        "an index defect, reported rather than dropped:",
      ...outline.orphans.map(line),
    );
  }
  return out.join("\n");
}
