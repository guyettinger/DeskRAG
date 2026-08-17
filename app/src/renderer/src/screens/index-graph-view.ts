/**
 * What the stage ladder SAYS — grouping, meters, rates and the time rollup.
 *
 * `.ts`, never `.tsx`: the ROOT tsconfig sets no `jsx`, so a root test that
 * reaches into a `.tsx` — even only for a type — breaks `npm run typecheck`.
 * It sits beside `StageGraph.tsx` for the same reason `graph-layout.ts` sits
 * beside `GraphCanvas.tsx`, and it imports nothing from `api.ts`, which
 * evaluates `window.deskrag` at module scope.
 *
 * ## There is no geometry here any more, and that is the point.
 *
 * This module used to place twelve absolutely-positioned nodes and route their
 * `needs` edges down a gutter of 9px channels. It was measured and it failed:
 * twelve stages declare **21** edges, so the gutter was ~110px of near-identical
 * gray line beside every node, and transitive reduction only reaches **14**
 * because NINE of those are fan-out from `segment` (5 out-edges) and fan-in to
 * `compose` (4 in-edges). The dependency structure is hub-shaped, and parallel
 * wires are the wrong encoding for a hub — no amount of channel assignment fixes
 * a picture whose content is "these five things all read the same thing".
 *
 * So the shape is carried by NAMED BANDS (`StagePhase`), which is legal only
 * because the phases are contiguous runs of the execution order —
 * `stagePhaseViolations()` in `index-plan.ts` asserts exactly that. Rows inside
 * a band stay stacked, because `runStages` is a strictly sequential loop and
 * putting Captions beside Transcribing would assert a concurrency the app does
 * not have. Bands are normal document flow, so there is nothing left to measure
 * and no `ResizeObserver`.
 */

import {
  STAGE_PHASES,
  type IndexStageDTO,
  type StagePhase,
  type StageProgress,
} from "@shared/types";

/** One band: a phase, its prose, and the stages that fall in it, in run order. */
export interface PhaseBand {
  phase: StagePhase;
  title: string;
  purpose: string;
  stages: IndexStageDTO[];
}

/**
 * Gather the ladder into bands, preserving run order exactly.
 *
 * Emits only phases that actually HAVE stages: a `trace-rebuild` job contains
 * one stage and must draw one band, not four with three empty. An empty band
 * would be the "present-and-empty versus absent" mistake the detail overlay
 * already made — absence here means "this job has no such work", which is a
 * different claim from "this work produced nothing".
 *
 * A new band starts whenever the phase CHANGES rather than by looking each stage
 * up in a phase-keyed map. That difference matters: if the table ever violated
 * contiguity, this renders the truth (the same phase twice, in the order it
 * actually runs) instead of silently reordering stages to fit their labels.
 */
export function groupByPhase(stages: readonly IndexStageDTO[]): PhaseBand[] {
  const meta = new Map(STAGE_PHASES.map((p) => [p.id, p]));
  const bands: PhaseBand[] = [];
  for (const stage of stages) {
    const last = bands[bands.length - 1];
    if (last && last.phase === stage.phase) {
      last.stages.push(stage);
      continue;
    }
    const m = meta.get(stage.phase);
    bands.push({
      phase: stage.phase,
      title: m?.title ?? stage.phase,
      purpose: m?.purpose ?? "",
      stages: [stage],
    });
  }
  return bands;
}

/**
 * What meter, if any, a stage draws.
 *
 * Three cases and no fourth, because the alternative is a bar that asserts a
 * measurement nobody took:
 *
 *  - `determinate` — the stage counts its own units and said so.
 *  - `indeterminate` — the stage is running and CANNOT count. Composing is the
 *    real instance: its cost is inside `composeLadder`, whose number of model
 *    calls is not known until each level's frontier exists, so any total would
 *    be invented. The fast structural stages land here too, though at 8ms none
 *    of them renders long enough to be seen.
 *  - `none` — pending, skipped, or finished. A completed stage's meter is not a
 *    fact about it; its elapsed time and its evidence line are.
 *
 * This is the same rule as drawing no highlight box at all on a grid
 * disagreement: a wrong box is worse than no box.
 */
export type StageMeter =
  | { kind: "determinate"; done: number; total: number; unit: string; pct: number }
  | { kind: "indeterminate" }
  | { kind: "none" };

export function stageMeter(stage: IndexStageDTO): StageMeter {
  if (stage.state !== "running") return { kind: "none" };
  const p = stage.progress;
  if (p === null || p.total <= 0) return { kind: "indeterminate" };
  // Clamped: `done` counts units ENTERED at the top of a loop, and a final call
  // reports the total, so it can never legitimately exceed it — but a bar wider
  // than its track is a rendering artefact, not a disclosure, and the count
  // beside it still carries the raw numbers.
  const pct = Math.max(0, Math.min(100, (p.done / p.total) * 100));
  return { kind: "determinate", done: p.done, total: p.total, unit: p.unit, pct };
}

/**
 * How long this stage has been going, measured against a LIVE clock while it
 * runs and against its own closed measurement once it has ended.
 *
 * The DTO's `elapsedMs` is computed when the queue SNAPSHOT is built, and that
 * happens only on stage transitions — so for the stage actually running it is
 * frozen at whatever it was at `begin`, which is ~0. Measured in the app: the
 * running row read "0ms" while its meter advanced, and no rate ever appeared
 * because `stageRate`'s two-second floor could never be met.
 *
 * A finished stage keeps `elapsedMs`: it is a real interval with both ends
 * known, and re-deriving it from `startedAt` against `now` would make a
 * completed stage's time keep growing.
 */
export function liveElapsedMs(stage: IndexStageDTO, now: number): number | null {
  if (stage.state === "running" && stage.startedAt !== null) {
    return Math.max(0, now - stage.startedAt);
  }
  return stage.elapsedMs;
}

/**
 * Units per second so far, or null when there is nothing honest to say.
 *
 * MEASURED, never extrapolated — there is deliberately no ETA. `done` over the
 * interval in which those units were done is a true average over work that
 * actually happened; a projection of when it will finish is not, and this
 * screen's rule is that a number on it is something that occurred.
 *
 * The floors are the rail's `bucketRate` lesson, which was paid for: at 1000
 * buckets over 40 seconds, ONE keystroke reported "25 keys/s" — arithmetically
 * true and practically a lie. One unit finished 200ms into a stage would report
 * an equally fictional 5/s and then fall by an order of magnitude. Below two
 * units or two seconds there is no rate yet, and saying so is withholding a
 * label that does not fit, exactly as `labelFits` does.
 */
export const RATE_MIN_UNITS = 2;
export const RATE_MIN_MS = 2000;

export function stageRate(progress: StageProgress | null, startedAt: number | null): string | null {
  if (progress === null || startedAt === null) return null;
  // Against the OBSERVATION's own clock, never a live one — see `StageProgress.at`.
  // A record written before `at` existed carries 0, which fails this and is
  // therefore withheld rather than reported as an absurd rate.
  const elapsedMs = progress.at - startedAt;
  if (progress.done < RATE_MIN_UNITS || elapsedMs < RATE_MIN_MS) return null;
  const perSec = progress.done / (elapsedMs / 1000);
  if (!Number.isFinite(perSec) || perSec <= 0) return null;
  // Below 1/s the reciprocal is the readable number: "3.4s each" beats "0.3/s"
  // for the caption stage, which is the one anybody watches.
  if (perSec < 1) return `${(1 / perSec).toFixed(1)}s each`;
  return `${perSec.toFixed(1)}/s`;
}

/** One block of the rollup bar. */
export interface TimeShare {
  id: string;
  label: string;
  ms: number;
  pct: number;
}

export interface TimeShares {
  segments: TimeShare[];
  /** Stages too small to draw, folded into one trailing block. */
  folded: number;
  foldedMs: number;
  /** The SUM of stage times — NOT the job's wall clock. See below. */
  totalMs: number;
}

/**
 * A share below this draws nothing and is folded into the tail.
 *
 * 8ms against 22 minutes is 0.0006% — sub-pixel at any width. The alternative is
 * a minimum-width block, and that is the one thing the rail forbids: a bar is the
 * signal's true extent and must never be widened to be seen. So the small ones
 * are counted rather than drawn, and the row list below carries every stage's
 * exact time anyway.
 */
export const MIN_SHARE_PCT = 1;

/**
 * The most blocks the bar will draw before folding the remainder.
 *
 * It is the size of the PALETTE, not a taste judgement. `styles.css` gives the
 * blocks five positional slots plus a neutral one for the fold, drawn from
 * `--data-*` minus the two semantic tones (`--data-ok`, `--data-alarm`) — a
 * share of the clock must never read as a status. A sixth coloured block would
 * wrap to the first slot's azure and put two different stages in one colour with
 * the legend claiming they differ, which is the collision this whole rollup
 * already shipped once and was caught only in a screenshot.
 *
 * A twelve-stage pipeline can put more than five stages over 1%, so this is
 * reachable in practice, not theoretical.
 */
export const MAX_SHARE_SEGMENTS = 5;

/**
 * Where the job's time actually went.
 *
 * **`totalMs` is the SUM OF STAGE TIMES and is not the job's wall clock.** The
 * worker's gate holds BETWEEN stages while a recording runs, so a job can sit
 * paused for minutes with no stage accruing anything. Presenting Σ as "total"
 * would contradict the queue row's "took 24m 31s" in the same glance — the same
 * defect as the Library's two clocks disagreeing, and the caller shows both so
 * the difference reads as the hold it is.
 *
 * Only stages with a measured elapsed time take part. A RUNNING stage is
 * excluded: its elapsed grows on every tick, so including it would make every
 * other block shrink continuously and the bar would never sit still.
 */
export function timeShares(stages: readonly IndexStageDTO[]): TimeShares {
  const measured = stages.filter(
    (s) => s.elapsedMs !== null && s.elapsedMs > 0 && s.state !== "running",
  );
  const totalMs = measured.reduce((sum, s) => sum + (s.elapsedMs ?? 0), 0);
  if (totalMs <= 0) return { segments: [], folded: 0, foldedMs: 0, totalMs: 0 };

  // Largest first: the question this bar answers is "what cost me the time",
  // and run order already has a whole screen below devoted to it. Sorting BEFORE
  // the cut is what makes the fold keep the costliest stages rather than
  // whichever ones happened to run first.
  const ranked = measured
    .map((s) => {
      const ms = s.elapsedMs ?? 0;
      return { id: s.id, label: s.label, ms, pct: (ms / totalMs) * 100 };
    })
    .sort((a, b) => b.ms - a.ms);

  const segments: TimeShare[] = [];
  let folded = 0;
  let foldedMs = 0;
  for (const share of ranked) {
    // Two reasons to fold, and they are the same disclosure: too small to draw
    // honestly, or past the palette's distinct colours.
    if (share.pct < MIN_SHARE_PCT || segments.length >= MAX_SHARE_SEGMENTS) {
      folded++;
      foldedMs += share.ms;
      continue;
    }
    segments.push(share);
  }
  return { segments, folded, foldedMs, totalMs };
}

/**
 * Each stage's dependencies with the implied ones removed.
 *
 * `searchIndex` declares five needs and four of them are already implied by
 * `compose` needing them; printing all five as chips restates the hub instead of
 * describing the stage. The reduction is over the LADDER as given, so a job
 * whose gates dropped a stage reduces against what actually remains rather than
 * against the full table.
 *
 * The full `needs` is still on the DTO and the row puts it in `title` — nothing
 * is hidden, it is just not the first thing read.
 */
export function reducedNeeds(stages: readonly IndexStageDTO[]): Map<string, string[]> {
  const byId = new Map(stages.map((s) => [s.id, s]));
  /** Everything reachable from `id` through `needs`, excluding `id` itself. */
  const closure = new Map<string, Set<string>>();
  const reach = (id: string): Set<string> => {
    const hit = closure.get(id);
    if (hit) return hit;
    const out = new Set<string>();
    // Seeded before recursing so a cycle — which `stageOrderViolations` already
    // forbids, but which must not hang the renderer if it ever appeared —
    // terminates instead of recursing forever.
    closure.set(id, out);
    for (const need of byId.get(id)?.needs ?? []) {
      if (!byId.has(need)) continue;
      out.add(need);
      for (const deep of reach(need)) out.add(deep);
    }
    return out;
  };

  const result = new Map<string, string[]>();
  for (const stage of stages) {
    const direct = stage.needs.filter((n) => byId.has(n));
    const kept = direct.filter((n) => {
      // Drop `n` when some OTHER direct need already reaches it.
      return !direct.some((other) => other !== n && reach(other).has(n));
    });
    result.set(stage.id, kept);
  }
  return result;
}

/** The tone token a stage state reads through `[data-tone]`. */
export function stageTone(state: IndexStageDTO["state"]): string {
  switch (state) {
    case "done":
      return "ok";
    case "running":
      return "accent";
    case "failed":
      return "alarm";
    case "skipped":
      return "neutral";
    default:
      return "neutral";
  }
}

/**
 * A stage's elapsed time, or null when there is nothing true to say.
 *
 * Sub-second stages report in milliseconds rather than rounding to "0s": half
 * the pipeline is pure SQLite over rows that are already there, and a ladder
 * where eight of twelve nodes read "0s" says less than one that shows the two
 * that actually cost something.
 */
export function stageElapsed(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Round to whole SECONDS first, then split. Rounding the remainder separately
  // produces "4m 60s" — which the real Frame patches stage printed, at 299.6s,
  // in the running app. Every unit test passed: none of them happened to land in
  // the last half-second of a minute.
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
