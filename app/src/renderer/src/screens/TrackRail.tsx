import React, { useEffect, useMemo, useRef, useState } from "react";
import type { MediaPlayerInstance } from "@vidstack/react";
import type { SessionTracksDTO } from "@shared/types";
import { api } from "../api.js";
import { TrackLane } from "./TrackLane.js";
import { readoutAt } from "./track-view.js";

interface Props {
  sessionId: string;
  /** Null for a session with no video: the axis is real, seeking is not. */
  player: React.RefObject<MediaPlayerInstance | null> | null;
  onInspect: (frameId: string) => void;
}

/**
 * Every recorded signal on one time axis, beneath the player. Replaces the
 * keyframe filmstrip, so the screen has exactly one time axis.
 *
 * The rail always spans the WHOLE session — width is scrubber width, always —
 * which is what makes alignment with the playhead structural rather than
 * computed. It scrolls vertically, because fifteen lanes do not fit above a
 * video frame in a 900x600 window and cutting lanes would sacrifice the
 * capture-audit reading to the navigation one.
 */
export function TrackRail({ sessionId, player, onInspect }: Props): React.JSX.Element {
  const [tracks, setTracks] = useState<SessionTracksDTO | null>(null);
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
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

  // The playhead is written IMPERATIVELY. `player.subscribe` fires every
  // animation frame; routing it through state would re-render fifteen lanes at
  // 60fps. KeyframeStrip already encoded this lesson by setting state only when
  // the nearest keyframe changed.
  useEffect(() => {
    const p = player?.current;
    if (!p || totalSec <= 0) return;
    return p.subscribe(({ currentTime }) => {
      const el = headRef.current;
      if (el) el.style.transform = `translateX(${(currentTime / totalSec) * 100}%)`;
    });
  }, [player, totalSec]);

  const secAt = (clientX: number): number | null => {
    const el = plotRef.current;
    if (!el || totalSec <= 0) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return null;
    return Math.max(0, Math.min(totalSec, ((clientX - r.left) / r.width) * totalSec));
  };

  const seek = (sec: number): void => {
    const p = player?.current;
    if (p) p.currentTime = Math.max(0, sec);
  };

  const readout = useMemo(
    () => (tracks && hoverSec !== null ? readoutAt(tracks, hoverSec) : null),
    [tracks, hoverSec],
  );

  if (!tracks) return <div className="tracks tracks--note">reading signals…</div>;
  if (totalSec <= 0) {
    return <div className="tracks tracks--note">this recording has no measurable span</div>;
  }

  return (
    <div className="tracks">
      <div
        className="tracks__body"
        ref={plotRef}
        onMouseMove={(e) => setHoverSec(secAt(e.clientX))}
        onMouseLeave={() => setHoverSec(null)}
        onClick={(e) => {
          // A keyframe handles its own click and stops there; anything else on
          // the rail is a seek.
          if ((e.target as HTMLElement).closest(".tracks__thumb, .tracks__mark")) return;
          const sec = secAt(e.clientX);
          if (sec !== null && player) seek(sec);
        }}
      >
        {tracks.lanes.map((lane) => (
          <TrackLane
            key={lane.id}
            lane={lane}
            totalSec={totalSec}
            onSeek={player ? seek : null}
            onInspect={onInspect}
          />
        ))}
        {player && <div className="tracks__playhead" ref={headRef} />}
        {hoverSec !== null && (
          <div className="tracks__crosshair" style={{ left: `${(hoverSec / totalSec) * 100}%` }} />
        )}
      </div>
      <div className="tracks__readout mono">{readout ? readout.join(" · ") : " "}</div>
    </div>
  );
}
