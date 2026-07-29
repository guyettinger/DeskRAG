import React, { useEffect, useRef } from "react";
import type { KeyframeMarkerDTO } from "@shared/types";
import { timecode } from "../api.js";

interface Props {
  keyframes: KeyframeMarkerDTO[];
  /** The keyframe nearest the playhead, highlighted and scrolled into view. */
  activeFrameId: string | null;
  /** Click — move the playhead to this keyframe. Omitted when there is no video. */
  onSeek?: (offsetSec: number) => void;
  /** Double click (or click, with no video) — open the keyframe in DetailView. */
  onInspect: (frameId: string) => void;
}

/**
 * The contact sheet under the player: every indexed keyframe of the session, in
 * order. It is the always-visible counterpart to the player's auto-hiding
 * chrome, and the whole UI for sessions recorded without video.
 */
export function KeyframeStrip({
  keyframes,
  activeFrameId,
  onSeek,
  onInspect,
}: Props): React.JSX.Element | null {
  const stripRef = useRef<HTMLDivElement>(null);

  // Centre the active keyframe. Scrolling the container directly rather than
  // scrollIntoView(), which would also scroll the page behind it.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activeFrameId) return;
    const el = strip.querySelector<HTMLElement>(`[data-frame="${CSS.escape(activeFrameId)}"]`);
    if (!el) return;
    strip.scrollTo({
      left: el.offsetLeft - strip.clientWidth / 2 + el.clientWidth / 2,
      behavior: "smooth",
    });
  }, [activeFrameId]);

  if (keyframes.length === 0) return null;

  return (
    <div className="filmstrip" ref={stripRef}>
      {keyframes.map((k) => (
        <button
          key={k.frameId}
          data-frame={k.frameId}
          className={`filmstrip__item${activeFrameId === k.frameId ? " is-active" : ""}`}
          title={k.segmentDigest ?? timecode(k.tMono)}
          onClick={() => (onSeek ? onSeek(k.offsetSec) : onInspect(k.frameId))}
          onDoubleClick={() => onInspect(k.frameId)}
        >
          <div className="filmstrip__thumb">
            {k.thumbUrl ? (
              <img src={k.thumbUrl} alt="" loading="lazy" draggable={false} />
            ) : (
              <span className="frame__noimg">no keyframe</span>
            )}
          </div>
          <span className="filmstrip__tc mono">{timecode(k.tMono)}</span>
        </button>
      ))}
    </div>
  );
}
