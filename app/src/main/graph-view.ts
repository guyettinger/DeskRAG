/**
 * The projection the Flows screen reads: a `Graph` becomes cards, wires, and
 * the routes recorded through them.
 *
 * Pure: no Electron, no Node, no I/O — which is what lets it live in the root
 * test suite rather than being eyeballed in the running app.
 */

import {
  shortId,
  type EdgeActionDTO,
  type EdgeSourceDTO,
  type FlowRouteDTO,
  type GraphDTO,
  type GraphEdgeDTO,
  type GraphNodeDTO,
  type NodeSourceDTO,
  type RouteVariantDTO,
  type RouteWalkDTO,
} from "@shared/types";
import { isLocatable } from "deskrag";
import type { Action, Anchor, EdgeSource, Graph, NodeSource, Predicate, TraceNode } from "deskrag";
// One definition of what a moment is, shared with the track rail and the
// keyframe markers. Both modules are pure and root-tested.
import { laneSec } from "./session-tracks.js";
// The one implementation of "these two are the same work", shared with
// `npm run probe:routes`, which is what chose its rule.
import {
  clusterRoutes,
  DEFAULT_CLUSTER_RULE,
  type ClusterRule,
} from "./route-cluster.js";

/**
 * Roles whose label names a STATE rather than a document. `Sheet` and `Dialog`
 * are kept in `STABLE_ROLES` for exactly this reason ("Open", "Save"), while
 * `Window` is excluded because its label is the open file.
 */
const HINT_ROLES: ReadonlySet<string> = new Set(["sheet", "dialog"]);

/**
 * Real data carries roles WITHOUT the `AX` prefix — the Swift sidecar strips it.
 * Predicate args are already canonical, so this is belt and braces; every
 * consumer of a role in this repo normalizes, and the one that did not produced
 * zero predicates from every recording.
 */
const canonical = (role: unknown): string =>
  typeof role === "string" ? role.replace(/^AX/i, "").toLowerCase() : "";

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/**
 * A node's name, from what nodes actually carry.
 *
 * There is no `window` predicate to use: `extractPredicates` never emits one and
 * `Window` is absent from `STABLE_ROLES`, both because a title is document
 * identity rather than state. Two nodes in one app with no sheet and no focused
 * element therefore label identically — the id chip on the card separates them,
 * and inventing a difference would be worse than showing there isn't one.
 */
export function labelNode(node: TraceNode): { label: string; app?: string; hint?: string } {
  const preds: readonly Predicate[] = node.predicates;
  const appName = str(preds.find((p) => p.kind === "app")?.args["app"]);

  const sheet = preds.find(
    (p) => p.kind === "ax_exists" && HINT_ROLES.has(canonical(p.args["role"])),
  );
  const focus = preds.find((p) => p.kind === "ax_focused");
  // The URL sits between them: a sheet names a state outright ("Save"), a URL
  // names WHICH web app you are in — the thing `app` is too coarse to say and
  // the only way two browser nodes are distinguishable on a card — and a focused
  // element is the weakest of the three, being wherever the caret happened to be.
  const url = preds.find((p) => p.kind === "url");
  const hint =
    str(sheet?.args["label"]) ?? str(url?.args["prefix"]) ?? str(focus?.args["label"]);

  if (appName === undefined && hint === undefined) {
    // The full id is a 30-char session-scoped ULID; this label is read in a
    // 180px card and in the review's route line.
    return { label: `${shortId(node.id)} — no state` };
  }
  const label =
    appName === undefined ? hint! : hint === undefined ? appName : `${appName} — ${hint}`;
  return {
    label,
    ...(appName !== undefined ? { app: appName } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}

/**
 * BFS distance from a root, first-seen winning so a merged loop does not
 * re-rank its target. A node unreachable from every root ranks 0 rather than
 * being dropped: an orphan is visible and fixable, an omitted node is not.
 *
 * EVERY ROOT, not only `graph.entry` — and the difference is not cosmetic. A
 * graph accretes across sessions, and two recordings that began in different
 * applications share no starting state, so an install genuinely has as many
 * roots as it has distinct openings. Walking from the declared entry alone left
 * every other chain at rank 0: measured on the real store, 15 of 22 nodes in one
 * flat row.
 *
 * That was invisible until the recorder was filtered out of the graph, and the
 * reason is worth keeping: the recording used to open on a node with NO
 * predicates, and a node with no predicates is vacuously true of every desktop,
 * so `matchNode` merged every session's first node into one. The graph looked
 * like a tree because it had a fake universal root. Removing it did not break
 * the ranking; it revealed that the ranking had only ever worked by accident.
 *
 * `graph.entry` is still seeded FIRST so first-seen-wins resolves ties the way
 * it always did.
 */
export function rankNodes(graph: Graph): Map<string, number> {
  const out = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const e of graph.edges) {
    const list = outgoing.get(e.from);
    if (list === undefined) outgoing.set(e.from, [e.to]);
    else list.push(e.to);
    hasIncoming.add(e.to);
  }

  const queue: string[] = [];
  const seed = (id: string): void => {
    if (out.has(id)) return;
    out.set(id, 0);
    queue.push(id);
  };
  if (graph.nodes.some((n) => n.id === graph.entry)) seed(graph.entry);
  // A root is a node nothing leads to. Seeded after the entry, in graph order,
  // so the walk is deterministic across reads.
  for (const n of graph.nodes) if (!hasIncoming.has(n.id)) seed(n.id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    const next = (out.get(id) ?? 0) + 1;
    for (const to of outgoing.get(id) ?? []) {
      if (out.has(to)) continue;
      out.set(to, next);
      queue.push(to);
    }
  }

  for (const n of graph.nodes) if (!out.has(n.id)) out.set(n.id, 0);
  return out;
}

/**
 * Resolve a FRAME id to the blob holding its bytes, or undefined.
 *
 * `TraceNode.visual.frameBlobId` is named for a blob but `lift.ts` stores
 * `snap.frameId` in it — a frame id, which `deskrag://frame/<blobId>` cannot
 * serve, because the protocol looks the id up in the blob table. Every card
 * rendered a broken image until this was measured in the running app.
 *
 * Injected rather than imported so this module stays pure and testable: the
 * same reason `trace/` takes its world through callbacks.
 */
export type ResolveFrameBlob = (frameId: string) => string | undefined;

/**
 * The id to print on each card: the bare suffix where that is unambiguous, and
 * widened with a slice of the session ULID where it is not.
 *
 * A graph accretes across sessions, so a second recording immediately produces
 * two nodes whose ids end `:n2`. Measured on the real graph: three cards
 * labelled "TextEdit" with chips `n2`, `n2`, `n3`. Since the label deliberately
 * does not distinguish same-app states, the chip was the only thing left that
 * could — so it has to.
 */
export function chipIds(ids: readonly string[]): Map<string, string> {
  const bySuffix = new Map<string, string[]>();
  for (const id of ids) {
    const s = shortId(id);
    const list = bySuffix.get(s);
    if (list === undefined) bySuffix.set(s, [id]);
    else list.push(id);
  }
  const out = new Map<string, string>();
  for (const [suffix, group] of bySuffix) {
    for (const id of group) {
      if (group.length === 1) {
        out.set(id, suffix);
        continue;
      }
      // The ULID's tail is its most-varying part, so a short slice separates
      // sessions recorded close together.
      const prefix = id.slice(0, Math.max(0, id.length - suffix.length - 1));
      out.set(id, prefix.length > 0 ? `${prefix.slice(-4)}:${suffix}` : suffix);
    }
  }
  return out;
}

/**
 * When each recording started, by session id. Injected for the same reason
 * `ResolveFrameBlob` is: this module stays pure, and the store is the caller's
 * problem. A source whose session is unknown is DROPPED rather than shown with
 * a fabricated time — it names a recording that is no longer there.
 */
export type ResolveSessionStart = (sessionId: string) => number | undefined;

/**
 * Where lane offset 0 sits for a recording, injected like `ResolveSessionStart`
 * and for the same reason.
 *
 * `atSec` is LANE seconds, and this module used to mint it as raw
 * `tMono / MS_PER_SEC` — which is the axis only when the video's first frame
 * happens to coincide with `t_mono` zero. It never does: capture runs while
 * ffmpeg is still spawning, measured at 1.9s of pre-roll on a real session, so
 * every jump from this screen landed that much early. The Library's own
 * keyframe markers were always computed correctly; two callers of one payload
 * disagreeing about what a moment IS is the drift the shared `laneSec` exists
 * to close.
 */
export type ResolveLaneOrigin = (sessionId: string) => number;

function toNodeSources(
  sources: readonly NodeSource[] | undefined,
  startedAt: ResolveSessionStart,
  laneOrigin: ResolveLaneOrigin,
): NodeSourceDTO[] {
  return (sources ?? []).flatMap((s) => {
    const at = startedAt(s.sessionId);
    return at === undefined
      ? []
      : [
          {
            sessionId: s.sessionId,
            startedAt: at,
            atSec: laneSec(s.tMono, laneOrigin(s.sessionId)),
          },
        ];
  });
}

function toEdgeSources(
  sources: readonly EdgeSource[] | undefined,
  startedAt: ResolveSessionStart,
  laneOrigin: ResolveLaneOrigin,
): EdgeSourceDTO[] {
  return (sources ?? []).flatMap((s) => {
    const at = startedAt(s.sessionId);
    if (at === undefined) return [];
    const origin = laneOrigin(s.sessionId);
    return [
      {
        sessionId: s.sessionId,
        startedAt: at,
        atSec: laneSec(s.tMonoStart, origin),
        throughSec: laneSec(s.tMonoEnd, origin),
      },
    ];
  });
}

/**
 * An edge's actions in words, with a typed action's slot samples attached.
 *
 * The samples come from the GRAPH's slots, which is where they live — a slot is
 * shared by every edge that references it, which is exactly what makes two
 * samples a discovered variable rather than two unrelated constants.
 */
function toEdgeActions(actions: readonly Action[], graph: Graph): EdgeActionDTO[] {
  return actions.map((a) => {
    const slot = a.kind === "type" ? graph.slots.find((s) => s.name === a.slot) : undefined;
    return {
      action: describeAction(a),
      target: describeTarget(a),
      ...(slot !== undefined ? { slot: { name: slot.name, samples: [...slot.samples] } } : {}),
    };
  });
}

export interface GraphViewOptions {
  resolveFrameBlob?: ResolveFrameBlob;
  sessionStart?: ResolveSessionStart;
  laneOrigin?: ResolveLaneOrigin;
}

export function toGraphDTO(graph: Graph, opts: GraphViewOptions = {}): GraphDTO {
  const ranks = rankNodes(graph);
  const chips = chipIds(graph.nodes.map((n) => n.id));
  const {
    resolveFrameBlob,
    sessionStart = (): undefined => undefined,
    // No resolver means t_mono zero, which is where a session with no video
    // starts anyway — the same fallback `laneOriginOf` takes.
    laneOrigin = (): number => 0,
  } = opts;

  const nodes: GraphNodeDTO[] = graph.nodes.map((n) => {
    const named = labelNode(n);
    // No resolver, or a frame with no blob, means NO image — the card degrades
    // to its text state, which is strictly better than a broken one.
    const blobId =
      n.visual === undefined || resolveFrameBlob === undefined
        ? undefined
        : resolveFrameBlob(n.visual.frameBlobId);
    return {
      id: n.id,
      label: named.label,
      chip: chips.get(n.id) ?? shortId(n.id),
      ...(named.app !== undefined ? { app: named.app } : {}),
      ...(named.hint !== undefined ? { hint: named.hint } : {}),
      ...(blobId !== undefined ? { frameBlobId: blobId } : {}),
      observations: n.observations,
      predicates: n.predicates.map(describePredicate),
      locatable: isLocatable(n.predicates),
      intervene: n.intervene,
      rank: ranks.get(n.id) ?? 0,
      sources: toNodeSources(n.sources, sessionStart, laneOrigin),
    };
  });

  const edges: GraphEdgeDTO[] = graph.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    actions: toEdgeActions(e.actions, graph),
    back: (ranks.get(e.to) ?? 0) <= (ranks.get(e.from) ?? 0),
    provenance: e.provenance,
    observations: e.observations,
    sources: toEdgeSources(e.sources, sessionStart, laneOrigin),
    ...(e.liftWarnings !== undefined ? { liftWarnings: [...e.liftWarnings] } : {}),
  }));

  return {
    id: graph.id,
    entry: graph.entry,
    nodes,
    edges,
    slots: graph.slots.map((s) => ({ name: s.name, samples: [...s.samples] })),
  };
}

export const describePredicate = (p: Predicate): string => {
  const args = Object.entries(p.args)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
  return `${p.kind}(${args})`;
};

/** What the action does, in a reader's words rather than an enum's. */
export function describeAction(a: Action): string {
  switch (a.kind) {
    case "click":
      return a.count > 1 ? `${a.count}× click` : "click";
    case "drag":
      return "drag";
    case "hover":
      return `hover ${a.dwellMs}ms`;
    case "scroll":
      return "scroll";
    case "type":
      return "type";
    case "chord":
      return `press ${a.keys.join("+")}`;
    case "wait":
      return `wait until ${describePredicate(a.until)}`;
  }
}

const describeAnchor = (anchor: Anchor): string => {
  const ax = anchor.ax;
  if (ax === undefined) {
    return `point (${Math.round(anchor.point.x)}, ${Math.round(anchor.point.y)})`;
  }
  const parts = [ax.role];
  if (ax.label !== undefined && ax.label.length > 0) parts.push(`"${ax.label}"`);
  if (ax.identifier !== undefined && ax.identifier.length > 0) parts.push(`#${ax.identifier}`);
  return parts.join(" ");
};

/**
 * The target as RECORDED — the descriptors lifting captured, never a live
 * resolution. Nothing here resolves anything against a running desktop, which
 * is the whole difference between this screen and the one it replaced.
 */
export function describeTarget(a: Action): string {
  switch (a.kind) {
    case "click":
    case "hover":
    case "scroll":
      return describeAnchor(a.anchor);
    case "drag":
      return `${describeAnchor(a.from)} → ${describeAnchor(a.to)}`;
    case "type":
      return `slot ${a.slot}`;
    case "chord":
    case "wait":
      return "—";
  }
}

// --- flows -----------------------------------------------------------------

/** Hops shown in a route's label before it is elided. */
const MAX_ROUTE_HOPS = 4;

/**
 * A ROUTE IS KEYED BY THE STATES IT PASSES THROUGH, NAMED — the sequence of
 * `labelNode` labels, with consecutive repeats and stateless nodes dropped.
 *
 * THE TWO STRICTER KEYS WERE BOTH MEASURED AND BOTH FAILED, on a real graph of
 * 9 recordings, 17 nodes and 44 edges:
 *
 * - **Edge sequence** (the obvious one): 9 routes, every one ×1. Five of those
 *   recordings were the same task — open Calculator, use it, come back — and
 *   they differed only in HOW MANY times a button was pressed, so the exact
 *   edge sequence split them 4/5/6/8 steps apart.
 * - **Node-id sequence**: also 9 routes, every one ×1, and for a more
 *   interesting reason. Equivalent states across recordings DO NOT MERGE into
 *   one node: identity is task-derived, so a Calculator state whose outgoing
 *   edge targets a different button is a genuinely different node, and
 *   `matchNode` correctly declines. Node identity therefore cannot express "the
 *   same place" across recordings at all.
 *
 * The label sequence found the repetition the other two missed: 5 routes, one
 * of them ×5. That is not a loosening for its own sake — a `labelNode` label is
 * app plus its distinguishing hint (a sheet's name, a URL prefix, the focused
 * element), which is precisely the granularity at which a person says "I do
 * this a lot".
 *
 * A stateless node contributes nothing and is dropped: a node with no
 * predicates is vacuously true of every desktop — the UI says exactly that
 * about such nodes — so it cannot help say which flow this is.
 *
 * STILL NEVER A GRAPH TRAVERSAL. Every route is grouped from recordings that
 * actually happened and `count` counts real sessions, so a graph with no
 * provenance yields NO routes and the screen says why. What loosening the key
 * costs is precision of highlight: several distinct paths can share a route, so
 * `nodeIds`/`edgeIds` are the UNION of what its recordings walked — "these five
 * recordings all did this, and here is everywhere they went".
 */
/** One stretch a route's recording actually walked. */
export interface RouteSpan {
  sessionId: string;
  tMonoStart: number;
  tMonoEnd: number;
}

/** A composed level covering some of a span, and how much of it. */
export interface CoveringSummary {
  text: string;
  /** 1 for a task, 2 for a process, and so on. The root is the largest. */
  level: number;
  coveredMs: number;
}

/**
 * Name a route from what its recordings actually did.
 *
 * The route's KEY is unchanged and must stay that way. Summaries are
 * NONDETERMINISTIC — a re-index can reword every one of them — so re-keying on
 * them would change a route's identity on every rebuild. Names change;
 * identities must not. This is also why the key survived two measured
 * alternatives (edge-id and node-id sequences, 9 routes all x1 apiece).
 *
 * Walk up from level 1 and take the LOWEST level at which a single node covers
 * the majority of the span, so a route is named at the altitude it actually
 * occupies rather than a fixed one. Nothing qualifying returns null, and the
 * caller keeps the label sequence — the honest answer for a route that is not
 * one task.
 *
 * Recordings disagree sometimes. The dominant name wins and its COUNT is
 * reported; the names are never merged into one sentence, the same rule
 * `observations`/`sources` follows.
 */
export function nameRoute(
  spans: readonly RouteSpan[],
  covering: (span: RouteSpan) => CoveringSummary[],
): { name: string | null; observations: number } {
  const votes = new Map<string, number>();
  for (const span of spans) {
    const total = span.tMonoEnd - span.tMonoStart;
    if (total <= 0) continue;
    const best = covering(span)
      .filter((c) => c.coveredMs * 2 > total)
      .sort((a, b) => a.level - b.level)[0];
    if (best === undefined) continue;
    votes.set(best.text, (votes.get(best.text) ?? 0) + 1);
  }
  let name: string | null = null;
  let observations = 0;
  for (const [text, n] of votes) {
    // Strictly greater, so a tie keeps the first-inserted name and the result
    // is stable across reads rather than following Map iteration order.
    if (n > observations) {
      name = text;
      observations = n;
    }
  }
  return { name, observations };
}

export function frequentRoutes(
  graph: Graph,
  /**
   * The composed levels covering a stretch of one recording. Injected, so this
   * module stays a pure projection and keeps its place in the ROOT suite —
   * `DeskRagService.flows()` is the only thing that reads the store.
   */
  covering: (span: RouteSpan) => CoveringSummary[] = () => [],
  /**
   * When two routes are the same work. Parameterised for ONE reason:
   * `npm run probe:routes` compares rules by calling this function with each of
   * them, so what it measures is what actually ships. A probe that re-grouped
   * the keys itself would be measuring a second implementation — the
   * `ax-dump`/`ax-exec` drift hazard, in the instrument rather than the code.
   */
  rule: ClusterRule = DEFAULT_CLUSTER_RULE,
): FlowRouteDTO[] {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  /** Undefined for a node that describes no state, which names no place. */
  const placeOf = (id: string): string | undefined => {
    const n = nodeById.get(id);
    if (n === undefined) return shortId(id);
    return n.predicates.length === 0 ? undefined : labelNode(n).label;
  };

  /** session -> the edges it walked, with the moment it walked each. */
  const walked = new Map<string, { edgeId: string; at: number }[]>();
  for (const edge of graph.edges) {
    for (const source of edge.sources ?? []) {
      const list = walked.get(source.sessionId);
      const step = { edgeId: edge.id, at: source.tMonoStart };
      if (list === undefined) walked.set(source.sessionId, [step]);
      else list.push(step);
    }
  }

  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
  interface Group {
    places: string[];
    nodeIds: string[];
    /** The UNION, for the canvas highlight. Never rendered as steps. */
    edgeIds: string[];
    sessionIds: string[];
    /** What each recording actually walked. Parallel to `sessionIds`. */
    walks: RouteWalkDTO[];
    /** One stretch per recording — what the route's name is derived from. */
    spans: RouteSpan[];
  }
  const byKey = new Map<string, Group>();

  for (const [sessionId, steps] of walked) {
    // A session can walk one edge more than once (a loop), so the order is by
    // the recorded moment — the graph's own edge order would be wrong.
    const ordered = [...steps].sort((a, b) => a.at - b.at);
    const edgeIds = ordered.map((s) => s.edgeId);
    if (edgeIds.length === 0) continue;
    // The recording's whole walk, end to end: the summaries covering it are
    // what name the route.
    const span: RouteSpan = {
      sessionId,
      tMonoStart: ordered[0]!.at,
      tMonoEnd: Math.max(
        ...ordered.map((s) => edgeById.get(s.edgeId)?.sources?.[0]?.tMonoEnd ?? s.at),
      ),
    };

    const nodeIds: string[] = [];
    for (const edgeId of edgeIds) {
      const edge = edgeById.get(edgeId);
      if (edge === undefined) continue;
      if (nodeIds.length === 0) nodeIds.push(edge.from);
      nodeIds.push(edge.to);
    }

    const places: string[] = [];
    for (const id of nodeIds) {
      const place = placeOf(id);
      // Staying in one app across six states is one hop, not six.
      if (place !== undefined && places[places.length - 1] !== place) places.push(place);
    }
    if (places.length === 0) continue;

    const key = places.join(" → ");
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        places,
        nodeIds,
        edgeIds,
        sessionIds: [sessionId],
        walks: [{ sessionId, edgeIds: [...edgeIds] }],
        spans: [span],
      });
      continue;
    }
    // The union, in first-walked order: these recordings share a shape, not a
    // path, so the HIGHLIGHT has to show everywhere they actually went.
    //
    // The per-recording walk is kept BESIDE it rather than thrown away, because
    // the union is not a path and numbering it asserts an order no recording
    // walked. `edgeIds` answers "what should light up"; `walks` answers "what
    // did this recording do", and only the second can become a step list.
    existing.sessionIds.push(sessionId);
    existing.walks.push({ sessionId, edgeIds: [...edgeIds] });
    existing.spans.push(span);
    for (const id of nodeIds) if (!existing.nodeIds.includes(id)) existing.nodeIds.push(id);
    for (const id of edgeIds) if (!existing.edgeIds.includes(id)) existing.edgeIds.push(id);
  }

  // --- the same work, walked slightly differently -------------------------
  //
  // Everything above groups by EXACT equality of the place sequence, which is
  // right about what a route IS and wrong about when two of them are one: a
  // side trip through Finder renames the key, and identical work lands as two
  // routes of ×1 that never look like a habit. `route-cluster.ts` merges those,
  // and merges WHOLE groups so the session ids still partition — which is what
  // keeps `bindSkill`'s strict majority a proof rather than a threshold.
  //
  // Most-walked first, then SHORTEST, so a cluster is named after the walk most
  // recordings took and — between two walked equally often — the one without
  // the detour. The detour is the variant; naming the route after it would
  // publish a procedure with a side trip in the middle of it.
  const ordered = [...byKey].sort(
    ([ka, a], [kb, b]) =>
      b.sessionIds.length - a.sessionIds.length ||
      a.places.length - b.places.length ||
      ka.localeCompare(kb),
  );
  const clusters = clusterRoutes(
    ordered.map(([key, g]) => ({ key, places: g.places, count: g.sessionIds.length })),
    rule,
  );
  const groupOf = new Map(ordered);

  const merged: { key: string; group: Group; variants: RouteVariantDTO[] }[] = clusters.map(
    (cluster) => {
      const canonical = groupOf.get(cluster.canonical.key)!;
      // The canonical group's own arrays are never mutated — a merge builds a
      // new one, so running this twice over one `byKey` gives one answer.
      const group: Group = {
        places: canonical.places,
        nodeIds: [...canonical.nodeIds],
        edgeIds: [...canonical.edgeIds],
        sessionIds: [...canonical.sessionIds],
        walks: [...canonical.walks],
        spans: [...canonical.spans],
      };
      const variants: RouteVariantDTO[] = [];
      for (const member of cluster.members) {
        if (member.key === cluster.canonical.key) continue;
        const g = groupOf.get(member.key)!;
        group.sessionIds.push(...g.sessionIds);
        group.walks.push(...g.walks);
        group.spans.push(...g.spans);
        // The UNION again, and for the same reason: the highlight has to light
        // up everywhere the recordings actually went, including the detour.
        for (const id of g.nodeIds) if (!group.nodeIds.includes(id)) group.nodeIds.push(id);
        for (const id of g.edgeIds) if (!group.edgeIds.includes(id)) group.edgeIds.push(id);
        const v = cluster.variants.find((x) => x.key === member.key);
        variants.push({
          key: member.key,
          label: member.places.join(" → "),
          count: g.sessionIds.length,
          extraHops: v?.extraHops ?? -1,
          sessionIds: [...g.sessionIds],
        });
      }
      return { key: cluster.canonical.key, group, variants };
    },
  );

  const routes: FlowRouteDTO[] = merged.map(({ key: id, group: g, variants }) => {
    const named = nameRoute(g.spans, covering);
    return {
    id,
    variants,
    count: g.sessionIds.length,
    name: named.name,
    nameObservations: named.observations,
    label:
      g.places.length > MAX_ROUTE_HOPS
        ? `${g.places.slice(0, MAX_ROUTE_HOPS).join(" → ")} → …`
        : g.places.join(" → "),
    nodeIds: g.nodeIds,
    edgeIds: g.edgeIds,
    sessionIds: g.sessionIds,
    walks: g.walks,
    };
  });

  // Most-walked first, then longest — a route walked five times is the
  // headline, and between two equally-walked routes the longer one says more.
  // The final tie breaks on the key so the order is stable across reloads
  // rather than depending on Map iteration of whatever the store returned.
  routes.sort(
    (a, b) => b.count - a.count || b.edgeIds.length - a.edgeIds.length || a.id.localeCompare(b.id),
  );
  return routes;
}
