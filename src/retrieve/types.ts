/**
 * Retrieval contracts. A Query can carry a text intent, a behavioral vector, or
 * both (image comes later with frames). A ViewSearcher knows how to turn a Query
 * into a query vector for ONE segment vector space; the retriever fans the query
 * across all applicable views and fuses the ranked lists with RRF.
 */

import type { View } from "../embed/types.js";
import type { FrameRow, SegmentRow } from "../store/types.js";

export interface Query {
  /** Natural-language intent — routed to text views (digest/caption/...). */
  text?: string;
  /** Behavioral intent vector — routed to the behavior view. */
  behavior?: Float32Array;
  /** Visual example — routed to the frame_image view (Tier 2). */
  image?: Uint8Array;
}

/** Turns a Query into a query vector for one namespace, or null if N/A. */
export interface ViewSearcher {
  readonly namespace: string;
  readonly view: View;
  queryVector(q: Query): Promise<Float32Array | null>;
}

/** One view's contribution to a fused hit (provenance for scoring/rerank). */
export interface PerViewHit {
  namespace: string;
  view: View;
  rank: number; // 1-based
  distance: number;
}

export interface SegmentHit {
  segmentId: string;
  /** Fused RRF score. */
  score: number;
  perView: PerViewHit[];
  /** Hydrated segment row (t_mono range, digest, ...), if it still exists. */
  segment?: SegmentRow;
}

export interface RetrievalResult {
  segments: SegmentHit[];
}

/** A frame hit from Tier 2 (scoped to Tier-1 segments). */
export interface FrameHit {
  frameId: string;
  distance: number;
  frame?: FrameRow;
}

/** A region hit from Tier 3 — the highlight (bbox + label) to outline on a frame. */
export interface RegionHit {
  regionId: string;
  frameId: string;
  bbox: { x: number; y: number; w: number; h: number };
  role: string | null;
  label: string | null;
  /** How this region matched: image ANN, AX-label FTS, or both. */
  matchedBy: ("ann" | "fts")[];
  /** ANN distance when matched by image (absent for FTS-only hits). */
  distance?: number;
}

export interface Tier1Options {
  /** RRF damping constant. */
  rrfK?: number;
  /** Neighbors to pull from each view before fusion. */
  perViewK?: number;
  /** Fused segments to return. */
  topN?: number;
}

/** Relative weights for the assembled frame score (w1·frame + w2·region + w3·segment). */
export interface RetrieverWeights {
  frame: number;
  region: number;
  segment: number;
}

/** A recalled frame with its score breakdown and highlights. */
export interface FrameResult {
  frameId: string;
  score: number;
  /** The frame's best containing segment (highest Tier-1 score). */
  segmentId?: string;
  /** Tier-2 ANN distance for a visual query (absent for non-visual recall). */
  frameDistance?: number;
  frame?: FrameRow;
  /** Matched region bboxes + labels to outline on the frame (PixelRAG affordance). */
  highlights: RegionHit[];
}

/** The assembled coarse-to-fine result. */
export interface AssembledResult {
  segments: SegmentHit[];
  frames: FrameResult[];
}
