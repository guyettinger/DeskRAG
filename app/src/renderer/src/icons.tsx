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

/**
 * Indexing: a stack of layers being fed through. Deliberately NOT a spinner or
 * an hourglass — the nav icon names a place you can go, and it is the same shape
 * whether anything is running or not. Liveness is the topbar chip's job.
 */
export const IconIndexing = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <path d="M3.5 7.2 12 3.2l8.5 4-8.5 4z" />
    <path d="M3.5 12 12 16l8.5-4" />
    <path d="M3.5 16.6 12 20.6l8.5-4" />
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

/* One path that branches into two, with a node at each fork and each end —
   "the shapes your work takes". Deliberately NOT the old play-in-an-arc: this
   screen explores recorded behavior and never replays it. */
/* A page with a turned corner and a spark — a written artifact, not a graph. */
export const IconSkills = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" />
    <path d="M14 3v4h4" />
    <path d="m10 13 1 2.2 2.2 1-2.2 1L10 19.4 9 17.2 6.8 16.2 9 15.2z" />
  </svg>
);

export const IconFlows = (p: P): React.JSX.Element => (
  <svg {...base} {...p}>
    <circle cx="5" cy="6" r="2" />
    <circle cx="13" cy="12" r="2" />
    <circle cx="19" cy="6" r="2" />
    <circle cx="19" cy="18" r="2" />
    <path d="M6.6 7.4 11.4 10.6" />
    <path d="M14.6 10.6 17.4 7.4" />
    <path d="M14.6 13.4 17.4 16.6" />
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
