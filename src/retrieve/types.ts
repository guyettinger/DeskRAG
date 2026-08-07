/**
 * Retrieval contracts. A Query can carry a text intent, a behavioral vector, or
 * both (image comes later with frames). A ViewSearcher knows how to turn a Query
 * into a query vector for ONE segment vector space; the retriever fans the query
 * across all applicable views and fuses the ranked lists with RRF.
 */

import type { View } from "../embed/types.js";
import type { FrameRow, SegmentRow } from "../store/types.js";

/**
 * What to recall. Any combination of the three modes; each is routed to the views
 * that can answer it, and the combination decides which tiers run.
 */
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

/**
 * The lexical half of Tier 1 — segment ids for a text query, BEST FIRST.
 *
 * Not a `ViewSearcher`: it produces no vector and belongs to no vector space.
 * It contributes one more ranked list to the same RRF, which is exactly what
 * makes hybrid dense+sparse retrieval free here — fusion by rank needs no
 * commensurable scores. Dense views are weakest on rare literal tokens (a
 * filename, an error string, a URL), which is where an inverted index is
 * strongest.
 */
export interface LexicalSearcher {
  /** Stable label for this list's contribution, e.g. "lexical". */
  readonly key: string;
  search(q: Query, limit: number): string[];
}

/** One view's contribution to a fused hit (provenance for scoring/rerank). */
export interface PerViewHit {
  namespace: string;
  view: View;
  rank: number; // 1-based
  distance: number;
}

/** A Tier-1 segment, with the per-view provenance that produced its fused rank. */
export interface SegmentHit {
  segmentId: string;
  /** Fused RRF score. */
  score: number;
  perView: PerViewHit[];
  /**
   * 1-based rank in the lexical list, when one contributed. Kept separate from
   * `perView` rather than widening `PerViewHit.view`, which is the vector-view
   * enum — a lexical match belongs to no vector space.
   */
  lexicalRank?: number;
  /** Hydrated segment row (t_mono range, digest, ...), if it still exists. */
  segment?: SegmentRow;
}

/** Tier 1's output on its own — the scope Tier 2 narrows into. */
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
  /**
   * 1-based DENSE rank of this region's role+label among the AX-label FTS
   * matches (bm25 order), when matched by text. This is what lets a text query
   * rank frames INSIDE one segment: a flat per-hit constant would say only
   * "matched", so every frame showing any matching label would tie.
   *
   * Dense, and keyed on the label rather than the row, because two frames
   * showing the SAME control are equally good answers — bm25 orders equal rows
   * arbitrarily, and a positional rank would let that arbitrary order outweigh
   * the segment evidence.
   */
  ftsRank?: number;
}

/** How wide Tier 1 fans across views, and how hard RRF damps deep ranks. */
export interface Tier1Options {
  /** RRF damping constant. */
  rrfK?: number;
  /** Neighbors to pull from each view before fusion. */
  perViewK?: number;
  /** Fused segments to return. */
  topN?: number;
  /** Optional lexical lane fused alongside the dense views (hybrid retrieval). */
  lexical?: LexicalSearcher;
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
