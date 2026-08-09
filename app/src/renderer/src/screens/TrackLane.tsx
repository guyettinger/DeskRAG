import React from "react";
import type { TrackLaneDTO } from "@shared/types";
import { keyframeLabel } from "../api.js";
import { densityPath, labelFits, spanRects, thumbPlacement } from "./track-view.js";

/**
 * Matches `.tracks__plot`'s height for a density lane, so a one-unit inset in
 * `densityPath` is one pixel. Density lanes keep the taller row: a trace needs
 * vertical room to be a trace rather than a line.
 */
const DENSITY_H = 30;
/**
 * Thumbnail width in PIXELS — 16:9 against the 42px image `.tracks__thumb`
 * draws. It used to be a fraction duplicated as a percentage in the stylesheet,
 * with nothing to enforce the pair; the axis width now arrives measured, so this
 * one constant drives both the CSS width and the placement decision.
 */
const THUMB_PX = 76;
/**
 * Minimum width of a span's HIT target, in px. The bar itself is never widened
 * — see `spanRects`.
 */
const MIN_HIT_PX = 12;

interface Props {
  lane: TrackLaneDTO;
  totalSec: number;
  /** The plot column's measured width. 0 until the rail's observer first fires. */
  axisWidth: number;
  /** Null when there is no video: the axis is real but nothing can be sought. */
  onSeek: ((sec: number) => void) | null;
  onInspect: (frameId: string) => void;
}

const pct = (sec: number, totalSec: number): string =>
  `${totalSec > 0 ? Math.max(0, Math.min(100, (sec / totalSec) * 100)) : 0}%`;

/** A thumbnail's left edge in pixels, centred on its time but kept on the axis. */
const thumbLeft = (sec: number, totalSec: number, axisWidth: number): number => {
  const centre = totalSec > 0 ? (sec / totalSec) * axisWidth : 0;
  return Math.max(0, Math.min(Math.max(0, axisWidth - THUMB_PX), centre - THUMB_PX / 2));
};

/**
 * One lane of the rail. Four shapes cover fifteen lanes, so a new signal is a
 * builder in `session-tracks.ts` and never a new component here.
 */
export function TrackLane(props: Props): React.JSX.Element {
  const { lane } = props;
  // An empty lane keeps its row but not its height. Absence still has to be
  // VISIBLE — "no scrolling recorded" is the payload, and a lane that vanished
  // would make a signal that was never captured indistinguishable from one this
  // build does not know about. It just stops costing as much as a lane with data.
  const empty = lane.emptyReason !== null;
  return (
    <div
      className="tracks__lane"
      // The rail's ONE mousemove reads this with `closest()`. Sixteen lanes
      // across four shapes would otherwise need sixteen more handlers, which is
      // sixteen more places for the hit rule to drift from the axis rule.
      data-lane={lane.id}
      data-shape={lane.shape}
      data-empty={empty || undefined}
    >
      <div className="tracks__gutter">
        <span className="tracks__title mono">{lane.title}</span>
        {lane.warning && (
          <span className="tracks__warn" title={lane.warning}>
            !
          </span>
        )}
      </div>
      <div className="tracks__plot">
        {empty ? (
          <span className="tracks__empty">{lane.emptyReason}</span>
        ) : (
          <LaneBody {...props} />
        )}
      </div>
    </div>
  );
}

function LaneBody({ lane, totalSec, axisWidth, onSeek, onInspect }: Props): React.JSX.Element | null {
  // No `title` anywhere below: the hover card names every lane at once, and a
  // native tooltip appearing over it would fight it for the same pixels.
  if (lane.shape === "span") {
    return (
      <>
        {lane.spans?.map((s, i) => {
          const r = spanRects(s.startSec, s.endSec, totalSec, axisWidth, MIN_HIT_PX);
          // A span lying entirely off the axis draws nothing. `preRollSec` on the
          // ruler is what reports that it existed — a zero-width bar could not.
          if (r.widthPct <= 0) return null;
          // The bar carries the signal's TRUE extent; the hit target is a
          // separate padded rect, because widening the bar to make it clickable
          // is the overstatement this rail was rebuilt to remove.
          //
          // The label is measured against the VISIBLE width, not the recorded
          // duration: a clipped bar has less room than its span claims, and
          // measuring the claim is how a label ends up wider than its box.
          const visibleSec = (r.widthPct / 100) * totalSec;
          const showLabel =
            lane.showLabels && labelFits(visibleSec, totalSec, axisWidth, s.label);
          return (
            <React.Fragment key={i}>
              <div
                className="tracks__span"
                data-tone={s.tone}
                data-clip-start={r.clippedStart || undefined}
                data-clip-end={r.clippedEnd || undefined}
                style={{ left: `${r.leftPct}%`, width: `${r.widthPct}%` }}
              >
                {showLabel && <span className="tracks__span-label">{s.label}</span>}
              </div>
              <div
                className="tracks__span-hit"
                style={
                  r.hit
                    ? { left: r.hit.leftPx, width: r.hit.widthPx }
                    : { left: `${r.leftPct}%`, width: `${r.widthPct}%` }
                }
              />
            </React.Fragment>
          );
        })}
      </>
    );
  }

  if (lane.shape === "mark") {
    return (
      <>
        {lane.marks?.map((m, i) => (
          <div
            key={i}
            className="tracks__mark"
            data-tone={m.tone}
            style={{ left: pct(m.atSec, totalSec) }}
          />
        ))}
      </>
    );
  }

  if (lane.shape === "thumb") {
    const thumbs = lane.thumbs ?? [];
    // Before the first measurement nothing is known about the spacing, so only
    // the first keeps an image and the rest degrade to ticks for that one frame.
    const show = thumbPlacement(
      thumbs.map((t) => t.atSec),
      totalSec,
      axisWidth > 0 ? THUMB_PX / axisWidth : Infinity,
    );
    return (
      <>
        {thumbs.map((t, i) => {
          const label = `${keyframeLabel(t.marker)} · ${t.regionCount} regions`;
          return (
            <button
              key={t.marker.frameId}
              className={show[i] ? "tracks__thumb" : "tracks__mark"}
              data-tone="accent"
              aria-label={label}
              // The width is written HERE, not in the stylesheet, so THUMB_PX is
              // the single source both the box and `thumbPlacement` read. An
              // image is CLAMPED to the axis rather than centred past its end —
              // a keyframe near t=0 otherwise paints over the title column,
              // which is now the transport's column too. Ticks stay exact.
              style={
                show[i]
                  ? { left: thumbLeft(t.atSec, totalSec, axisWidth), width: THUMB_PX }
                  : { left: pct(t.atSec, totalSec) }
              }
              onClick={() => (onSeek ? onSeek(t.atSec) : onInspect(t.marker.frameId))}
              onDoubleClick={() => onInspect(t.marker.frameId)}
            >
              {show[i] && t.marker.thumbUrl && (
                <img src={t.marker.thumbUrl} alt="" loading="lazy" draggable={false} />
              )}
            </button>
          );
        })}
      </>
    );
  }

  if (lane.shape === "density" && lane.density) {
    // preserveAspectRatio="none" so one viewBox stretches to any rail width —
    // this is what makes a fixed 1000 buckets independent of pixel width.
    return (
      <svg
        className="tracks__density"
        viewBox={`0 0 100 ${DENSITY_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={densityPath(lane.density.values, DENSITY_H)} className="tracks__trace" />
        {lane.density.values2 && (
          <path
            d={densityPath(lane.density.values2, DENSITY_H)}
            className="tracks__trace is-second"
          />
        )}
      </svg>
    );
  }

  return null;
}
