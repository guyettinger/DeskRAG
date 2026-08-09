import React, { useCallback, useEffect, useState } from "react";
import type { SessionDetailDTO, SessionSummaryDTO } from "@shared/types";
import { api, durationShort, formatBytes, timecode, wallClock } from "../api.js";
import { GhostLottie } from "../brand/GhostLottie.js";
import { SessionPlayer } from "./SessionPlayer.js";
import type { SeekRequest } from "./TrackRail.js";

interface Props {
  /**
   * A jump from Flows or from Search: open this recording at this moment.
   *
   * `atSec` is LANE seconds — a `t_mono` offset — which is the axis the track
   * rail is drawn in. It is NOT media time: the encoded video runs about 1%
   * short of the span it covers, and `TrackRail.seek` is the one place the two
   * clocks are reconciled. `nonce` is what makes a repeat of the same moment a
   * second jump rather than a dead click; see `App`'s `OpenAt`.
   */
  openAt?: { sessionId: string; atSec: number; nonce: number } | null;
  /** Consumed — clear it, or picking another recording would re-seek. */
  onOpened?: () => void;
}

export function LibraryScreen({ openAt, onOpened }: Props = {}): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummaryDTO[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The moment to seek to once the player is ready, held separately from
   * `openAt` so the jump survives the selection change that triggers the
   * detail fetch — and so it can be cleared the instant it is handed over.
   */
  const [seekTo, setSeekTo] = useState<SeekRequest | null>(null);
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

  // A jump arrives as a prop, so it has to be turned into local state exactly
  // once. `onOpened` clears it upstream; `seekTo` carries it the rest of the
  // way down to the rail, which is the only thing that knows both clocks.
  useEffect(() => {
    if (!openAt) return;
    setSelected(openAt.sessionId);
    setSeekTo({ sec: openAt.atSec, nonce: openAt.nonce });
    onOpened?.();
  }, [openAt, onOpened]);

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
        <p>Play one back to see every signal it captured on a single time axis.</p>
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
                onClick={() => {
                  setSelected(s.id);
                  // Picking a recording by hand starts at its beginning: the
                  // pending seek belonged to the jump, not to this list.
                  setSeekTo(null);
                }}
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
                </div>
                {/* The list IDENTIFIES a recording; the stage header SPECIFIES
                    it. So the row carries a coarse duration and a frame count
                    and stops there — the full timecode and the byte size are in
                    the header, and carrying them here wrapped every row onto a
                    second line in a 300px column. */}
                <div className="sessioncard__body">
                  <div className="sessioncard__when">{wallClock(s.startedAt)}</div>
                  <div className="sessioncard__meta mono">
                    {durationShort(s.durationMs)} · {s.frameCount} frames
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
                <SessionPlayer key={detail.id} detail={detail} seekTo={seekTo} />
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
