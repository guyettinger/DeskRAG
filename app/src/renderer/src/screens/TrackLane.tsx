import React from "react";
import type { TrackLaneDTO } from "@shared/types";
import { keyframeLabel } from "../api.js";
import { densityPath, thumbPlacement } from "./track-view.js";

/** Matches `.tracks__plot`'s height, so a one-unit inset is one pixel. */
const DENSITY_H = 48;
/**
 * Thumbnail width in PIXELS — 16:9 against the 42px image `.tracks__thumb`
 * draws. It used to be a fraction duplicated as a percentage in the stylesheet,
 * with nothing to enforce the pair; the axis width now arrives measured, so this
 * one constant drives both the CSS width and the placement decision.
 */
const THUMB_PX = 76;

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
  return (
    <div className="tracks__lane" data-shape={lane.shape}>
      <div className="tracks__gutter">
        <span className="tracks__title">{lane.title}</span>
        {lane.warning && (
          <span className="tracks__warn" title={lane.warning}>
            !
          </span>
        )}
      </div>
      <div className="tracks__plot">
        {lane.emptyReason ? (
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
        {lane.spans?.map((s, i) => (
          <div
            key={i}
            className="tracks__span"
            data-tone={s.tone}
            style={{
              left: pct(s.startSec, totalSec),
              width: pct(s.endSec - s.startSec, totalSec),
            }}
          >
            <span className="tracks__span-label">{s.label}</span>
          </div>
        ))}
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
