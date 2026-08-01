/**
 * The projection the reviewer reads.
 *
 * Pure: no Electron, no Node, no I/O — which is what lets it live in the root
 * test suite. It is the last thing between a `Plan` and a human authorizing a
 * click, so it is tested rather than eyeballed.
 */

import {
  shortId,
  type GraphDTO,
  type GraphEdgeDTO,
  type GraphNodeDTO,
  type PlanDTO,
  type PlanStepDTO,
} from "@shared/types";
import { isRepairStep, isSupersededStep } from "deskrag";
import type { Action, Anchor, Graph, Plan, PlanStep, Predicate, TraceNode } from "deskrag";

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
  const hint = str(sheet?.args["label"]) ?? str(focus?.args["label"]);

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
 * BFS distance from the entry, first-seen winning so a merged loop does not
 * re-rank its target. A node unreachable from the entry ranks 0 rather than
 * being dropped: an orphan is visible and fixable, an omitted node is not.
 */
export function rankNodes(graph: Graph): Map<string, number> {
  const out = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = outgoing.get(e.from);
    if (list === undefined) outgoing.set(e.from, [e.to]);
    else list.push(e.to);
  }

  const queue: string[] = [];
  if (graph.nodes.some((n) => n.id === graph.entry)) {
    out.set(graph.entry, 0);
    queue.push(graph.entry);
  }
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

export function toGraphDTO(graph: Graph, resolveFrameBlob?: ResolveFrameBlob): GraphDTO {
  const ranks = rankNodes(graph);
  const chips = chipIds(graph.nodes.map((n) => n.id));

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
      intervene: n.intervene,
      rank: ranks.get(n.id) ?? 0,
    };
  });

  const edges: GraphEdgeDTO[] = graph.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    actions: e.actions.length,
    back: (ranks.get(e.to) ?? 0) <= (ranks.get(e.from) ?? 0),
    provenance: e.provenance,
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

/** What the step does, in a reviewer's words rather than an enum's. */
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
 * The target as RECORDED. Deliberately not sourced from the resolution: the
 * resolution is where the action will land, and the review has to show both so a
 * disagreement between them is visible rather than smoothed over.
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

const stepDTO = (s: PlanStep): PlanStepDTO => {
  if (isRepairStep(s)) {
    return {
      kind: "repair",
      edgeId: s.edgeId,
      app: s.app,
      launch: s.launch,
      reason: s.reason,
    };
  }
  if (isSupersededStep(s)) {
    return {
      kind: "superseded",
      edgeId: s.edgeId,
      action: describeAction(s.action),
      reason: s.reason,
    };
  }
  return {
    kind: "action",
    edgeId: s.edgeId,
    action: describeAction(s.action),
    target: describeTarget(s.action),
    ...(s.resolution !== undefined
      ? { layer: s.resolution.layer, confidence: s.resolution.confidence }
      : {}),
    ...(s.slotBinding !== undefined ? { slot: s.slotBinding } : {}),
  };
};

/**
 * `handoffApp` is the app the reviewer's window will be handed back to. It is
 * rendered as the plan's FIRST step because that is when it happens — inside
 * `arm`, before `executePlan` posts anything. Undefined when the `from` node
 * carries no `app` predicate: there is nothing to name, and the window is hidden
 * regardless.
 */
export function toPlanDTO(plan: Plan, graph: Graph, segment: number, handoffApp?: string): PlanDTO {
  const labelOf = (id: string): string => {
    const n = graph.nodes.find((x) => x.id === id);
    return n === undefined ? id : labelNode(n).label;
  };

  const steps: PlanStepDTO[] = [
    ...(handoffApp !== undefined ? [{ kind: "handoff" as const, app: handoffApp }] : []),
    ...plan.steps.map(stepDTO),
  ];

  return {
    id: plan.id,
    segment,
    from: plan.from,
    to: plan.to,
    fromLabel: labelOf(plan.from),
    toLabel: labelOf(plan.to),
    steps,
    blockers: plan.blockers.map((b) => ({ reason: b.reason, scope: b.scope })),
    brittleness: plan.brittleness.map((b) => ({
      edgeId: b.edgeId,
      axRate: b.axRate,
      belowFloor: b.belowFloor,
      bound: b.bound,
    })),
    ...(plan.cut !== undefined
      ? {
          cut: {
            resumeAt: plan.cut.resumeAt,
            edgeId: plan.cut.edgeId,
            attempts: plan.cut.attempts.map((a) => ({ layer: a.layer, rejected: a.rejected })),
          },
        }
      : {}),
    remainder: plan.remainder.map((r) => ({
      edgeId: r.edgeId,
      toNodeId: r.toNodeId,
      actions: r.actions.map((a) => ({
        kind: a.kind,
        ...(a.descriptors !== undefined ? { descriptors: [...a.descriptors] } : {}),
        ...(a.recordedPoint !== undefined ? { recordedPoint: { ...a.recordedPoint } } : {}),
        ...(a.slot !== undefined ? { slot: a.slot } : {}),
      })),
      repairs: r.repairs.map((p) => ({ app: p.app, launch: p.launch })),
    })),
    ...(plan.drift !== undefined ? { drift: { ...plan.drift } } : {}),
  };
}
