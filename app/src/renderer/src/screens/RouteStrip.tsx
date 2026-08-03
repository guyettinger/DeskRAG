/**
 * The thread between the two modes: the node chain this segment traverses.
 *
 * The chain is derived rather than carried — `PlanDTO` has `from`/`to` and the
 * steps carry `edgeId`, so walking `graph.edges` reconstructs the intermediate
 * nodes and the DTO needs no new field.
 */

import React from "react";
import { shortId, type GraphDTO, type PlanDTO } from "@shared/types";

/**
 * `plan.from`, then the destination of each distinct edge the steps name, in
 * step order. An edge id with no match in the graph is skipped rather than
 * breaking the chain: a plan is always built from the graph it is shown with,
 * so this can only happen if they have drifted, and a short chain is a better
 * failure than none.
 */
export function routeNodeIds(plan: PlanDTO, graph: GraphDTO): string[] {
  const byId = new Map(graph.edges.map((e) => [e.id, e]));
  const out = [plan.from];
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (step.kind === "handoff") continue;
    if (seen.has(step.edgeId)) continue;
    seen.add(step.edgeId);
    const edge = byId.get(step.edgeId);
    if (edge !== undefined) out.push(edge.to);
  }
  return out;
}

export function RouteStrip({
  plan,
  graph,
  onBack,
  pending,
}: {
  plan: PlanDTO | null;
  graph: GraphDTO;
  onBack: () => void;
  pending: boolean;
}): React.JSX.Element {
  const chips = plan === null ? [] : routeNodeIds(plan, graph);
  const labelFor = (id: string): string => graph.nodes.find((n) => n.id === id)?.chip ?? shortId(id);

  return (
    <div className="route">
      <button className="gbtn" onClick={onBack} title="Look at the graph — this does not cancel">
        ⟵ graph
      </button>
      <div className="route__chain">
        {chips.map((id, i) => (
          <React.Fragment key={`${id}-${i}`}>
            {i > 0 && <span className="route__link" />}
            <span className={`route__node${i === chips.length - 1 ? " is-dest" : ""}`} title={id}>
              {labelFor(id)}
            </span>
          </React.Fragment>
        ))}
      </div>
      {pending && <span className="route__pending">awaiting approval</span>}
    </div>
  );
}
