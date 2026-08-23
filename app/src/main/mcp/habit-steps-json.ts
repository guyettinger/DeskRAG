/**
 * `steps.json` — a habit's steps as data, to sit beside a pasted HABIT.md.
 *
 * Progressive disclosure, the SKILL.md convention: metadata (`list_habits`),
 * then body (`get_habit`), then bundled files (this). Agents parse prose badly,
 * and the record is prose because prose is right for the thing a person keeps.
 *
 * NO RECORDED VALUE APPEARS HERE, and `showSamples` is not consulted. That is
 * stricter than honouring the toggle, and the reason is `habit-marks.ts`'s rule
 * one level down: whether the rendered FILE prints values is a per-habit toggle,
 * and a payload has no toggle, so it carries none at all. A file a person
 * deliberately turned values on for is not a JSON body handed to a background
 * process over a socket. The slot NAME travels; the samples do not exist here.
 *
 * `arrivesWhen` is the destination node's PREDICATES, which is what "anchor"
 * means at this seam — there is none on the DTO layer, and a node's predicates
 * are its whole identity, so they answer "how do I know I have arrived".
 * `locatable: false` is the matching disclosure: such a node is satisfied by
 * every observation in its application and cannot say which state this is.
 */

import type { FlowsDTO, HabitDTO, HabitStepDTO } from "@shared/types";

interface StepJson {
  index: number;
  edgeId: string;
  from: string;
  to: string;
  toNodeId: string | null;
  actions: { action: string; target: string; slot?: string }[];
  observations: number;
  everyRecording: boolean;
  missing: boolean;
  liftWarnings: string[];
  firstAt: { sessionId: string; atSec: number } | null;
  /** The destination state's predicates, or null with a stated reason. */
  arrivesWhen: string[] | null;
  arrivesWhenAbsent?: string;
  locatable: boolean | null;
}

const NO_GRAPH_REASON =
  "there is no trace graph on this machine, so no state could be resolved for this step";
const NO_EDGE_REASON =
  "this step's edge is not in the trace graph, so its destination state is unknown — the label above is the stored copy";

function toStepJson(step: HabitStepDTO, flows: FlowsDTO | null): StepJson {
  const edge = flows?.graph.edges.find((e) => e.id === step.edgeId);
  const node = edge === undefined ? undefined : flows?.graph.nodes.find((n) => n.id === edge.to);
  const base: StepJson = {
    index: step.index,
    edgeId: step.edgeId,
    from: step.from,
    to: step.to,
    toNodeId: node?.id ?? null,
    actions: step.actions.map((a) => ({
      action: a.action,
      target: a.target,
      // `exactOptionalPropertyTypes`: a conditional spread, never `slot: undefined`.
      ...(a.slot !== undefined ? { slot: a.slot.name } : {}),
    })),
    observations: step.observations,
    everyRecording: step.everyRecording,
    missing: step.missing,
    liftWarnings: [...step.liftWarnings],
    firstAt:
      step.firstAt === null
        ? null
        : { sessionId: step.firstAt.sessionId, atSec: step.firstAt.atSec },
    arrivesWhen: node === undefined ? null : [...node.predicates],
    locatable: node?.locatable ?? null,
  };
  if (node === undefined) {
    base.arrivesWhenAbsent = flows === null ? NO_GRAPH_REASON : NO_EDGE_REASON;
  }
  return base;
}

/** The document, or the reason there isn't one. */
export function habitStepsJson(
  habit: HabitDTO,
  flows: FlowsDTO | null,
): string | { error: string } {
  if (habit.ways.length === 0) {
    return {
      error:
        `Habit ${habit.id} has no live steps: the route it was written from is no longer in ` +
        "the trace graph. `get_habit` still returns the file, whose steps are a stored copy " +
        "that has not been re-checked against any recording.",
    };
  }
  return JSON.stringify(
    {
      habitId: habit.id,
      slug: habit.slug,
      title: habit.title,
      version: habit.version,
      routeKey: habit.binding.routeKey,
      apps: [...habit.apps],
      note:
        "Recorded steps, generated from the user's own recordings. Slot NAMES only — no " +
        "recorded keystroke value appears in this file. `arrivesWhen` is the state each step " +
        "arrives in; when it is null, `arrivesWhenAbsent` says why.",
      ways: habit.ways.map((w) => ({
        letter: w.letter,
        recordings: w.sessionIds.length,
        steps: w.steps.map((s) => toStepJson(s, flows)),
      })),
    },
    null,
    2,
  );
}
