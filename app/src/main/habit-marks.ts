/**
 * B's projection, mapped into the three fields the Habits screen draws.
 *
 * A pure module rather than a method on `DeskRagService`, which imports electron
 * and therefore cannot be constructed by the root suite at all — the same
 * constraint that produced `habit-doc.ts`, and the reason `probe:merge` and
 * `probe:reflect` exist. Everything decidable is decided here, where a test can
 * watch it.
 *
 * FACTS ONLY. The display state — canonical, deviated, stopped short — is
 * derived in `habits-view.ts`, which is `.ts` so the root suite can reach it
 * too. Deciding it here would put a rendering choice on the wrong side of the
 * process boundary, where no root test can see it change.
 */

import type {
  DroppedEarlyDTO,
  FlowRouteDTO,
  FlowsDTO,
  HabitForkDTO,
  HabitForkRowDTO,
  HabitSlotDTO,
  HabitStepDTO,
  HabitTimingsDTO,
  HabitWayDTO,
  WalkFitDTO,
} from "@shared/types";
import { flowVariables, flowWalks, variantLetter, type FlowStep } from "./flow-steps.js";
import { slotNote, taggedCautions } from "./habit-doc.js";
import { walkAnalysis } from "./walk-analysis.js";
import { runPhrase, wayFork } from "./way-fork.js";

/**
 * Each recording's fit against the standard, keyed by session.
 *
 * EMPTY, never a map of zeroes, when there is no standard: `walkAnalysis`
 * returns `baseline.wayIndex === null` for a route recorded once, and a fit of
 * all-zeroes would be indistinguishable from a recording that matched. The
 * screen's `fit: null` says "nothing was compared" and must stay able to.
 */
export function walkFits(flows: FlowsDTO, route: FlowRouteDTO): Map<string, WalkFitDTO> {
  const out = new Map<string, WalkFitDTO>();
  if (route.count < 2) return out;

  const analysis = walkAnalysis({ flows, route });
  if (analysis.baseline.wayIndex === null || analysis.walks.length < 2) return out;

  for (const w of analysis.walks) {
    out.set(w.sessionId, {
      inserted: w.deviations.filter((d) => d.kind === "inserted").length,
      skipped: w.deviations.filter((d) => d.kind === "skipped").length,
      reordered: w.deviations.filter((d) => d.kind === "reordered").length,
      reachedEnd: w.reachedEnd,
    });
  }
  return out;
}

/**
 * A step, stripped to what the instrument draws.
 *
 * `FlowStepAction` carries a `slot` with its recorded `samples`; this keeps the
 * NAME and drops the samples. Whether the rendered FILE prints values is a
 * per-habit toggle, and the DTO that feeds a pixel has no toggle — so it
 * carries no values at all, the same rule `HabitBrief` holds against the model.
 * A name is not a value: the record prints slot names unconditionally.
 */
function toStep(step: FlowStep): HabitStepDTO {
  return {
    index: step.index,
    edgeId: step.edgeId,
    from: step.from,
    to: step.to,
    app: step.app,
    actions: step.actions.map((a) => ({
      action: a.action,
      target: a.target,
      // `exactOptionalPropertyTypes` — a conditional spread, never `slot: undefined`.
      ...(a.slot !== undefined ? { slot: { name: a.slot.name } } : {}),
    })),
    observations: step.observations,
    everyRecording: step.everyRecording,
    liftWarnings: [...step.liftWarnings],
    missing: step.missing,
    firstAt:
      step.firstAt === null
        ? null
        : {
            sessionId: step.firstAt.sessionId,
            startedAt: step.firstAt.startedAt,
            atSec: step.firstAt.atSec,
          },
  };
}

/**
 * The record's Ways, structured.
 *
 * `flowWalks` and `variantLetter` are the record's OWN functions, so the
 * instrument and the file cannot letter or order the ways differently. Two
 * renderers of one thing is the `ax-dump`/`ax-exec` drift hazard; they are safe
 * here only because both read this same `FlowWalk[]`, and neither parses the
 * other's output.
 */
export function habitWays(flows: FlowsDTO, route: FlowRouteDTO): HabitWayDTO[] {
  const totalMs = new Map(
    route.walks.map((w) => [w.sessionId, Math.max(0, Math.round((w.throughSec - w.atSec) * 1000))]),
  );
  return flowWalks(flows, route).map((w) => ({
    letter: variantLetter(w.index),
    sessionIds: [...w.sessionIds],
    steps: w.steps.map(toStep),
    // Dropped, never zeroed — a zero would read as an instantaneous recording
    // and would drag a printed range's floor to 0.0s.
    totalsMs: w.sessionIds.flatMap((id) => {
      const ms = totalMs.get(id);
      return ms === undefined ? [] : [ms];
    }),
  }));
}

/**
 * Where the ways fork, as the screen's own shape.
 *
 * Indices, not embedded steps: `way` indexes what `habitWays` returned for the
 * same route, and `step` indexes that way's steps. `FlowStep.index` IS the
 * step's position in its way — `stepsFor` mints it from the edge order — so the
 * mapping is a read, not a search.
 */
export function habitFork(flows: FlowsDTO, route: FlowRouteDTO): HabitForkDTO | null {
  const fork = wayFork({ flows, route });
  if (fork === null) return null;
  const rows: HabitForkRowDTO[] = fork.rows.map((row) =>
    row.kind === "spine"
      ? {
          kind: "spine",
          from: row.from,
          to: row.to,
          at: row.at.map((a) => ({ way: a.wayIndex, step: a.step.index })),
        }
      : {
          kind: "fork",
          after: row.after,
          runs: row.runs.map((r) => ({
            way: r.wayIndex,
            steps: r.steps.map((st) => st.index),
            phrase: runPhrase(r, row.after),
          })),
        },
  );
  return { rows, verdict: fork.verdict };
}

/** A's strict-prefix relation, as the screen's own shape. */
export function droppedEarlyOf(flows: FlowsDTO, route: FlowRouteDTO): DroppedEarlyDTO[] {
  return walkAnalysis({ flows, route }).droppedEarly.map((p) => ({
    places: [...p.places],
    count: p.count,
  }));
}


/**
 * What the route's typed actions varied — NAMES AND COUNTS, never values.
 *
 * `flowVariables` is the record's own projection, so the block the screen draws
 * and the block the file prints name the same slots in the same order. What
 * differs is only what is dropped: the samples stay in the file, behind the
 * per-habit `showSamples` toggle, because a DTO has no toggle and so can carry
 * no values. A COUNT is not a value — "1 recorded value" says how much varied
 * without saying what was typed.
 */
export function habitSlots(flows: FlowsDTO, route: FlowRouteDTO): HabitSlotDTO[] {
  const steps = flowWalks(flows, route).flatMap((w) => w.steps);
  return flowVariables(steps).map((v) => ({
    name: v.name,
    samples: v.samples.length,
    note: slotNote(v.samples.length),
  }));
}

/**
 * Where the time goes, on the baseline Way.
 *
 * NULL under exactly the record's guard — fewer than two recordings, or no
 * baseline — so the screen and the file are silent together. One recording's
 * timings are a fact about one afternoon, not about a habit, and a chart drawn
 * where the document beside it says nothing would claim more than the evidence.
 *
 * `StepCost.stepIndex` indexes the baseline Way's steps, so the labels are read
 * from that Way rather than looked up from the graph — the same reason
 * `timeBlock` does it that way: two functions naming one edge is the
 * `ax-dump`/`ax-exec` drift hazard.
 */
export function habitTimings(flows: FlowsDTO, route: FlowRouteDTO): HabitTimingsDTO | null {
  if (route.count < 2) return null;
  const analysis = walkAnalysis({ flows, route });
  const wayIndex = analysis.baseline.wayIndex;
  if (wayIndex === null) return null;

  const baseWay = flowWalks(flows, route)[wayIndex];
  if (baseWay === undefined) return null;

  // Steps with no recorded duration are DROPPED, exactly as the record drops
  // them: a zero would draw a bar of no length beside real ones and read as an
  // instantaneous step rather than an unmeasured one.
  const rows = analysis.steps.filter((s) => s.durations.length > 0);
  if (rows.length === 0) return null;

  // THE ATTRIBUTION IS KEPT. `cost.durations` is `{ sessionId, ms }[]` and this
  // used to `.map((d) => d.ms)` it away, which cost the strip its lanes: without
  // the session id a step's spans can be drawn as a bar chart and as nothing
  // else. `cost.stepIndex` is kept for the same class of reason — see
  // `HabitStepTimingDTO.stepIndex`.
  const steps = rows.flatMap((cost) => {
    const step = baseWay.steps[cost.stepIndex];
    if (step === undefined) return [];
    return [
      {
        stepIndex: cost.stepIndex,
        from: step.from,
        to: step.to,
        runs: cost.durations.map((d) => ({ sessionId: d.sessionId, ms: d.ms })),
        gapsAfterMs: cost.gapsAfter.map((g) => ({ sessionId: g.sessionId, ms: g.ms })),
      },
    ];
  });
  if (steps.length === 0) return null;

  return {
    wayLetter: variantLetter(wayIndex),
    steps,
    single: rows.every((r) => r.durations.length === 1),
  };
}

/**
 * What this evidence does not say, WITHOUT the lifting notes.
 *
 * The notes are rebuilt on screen from `HabitStepDTO.liftWarnings`, which the
 * renderer already holds, and rolled up behind a disclosure. Carrying them here
 * would put 56 of the section's 61 bullets in this field — measured on the
 * author's real store — each a raw `t_mono` float and a macOS keycode, burying
 * the five sentences the section exists to deliver.
 *
 * The rendered FILE is untouched and still prints every one of them, in place.
 * `taggedCautions` is what makes that true of one source rather than two.
 */
export function habitCautions(flows: FlowsDTO, route: FlowRouteDTO): string[] {
  const walks = flowWalks(flows, route);
  const dropped = walkAnalysis({ flows, route }).droppedEarly;
  return taggedCautions(flows, route, walks, dropped)
    .filter((c) => c.kind === "caution")
    .map((c) => c.text);
}
