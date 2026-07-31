/**
 * Merge a linear Trace into a Graph. This is where variation stops being
 * something an AI invents and becomes something you recorded.
 *
 * Edge equivalence compares action kinds, order, and resolved anchors, but NOT
 * typed content — so two recordings differing only in what was typed collapse
 * into one edge with two slot observations. Slots are therefore discovered by
 * recording a task twice, not declared by hand.
 *
 * Merging never mutates its inputs: it builds a new Graph. A rejected or partial
 * merge therefore leaves the stored graph byte-identical.
 */

import { anchorKey } from "./anchors.js";
import { matchNode, type MatchOptions } from "./identity.js";
import type { Action, Graph, Slot, Trace, TraceEdge, TraceNode } from "./types.js";

/** Canonical per-action key. Excludes typed content and the slot name. */
export function actionSignature(a: Action): string {
  switch (a.kind) {
    case "click":
      return `click:${anchorKey(a.anchor)}:${a.button}:${a.count}`;
    case "drag":
      return `drag:${anchorKey(a.from)}->${anchorKey(a.to)}:${a.button}`;
    case "hover":
      return `hover:${anchorKey(a.anchor)}`;
    case "scroll":
      return `scroll:${anchorKey(a.anchor)}:${Math.sign(a.delta.x)},${Math.sign(a.delta.y)}`;
    case "type":
      // Neither the recorded value nor the slot name: two recordings that typed
      // into the same field are the same edge, and that is the whole point.
      return "type";
    case "chord":
      return `chord:${a.keys.join("+")}`;
    case "wait":
      return `wait:${a.until.kind}`;
  }
}

export function edgeSignature(e: TraceEdge): string {
  return e.actions.map(actionSignature).join("|");
}

export async function mergeTrace(
  graph: Graph | undefined,
  trace: Trace,
  opts: MatchOptions = {},
): Promise<Graph> {
  const next: Graph =
    graph === undefined
      ? { id: trace.sessionId, nodes: [], edges: [], slots: [], entry: "" }
      : {
          id: graph.id,
          nodes: graph.nodes.map((n) => ({ ...n, predicates: [...n.predicates] })),
          edges: graph.edges.map((e) => ({ ...e, actions: [...e.actions], outcomes: { ...e.outcomes } })),
          slots: graph.slots.map((s) => ({ ...s, samples: [...s.samples] })),
          entry: graph.entry,
        };

  // Map every trace node onto a graph node id, merging where identity allows.
  const idMap = new Map<string, string>();
  for (const tn of trace.nodes) {
    const result = await matchNode(tn, next.nodes, opts);
    if (result.nodeId !== undefined) {
      const existing = next.nodes.find((n) => n.id === result.nodeId)!;
      existing.observations += 1;
      idMap.set(tn.id, existing.id);
    } else {
      const fresh: TraceNode = { ...tn, predicates: [...tn.predicates] };
      next.nodes.push(fresh);
      idMap.set(tn.id, fresh.id);
    }
  }

  if (next.entry === "" && trace.nodes.length > 0) {
    next.entry = idMap.get(trace.nodes[0]!.id)!;
  }

  for (const te of trace.edges) {
    const from = idMap.get(te.from)!;
    const to = idMap.get(te.to)!;
    const sig = edgeSignature(te);
    const existing = next.edges.find((e) => e.from === from && e.to === to && edgeSignature(e) === sig);
    if (existing !== undefined) {
      existing.observations += 1;
      if (te.liftWarnings !== undefined) {
        existing.liftWarnings = [...(existing.liftWarnings ?? []), ...te.liftWarnings];
      }
    } else {
      next.edges.push({
        ...te,
        from,
        to,
        actions: [...te.actions],
        outcomes: { ...te.outcomes },
      });
    }
  }

  for (const s of trace.slots) {
    const existing = next.slots.find((x) => x.name === s.name);
    if (existing === undefined) {
      next.slots.push({ ...s, samples: [...s.samples] });
    } else {
      for (const sample of s.samples) {
        if (!existing.samples.includes(sample)) existing.samples.push(sample);
      }
    }
  }

  return next;
}

/** Slots with more than one observed value are the discovered variables. */
export function discoveredVariables(graph: Graph): Slot[] {
  return graph.slots.filter((s) => s.samples.length > 1);
}
