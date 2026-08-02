/**
 * Where every card and wire goes. Pure — no React, no DOM — so it lives in the
 * ROOT suite alongside `plan-view.ts`, for the same reason: it is layout for
 * data a human reads before authorizing a click, and it has real failure modes.
 *
 * No layout dependency. `@vidstack/react` was worth one because a media player
 * is not 60 lines; a layered layout for tens of nodes is.
 */

import type { GraphDTO, GraphEdgeDTO, GraphNodeDTO } from "@shared/types";

export const CARD_W = 180;
export const CARD_H = 132;
export const GAP_X = 40;
export const GAP_Y = 56;
/** Breathing room around the world so cards are not flush against the edge. */
const MARGIN = 48;

export interface PlacedNode {
  node: GraphNodeDTO;
  x: number;
  y: number;
}

export interface PlacedEdge {
  edge: GraphEdgeDTO;
  /** An SVG path `d`, in world coordinates. */
  d: string;
}

export interface Layout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  at: Map<string, PlacedNode>;
  width: number;
  height: number;
}

/**
 * Rank is the ROW. The graph flows downward, which is the axis a window has to
 * spare — and which lets the plan review take the whole stage rather than a
 * column stolen from the graph's width.
 *
 * Within a rank, order by the mean X of already-placed parents (one top-down
 * barycenter sweep). Ties break on the node's index in `graph.nodes`, so the
 * result is IDENTICAL across calls: `LocationDTO` arrives on a poll and
 * re-renders the canvas, and a layout that reordered on equal barycenters would
 * twitch continuously.
 */
export function layoutGraph(graph: GraphDTO): Layout {
  const order = new Map(graph.nodes.map((node, i) => [node.id, i]));

  const byRank = new Map<number, GraphNodeDTO[]>();
  for (const node of graph.nodes) {
    const list = byRank.get(node.rank);
    if (list === undefined) byRank.set(node.rank, [node]);
    else list.push(node);
  }

  // Forward edges only: a back edge points at an equal or lower rank, so using
  // it as a parent would pull a node toward a rank not yet placed.
  const parents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.back) continue;
    const list = parents.get(edge.to);
    if (list === undefined) parents.set(edge.to, [edge.from]);
    else list.push(edge.from);
  }

  const at = new Map<string, PlacedNode>();
  const placed: PlacedNode[] = [];

  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const row = byRank.get(rank)!;
    /** Mean x of placed parents; -1 when there are none, so roots keep array order. */
    const bary = (node: GraphNodeDTO): number => {
      const xs = (parents.get(node.id) ?? [])
        .map((id) => at.get(id)?.x)
        .filter((x): x is number => x !== undefined);
      return xs.length === 0 ? -1 : xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    const keyed = row.map((node) => ({ node, b: bary(node), i: order.get(node.id) ?? 0 }));
    keyed.sort((a, b) => (a.b === b.b ? a.i - b.i : a.b - b.b));

    keyed.forEach(({ node }, column) => {
      const p: PlacedNode = {
        node,
        x: column * (CARD_W + GAP_X),
        y: rank * (CARD_H + GAP_Y),
      };
      at.set(node.id, p);
      placed.push(p);
    });
  }

  const width = Math.max(...placed.map((p) => p.x + CARD_W), CARD_W) + MARGIN;
  const height = Math.max(...placed.map((p) => p.y + CARD_H), CARD_H) + MARGIN;

  const edges: PlacedEdge[] = [];
  for (const edge of graph.edges) {
    const a = at.get(edge.from);
    const b = at.get(edge.to);
    if (a === undefined || b === undefined) continue;
    edges.push({ edge, d: wire(a, b, edge.back, width) });
  }

  return { nodes: placed, edges, at, width, height };
}

/**
 * A forward wire leaves the bottom of one card and enters the top of the next.
 * A back edge bows OUT TO THE MARGIN instead of running down through every card
 * between its endpoints — a loop is a real feature of a merged graph and has to
 * stay readable as one.
 */
function wire(a: PlacedNode, b: PlacedNode, back: boolean, width: number): string {
  const x1 = a.x + CARD_W / 2;
  const x2 = b.x + CARD_W / 2;
  if (!back) {
    const y1 = a.y + CARD_H;
    const y2 = b.y;
    const mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  }
  // Out the right side, up the margin, back in the right side.
  const y1 = a.y + CARD_H / 2;
  const y2 = b.y + CARD_H / 2;
  const lane = Math.max(a.x, b.x) + CARD_W + Math.max(GAP_X, (width - Math.max(a.x, b.x)) / 3);
  return `M ${a.x + CARD_W} ${y1} C ${lane} ${y1}, ${lane} ${y2}, ${b.x + CARD_W} ${y2}`;
}
