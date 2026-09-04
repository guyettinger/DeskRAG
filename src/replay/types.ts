/**
 * The executor's vocabulary. Types plus the two tuning constants and the one
 * scoring function that belongs with them.
 *
 * `replay/` is a leaf: it imports `trace/` and `embed/types` and nothing else
 * from the library. Everything external — the live AX tree, actuation, the
 * keyboard layout — arrives through the interfaces declared here.
 */

import type { Keymap } from "../capture/env/types.js";
import type { UIElement } from "../embed/types.js";
import type {
  Action,
  Anchor,
  Graph,
  Predicate,
  Reach,
  Rect,
  Vec2,
  VisualMatcher,
} from "../trace/types.js";

export type { UIElement, Keymap };
export type { Predicate, Reach, Rect, Vec2, Anchor, Action, Graph, VisualMatcher };

/** The anchor ladder, best first. */
export type ResolvedLayer = "identifier" | "path" | "label" | "visual" | "point";

/**
 * The confidence a layer can reach before geometric disagreement reduces it.
 *
 * Ranked by RELIABILITY, not availability — availability turned out to be a
 * property of the application's AX implementation rather than of the descriptor.
 * Measured across three implementations: AXIdentifier appears on 67% of AX
 * anchors in TextEdit (AppKit), 9% in Chrome (Chromium), and 20% in System
 * Settings (SwiftUI), which has no usable labels at all. Ranking by "whichever
 * we saw most" would have encoded one app as a general rule.
 *
 * `path` is deliberately ABSENT from this table: its trust is not a constant.
 * See `pathCeiling`.
 */
export const LAYER_CEILING: Readonly<Record<Exclude<ResolvedLayer, "path">, number>> = {
  identifier: 1.0,
  label: 0.8,
  visual: 0.5,
  point: 0.3,
};

/** Steps in an ancestor chain: `Window[0]>Group[0]>Button[1]` is 3. */
export const pathDepth = (path: string): number => (path.length === 0 ? 0 : path.split(">").length);

const PATH_CEILING_MAX = 0.95;
const PATH_DEPTH_DECAY = 0.035;
/** Kept above `visual` so the path rung is always tried before it. */
const PATH_CEILING_MIN = 0.55;

/**
 * How much a positional path is trusted, given its depth.
 *
 * A path is the only descriptor always present, but its reliability collapses as
 * it lengthens: every step is an ordinal among same-role siblings, so a sibling
 * inserted at ANY level shifts it. Depth is therefore the honest measure of how
 * brittle a particular path is.
 *
 * This is a function rather than a constant because the three AX implementations
 * measured disagree about whether to prefer label or path, and they disagree
 * *because their depths differ* — AppKit averages 4, Chromium 11.4 (max 17),
 * SwiftUI 7.4. A fixed order helps one and hurts another; ranking by decayed
 * trust serves all three with one rule. The crossover sits just above depth 5,
 * so native paths outrank a label and web paths fall behind it.
 */
export function pathCeiling(depth: number): number {
  const decayed = PATH_CEILING_MAX - PATH_DEPTH_DECAY * Math.max(0, depth - 1);
  return Math.min(1, Math.max(PATH_CEILING_MIN, decayed));
}

/** The ceiling for any layer, given the anchor's path depth where relevant. */
export function ceilingFor(layer: ResolvedLayer, depth = 0): number {
  return layer === "path" ? pathCeiling(depth) : LAYER_CEILING[layer];
}

/** Below this, a layer is rejected and the ladder falls through. */
export const DEFAULT_MIN_CONFIDENCE = 0.25;

/**
 * An edge whose targets resolve below the `visual` rung more often than not
 * cannot be armed without an explicit override. 0.5 is a starting point, not a
 * finding: the measured whole-graph rate is 55%, so this gates roughly half of
 * real edges — the intended aggressiveness for a system whose first act is
 * clicking a real desktop.
 */
export const BRITTLENESS_FLOOR = 0.5;

/** One rung's worth of AX descriptor — a projection of `Anchor["ax"]`. */
export interface AxDescriptor {
  identifier?: string;
  path?: string;
  role: string;
  label?: string;
}

/**
 * Where a descriptor landed, and IN WHAT.
 *
 * `surfaceOrigin` is the top-left of the surface the element actually sits in —
 * the nearest enclosing `Window`, `Menu`, `Sheet`, `Popover` or `Drawer`, which
 * is what the window server calls a window even when accessibility does not.
 *
 * It exists because a MENU IS A WINDOW TO THE OS AND A CHILD TO ACCESSIBILITY.
 * macOS reports an open context menu as the focused window, so `focus_change`
 * carries the menu's frame and `windowRelative` is recorded against it — while
 * the AX tree nests `Menu` under the app window with no `Window` element of its
 * own. Judging that element against the app window's origin collapsed agreement
 * to zero and vetoed identifier, label and path alike, each having FOUND it.
 *
 * Optional because only a resolver that can see the ancestor chain can answer
 * it; one that cannot leaves it absent and the caller's `windowOrigin` stands,
 * which is exactly the previous behaviour.
 */
export interface LocateHit {
  handle: number;
  bounds: Rect;
  surfaceOrigin?: Vec2;
}

/** The AX roles that are a SURFACE — what the OS would call a window. */
export const SURFACE_ROLES: readonly string[] = ["Window", "Menu", "Sheet", "Popover", "Drawer"];

/** Resolve a descriptor against the live tree. Returns null when it is gone. */
export type Locate = (d: AxDescriptor) => Promise<LocateHit | null>;

/**
 * One observation of the live desktop: the tree PLUS the facts that are not in
 * it. `app` and `window` predicates are sourced from `PredicateContext`, which
 * at lift time comes from `focus_change` events — at replay there is no event
 * stream, so without these a live tree yields only `ax_exists` and no node
 * carrying an `app` predicate can ever verify.
 *
 * They travel with the tree in ONE call deliberately. Sourcing two halves of a
 * single fact separately is what made boundary snapshots describe the previous
 * application; an app name fetched a moment after the tree has the same hazard.
 */
export interface AxObservation {
  elements: UIElement[];
  /** Frontmost application's display name, matching what capture recorded. */
  app?: string;
  /** Focused window title. */
  windowTitle?: string;
  /**
   * The page URL, when the frontmost app is showing one.
   *
   * `lift` emits a `url` predicate for every browser node (from `url_change`),
   * and `verifyNode` requires expected ⊆ observed — so an observation with no
   * URL fails EVERY browser node, and `locateNode`, which requires a satisfied
   * verify, never proposes one. Both sidecars already read `AXURL` during their
   * walk; this is the field that carries it the rest of the way.
   */
  url?: string;
}

/** `activated` — raised. `launched` — started, then raised. */
export type ActivateOutcome = "activated" | "launched" | "not-running";

/**
 * Everything that touches the desktop. `execute.ts` depends only on this, which
 * is what makes the suite structurally incapable of posting a real event.
 */
export interface Actuator {
  /** Live AX tree of the frontmost app, plus app/window, for verification. */
  dump(): Promise<AxObservation>;
  /**
   * Which applications are running, by `localizedName`. INERT — this is the read
   * planning uses to decide between a repair step and a blocker. Planning must
   * never call `activate` to find out, because that would activate the app and
   * change the world the plan is describing.
   */
  runningApps(): Promise<string[]>;
  /** Raise `app`, or launch it when `launch` is true. Execution only. */
  activate(app: string, launch: boolean): Promise<ActivateOutcome>;
  locate(d: AxDescriptor): Promise<LocateHit | null>;
  moveTo(p: Vec2): Promise<void>;
  click(p: Vec2, button: number, count: number): Promise<void>;
  dragPath(samples: readonly { p: Vec2; atMs: number }[], button: number): Promise<void>;
  scroll(p: Vec2, delta: Vec2, steps: number): Promise<void>;
  key(keycode: number, modifiers: readonly string[], down: boolean): Promise<void>;
}

export interface Resolution {
  layer: ResolvedLayer;
  /** Where the action will actually go. */
  point: Vec2;
  bounds?: Rect;
  /**
   * [0,1] — how much the resolved target AGREES with the recorded one. Starts at
   * the layer's ceiling and is reduced by geometric disagreement. It is NOT a
   * probability that the action will succeed; nothing here can know that.
   */
  confidence: number;
  /** Layers tried and why each was rejected — the brittleness record. */
  attempts: { layer: ResolvedLayer; rejected: string }[];
}

export interface PlannedAction {
  edgeId: string;
  action: Action;
  /** Absent for `chord`, `type`, and `wait`, which have no spatial target. */
  resolution?: Resolution;
  slotBinding?: { name: string; value: string };
}

/**
 * A step the EXECUTOR synthesized to reach a state, as opposed to one the user
 * recorded. Activation is not an `Action` because `Action` is the IR — recorded
 * behaviour — and nothing recorded this; keeping it separate is also what stops
 * this feature from reaching into `src/trace/`.
 */
export interface RepairStep {
  repair: "activate";
  /**
   * The edge this repair belongs to. Execution finds a node boundary by asking
   * which edge a step ends, and a repair is the LAST step of a cross-app edge —
   * without this it would be the one step kind that cannot answer.
   */
  edgeId: string;
  app: string;
  /**
   * Whether execution may LAUNCH the app rather than only raise it. Decided at
   * plan time and recorded here, so the review shows exactly what will happen —
   * an override that only lived in the executor's options would be a launch the
   * plan never disclosed.
   */
  launch: boolean;
  /** The unmet predicate this repairs, so the plan can explain itself. */
  reason: string;
}

/**
 * An action the plan will NOT post, kept visible so the review explains itself.
 * A repair that replaces a recorded app switch must be disclosed, never silent —
 * the same rule that makes activation a visible step rather than an implicit one.
 */
export interface SupersededStep {
  superseded: "activate";
  edgeId: string;
  action: Action;
  /** Why it is not being posted, in the reviewer's words. */
  reason: string;
}

/** A recorded action, a synthesized repair, or an action the repair replaces. */
export type PlanStep = PlannedAction | RepairStep | SupersededStep;

// Both guards key on a field unique to their variant, so `PlannedAction` stays
// the fall-through case — a caller that only knows about actions keeps working.
export const isRepairStep = (s: PlanStep): s is RepairStep => "repair" in s;
export const isSupersededStep = (s: PlanStep): s is SupersededStep => "superseded" in s;

/** An `assertable` predicate that does not hold, or an unusable `type` action. */
export interface Blocker {
  predicate?: Predicate;
  reason: string;
  /**
   * Blockers span the WHOLE run. `assertable` means no UI action can produce the
   * predicate, so checking a remainder node against the present observation is
   * valid — an unreachable goal is knowable before anything is posted.
   */
  scope: "segment" | "remainder";
}

export interface EdgeBrittleness {
  edgeId: string;
  /** Share of this edge's targets that resolved to an AX rung. */
  axRate: number;
  belowFloor: boolean;
  /**
   * `measured` — resolved against the live tree. `upper` — a remainder edge,
   * where the rate is a deductive CEILING rather than an observation: an anchor
   * with no `ax` layer can never reach an AX rung, at any time, by any
   * mechanism. That is arithmetic over the recording, not a forecast.
   */
  bound: "measured" | "upper";
}

/** Where greedy resolution stopped, and why. */
export interface SegmentCut {
  /** Node to re-observe and re-plan from — the `from` of the first unplanned edge. */
  resumeAt: string;
  edgeId: string;
  /** `resolveAnchor`'s own record of which rungs were tried and how each failed. */
  attempts: { layer: ResolvedLayer; rejected: string }[];
}

/**
 * What a remainder action discloses. Descriptor presence is a fact about the
 * RECORDING, not a forecast of what the anchor will resolve to — the plan does
 * not claim to know where an unresolved action will land.
 */
export interface RemainderAction {
  kind: Action["kind"];
  descriptors?: ("identifier" | "label" | "path" | "visual")[];
  /** Where it was recorded. Provenance, never presented as a target. */
  recordedPoint?: Vec2;
  slot?: string;
}

export interface RemainderEdge {
  edgeId: string;
  toNodeId: string;
  actions: RemainderAction[];
  /** Repairs this edge would need, from the same inert `runningApps` read. */
  repairs: RepairStep[];
}

export interface Plan {
  id: string;
  graphId: string;
  /** Node id observed at plan time. */
  from: string;
  /** Goal node id. */
  to: string;
  steps: PlanStep[];
  /** Non-empty means the plan cannot be armed. */
  blockers: Blocker[];
  brittleness: EdgeBrittleness[];
  /**
   * Absent when the plan reaches the goal in one segment — today's behaviour,
   * and the shape the 2026-07-31 single-click run produces.
   */
  cut?: SegmentCut;
  /** Edges beyond the cut: disclosed, deliberately unresolved. */
  remainder: RemainderEdge[];
  /** Set when the previous segment did not land where it said it would. */
  drift?: { expected: string; observed: string };
}

export interface ReplayInput {
  graph: Graph;
  actuator: Actuator;
  /**
   * The layout to type through, in reverse (char -> keycode). NOT optional and
   * NOT defaulted: the lift resolved keycode -> char against a captured keymap,
   * and typing through a different one is silently wrong text. A US-QWERTY
   * fallback is exactly what the capture spec rejected a static table to avoid.
   */
  keymap: Keymap;
  /** Optional visual corroboration for the `visual` rung. */
  visualMatcher?: VisualMatcher;
}

/** What `locateNode` concluded. `candidates` is reported whatever the outcome. */
export interface NodeLocation {
  nodeId?: string;
  candidates: number;
  ambiguous: boolean;
}

/**
 * The QUERY-TIME half of the recency litmus, for `edgeCost`.
 *
 * `edgeCost` ranks by a raw lifetime tally, so a workflow walked twelve times
 * last spring and abandoned outranks one walked four times last week, forever.
 * The correction is a time preference in the cost function — which is evaluated
 * per query — and NOT a decay applied to `TraceEdge.observations`, which counts
 * what was seen and must keep meaning that. See docs/internals/persistence.md.
 *
 * `startedAt` is injected because the wall clock is not in `trace/` to be read:
 * `EdgeSource` carries `sessionId` and `t_mono` only, and `session.started_at`
 * is joined at query time. That is the litmus already holding at the schema,
 * and it is what keeps `replay/` a leaf.
 */
export interface EdgeRecency {
  /** Wall clock a recording started at, or null when it cannot be dated. */
  startedAt: (sessionId: string) => number | null;
  /** Reference time to measure staleness against. */
  now: number;
  /** Milliseconds after which a walk counts half. */
  halfLifeMs: number;
}

export interface RunInput extends ReplayInput {
  goalNodeId: string;
  /**
   * Weight observations by how recently they were made. ABSENT BY DEFAULT, and
   * absence is the pre-existing behaviour exactly.
   */
  recency?: EdgeRecency;
  /**
   * The review gate. `replay/` never decides to act; the caller does. Injected
   * for the same reason `Actuator` is — it keeps the decision outside this
   * package, so an AI-in-the-loop caller can supply it later without `replay/`
   * growing a policy of its own.
   */
  arm: (plan: Plan) => Promise<boolean>;
  slotBindings?: Record<string, string>;
  allowLaunch?: boolean;
  override?: boolean;
  /** Runaway guard. Default 8. */
  maxSegments?: number;
  pollMs?: number;
}

export type RunStop =
  | "declined"
  | "not-located"
  | "no-path"
  | "no-progress"
  | "max-segments"
  | "failed";

export interface RunOutcome {
  goalNodeId: string;
  reached: boolean;
  segments: { plan: Plan; outcome: ExecOutcome }[];
  stopped?: RunStop;
}

export interface ExecOutcome {
  planId: string;
  completed: boolean;
  stepsRun: number;
  failure?: { step: number; reason: string };
  telemetry: { edgeId: string; layer: ResolvedLayer; confidence: number }[];
}

const area = (r: Rect): number => Math.max(0, r.w) * Math.max(0, r.h);
const centre = (r: Rect): Vec2 => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * How much `actual` agrees with `recorded`, in [0,1] — the product of area
 * similarity and centre proximity. Proximity is normalized by the recorded box's
 * diagonal, so "far" means far RELATIVE TO THE TARGET: 40px is a different
 * distance for a menu item than for a window.
 */
export function agreement(recorded: Rect, actual: Rect): number {
  const aR = area(recorded);
  const aA = area(actual);
  const areaRatio = aR > 0 && aA > 0 ? Math.min(aR, aA) / Math.max(aR, aA) : 0;

  const cR = centre(recorded);
  const cA = centre(actual);
  const dist = Math.hypot(cA.x - cR.x, cA.y - cR.y);
  const diag = Math.hypot(recorded.w, recorded.h);
  // A degenerate recorded box has no scale to judge against, so proximity is
  // unknowable rather than perfect.
  const proximity = diag > 0 ? Math.max(0, 1 - dist / diag) : 0;

  const score = areaRatio * proximity;
  return Math.min(1, Math.max(0, score));
}
