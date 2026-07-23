/**
 * The animated DeskRAG ghost, played by lottie-web's light build.
 *
 * Honors prefers-reduced-motion: renders a single static frame rather than
 * looping. `playing={false}` also parks it on a static frame, so the same
 * component covers idle and busy states.
 */

import React, { useEffect, useRef } from "react";
import lottie from "lottie-web/build/player/lottie_light";
import type { AnimationItem } from "lottie-web";
import animationData from "@brand/deskrag-ghost.lottie.json";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function GhostLottie({
  size = 96,
  playing = true,
  className,
}: {
  size?: number;
  playing?: boolean;
  className?: string;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const anim = useRef<AnimationItem | null>(null);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const reduced = prefersReducedMotion();
    const item = lottie.loadAnimation({
      container,
      renderer: "svg",
      loop: true,
      autoplay: false,
      animationData,
    });
    anim.current = item;
    if (reduced) item.goToAndStop(0, true);
    return () => {
      item.destroy();
      anim.current = null;
    };
  }, []);

  useEffect(() => {
    const item = anim.current;
    if (!item) return;
    if (playing && !prefersReducedMotion()) item.play();
    else item.goToAndStop(0, true);
  }, [playing]);

  return (
    <div
      ref={host}
      className={className}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
