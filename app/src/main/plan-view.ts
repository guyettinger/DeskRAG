/**
 * The projection the reviewer reads.
 *
 * Pure: no Electron, no Node, no I/O — which is what lets it live in the root
 * test suite. It is the last thing between a `Plan` and a human authorizing a
 * click, so it is tested rather than eyeballed.
 */

import type { GraphDTO, GraphEdgeDTO, GraphNodeDTO } from "@shared/types";
import type { Graph, Predicate, TraceNode } from "deskrag";

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
    return { label: `${node.id} — no state` };
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

export function toGraphDTO(graph: Graph): GraphDTO {
  const ranks = rankNodes(graph);

  const nodes: GraphNodeDTO[] = graph.nodes.map((n) => {
    const named = labelNode(n);
    return {
      id: n.id,
      label: named.label,
      ...(named.app !== undefined ? { app: named.app } : {}),
      ...(named.hint !== undefined ? { hint: named.hint } : {}),
      ...(n.visual !== undefined ? { frameBlobId: n.visual.frameBlobId } : {}),
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
