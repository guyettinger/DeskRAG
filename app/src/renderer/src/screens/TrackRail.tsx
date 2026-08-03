import React, { useEffect, useMemo, useRef, useState } from "react";
import type { MediaPlayerInstance } from "@vidstack/react";
import type { SessionTracksDTO } from "@shared/types";
import { api, keyframeLabel } from "../api.js";
import { TrackLane } from "./TrackLane.js";
import { readoutAt } from "./track-view.js";

/** How far from the cursor a point event still counts as "here". */
const HOVER_TOL_PX = 8;
/** Card width + margin, for deciding which side of the cursor it sits on. */
const TIP_W = 336;
const TIP_H = 260;

interface Props {
  sessionId: string;
  /** Null for a session with no video: the axis is real, seeking is not. */
  player: React.RefObject<MediaPlayerInstance | null> | null;
  /**
   * The player's duration — MEDIA seconds, which are not the lanes' seconds.
   * The video decodes a shorter span than it covers (measured: 84.9s of media
   * for an 85.76s t_mono span), so a media time divided by the lane total lands
   * ~1% early — 5px at the right end of the axis. Null without a video.
   */
  videoSec: number | null;
  onInspect: (frameId: string) => void;
}

interface Hover {
  sec: number;
  x: number;
  y: number;
}

/**
 * Every recorded signal on one time axis, beneath the player. Replaces the
 * keyframe filmstrip, so the screen has exactly one time axis.
 *
 * That axis is `.tracks__axis` — the plot column, NOT the whole rail. The
 * distinction is the whole point: the gutter holds lane titles, so measuring
 * the cursor against the rail's full width puts the crosshair on a different
 * SCALE from the lanes it stands over (it did, until this box existed). The
 * column's width and inset are the same tokens the docked control bar uses, so
 * the scrubber above and the lanes below are one axis structurally rather than
 * by tuning.
 *
 * It scrolls vertically, because fifteen 48px lanes do not fit above a video
 * frame in a 900x600 window and cutting lanes would sacrifice the capture-audit
 * reading to the navigation one.
 */
export function TrackRail({ sessionId, player, videoSec, onInspect }: Props): React.JSX.Element {
  const [tracks, setTracks] = useState<SessionTracksDTO | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [axisWidth, setAxisWidth] = useState(0);
  const axisRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setTracks(null);
    void api.sessions.tracks(sessionId).then((t) => {
      if (live) setTracks(t);
    });
    return () => {
      live = false;
    };
  }, [sessionId]);

  const totalSec = tracks?.totalSec ?? 0;

  // The axis is measured, not assumed: the thumbnail spacing rule and the hover
  // tolerance are both PIXEL facts, and the rail is resizable.
  useEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAxisWidth(el.clientWidth));
    ro.observe(el);
    setAxisWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [tracks]);

  // The playhead is written IMPERATIVELY. `player.subscribe` fires every
  // animation frame; routing it through state would re-render fifteen lanes at
  // 60fps. KeyframeStrip already encoded this lesson by setting state only when
  // the nearest keyframe changed.
  //
  // Note the divisor: MEDIA time over MEDIA duration. The axis is a fraction,
  // and the two clocks meet only there.
  const mediaSec = videoSec && videoSec > 0 ? videoSec : totalSec;
  useEffect(() => {
    const p = player?.current;
    if (!p || mediaSec <= 0) return;
    return p.subscribe(({ currentTime }) => {
      const el = headRef.current;
      if (el) el.style.transform = `translateX(${(currentTime / mediaSec) * 100}%)`;
    });
  }, [player, mediaSec]);

  /** Lane seconds under the cursor, or null when it is off the axis (the gutter). */
  const secAt = (clientX: number): number | null => {
    const el = axisRef.current;
    if (!el || totalSec <= 0) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || clientX < r.left || clientX > r.right) return null;
    return ((clientX - r.left) / r.width) * totalSec;
  };

  /** Takes LANE seconds and converts, so nothing outside this function has to
   *  know that the video's clock runs slightly short of the session's. */
  const seek = (sec: number): void => {
    const p = player?.current;
    if (p && totalSec > 0) p.currentTime = Math.max(0, (sec / totalSec) * mediaSec);
  };

  const readout = useMemo(() => {
    if (!tracks || !hover) return null;
    return readoutAt(tracks, hover.sec, {
      tolSec: axisWidth > 0 ? (HOVER_TOL_PX / axisWidth) * totalSec : 0,
      label: keyframeLabel,
    });
  }, [tracks, hover, axisWidth, totalSec]);

  if (!tracks) return <div className="tracks tracks--note">reading signals…</div>;
  if (totalSec <= 0) {
    return <div className="tracks tracks--note">this recording has no measurable span</div>;
  }

  return (
    <div className="tracks">
      <div
        className="tracks__body"
        onMouseMove={(e) => {
          const sec = secAt(e.clientX);
          setHover(sec === null ? null : { sec, x: e.clientX, y: e.clientY });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          // A keyframe handles its own click and stops there; anything else on
          // the axis is a seek. The gutter is not on the axis, so it is neither.
          if ((e.target as HTMLElement).closest(".tracks__thumb, .tracks__mark")) return;
          const sec = secAt(e.clientX);
          if (sec !== null && player) seek(sec);
        }}
      >
        {/* The lanes and the axis share this box, and it is what gives the
            playhead its height: an abspos child of the SCROLLER would be sized
            to the client box and stop at the fold once the rail is scrolled. */}
        <div className="tracks__inner">
          {tracks.lanes.map((lane) => (
            <TrackLane
              key={lane.id}
              lane={lane}
              totalSec={totalSec}
              axisWidth={axisWidth}
              onSeek={player ? seek : null}
              onInspect={onInspect}
            />
          ))}
          <div className="tracks__axis" ref={axisRef}>
            {player && <div className="tracks__playhead" ref={headRef} />}
            {hover && (
              <div className="tracks__crosshair" style={{ left: `${(hover.sec / totalSec) * 100}%` }} />
            )}
          </div>
        </div>
      </div>
      {hover && readout && <ReadoutCard hover={hover} readout={readout} />}
    </div>
  );
}

/**
 * Every lane resolved at the cursor, laid out. ONE card for all lanes, never one
 * per lane — the question it answers is "what was happening here", and asking it
 * fifteen times is not the same question.
 *
 * Positioned `fixed` off the pointer rather than inside the rail, because the
 * rail is a clipped scroller and a card anchored inside it would be cut off at
 * exactly the lanes near its edges.
 */
function ReadoutCard({
  hover,
  readout,
}: {
  hover: Hover;
  readout: ReturnType<typeof readoutAt>;
}): React.JSX.Element | null {
  if (readout.rows.length === 0) return null;
  const flipX = hover.x + TIP_W > window.innerWidth;
  const flipY = hover.y + TIP_H > window.innerHeight;
  return (
    <div
      className="tracks__tip"
      style={{
        left: flipX ? undefined : hover.x + 14,
        right: flipX ? window.innerWidth - hover.x + 14 : undefined,
        top: flipY ? undefined : hover.y + 14,
        bottom: flipY ? window.innerHeight - hover.y + 14 : undefined,
      }}
    >
      <div className="tracks__tip-head mono">{readout.timecode}</div>
      <div className="tracks__tip-rows">
        {readout.rows.map((row) => (
          <React.Fragment key={row.laneId}>
            <span className="tracks__tip-title">{row.title}</span>
            <span className="tracks__tip-value" data-tone={row.tone ?? undefined}>
              {row.text}
            </span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
