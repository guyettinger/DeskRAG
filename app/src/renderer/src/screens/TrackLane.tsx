import React from "react";
import type { TrackLaneDTO } from "@shared/types";
import { keyframeLabel } from "../api.js";
import { densityPath, thumbPlacement } from "./track-view.js";

const DENSITY_H = 24;
/** Thumbnail width as a fraction of the rail. MUST match `.tracks__thumb` width. */
const THUMB_FRAC = 0.055;

interface Props {
  lane: TrackLaneDTO;
  totalSec: number;
  /** Null when there is no video: the axis is real but nothing can be sought. */
  onSeek: ((sec: number) => void) | null;
  onInspect: (frameId: string) => void;
}

const pct = (sec: number, totalSec: number): string =>
  `${totalSec > 0 ? Math.max(0, Math.min(100, (sec / totalSec) * 100)) : 0}%`;

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

function LaneBody({ lane, totalSec, onSeek, onInspect }: Props): React.JSX.Element | null {
  if (lane.shape === "span") {
    return (
      <>
        {lane.spans?.map((s, i) => (
          <div
            key={i}
            className="tracks__span"
            data-tone={s.tone}
            title={s.label}
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
            title={m.label}
            style={{ left: pct(m.atSec, totalSec) }}
          />
        ))}
      </>
    );
  }

  if (lane.shape === "thumb") {
    const thumbs = lane.thumbs ?? [];
    const show = thumbPlacement(
      thumbs.map((t) => t.atSec),
      totalSec,
      THUMB_FRAC,
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
              title={label}
              aria-label={label}
              style={{ left: pct(t.atSec, totalSec) }}
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
