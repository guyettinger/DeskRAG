/**
 * A recorded route as step-by-step procedural text — the answer to "how did I
 * do this last time, and what changed between attempts".
 *
 * Pure, and it re-uses the projection the Flows screen already reads:
 * `EdgeActionDTO.action` is already "3× click" and `target` is already
 * `Button "Send"`, because `graph-view.ts` put them in a reader's words. This
 * module only walks and formats.
 */

import type { EdgeActionDTO, FlowRouteDTO, FlowsDTO, GraphEdgeDTO } from "@shared/types";

/** A route by its id, or undefined — the caller reports the miss. */
export function findRoute(flows: FlowsDTO, routeId: string): FlowRouteDTO | undefined {
  return flows.routes.find((r) => r.id === routeId);
}

function when(startedAt: number, atSec: number): string {
  return new Date(startedAt + atSec * 1000).toISOString().replace("T", " ").slice(0, 16);
}

/**
 * One action line.
 *
 * A slot with TWO OR MORE samples is a discovered variable — the thing recording
 * a task twice produces, and the reason `trace/` refuses to let a model invent
 * variation. One sample is just a value that happened to be typed, and calling
 * it a variable would overstate the evidence.
 */
function actionLine(a: EdgeActionDTO): string {
  const head = `    ${a.action.padEnd(12)} ${a.target}`;
  if (a.slot === undefined) return head;
  const samples = a.slot.samples.map((s) => JSON.stringify(s)).join(", ");
  const varies = a.slot.samples.length >= 2 ? " — varies between recordings" : "";
  return `${head}\n      slot \`${a.slot.name}\`: ${samples}${varies}`;
}

function stepLines(edge: GraphEdgeDTO, index: number, labelOf: (id: string) => string): string[] {
  const out = [`Step ${index + 1} — ${labelOf(edge.from)}  ⟶  ${labelOf(edge.to)}`];
  if (edge.actions.length === 0) out.push("    (no actions recorded on this edge)");
  out.push(...edge.actions.map(actionLine));

  const walked =
    edge.observations === 1 ? "walked once" : `walked by ${edge.observations} recordings`;
  const first = edge.sources[0];
  // `sources` can be SHORTER than `observations` — a graph lifted before
  // provenance has none, and deleting a recording removes its sources while
  // leaving the count. Never derive one from the other; print what each says.
  const seen =
    first === undefined ? "" : `, first at ${when(first.startedAt, first.atSec)}`;
  out.push(`    · ${walked}${seen}`);

  for (const w of edge.liftWarnings ?? []) out.push(`    · lifting note: ${w}`);
  return out;
}

export function renderFlow(flows: FlowsDTO, route: FlowRouteDTO): string {
  const nodeById = new Map(flows.graph.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(flows.graph.edges.map((e) => [e.id, e]));
  const labelOf = (id: string): string => nodeById.get(id)?.label ?? `${id} (unknown state)`;

  const out: string[] = [];
  out.push(route.name ?? route.label);
  if (route.name !== null) out.push(route.label);

  // One recording is not a habit. An agent told "this is how you do it" from a
  // single walk would be over-reading the evidence, so the count leads.
  out.push(
    route.count === 1
      ? "Recorded once."
      : `Recorded ${route.count} times.` +
          (route.name !== null && route.nameObservations < route.count
            ? ` ${route.nameObservations} of ${route.count} recordings agreed on that name.`
            : ""),
  );
  out.push("");

  route.edgeIds.forEach((id, i) => {
    const edge = edgeById.get(id);
    if (edge === undefined) {
      // Skipping it would make the flow read as shorter than it was.
      out.push(`Step ${i + 1} — edge ${id} is not in the graph (index defect)`, "");
      return;
    }
    out.push(...stepLines(edge, i, labelOf), "");
  });

  return out.join("\n").trimEnd();
}

export function renderFlowList(flows: FlowsDTO): string {
  if (flows.routes.length === 0) {
    // Routes are NEVER synthesized from traversal: a merged graph composes paths
    // no recording ever walked, and offering those as "your common flows" would
    // present something the user has never done as a habit. So an empty list is
    // a real state with a specific remedy, not an absence of data.
    return (
      "No recorded routes. A route is a path a recording actually walked, so " +
      "this is empty when the trace graph carries no provenance — press " +
      "`Rebuild trace graph` in the app (Library → Recordings) and try again."
    );
  }
  return flows.routes
    .map((r) => {
      const times = r.count === 1 ? "1 recording" : `${r.count} recordings`;
      return `${r.name ?? r.label}\n  id: ${r.id}\n  ${times} · ${r.edgeIds.length} step(s)\n  states: ${r.label}`;
    })
    .join("\n\n");
}
