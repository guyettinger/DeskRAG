/**
 * WHERE THE WAYS FORK, as one graph rather than as six prose lists.
 *
 * The section used to be a row of inert chips over an indented list of phrases
 * — `Way A: nothing here`, `Way B: first, 1 step: n0 — no state → Calculator`.
 * Measured on the author's real store that is six ways and three divergence
 * points rendered as fourteen lines, half of which say that nothing happened.
 * A reader could not see that Ways D and E take the SAME shortcut, or that F's
 * detour is nine steps long, without reading every line and holding it.
 *
 * `HabitForkDTO.rows` already IS a lattice: a spine row is a step every way
 * took, and a fork row is what each way did in the gap. Nothing here re-derives
 * that alignment — `foldFork` folds the flat rows exactly once, in
 * `way-fork-view.ts`, and this places the result.
 *
 * IT COMPOSES NO WORDS about the run. Every phrase on the DTO is written by
 * `app/src/main/way-fork.ts` so the screen and the rendered file cannot say
 * different things; a place name and an action tally are read from the step.
 *
 * A `.ts` module, never `.tsx`, so the root suite can reach it — the rule
 * `habit-portrait.ts`, `habit-rhythm.ts` and `way-fork-view.ts` state. Layout
 * for data a person reads before trusting a habit has real failure modes, and
 * `graph-layout.ts` is in the suite for that same reason.
 *
 * NO SCORE. A wire's weight is HOW MANY WAYS cross it, which is a count of
 * paths on the page and not a judgement about any of them.
 */

import type { HabitForkDTO, HabitStepDTO, HabitWayDTO } from "@shared/types";
import { actionSummary, toneOf } from "./habit-record-view.js";
import { foldFork } from "./way-fork-view.js";

/**
 * A PILL, not a card.
 *
 * Flows draws 180x132 nodes because each carries a keyframe and the question
 * there is "do I recognise this screen". The question here is the SHAPE of the
 * divergence, and a diagram that answers it has to fit a route's whole fork on
 * one screen — the real store's longest branch is nine steps. So a node is a
 * place, a tally and a tone, at a third of the height.
 */
export const LNODE_W = 172;
export const LNODE_H = 52;
export const LANE_GAP = 26;
/**
 * The gap between rows, and it is a MEASUREMENT rather than a spacing token.
 *
 * The real store's longest branch is nine steps, so this multiplies by fifteen
 * rows: at 30 the diagram measured 1230px in the running app, which is more
 * scrolling than a fork of six ways is worth. At 22 the wires still read as
 * curves rather than as kinks and the whole graph is ~1100px.
 */
export const ROW_GAP = 22;
/** Breathing room around the world, so a pill is not flush against the edge. */
const MARGIN = 20;

export interface LatticeNode {
  id: string;
  /** `origin` has no step of its own: it is where a way's first step began. */
  kind: "origin" | "spine" | "branch";
  /** The place this node IS — a step's arrival, or an origin's departure. */
  place: string;
  /** "12 clicks · types {note}". Empty where nothing was recorded. */
  summary: string;
  /** `--data-N`'s N, or null for a place whose step named no application. */
  toneSlot: number | null;
  /** Ways whose path passes through here, ascending. Never empty. */
  ways: number[];
  /** The earliest recording that walked the step, or null. See `HabitStepDTO`. */
  firstAt: HabitStepDTO["firstAt"];
  x: number;
  y: number;
}

export interface LatticeEdge {
  id: string;
  from: string;
  to: string;
  /** Ways that cross this wire, ascending. Its weight, never a score. */
  ways: number[];
  /** An SVG path `d`, in world coordinates. */
  d: string;
}

/** One way's whole path, which is exactly the set that lights when it is picked. */
export interface LatticePath {
  way: number;
  letter: string;
  nodes: string[];
  edges: string[];
}

export interface Lattice {
  nodes: LatticeNode[];
  edges: LatticeEdge[];
  paths: LatticePath[];
  width: number;
  height: number;
}

/** A band's groups, and the rows they need. Internal to `layoutWays`. */
interface Group {
  /** The PLACE sequence, so two ways doing the identical thing collapse to one. */
  key: string;
  ways: number[];
  steps: HabitStepDTO[];
}

/**
 * THE BRANCHES OF ONE GAP, with identical runs COLLAPSED.
 *
 * Ways B, D and E all take the same single step at the start of the real
 * store's route, and drawing three parallel copies of one step would say they
 * differ.
 *
 * GROUPED ON PLACE LABELS, NOT ON EDGE IDS — `way-fork.ts`'s `placeKey`, and
 * for the measurement recorded there rather than for a preference: the real
 * store's Ways share EXACTLY ONE EDGE between them, because a node's identity
 * is what the task does next, so two recordings of the same button mashing lift
 * to different nodes and therefore different edges. This grouped on edge ids
 * first, and the running app showed exactly what that comment predicts —
 * B, D and E drew as THREE separate pills of one step, and the next gap
 * collapsed A, B and F while leaving C beside them. The fork this reads was
 * already aligned on places; grouping its output any other way re-splits what
 * it just matched.
 *
 * The key cannot be shared as code: `way-fork.ts` lives in main, which imports
 * electron, and takes `FlowStep` where this takes `HabitStepDTO`. It is the
 * same join over the same two fields.
 *
 * The empty group — ways that did nothing in this gap — is kept and is what
 * lets the trunk be drawn as a wire rather than as a node nobody walked.
 */
function groupRuns(
  runs: readonly { way: number; steps: number[] }[],
  ways: readonly HabitWayDTO[],
): Group[] {
  // A NUL delimiter, for `placeKey`'s reason: a place label cannot contain one,
  // so the joined key cannot collide. Written as an ESCAPE and never as a
  // literal byte — two literal NULs in `store.ts` are why `grep` skips it.
  const by = new Map<string, Group>();
  for (const run of runs) {
    const steps = run.steps.flatMap((i) => {
      const s = ways[run.way]?.steps[i];
      return s === undefined ? [] : [s];
    });
    const key = steps.map((s) => `${s.from}\0${s.to}`).join("\u0001");
    const seen = by.get(key);
    if (seen === undefined) by.set(key, { key, ways: [run.way], steps });
    else seen.ways.push(run.way);
  }
  return [...by.values()];
}

/**
 * A branch's lane, as an offset in node widths from the spine.
 *
 * THE SPINE IS ALWAYS THE CENTRE COLUMN. When some ways pass a gap without
 * moving, those ways ARE the trunk, so lane 0 belongs to them and the branches
 * fan out around it: a diagram whose middle column wanders would stop reading
 * as "the shared route, with detours off it". Where every way detours there is
 * no trunk in that gap, and the centre is free.
 *
 * `-1, +1, -2, +2 …` in group order, so the assignment is deterministic —
 * `layoutGraph`'s rule, and for the same reason: a layout that reshuffled
 * between renders would twitch on every reload.
 */
function laneOffsets(count: number, trunk: boolean): number[] {
  const out: number[] = [];
  let step = 1;
  if (!trunk) out.push(0);
  while (out.length < count) {
    out.push(-step);
    if (out.length < count) out.push(step);
    step += 1;
  }
  return out.slice(0, count);
}

/** Centred around zero, for a row of peers with no trunk between them. */
function centred(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i - (count - 1) / 2);
}

/**
 * Every node, every wire, and each way's own path through them.
 *
 * The paths are built FIRST, one per way, and the edges are derived from them
 * as consecutive pairs. That ordering is what makes the picture and the
 * highlight provably agree: an edge exists because some way crosses it, so
 * there is no wire a highlight can miss and no highlighted wire that is not
 * drawn. Deriving edges from the band structure instead would need the
 * straight-through case, the multi-step branch and the trailing band handled
 * three separate times.
 */
export function layoutWays(
  fork: HabitForkDTO,
  ways: readonly HabitWayDTO[],
  tones: Map<string, number>,
): Lattice {
  const view = foldFork(fork, ways);

  const nodes: LatticeNode[] = [];
  const at = new Map<string, LatticeNode>();
  /** Each way's node ids, in order. Edges fall out of this. */
  const walk = new Map<number, string[]>();
  for (let w = 0; w < ways.length; w += 1) walk.set(w, []);

  const add = (
    id: string,
    kind: LatticeNode["kind"],
    place: string,
    step: HabitStepDTO | null,
    members: readonly number[],
    row: number,
    lane: number,
  ): void => {
    const node: LatticeNode = {
      id,
      kind,
      place,
      summary: step === null ? "" : actionSummary(step.actions),
      toneSlot: toneOf(step?.app ?? null, tones),
      ways: [...members].sort((a, b) => a - b),
      firstAt: step?.firstAt ?? null,
      x: lane * (LNODE_W + LANE_GAP),
      y: row * (LNODE_H + ROW_GAP),
    };
    nodes.push(node);
    at.set(id, node);
    for (const w of members) walk.get(w)?.push(id);
  };

  /* --- the origins ------------------------------------------------------- *
   * A ROUTE'S WAYS NEED NOT START IN THE SAME PLACE, and on the real store
   * they do not: three ways open at `n0 — no state` and three at `Calculator`.
   * A single origin node would assert a shared beginning that is not there,
   * and printing `from → to` on every first node instead would double a place
   * the diagram prints once everywhere else — the spine's own rule.
   */
  const origins: { place: string; ways: number[] }[] = [];
  for (let w = 0; w < ways.length; w += 1) {
    const first = ways[w]?.steps[0];
    if (first === undefined) continue;
    const found = origins.find((o) => o.place === first.from);
    if (found === undefined) origins.push({ place: first.from, ways: [w] });
    else found.ways.push(w);
  }
  const originLanes = centred(origins.length);
  origins.forEach((o, i) => {
    const id = `o:${i}`;
    add(id, "origin", o.place, null, o.ways, 0, originLanes[i]!);
  });

  /* --- the bands and the spine ------------------------------------------- */

  let row = origins.length === 0 ? 0 : 1;

  const band = (index: number, runs: readonly { way: number; steps: number[] }[]): void => {
    const groups = groupRuns(runs, ways);
    const moving = groups.filter((g) => g.steps.length > 0);
    if (moving.length === 0) return;
    const trunk = groups.length > moving.length;
    const lanes = laneOffsets(moving.length, trunk);

    moving.forEach((g, i) => {
      g.steps.forEach((step, j) => {
        add(`b:${index}:${i}:${j}`, "branch", step.to, step, g.ways, row + j, lanes[i]!);
      });
    });
    row += Math.max(...moving.map((g) => g.steps.length));
  };

  band(-1, view.leading.map((r) => ({ way: r.way, steps: r.steps })));

  view.steps.forEach((s, i) => {
    // A spine step is one step, so any way's copy of it carries the same
    // actions — the first is read rather than merged, which is what makes the
    // tally on the pill the step's own and not a sum across ways.
    const rep = s.at[0];
    const step = rep === undefined ? null : (ways[rep.way]?.steps[rep.step] ?? null);
    add(`s:${i}`, "spine", s.to, step, s.at.map((a) => a.way), row, 0);
    row += 1;
    band(i, s.after.map((r) => ({ way: r.way, steps: r.steps })));
  });

  /* --- the wires, derived from the paths ---------------------------------- */

  // SHIFTED BEFORE THE WIRES ARE DRAWN. A lane is a SIGNED offset from the
  // spine, so the leftmost branch sits at a negative x and would be clipped by
  // the viewport; a wire computed before the shift would then be drawn against
  // coordinates nothing else uses. One translation, once, and only then geometry.
  const left = Math.min(0, ...nodes.map((n) => n.x));
  for (const n of nodes) n.x = n.x - left + MARGIN;

  const byPair = new Map<string, LatticeEdge>();
  const paths: LatticePath[] = [];

  for (let w = 0; w < ways.length; w += 1) {
    // `add` appends in draw order and origins are added first, so a way's
    // origin is already the head of its own list.
    const ids = walk.get(w) ?? [];
    const edges: string[] = [];
    for (let i = 1; i < ids.length; i += 1) {
      const id = `${ids[i - 1]}>${ids[i]}`;
      const seen = byPair.get(id);
      if (seen === undefined) {
        byPair.set(id, {
          id,
          from: ids[i - 1]!,
          to: ids[i]!,
          ways: [w],
          d: wire(at.get(ids[i - 1]!)!, at.get(ids[i]!)!),
        });
      } else if (!seen.ways.includes(w)) {
        seen.ways.push(w);
      }
      if (!edges.includes(id)) edges.push(id);
    }
    paths.push({ way: w, letter: ways[w]?.letter ?? String(w), nodes: ids, edges });
  }

  const edges = [...byPair.values()];
  for (const e of edges) e.ways.sort((a, b) => a - b);

  return {
    nodes,
    edges,
    paths,
    // A fork with no steps anywhere draws nothing, and `Math.max()` of an empty
    // list is -Infinity — a world of negative size renders as a blank SVG with
    // no error at all.
    width: nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.x + LNODE_W)) + MARGIN,
    height: nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.y + LNODE_H)) + MARGIN,
  };
}

/**
 * A wire leaves the bottom of one pill and enters the top of the next.
 *
 * `graph-layout.ts`'s forward wire exactly, and only that one: this graph has
 * no back edges by construction — the fork is an alignment of finite step
 * sequences, so every wire points strictly down a row.
 */
function wire(a: LatticeNode, b: LatticeNode): string {
  const x1 = a.x + LNODE_W / 2;
  const x2 = b.x + LNODE_W / 2;
  const y1 = a.y + LNODE_H;
  const y2 = b.y;
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

/**
 * Wire weight from how many ways cross it.
 *
 * Sub-linear, `GraphCanvas`'s rule: the question is "is this the shared route
 * or a detour", not "by exactly how many". Linear width would make the trunk of
 * a six-way route a black bar that hides everything crossing it.
 */
export function wayWireWidth(count: number): number {
  return Math.min(5, 1.4 + Math.log2(Math.max(1, count)) * 1.3);
}
