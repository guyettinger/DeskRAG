/**
 * The experience trace IR — a manipulable representation of recorded desktop
 * behavior. A Graph's nodes are verified states and its edges are action
 * sequences; a Trace is that same shape constrained to the single linear path
 * one recording produces.
 *
 * Pure types plus one lookup table. This module imports nothing but `UIElement`,
 * which keeps `trace/` a leaf: everything it needs from the store arrives through
 * injected callbacks or the minimal local interfaces declared here (the same
 * pattern `segment/types.ts` uses for `SegEvent`).
 */

import type { UIElement } from "../embed/types.js";

export type { UIElement };

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// --- anchors ---------------------------------------------------------------

/**
 * Three independent descriptions of one target, resolved `ax → visual → point`
 * at replay. Recorded independently at capture time and NEVER derived from one
 * another at replay time — deriving an AX target from a coordinate is how these
 * systems silently drift.
 *
 * `point` is required: it is always recordable, so an anchor is never empty.
 */
export interface Anchor {
  /**
   * `path` is the ancestor chain — role+label alone is not unique in a window.
   * `identifier` is the app-assigned AXIdentifier where one exists: a stronger
   * anchor than the path, which shifts when the UI gains or loses a sibling.
   */
  ax?: { role: string; label?: string; identifier?: string; path: string };
  /** `framePhash` is the pHash of the frame this region was proposed from. */
  visual?: { regionId: string; framePhash: string; bbox: Rect };
  point: { x: number; y: number; displayId: string; windowRelative?: Vec2 };
}

// --- motion ----------------------------------------------------------------

/** One cubic segment; its start is the previous segment's `end` (or the origin). */
export interface CubicBezier {
  c1: Vec2;
  c2: Vec2;
  end: Vec2;
}

/**
 * A fitted motion path, **normalized to a unit box between its endpoints**. The
 * shape carries no absolute coordinates, so retargeting re-projects the same
 * curve onto new endpoints. "Verbatim" vs "synthesized" is therefore a runtime
 * consequence of where the endpoints resolved, not a stored mode — one code path.
 */
export interface Path {
  /** Control points in unit space: the path runs (0,0) → (1,0). */
  curve: CubicBezier[];
  durationMs: number;
  /** Monotonic non-decreasing progress in [0,1], sampled at uniform times. */
  velocity: number[];
  /** Low when the source samples were sparse or the fit residual was high. */
  fitConfidence: number;
}

// --- predicates ------------------------------------------------------------

export type PredicateKind =
  | "app"
  | "window"
  | "ax_exists"
  | "ax_focused"
  | "display"
  | "file"
  | "permission";

/**
 * `achievable` — some edge in the graph establishes it, so a failed check has a
 * repair path (pathfind from where we actually are).
 * `assertable` — no UI action can produce it; it can only gate, with a specific
 * reason. This tag is what makes "ensure the same state is present" well-defined.
 */
export type Reach = "achievable" | "assertable";

export const REACH_BY_KIND: Readonly<Record<PredicateKind, Reach>> = {
  app: "achievable",
  window: "achievable",
  ax_exists: "achievable",
  ax_focused: "achievable",
  display: "assertable",
  file: "assertable",
  permission: "assertable",
};

export interface Predicate {
  kind: PredicateKind;
  args: Record<string, string | number | boolean>;
  reach: Reach;
}

// --- slots -----------------------------------------------------------------

/** A `Slot.name`, resolved against `Graph.slots`. */
export type SlotRef = string;

/**
 * Slots live on the graph, not the action, so one slot can be referenced by
 * several edges. One sample is a constant that happens to be addressable; two or
 * more is a discovered variable (see merge.ts).
 *
 * `secret` is reserved and always false — secure-field content is recorded
 * verbatim, an explicit design decision.
 */
export interface Slot {
  name: string;
  samples: string[];
  secret: false;
}

// --- actions ---------------------------------------------------------------

/**
 * `wait` is load-bearing: replay waits on STATE, never sleeps on a recorded
 * duration. A dialog that took 400ms while recording takes seconds on a cold
 * start. `type` and `chord` are separate because text entry's unit is the string
 * while a chord's unit is the key combination — a command, not text.
 */
export type Action =
  | { kind: "click"; anchor: Anchor; button: number; count: number }
  | { kind: "drag"; from: Anchor; to: Anchor; path: Path; button: number }
  | { kind: "hover"; anchor: Anchor; dwellMs: number }
  | { kind: "scroll"; anchor: Anchor; delta: Vec2; steps: number }
  | { kind: "type"; slot: SlotRef; recorded: string }
  | { kind: "chord"; keys: string[] }
  | { kind: "wait"; until: Predicate; timeoutMs: number };

export type ActionKind = Action["kind"];

// --- graph -----------------------------------------------------------------

/** Whether the AI may intervene here, and how far. Default `select`. */
export type Intervene = "none" | "select" | "synthesize";

/**
 * A node is both a checkpoint (replay verifies state here) and an intervention
 * point (the AI may alter what happens next). Deliberately the same places: an AI
 * can only sensibly rewrite a trace where state is settled.
 */
export interface TraceNode {
  id: string;
  predicates: Predicate[];
  visual?: { frameBlobId: string; phash: string };
  intervene: Intervene;
  observations: number;
}

export interface TraceEdge {
  id: string;
  from: string;
  to: string;
  actions: Action[];
  guard?: Predicate[];
  provenance: "recorded" | "synthesized";
  observations: number;
  outcomes: { attempts: number; successes: number };
  liftWarnings?: string[];
}

export interface Graph {
  id: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  slots: Slot[];
  entry: string;
}

/** The output of lifting one session: a linear chain, merged into a Graph. */
export interface Trace {
  sessionId: string;
  /** In traversal order. */
  nodes: TraceNode[];
  /** `edges[i]` connects `nodes[i]` → `nodes[i+1]`. */
  edges: TraceEdge[];
  /** Each with exactly one sample. */
  slots: Slot[];
}

// --- injected seams --------------------------------------------------------

export interface FrameRef {
  frameId: string;
  phash: string;
}

/**
 * Visual corroboration for node identity. Injected by the caller so `trace/`
 * never depends on `represent/` or `retrieve/` — the same pattern the store's
 * reconciliation uses for its re-embed callback.
 */
export interface VisualMatcher {
  similar(ref: FrameRef, candidates: readonly FrameRef[]): Promise<number[]>;
}

/** Minimal event shape lifting needs. `EventRow` is structurally compatible. */
export interface TraceEvent {
  tMono: number;
  kind: string;
  x: number | null;
  y: number | null;
  data: unknown;
}

/** Minimal region shape anchors need. `RegionRow` is structurally compatible. */
export interface AnchorRegion {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// --- AI intervention wire contract -----------------------------------------

/**
 * Showing `atNode` alongside `observed` is deliberate: the model sees the DIFF
 * between expectation and reality, a far easier judgment for a small local model
 * than "here is a screen, decide what to do".
 */
export interface InterventionRequest {
  goal: string;
  /** What the recording expects here. */
  atNode: Predicate[];
  /** What is actually true now. */
  observed: Predicate[];
  options: { edgeId: string; summary: string; guard?: Predicate[] }[];
  slots: { name: string; samples: string[] }[];
  allow: "select" | "synthesize";
}

export interface InterventionResponse {
  choose?: string;
  bind?: Record<string, string>;
  /** Rejected unless the request carried `allow: "synthesize"`. */
  synthesize?: Action[];
  abort?: string;
}
