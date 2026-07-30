import React, { useCallback, useEffect, useState } from "react";
import type { SessionDetailDTO, SessionSummaryDTO } from "@shared/types";
import { api, formatBytes, timecode, wallClock } from "../api.js";
import { GhostLottie } from "../brand/GhostLottie.js";
import { SessionPlayer } from "./SessionPlayer.js";

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
    <div className="page page--fill">
      <div className="page__head">
        <span className="eyebrow">Library</span>
        <h1>Your recordings</h1>
        <p>
          Every session you have captured. Play one back — the scrubber is divided at the
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
            {detail ? (
              <>
                <StageHead detail={detail} />
                <SessionPlayer key={detail.id} detail={detail} />
              </>
            ) : (
              <div className="spinner" />
            )}
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

/** What this recording is, above the stage: when, how long, how much of it. */
function StageHead({ detail }: { detail: SessionDetailDTO }): React.JSX.Element {
  return (
    <div className="stagehead">
      <h2 className="stagehead__when">{wallClock(detail.startedAt)}</h2>
      <div className="stagehead__meta mono">
        {timecode(detail.durationMs)} · {detail.frameCount} frames · {formatBytes(detail.sizeBytes)}
      </div>
    </div>
  );
}
