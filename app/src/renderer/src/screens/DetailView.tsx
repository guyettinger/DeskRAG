import React, { useEffect, useState } from "react";
import type { ResultDetailDTO } from "@shared/types";
import { api, timecode, wallClock } from "../api.js";
import { IconClose, IconLibrary } from "../icons.js";
import { AxTree } from "./AxTree.js";

interface Props {
  frameId: string;
  onClose: () => void;
  /**
   * Jump to this frame's recording in the Library.
   *
   * OPTIONAL, and that is load-bearing: `SessionPlayer` opens this same view to
   * inspect a keyframe, where the button would point at the screen the reader
   * is already on. Absent there, present from Search.
   */
  onOpenRecording?: (sessionId: string, atSec: number) => void;
}

interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Position a bbox over the keyframe. Everything drawn here — search highlights
 * and AX elements alike — is in frame space (screen points), and the canvas is
 * exactly the painted image rect, so the same percentage mapping serves both
 * regardless of how far the stored JPEG was downscaled.
 */
function boxStyle(b: Bbox, frameW: number, frameH: number): React.CSSProperties {
  return {
    left: `${(b.x / frameW) * 100}%`,
    top: `${(b.y / frameH) * 100}%`,
    width: `${(b.w / frameW) * 100}%`,
    height: `${(b.h / frameH) * 100}%`,
  };
}

export function DetailView({ frameId, onClose, onOpenRecording }: Props): React.JSX.Element {
  const [detail, setDetail] = useState<ResultDetailDTO | null>(null);
  const [missing, setMissing] = useState(false);
  const [selectedAx, setSelectedAx] = useState<number | null>(null);
  const [hoveredAx, setHoveredAx] = useState<number | null>(null);
  /** The keyframe's own aspect ratio, so the canvas can't letterbox its bboxes. */
  const [aspect, setAspect] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    setDetail(null);
    setMissing(false);
    setSelectedAx(null);
    setHoveredAx(null);
    setAspect(null);
    void api.search.detail(frameId).then((d) => {
      if (ignore) return;
      // detail() resolves null for a frame that no longer exists; without this it
      // is indistinguishable from "still loading" and spins forever.
      if (d) setDetail(d);
      else setMissing(true);
    });
    return () => {
      ignore = true;
    };
  }, [frameId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Frames recorded before the app passed its display size have no frame space,
  // so nothing can be mapped onto them.
  const locatable = detail !== null && detail.width > 0 && detail.height > 0;
  const axBox = (i: number | null): (Bbox & { label: string }) | null => {
    if (!locatable || i === null) return null;
    const n = detail.ax[i];
    return n ? { x: n.x, y: n.y, w: n.w, h: n.h, label: n.label ?? n.role } : null;
  };
  const selectedBox = axBox(selectedAx);
  const hoveredBox = hoveredAx === selectedAx ? null : axBox(hoveredAx);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="detail" onClick={(e) => e.stopPropagation()}>
        <button className="detail__close" onClick={onClose} aria-label="Close">
          <IconClose style={{ width: 16, height: 16 }} />
        </button>

        <div className="detail__stage">
          {missing ? (
            <div className="frame__noimg" style={{ position: "static" }}>
              frame no longer exists
            </div>
          ) : !detail ? (
            <div className="spinner" />
          ) : detail.imageUrl ? (
            <div
              className="detail__canvas"
              style={aspect ? ({ "--frame-ar": aspect } as React.CSSProperties) : undefined}
            >
              <img
                src={detail.imageUrl}
                alt="Recorded keyframe"
                onLoad={(e) => setAspect(`${e.currentTarget.naturalWidth} / ${e.currentTarget.naturalHeight}`)}
              />
              {locatable &&
                detail.highlights.map((h) => (
                  <div key={h.regionId} className="bbox" style={boxStyle(h.bbox, detail.width, detail.height)}>
                    {h.label && <span className="bbox__label">{h.label}</span>}
                  </div>
                ))}
              {hoveredBox && (
                <div className="bbox bbox--ax-hover" style={boxStyle(hoveredBox, detail.width, detail.height)} />
              )}
              {selectedBox && (
                <div className="bbox bbox--ax" style={boxStyle(selectedBox, detail.width, detail.height)}>
                  <span
                    className={`bbox__label bbox__label--ax${
                      selectedBox.y / detail.height < 0.03 ? " bbox__label--inside" : ""
                    }`}
                  >
                    {selectedBox.label}
                  </span>
                </div>
              )}
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
                  {detail.score !== undefined && (
                    <>
                      <dt>Score</dt>
                      <dd style={{ color: "var(--accent)" }}>{detail.score.toFixed(3)}</dd>
                    </>
                  )}
                  <dt>Session</dt>
                  <dd>{detail.session.id.slice(0, 12)}…</dd>
                </dl>
                {onOpenRecording && (
                  <button
                    className="btn ghost detail__open"
                    onClick={() => {
                      onOpenRecording(detail.session.id, detail.offsetSec);
                      onClose();
                    }}
                  >
                    <span className="inline">
                      <IconLibrary style={{ width: 15, height: 15 }} /> Open in Library
                    </span>
                  </button>
                )}
              </div>

              {/* The task this frame happened inside, above its own text: the
                  wider answer comes first. Unlike the search card, which
                  withholds the line, this names the field even when empty —
                  the same rule every field here follows, because an inspection
                  surface makes absence VISIBLE while a dense result list would
                  just carry one more dim row per card. */}
              <Section label="Task" text={detail.taskSummary} />
              <Section label="Digest" text={detail.segment?.digest} />
              <Section label="Caption" text={detail.segment?.caption} />
              <Section label="Transcript" text={detail.segment?.transcript} />

              <AxTree
                nodes={detail.ax}
                frameW={detail.width}
                frameH={detail.height}
                selected={selectedAx}
                onSelect={setSelectedAx}
                onHover={setHoveredAx}
              />
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
