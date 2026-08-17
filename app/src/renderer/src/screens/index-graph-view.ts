/**
 * Geometry for the stage ladder — where each node sits and what shape its wires
 * are.
 *
 * `.ts`, never `.tsx`: the ROOT tsconfig sets no `jsx`, so a root test that
 * reaches into a `.tsx` — even only for a type — breaks `npm run typecheck`.
 * It sits beside `StageGraph.tsx` for the same reason `graph-layout.ts` sits
 * beside `GraphCanvas.tsx`, and it imports nothing from `api.ts`, which
 * evaluates `window.deskrag` at module scope.
 *
 * Nothing here returns a `React.CSSProperties`: React's types live in
 * `app/node_modules` and the root suite cannot see them. Positions come back as
 * plain numbers and the component turns them into styles.
 *
 * The layout decision itself is made in main (`index-graph.ts`): row is
 * EXECUTION order, column is dependency depth. This module only turns those two
 * integers into pixels, which is the same split as `session-tracks.ts` (what a
 * lane means) versus `track-view.ts` (where it is drawn).
 */

import type { IndexStageDTO } from "@shared/types";

/** One node's box. Rows are fixed-height so the ladder reads as a sequence. */
export const NODE_H = 46;
export const ROW_GAP = 10;
export const COL_W = 34;
/** Horizontal spacing between wire channels. */
export const CHANNEL_W = 9;
/** Gutter when there are no wires at all (a one-node trace rebuild). */
export const MIN_GUTTER = 16;
/** Corner radius where a wire turns. */
const BEND = 5;

export interface PlacedStage {
  stage: IndexStageDTO;
  x: number;
  y: number;
}

export interface PlacedWire {
  key: string;
  /** SVG path `d`, in the same coordinate space as the node boxes. */
  d: string;
  /** Which vertical channel this wire runs down. 0 is nearest the nodes. */
  channel: number;
}

export interface StageLayout {
  nodes: PlacedStage[];
  wires: PlacedWire[];
  /** Where column 0 starts — computed from how many wire channels are needed. */
  gutter: number;
  width: number;
  height: number;
}

const rowY = (row: number): number => row * (NODE_H + ROW_GAP);

/**
 * Where a wire attaches on the left edge of a node.
 *
 * Every wire runs down the gutter rather than between the boxes, because the
 * boxes are full-width prose: a wire crossing them would be drawn over text.
 */
const anchorY = (row: number): number => rowY(row) + NODE_H / 2;

interface Routed {
  key: string;
  fromRow: number;
  toRow: number;
  channel: number;
}

/**
 * Give every wire a vertical channel of its own where it would otherwise
 * overlap — the commit-graph idiom.
 *
 * **This replaced bowed curves, and the screenshot is why.** Twelve stages
 * declare twenty-one dependencies, and bowing all of them into one 18px gutter
 * drew a vertical stripe of overlapping dashes that read as static: measured in
 * the running app, 16 of 21 wires shared the same few pixels of horizontal
 * space. Every wire was individually correct and the picture said nothing. A
 * dependency you cannot trace with your eye is not disclosed, and the DOM
 * assertions all passed — only looking at it showed anything was wrong.
 *
 * Shortest span first, so a wire between neighbours hugs the nodes and the long
 * reaches swing wide. Two wires share a channel only when their row ranges do
 * not touch; touching would draw two wires as one continuous line.
 */
function routeWires(stages: readonly IndexStageDTO[]): Routed[] {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const pending: { key: string; fromRow: number; toRow: number }[] = [];
  for (const stage of stages) {
    for (const need of stage.needs) {
      const from = byId.get(need);
      if (!from) continue;
      pending.push({ key: `${need}->${stage.id}`, fromRow: from.row, toRow: stage.row });
    }
  }
  pending.sort(
    (a, b) => a.toRow - a.fromRow - (b.toRow - b.fromRow) || a.fromRow - b.fromRow,
  );

  const lanes: { lo: number; hi: number }[][] = [];
  return pending.map((w) => {
    let channel = 0;
    // `<=` / `>=`: two wires that merely TOUCH at a row still cannot share a
    // channel, because their vertical segments would be contiguous at the same
    // x and read as one wire spanning both.
    while (lanes[channel]?.some((r) => w.fromRow <= r.hi && w.toRow >= r.lo)) channel++;
    (lanes[channel] ??= []).push({ lo: w.fromRow, hi: w.toRow });
    return { ...w, channel };
  });
}

/**
 * Place the ladder.
 *
 * `width` is a parameter rather than a constant because the node boxes stretch
 * to the pane — the rail learned the same lesson, where a fixed thumbnail width
 * in TS and a percentage in CSS drifted apart with nothing enforcing the pair.
 */
export function layoutStages(stages: readonly IndexStageDTO[], width: number): StageLayout {
  const routed = routeWires(stages);
  const channels = routed.length === 0 ? 0 : Math.max(...routed.map((w) => w.channel)) + 1;
  // The gutter is SIZED BY THE WIRES rather than fixed, so a channel can never
  // be pushed off the left edge of the diagram.
  const gutter = Math.max(MIN_GUTTER, channels * CHANNEL_W + BEND + 4);

  const nodes: PlacedStage[] = stages.map((stage) => ({
    stage,
    x: gutter + stage.col * COL_W,
    y: rowY(stage.row),
  }));
  const xOf = new Map(nodes.map((n) => [n.stage.row, n.x]));

  const wires = routed.map((w) => {
    const y1 = anchorY(w.fromRow);
    const y2 = anchorY(w.toRow);
    const x1 = xOf.get(w.fromRow) ?? gutter;
    const x2 = xOf.get(w.toRow) ?? gutter;
    // Channel 0 sits nearest the nodes; each further channel steps left.
    const cx = gutter - BEND - w.channel * CHANNEL_W;
    return {
      key: w.key,
      channel: w.channel,
      // Out of the source's left edge, down its channel, back into the target's
      // left edge — with the two turns rounded so the corners are not hard.
      d:
        `M ${x1} ${y1} L ${cx + BEND} ${y1} Q ${cx} ${y1} ${cx} ${y1 + BEND} ` +
        `L ${cx} ${y2 - BEND} Q ${cx} ${y2} ${cx + BEND} ${y2} L ${x2} ${y2}`,
    };
  });

  const rows = stages.length;
  return {
    nodes,
    wires,
    gutter,
    width,
    height: rows === 0 ? 0 : rowY(rows - 1) + NODE_H,
  };
}

/** The tone token a stage state reads through `[data-tone]`. */
export function stageTone(state: IndexStageDTO["state"]): string {
  switch (state) {
    case "done":
      return "ok";
    case "running":
      return "accent";
    case "failed":
      return "alarm";
    case "skipped":
      return "neutral";
    default:
      return "neutral";
  }
}

/**
 * A stage's elapsed time, or null when there is nothing true to say.
 *
 * Sub-second stages report in milliseconds rather than rounding to "0s": half
 * the pipeline is pure SQLite over rows that are already there, and a ladder
 * where eight of twelve nodes read "0s" says less than one that shows the two
 * that actually cost something.
 */
export function stageElapsed(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Round to whole SECONDS first, then split. Rounding the remainder separately
  // produces "4m 60s" — which the real Frame patches stage printed, at 299.6s,
  // in the running app. Every unit test passed: none of them happened to land in
  // the last half-second of a minute.
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
