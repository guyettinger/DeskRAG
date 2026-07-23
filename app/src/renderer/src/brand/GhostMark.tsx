/**
 * The static DeskRAG mark.
 *
 * The SVG source is imported as raw text and inlined, rather than transcribed
 * into JSX — transcribing would fork the art away from geometry.ts, which is
 * exactly what this whole pipeline exists to prevent. Regenerate the source
 * with `npm run gen:brand` at the repo root.
 *
 * Inlined rather than used as an <img src>, so it needs no relaxation of the
 * renderer's Content-Security-Policy.
 */

import React from "react";
import markSvg from "@brand/deskrag-mark.svg?raw";

export function GhostMark({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={`brand-mark${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label="DeskRAG"
      // Build-time asset from this repo, not user content.
      dangerouslySetInnerHTML={{ __html: markSvg }}
    />
  );
}
