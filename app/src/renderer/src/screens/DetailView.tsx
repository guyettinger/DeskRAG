import React, { useEffect, useState } from "react";
import type { ResultDetailDTO } from "@shared/types";
import { api, timecode, wallClock } from "../api.js";
import { IconClose } from "../icons.js";

interface Props {
  frameId: string;
  onClose: () => void;
}

export function DetailView({ frameId, onClose }: Props): React.JSX.Element {
  const [detail, setDetail] = useState<ResultDetailDTO | null>(null);

  useEffect(() => {
    api.search.detail(frameId).then(setDetail);
  }, [frameId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="detail" onClick={(e) => e.stopPropagation()}>
        <button className="detail__close" onClick={onClose} aria-label="Close">
          <IconClose style={{ width: 16, height: 16 }} />
        </button>

        <div className="detail__stage">
          {!detail ? (
            <div className="spinner" />
          ) : detail.imageUrl ? (
            <div className="detail__canvas">
              <img src={detail.imageUrl} alt="Recorded keyframe" />
              {detail.highlights.map((h) => (
                <div
                  key={h.regionId}
                  className="bbox"
                  style={{
                    left: `${(h.bbox.x / detail.width) * 100}%`,
                    top: `${(h.bbox.y / detail.height) * 100}%`,
                    width: `${(h.bbox.w / detail.width) * 100}%`,
                    height: `${(h.bbox.h / detail.height) * 100}%`,
                  }}
                >
                  {h.label && <span className="bbox__label">{h.label}</span>}
                </div>
              ))}
            </div>
          ) : (
            <div className="frame__noimg" style={{ position: "static" }}>
              no keyframe image
            </div>
          )}
        </div>

        <div className="detail__side">
          {detail && (
            <>
              <div>
                <span className="eyebrow">Frame</span>
                <dl className="meta-grid" style={{ marginTop: 8 }}>
                  <dt>Timecode</dt>
                  <dd>{timecode(detail.tMono)}</dd>
                  <dt>When</dt>
                  <dd>{wallClock(detail.wallClock)}</dd>
                  <dt>Size</dt>
                  <dd>
                    {detail.width}×{detail.height}
                  </dd>
                  {detail.score !== undefined && (
                    <>
                      <dt>Score</dt>
                      <dd style={{ color: "var(--accent)" }}>{detail.score.toFixed(3)}</dd>
                    </>
                  )}
                  <dt>Session</dt>
                  <dd>{detail.session.id.slice(0, 12)}…</dd>
                </dl>
              </div>

              <Section label="Digest" text={detail.segment?.digest} />
              <Section label="Caption" text={detail.segment?.caption} />
              <Section label="Transcript" text={detail.segment?.transcript} />

              <div className="field">
                <span className="field__label">
                  Accessibility ({detail.ax.length})
                </span>
                {detail.ax.length === 0 ? (
                  <span className="field__text empty">no AX captured for this frame</span>
                ) : (
                  <div className="axlist">
                    {detail.ax.slice(0, 40).map((e, i) => (
                      <span className="axtag" key={i}>
                        {e.role}
                        {e.label ? (
                          <>
                            {" "}
                            <b>{e.label}</b>
                          </>
                        ) : null}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ label, text }: { label: string; text?: string | null }): React.JSX.Element {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <span className={`field__text${text ? "" : " empty"}`}>{text || `no ${label.toLowerCase()}`}</span>
    </div>
  );
}
