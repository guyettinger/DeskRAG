/**
 * The stage ladder, projected from the plan table into something drawable.
 *
 * A pure projection over `INDEX_STAGES` and one job's stage records — the same
 * discipline as `graph-view.ts` and `session-tracks.ts`, and for the same
 * reason: the diagram must be incapable of disagreeing with what actually runs.
 * The ordering, the gates and the dependencies all live in `index-plan.ts`, so
 * nothing here restates them; it only reads them.
 *
 * ## Row is EXECUTION ORDER. Column is dependency depth.
 *
 * `runStages` is a strictly sequential `for` loop. Drawing the pipeline as a
 * free-branching DAG would therefore assert a concurrency the app does not have
 * — Captions, Transcribing and Frame patches all depend only on Segmenting, and
 * a DAG layout would put them side by side as if they ran together. They do not.
 *
 * But the dependency structure is real and is most of what makes the pipeline
 * comprehensible. So the two facts get one axis each: the vertical axis is the
 * order things actually happen (which is the array order — the plan table says
 * "the array IS the order; `needs` is CHECKED, never obeyed"), and the
 * horizontal axis carries the shape.
 *
 * **Deriving the row from `needs` would be wrong, and quietly so:** `trace`
 * needs only `segment`/`regions`/`linkAx`, so its longest path is 2 — yet it
 * runs LAST, after Composing and the search index, because a graph accretes
 * across recordings. A `needs`-derived layout would draw it in the middle of the
 * pipeline and nothing would fail.
 *
 * Because rows follow the table and `stageOrderViolations` is empty, every wire
 * points from a smaller row to a larger one: the ladder always flows downward
 * and no edge can double back. That is an invariant the root test asserts rather
 * than a property the renderer has to cope with.
 *
 * Imports only `index-plan.ts` (which imports nothing) and the shared contract,
 * so the ROOT suite can reach it with no store, no Electron and no model.
 */

import type { IndexStageDTO, IndexStageState } from "@shared/types";
import { INDEX_STAGES, stageSpec, type StageFacts, type StageId } from "./index-plan.js";
import type { StageRecord } from "./index-queue.js";

/**
 * How far a stage sits from a root of the dependency graph.
 *
 * Computed over the WHOLE table, never over one job's selection, so the ladder
 * keeps its shape when a gate removes a stage. A column that shifted because a
 * captioner was switched off would make two runs of the same pipeline look like
 * two different pipelines.
 */
function depths(): Map<StageId, number> {
  const out = new Map<StageId, number>();
  // One forward pass suffices: `needs` only ever points backwards in the table,
  // which `stageOrderViolations` already guarantees and the root test re-checks.
  for (const spec of INDEX_STAGES) {
    let d = 0;
    for (const need of spec.needs) d = Math.max(d, (out.get(need) ?? 0) + 1);
    out.set(spec.id, d);
  }
  return out;
}

const DEPTH = depths();

/** The widest column any stage occupies — what the renderer sizes its grid to. */
export const STAGE_COLUMNS = Math.max(...DEPTH.values()) + 1;

function elapsed(rec: StageRecord): number | null {
  if (rec.startedAt === null) return null;
  return (rec.endedAt ?? Date.now()) - rec.startedAt;
}

/**
 * One job's ladder as the renderer receives it.
 *
 * `stages` is the job's own record list, so a job stored by an older build draws
 * whatever it actually knows rather than being back-filled with assumptions
 * about a run that already happened.
 */
export function buildStageGraph(stages: readonly StageRecord[]): IndexStageDTO[] {
  const present = new Set<string>(stages.map((s) => s.id));
  return stages.map((rec, row) => {
    const spec = stageSpec(rec.id);
    return {
      id: rec.id,
      label: spec.label(LABEL_FACTS),
      describe: spec.describe(LABEL_FACTS),
      phase: spec.phase,
      state: rec.state as IndexStageState,
      detail: rec.detail,
      // Only a RUNNING stage has a meter. A record can carry stale progress —
      // a job that crashed mid-stage is re-queued with its `running` row intact
      // — and a pending stage showing "118/289" would claim work that is not
      // happening.
      progress: rec.state === "running" ? rec.progress : null,
      startedAt: rec.startedAt,
      elapsedMs: elapsed(rec),
      row,
      col: DEPTH.get(rec.id) ?? 0,
      // Only wires to stages that are actually on this ladder. A trace rebuild
      // draws one node, and an edge into a stage it does not contain would be a
      // wire ending in mid-air — the same defect the Flows filter avoids by
      // dimming rather than hiding.
      needs: spec.needs.filter((n) => present.has(n)),
    };
  });
}

/**
 * Labels are constant today — every `StageSpec.label` ignores its facts — but
 * the signature takes them, so this names the one place a fact would have to be
 * threaded through if that ever changed. Passing all-false would silently pick
 * the wrong branch of any future conditional label.
 */
const LABEL_FACTS: StageFacts = {
  patchEmbedder: true,
  captioner: true,
  hasAudio: true,
  whisper: true,
};
