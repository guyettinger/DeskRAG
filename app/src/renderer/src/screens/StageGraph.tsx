import React, { useEffect, useState } from "react";
import type { IndexStageDTO } from "@shared/types";
import {
  groupByPhase,
  liveElapsedMs,
  reducedNeeds,
  stageElapsed,
  stageMeter,
  stageRate,
  stageTone,
  timeShares,
} from "./index-graph-view.js";

/**
 * A clock that ticks only while something is running.
 *
 * The queue snapshot fires on stage TRANSITIONS, so nothing else would re-render
 * the running row between them — its elapsed time sat at "0ms" for the whole of
 * a fourteen-minute stage. One interval for the pane, not one per row, and it is
 * torn down the moment nothing is running so a finished ladder is static.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * The indexing pipeline, drawn.
 *
 * `.stagenode`, not `.stage`: `styles.css` has no scoping, so a class name is a
 * repo-wide identifier — and "stage" already means "the main pane of a screen"
 * in five selectors (`.record__stage`, `.library__stage`, `.detail__stage`,
 * `.flows__stage`, `.jobs__stage`). Claiming it for a pipeline stage is exactly
 * how `.sheet` and `.drawer` went wrong.
 *
 * ## This REPLACED a wire diagram, and the wires were measured before they went.
 *
 * Twelve stages declared 21 `needs` edges then (thirteen and 22 now), each
 * routed down its own 9px channel: ~110px of near-identical gray line beside
 * every node, and reduction only reached 14 because nine of them fanned out of
 * `segment` and into `compose`. The
 * structure is a hub, and parallel wires cannot draw a hub. It is carried by
 * NAMED BANDS now, which is honest only because phases are contiguous runs of
 * the execution order (`stagePhaseViolations()` asserts it).
 *
 * Rows inside a band stay STACKED. `runStages` is a strictly sequential loop, so
 * top to bottom is still the run order — a band that laid its stages out
 * side-by-side would assert a concurrency the app does not have, which is the
 * same mistake the row/column split existed to avoid.
 *
 * Plain document flow: no absolute positioning, no SVG, no `ResizeObserver`.
 * NOTHING TRUNCATES — a description wraps, and a detail either fits or the box
 * is too narrow.
 */
export function StageGraph({
  stages,
  jobStartedAt,
  jobEndedAt,
}: {
  stages: IndexStageDTO[];
  /**
   * The job's own wall clock, as its two ENDS rather than a duration.
   *
   * A duration computed by the parent would only be recomputed when the parent
   * re-renders — on IPC events — while the running row ticks once a second off
   * `useNow`. That is two clocks disagreeing in one glance, which is the defect
   * the Library's single running clock exists to prevent. Both are derived from
   * the same `now` here.
   */
  jobStartedAt: number | null;
  jobEndedAt: number | null;
}): React.JSX.Element {
  const now = useNow(stages.some((s) => s.state === "running"));
  const bands = groupByPhase(stages);
  const needs = reducedNeeds(stages);
  // A chip names a stage the way the stage names itself. `needs` carries
  // `StageId`s, which are the app's internal keys — printing `linkAx` beside a
  // row headed "Linking AX" would make one thing look like two.
  const labelOf = new Map(stages.map((s) => [s.id, s.label]));

  return (
    <div className="stagemap">
      <TimeRollup
        stages={stages}
        wallMs={jobStartedAt === null ? null : (jobEndedAt ?? now) - jobStartedAt}
      />
      {bands.map((band) => (
        <section className="stageband" key={band.phase}>
          <div className="stageband__head">
            <h3 className="stageband__title">{band.title}</h3>
            <p className="stageband__purpose">{band.purpose}</p>
          </div>
          <div className="stageband__rows">
            {band.stages.map((stage) => (
              <StageRow
                key={stage.id}
                stage={stage}
                needs={(needs.get(stage.id) ?? []).map((id) => labelOf.get(id) ?? id)}
                allNeeds={stage.needs.map((id) => labelOf.get(id) ?? id)}
                now={now}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Where the time went.
 *
 * Its total is the SUM OF STAGE TIMES, and the wall clock sits beside it rather
 * than replacing it. The worker holds BETWEEN stages while a recording runs, so
 * the two genuinely differ — presenting Σ as "total" would contradict the queue
 * row's own "took …" in one glance, which is the Library's two-clocks defect.
 * Showing both makes the gap legible as the pause it is.
 */
function TimeRollup({
  stages,
  wallMs,
}: {
  stages: IndexStageDTO[];
  wallMs: number | null;
}): React.JSX.Element | null {
  const shares = timeShares(stages);
  if (shares.segments.length === 0 && shares.folded === 0) return null;

  const stageSum = stageElapsed(shares.totalMs);
  const wall = wallMs === null ? null : stageElapsed(wallMs);
  // Only when it is a REAL difference. Rounding noise between the two would
  // otherwise print a "held" figure of a few milliseconds on every finished job.
  const heldMs = wallMs === null ? 0 : wallMs - shares.totalMs;
  const held = heldMs > 1000 ? stageElapsed(heldMs) : null;

  return (
    <div className="stagerollup">
      <div className="stagerollup__head">
        <span className="eyebrow">Where the time went</span>
        <span className="stagerollup__totals mono">
          {stageSum} of stage time
          {wall !== null && ` · ${wall} wall`}
        </span>
      </div>
      <div className="stagerollup__bar">
        {shares.segments.map((seg) => (
          <span
            className="stagerollup__seg"
            key={seg.id}
            style={{ width: `${seg.pct}%` }}
            title={`${seg.label} — ${stageElapsed(seg.ms)}`}
          />
        ))}
        {/* Folded, never widened: a sliver at 0.0006% has no honest width, and a
            minimum-width block would be a bar widened to be seen. */}
        {shares.folded > 0 && (
          <span
            className="stagerollup__seg stagerollup__seg--rest"
            style={{ width: `${(shares.foldedMs / shares.totalMs) * 100}%` }}
            title={`${shares.folded} smaller stages — ${stageElapsed(shares.foldedMs)} together`}
          />
        )}
      </div>
      <div className="stagerollup__legend">
        {shares.segments.map((seg) => (
          <span className="stagerollup__key" key={seg.id}>
            <span className="stagerollup__swatch" />
            {seg.label} <span className="mono">{stageElapsed(seg.ms)}</span>
          </span>
        ))}
        {shares.folded > 0 && (
          <span className="stagerollup__key stagerollup__key--rest">
            {/* "smaller", not "under 1%": a stage can also be folded for being
                past the palette's distinct colours, and naming only one of the
                two reasons would be false for the other. */}
            <span className="stagerollup__swatch" />+{shares.folded} smaller{" "}
            {shares.folded === 1 ? "stage" : "stages"}{" "}
            <span className="mono">{stageElapsed(shares.foldedMs)}</span>
          </span>
        )}
        {held !== null && <span className="stagerollup__held">{held} paused for recording</span>}
      </div>
    </div>
  );
}

function StageRow({
  stage,
  needs,
  allNeeds,
  now,
}: {
  stage: IndexStageDTO;
  /** The transitive REDUCTION, as chips. */
  needs: string[];
  /** Everything the stage declares, for the tooltip — the reduction hides nothing. */
  allNeeds: string[];
  now: number;
}): React.JSX.Element {
  // LIVE while running: the snapshot's `elapsedMs` is frozen at `begin`, so both
  // the clock and the rate read against this instead.
  const elapsedMs = liveElapsedMs(stage, now);
  const elapsed = stageElapsed(elapsedMs);
  const meter = stageMeter(stage);
  const rate = stageRate(stage.progress, stage.startedAt);

  return (
    <div
      className={`stagenode stagenode--${stage.state}`}
      data-tone={stageTone(stage.state)}
      // The FULL dependency list, so the reduction below hides nothing.
      title={allNeeds.length > 0 ? `needs ${allNeeds.join(", ")}` : undefined}
    >
      <span className="stagenode__glyph" aria-hidden="true" />
      <div className="stagenode__text">
        <div className="stagenode__head">
          <span className="stagenode__name">{stage.label}</span>
          {/* Only when there is a real measurement. A stage that has not run has
              nothing to say about how long it took. */}
          {elapsed !== null && <span className="stagenode__time mono">{elapsed}</span>}
        </div>

        {/* What it DOES — constant, present on every stage in every state. The
            screen exists to explain the pipeline and previously showed only a
            two-word label. */}
        <p className="stagerow__desc">{stage.describe}</p>

        {meter.kind === "determinate" && (
          <div className="stagemeter">
            <div className="stagemeter__track">
              <div className="stagemeter__fill" style={{ width: `${meter.pct}%` }} />
            </div>
            <span className="stagemeter__count mono">
              {meter.done}/{meter.total} {meter.unit}
              {/* MEASURED, never projected. There is deliberately no ETA. */}
              {rate !== null && ` · ${rate}`}
            </span>
          </div>
        )}
        {meter.kind === "indeterminate" && (
          <div className="stagemeter stagemeter--indeterminate">
            <div className="stagemeter__track">
              <div className="stagemeter__fill" />
            </div>
            {/* Says WHY there is no count, rather than leaving a bar that looks
                stuck. A stage that cannot count is not a stage that is stalled. */}
            <span className="stagemeter__count">working — this stage cannot count its steps</span>
          </div>
        )}

        {/* A skipped stage STATES ITS REASON rather than merely dimming: a stage
            that dropped out silently is indistinguishable from one nobody
            implemented, which is the failure mode the gates keep producing. */}
        {stage.detail !== null && <div className="stagenode__detail">{stage.detail}</div>}

        {needs.length > 0 && (
          <div className="stageneeds">
            <span className="stageneeds__label">needs</span>
            {needs.map((n) => (
              <span className="stageneeds__chip" key={n}>
                {n}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
