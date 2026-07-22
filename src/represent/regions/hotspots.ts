/**
 * Source B — Interaction hotspots. The signal pure-pixel video RAG cannot have:
 * the user literally pointed at what mattered. We weight clicks/dwell heavily and
 * scrolls/moves lightly, then cluster with a WEIGHTED DBSCAN whose core condition
 * is a weight SUM (not a point count) — so a single heavy click (weight ≥
 * minWeight) forms its own cluster (minPoints effectively drops to 1), while a
 * drift of light mouse-moves does not.
 */

import type { Region } from "../../embed/types.js";
import { clampToFrame } from "./geometry.js";

export interface WeightedPoint {
  x: number;
  y: number;
  weight: number;
}

export interface HotspotEvent {
  kind: string;
  x?: number | null;
  y?: number | null;
}

export const DEFAULT_EVENT_WEIGHTS: Record<string, number> = {
  mouse_down: 3,
  mouse_up: 1,
  scroll: 1,
  mouse_move: 0.2,
};

/** Map interaction events to weighted points (drops events without coordinates). */
export function eventsToPoints(
  events: readonly HotspotEvent[],
  weights: Record<string, number> = DEFAULT_EVENT_WEIGHTS,
): WeightedPoint[] {
  const pts: WeightedPoint[] = [];
  for (const e of events) {
    const w = weights[e.kind];
    if (w === undefined || e.x == null || e.y == null) continue;
    pts.push({ x: e.x, y: e.y, weight: w });
  }
  return pts;
}

/**
 * Weighted DBSCAN. Returns a cluster label per point (-1 = noise). A point is a
 * core point when the summed weight of its eps-neighbourhood (incl. itself) ≥
 * minWeight.
 */
export function dbscanWeighted(
  pts: readonly WeightedPoint[],
  eps: number,
  minWeight: number,
): number[] {
  const n = pts.length;
  const labels = new Array<number>(n).fill(-2); // -2 unvisited, -1 noise, ≥0 cluster
  const eps2 = eps * eps;
  const neighbors = (i: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < n; j++) {
      const dx = pts[i]!.x - pts[j]!.x;
      const dy = pts[i]!.y - pts[j]!.y;
      if (dx * dx + dy * dy <= eps2) out.push(j);
    }
    return out;
  };
  const weightSum = (idx: readonly number[]) => idx.reduce((s, j) => s + pts[j]!.weight, 0);

  let cluster = -1;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    const nbrs = neighbors(i);
    if (weightSum(nbrs) < minWeight) {
      labels[i] = -1; // not (yet) core; may be claimed as a border point later
      continue;
    }
    cluster++;
    labels[i] = cluster;
    const seeds = [...nbrs];
    for (let k = 0; k < seeds.length; k++) {
      const q = seeds[k]!;
      if (labels[q] === -1) labels[q] = cluster; // border
      if (labels[q] !== -2) continue;
      labels[q] = cluster;
      const nq = neighbors(q);
      if (weightSum(nq) >= minWeight) seeds.push(...nq);
    }
  }
  return labels;
}

export interface HotspotOptions {
  frameW: number;
  frameH: number;
  eps?: number;
  minWeight?: number;
  /** Padding (px) around a cluster's point bbox. */
  pad?: number;
  /** Weight that maps to full hotspot priority (2). */
  weightScale?: number;
}

/** Cluster interaction points and crop a region around each cluster. */
export function hotspotRegions(points: readonly WeightedPoint[], opts: HotspotOptions): Region[] {
  const eps = opts.eps ?? 80;
  const minWeight = opts.minWeight ?? 3; // one heavy click qualifies
  const pad = opts.pad ?? 48;
  const weightScale = opts.weightScale ?? 9;

  const labels = dbscanWeighted(points, eps, minWeight);
  const clusters = new Map<number, WeightedPoint[]>();
  labels.forEach((c, i) => {
    if (c < 0) return;
    (clusters.get(c) ?? clusters.set(c, []).get(c)!).push(points[i]!);
  });

  const regions: Region[] = [];
  for (const members of clusters.values()) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, weight = 0;
    for (const p of members) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      weight += p.weight;
    }
    const box = clampToFrame(
      { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad },
      opts.frameW, opts.frameH,
    );
    regions.push({
      ...box,
      source: "hotspot",
      priority: 1 + Math.min(weight / weightScale, 1), // ~1–2
    });
  }
  return regions;
}
