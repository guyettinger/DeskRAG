import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyframeMarkerDTO, SessionDetailDTO, SessionSummaryDTO } from "@shared/types";
import { api, formatBytes, timecode, wallClock } from "../api.js";
import { GhostLottie } from "../brand/GhostLottie.js";
import { DetailView } from "./DetailView.js";

const SPEEDS = [0.5, 1, 2, 4];

export function LibraryScreen(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummaryDTO[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetailDTO | null>(null);
  const [confirming, setConfirming] = useState<SessionSummaryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const list = await api.sessions.list();
    setSessions(list);
    setSelected((cur) => (cur && list.some((s) => s.id === cur) ? cur : (list[0]?.id ?? null)));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let live = true;
    setDetail(null);
    void api.sessions.detail(selected).then((d) => {
      if (live) setDetail(d);
    });
    return () => {
      live = false;
    };
  }, [selected]);

  const remove = async (s: SessionSummaryDTO): Promise<void> => {
    setConfirming(null);
    setError(null);
    try {
      await api.sessions.remove(s.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  if (!sessions) return <div className="spinner" />;

  return (
    <div className="page">
      <div className="page__head">
        <span className="eyebrow">Library</span>
        <h1>Your recordings</h1>
        <p>
          Every session you have captured. Play one back — the ticks under the scrubber mark the
          keyframes that were indexed and searched.
        </p>
      </div>

      {error && (
        <div className="banner" style={{ marginTop: 16 }}>
          <span className="led" /> {error}
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="empty">
          <GhostLottie size={104} className="empty__ghost" playing />
          <h3>No recordings yet</h3>
          <p>Record a session on the Record tab and it will show up here.</p>
        </div>
      ) : (
        <div className="library">
          <div className="library__list">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`sessioncard${selected === s.id ? " is-active" : ""}`}
                onClick={() => setSelected(s.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && setSelected(s.id)}
              >
                <div className="sessioncard__thumb">
                  {s.posterUrl ? (
                    <img src={s.posterUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="frame__noimg">no keyframe</span>
                  )}
                  {s.hasVideo && <span className="sessioncard__badge mono">VIDEO</span>}
                </div>
                <div className="sessioncard__body">
                  <div className="sessioncard__when">{wallClock(s.startedAt)}</div>
                  <div className="sessioncard__meta mono">
                    {timecode(s.durationMs)} · {s.frameCount} frames · {formatBytes(s.sizeBytes)}
                  </div>
                </div>
                <button
                  className="sessioncard__del"
                  aria-label="Delete recording"
                  title="Delete recording"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirming(s);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className="library__stage">
            {detail ? <SessionPlayer key={detail.id} detail={detail} /> : <div className="spinner" />}
          </div>
        </div>
      )}

      {confirming && (
        <div className="overlay" onClick={() => setConfirming(null)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <h3>Delete this recording?</h3>
            <p className="mono">
              {wallClock(confirming.startedAt)} · {timecode(confirming.durationMs)} ·{" "}
              {formatBytes(confirming.sizeBytes)}
            </p>
            <p className="confirm__warn">
              The video, keyframes, transcripts, and search index for this session are removed
              permanently. This cannot be undone.
            </p>
            <div className="confirm__actions">
              <button className="btn ghost" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void remove(confirming)}>
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionPlayer({ detail }: { detail: SessionDetailDTO }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [openFrame, setOpenFrame] = useState<string | null>(null);
  const [hover, setHover] = useState<KeyframeMarkerDTO | null>(null);

  // Fall back to the t_mono span until the element reports its real duration.
  const span = detail.video ? (detail.video.tMonoEnd - detail.video.tMonoStart) / 1000 : 0;
  const total = duration || span;

  const seek = useCallback((sec: number): void => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(sec, v.duration || sec));
  }, []);

  const nearest = useMemo(() => {
    if (detail.keyframes.length === 0) return null;
    return detail.keyframes.reduce((best, k) =>
      Math.abs(k.offsetSec - position) < Math.abs(best.offsetSec - position) ? k : best,
    );
  }, [detail.keyframes, position]);

  const step = useCallback(
    (dir: 1 | -1): void => {
      const ks = detail.keyframes;
      if (ks.length === 0) return;
      const next =
        dir === 1
          ? ks.find((k) => k.offsetSec > position + 0.01)
          : [...ks].reverse().find((k) => k.offsetSec < position - 0.01);
      if (next) seek(next.offsetSec);
    },
    [detail.keyframes, position, seek],
  );

  const toggle = useCallback((): void => {
    const v = videoRef.current;
    if (v) void (v.paused ? v.play() : v.pause());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (openFrame) return; // DetailView owns the keyboard while it is open
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, toggle, openFrame]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = speed;
  }, [speed]);

  if (!detail.video) {
    return (
      <div className="player">
        <div className="player__note">
          No video for this session — it was recorded before video capture, or with the Screen
          signal off. Its {detail.keyframes.length} indexed keyframes:
        </div>
        <div className="sheet">
          {detail.keyframes.map((k) => (
            <button key={k.frameId} className="frame" onClick={() => setOpenFrame(k.frameId)}>
              <div className="frame__thumb">
                {k.thumbUrl ? (
                  <img src={k.thumbUrl} alt="" loading="lazy" />
                ) : (
                  <span className="frame__noimg">no keyframe</span>
                )}
                <span className="frame__tc mono">{timecode(k.tMono)}</span>
              </div>
            </button>
          ))}
        </div>
        {openFrame && <DetailView frameId={openFrame} onClose={() => setOpenFrame(null)} />}
      </div>
    );
  }

  const pct = total ? (position / total) * 100 : 0;

  return (
    <div className="player">
      <video
        ref={videoRef}
        className="player__video"
        src={detail.video.url}
        // Fragmented MP4 can report Infinity until enough is buffered.
        onLoadedMetadata={(e) =>
          setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)
        }
        onDurationChange={(e) =>
          setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)
        }
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onClick={toggle}
      />

      <div className="player__bar">
        <button className="btn ghost" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button className="btn ghost" onClick={() => step(-1)} title="Previous keyframe">
          ⏮
        </button>
        <button className="btn ghost" onClick={() => step(1)} title="Next keyframe">
          ⏭
        </button>
        <span className="mono player__time">
          {timecode(position * 1000)} / {timecode(total * 1000)}
        </span>
        <select
          className="player__speed mono"
          value={speed}
          aria-label="Playback speed"
          onChange={(e) => setSpeed(Number(e.target.value))}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <button
          className="btn"
          disabled={!nearest}
          onClick={() => nearest && setOpenFrame(nearest.frameId)}
        >
          Inspect keyframe
        </button>
      </div>

      <div
        className="scrub"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          seek(((e.clientX - r.left) / r.width) * total);
        }}
      >
        <div className="scrub__fill" style={{ width: `${pct}%` }} />
        <div className="scrub__head" style={{ left: `${pct}%` }} />
      </div>

      <div className="ticks">
        {detail.keyframes.map((k) => (
          <span
            key={k.frameId}
            className={`tick${nearest?.frameId === k.frameId ? " is-near" : ""}`}
            style={{ left: `${total ? (k.offsetSec / total) * 100 : 0}%` }}
            title={k.segmentDigest ?? timecode(k.tMono)}
            onMouseEnter={() => setHover(k)}
            onMouseLeave={() => setHover(null)}
            onClick={() => seek(k.offsetSec)}
          />
        ))}
        {hover?.thumbUrl && (
          <img
            className="tick__peek"
            src={hover.thumbUrl}
            alt=""
            style={{ left: `${total ? (hover.offsetSec / total) * 100 : 0}%` }}
          />
        )}
      </div>

      <div className="player__meta mono">
        {detail.keyframes.length} keyframes · {detail.segmentCount} segments · {detail.eventCount}{" "}
        events · {formatBytes(detail.sizeBytes)}
      </div>

      {openFrame && <DetailView frameId={openFrame} onClose={() => setOpenFrame(null)} />}
    </div>
  );
}
