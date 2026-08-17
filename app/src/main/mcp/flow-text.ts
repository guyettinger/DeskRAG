/**
 * A recorded route as step-by-step procedural text — the answer to "how did I
 * do this last time, and what changed between attempts".
 *
 * Pure, and it re-uses the projection the Flows screen already reads:
 * `EdgeActionDTO.action` is already "3× click" and `target` is already
 * `Button "Send"`, because `graph-view.ts` put them in a reader's words. This
 * module only walks and formats.
 */

import type { FlowRouteDTO, FlowsDTO } from "@shared/types";
import { flowSteps, type FlowStep, type FlowStepAction } from "../flow-steps.js";

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
 *
 * This prints recorded VALUES unconditionally, and deliberately keeps doing so:
 * `get_flow` is a shipped contract, documented in `docs/mcp.md` as returning
 * "the values that varied between attempts". The SKILL.md renderer makes the
 * opposite default choice for its own reasons — a file that gets pasted
 * elsewhere is a different exposure from a tool result — and the two differ here
 * rather than in the walk they share.
 */
function actionLine(a: FlowStepAction): string {
  const head = `    ${a.action.padEnd(12)} ${a.target}`;
  if (a.slot === undefined) return head;
  const samples = a.slot.samples.map((s) => JSON.stringify(s)).join(", ");
  const varies = a.slot.samples.length >= 2 ? " — varies between recordings" : "";
  return `${head}\n      slot \`${a.slot.name}\`: ${samples}${varies}`;
}

function stepLines(step: FlowStep): string[] {
  const out = [`Step ${step.index + 1} — ${step.from}  ⟶  ${step.to}`];
  if (step.actions.length === 0) out.push("    (no actions recorded on this edge)");
  out.push(...step.actions.map(actionLine));

  const walked =
    step.observations === 1 ? "walked once" : `walked by ${step.observations} recordings`;
  // `sources` can be SHORTER than `observations` — a graph lifted before
  // provenance has none, and deleting a recording removes its sources while
  // leaving the count. Never derive one from the other; print what each says.
  const seen =
    step.firstAt === null ? "" : `, first at ${when(step.firstAt.startedAt, step.firstAt.atSec)}`;
  out.push(`    · ${walked}${seen}`);

  for (const w of step.liftWarnings) out.push(`    · lifting note: ${w}`);
  return out;
}

export function renderFlow(flows: FlowsDTO, route: FlowRouteDTO): string {
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

  for (const step of flowSteps(flows, route)) {
    if (step.missing) {
      // Skipping it would make the flow read as shorter than it was.
      out.push(`Step ${step.index + 1} — edge ${step.edgeId} is not in the graph (index defect)`, "");
      continue;
    }
    out.push(...stepLines(step), "");
  }

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
      "`Rebuild trace graph` in the app (Settings → Maintenance) and try again."
    );
  }
  return flows.routes
    .map((r) => {
      const times = r.count === 1 ? "1 recording" : `${r.count} recordings`;
      return `${r.name ?? r.label}\n  id: ${r.id}\n  ${times} · ${r.edgeIds.length} step(s)\n  states: ${r.label}`;
    })
    .join("\n\n");
}
