import React from "react";

type P = React.SVGProps<SVGSVGElement>;
const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const IconRecord = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" />
  </svg>
);

export const IconSearch = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.2-4.2" />
  </svg>
);

export const IconSettings = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.6 15H4.5a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V4.5a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </svg>
);

export const IconClose = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconLibrary = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <rect x="3" y="4" width="18" height="14" rx="2" />
    <path d="M10.2 8.8l4.6 2.7-4.6 2.7z" fill="currentColor" stroke="none" />
    <path d="M7.5 21h9" />
  </svg>
);

export const IconImage = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="M21 16l-5-5-9 9" />
  </svg>
);

/* Player transport. The bar is the keyframe being jumped to, so the glyphs read
   as "snap to the previous/next indexed frame", not as a 10s seek. */
export const IconPrevKeyframe = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <path d="M6 5.5v13" />
    <path d="M19 6.2v11.6L10 12z" fill="currentColor" stroke="none" />
  </svg>
);

export const IconNextKeyframe = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <path d="M18 5.5v13" />
    <path d="M5 6.2v11.6L14 12z" fill="currentColor" stroke="none" />
  </svg>
);

/* A play head inside a return arc — "do that recorded thing again". */
export const IconReplay = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 3.2v3.8h-3.8" />
    <path d="M10.4 9.4l4.6 2.6-4.6 2.6z" fill="currentColor" stroke="none" />
  </svg>
);

/* A frame under a loupe — "open this keyframe with its regions". */
export const IconInspect = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <path d="M20 12.5V5.5a1.5 1.5 0 0 0-1.5-1.5h-13A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16h6" />
    <circle cx="16.5" cy="16.5" r="3.5" />
    <path d="M19.2 19.2L21.5 21.5" />
  </svg>
);
