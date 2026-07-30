import React, { useEffect, useRef } from "react";
import type { KeyframeMarkerDTO } from "@shared/types";
import { keyframeLabel, timecode } from "../api.js";

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
  //
  // Measured with rects, NOT offsetLeft: offsetLeft is relative to the nearest
  // positioned ancestor, and nothing from .filmstrip up to <body> is positioned,
  // so it reports a document-space number (rail + session list + page padding
  // included) that scrolls the clicked keyframe clean out of view.
  //
  // An item already fully in view is left alone — otherwise a click would yank
  // the thing just clicked, and playback would nudge the strip at every
  // keyframe boundary.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activeFrameId) return;
    const el = strip.querySelector<HTMLElement>(`[data-frame="${CSS.escape(activeFrameId)}"]`);
    if (!el) return;
    const stripRect = strip.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    if (elRect.left >= stripRect.left && elRect.right <= stripRect.right) return;
    const delta = elRect.left - stripRect.left - (strip.clientWidth - elRect.width) / 2;
    strip.scrollTo({ left: strip.scrollLeft + delta, behavior: "smooth" });
  }, [activeFrameId]);

  if (keyframes.length === 0) return null;

  return (
    <div className="filmstrip" ref={stripRef}>
      {keyframes.map((k) => (
        <button
          key={k.frameId}
          data-frame={k.frameId}
          className={`filmstrip__item${activeFrameId === k.frameId ? " is-active" : ""}`}
          title={keyframeLabel(k)}
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
