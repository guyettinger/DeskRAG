/**
 * The single source of truth for the DeskRAG mark: shape, motion, and palette.
 *
 * Pure functions, no I/O, no knowledge of any file format. Every emitter
 * (static SVG, animated SVG, Lottie, icons) derives its output from here, which
 * is what stops the animated SVG and the Lottie JSON from drifting apart.
 */

export type Pt = [number, number];

export const palette = {
  ghostTop: "#FFFFFF",
  ghostMid: "#F3EEFF",
  ghostBot: "#A18AF5",
  face: "#12161C",
  desk: "#8A93A3",
  deskOpacity: 0.55,
  shadow: "#6D5BD0",
  shadowOpacity: 0.28,
} as const;

/** The mark is composed on a 256x256 square. */
export const CANVAS = 256;

/** Loop timing, shared by the animated SVG and the Lottie. 3 seconds. */
export const FPS = 60;
export const FRAMES = 180;

/**
 * Sampled phases. Four distinct hem shapes plus a repeat of the first, so the
 * loop closes seamlessly. Each lands on a whole frame: 0, 45, 90, 135, 180.
 */
export const KEYFRAMES = [0, 0.25, 0.5, 0.75, 1] as const;

// --- Ghost-local coordinate box (240 x 260) -------------------------------
// Authoring the ghost in its own box keeps the numbers legible; GHOST_FIT
// places it on the 256 canvas.

const LEFT = 24;
const RIGHT = 216;
const APEX_Y = 20;
const SHOULDER_Y = 130;
const HEM_Y = 196;
const CUSP_X: readonly [number, number] = [88, 152];

const LOBE_DEPTH = 22;
const LOBE_WOBBLE = 5;
const CUSP_LIFT = 10;
const CUSP_WOBBLE = 3;

/** Places the 240x260 ghost box onto the 256 canvas: translate then scale. */
export const GHOST_FIT = { scale: 0.86, tx: 24.8, ty: 4.8 } as const;

/** Contact shadow, in canvas coordinates. Sits on the desk bar. */
export const shadowEllipse = { cx: 128, cy: 216, rx: 56, ry: 11 } as const;

/** The implied desk: one rounded bar, in canvas coordinates. */
export const deskBar = { x: 20, y: 213, w: 216, h: 7, r: 3.5 } as const;

/** Face, in ghost-local coordinates. */
export const eyes = [
  { cx: 88, cy: 112, rx: 13, ry: 17 },
  { cx: 152, cy: 112, rx: 13, ry: 17 },
] as const;
/** Mouth, in ghost-local coordinates, as a quadratic bezier: start, control, end. */
const MOUTH_START: Pt = [110, 130];
const MOUTH_CONTROL: Pt = [120, 141];
const MOUTH_END: Pt = [130, 130];
export const mouthWidth = 6;

/** Vertical bob amplitude, in ghost-local units. */
export const BOB_AMPLITUDE = 8;

/**
 * Body gradient ramp, top to bottom. The SVG applies these as fractional stop
 * offsets on a default objectBoundingBox gradient; the Lottie needs absolute
 * start/end points instead, so the vertical extent the ramp spans in
 * ghost-local coordinates is exported alongside the stops — derived from
 * APEX_Y / HEM_Y / LOBE_DEPTH here, rather than hand-derived once and pasted
 * into the emitter as a magic number that goes stale if the ghost's height
 * changes.
 */
export const bodyGradient = {
  stops: [
    { offset: 0, color: palette.ghostTop },
    { offset: 0.45, color: palette.ghostMid },
    { offset: 1, color: palette.ghostBot },
  ],
  /** Horizontal position of the ramp, ghost-local x (the apex x). */
  x: 120,
  /** Vertical span of the ramp, ghost-local y: apex to the lowest hem depth. */
  y0: APEX_Y,
  y1: HEM_Y + LOBE_DEPTH,
} as const;

/** Contact-shadow gradient ramp, centre to edge: alpha only, one colour. */
export const shadowGradient = {
  stops: [
    { offset: 0, alpha: palette.shadowOpacity },
    { offset: 0.55, alpha: 0.2 },
    { offset: 1, alpha: 0 },
  ],
} as const;

/**
 * Symmetric ease-in-out cubic-bezier control points — the one curve shared by
 * the animated SVG's SMIL keySplines, its generated CSS, and the Lottie's
 * keyframe handles. `in` is the outgoing handle's control point, `out` is the
 * incoming handle's; a plain CSS `ease-in-out` keyword happens to be this
 * exact curve, which is why the CSS below builds it explicitly instead of
 * relying on the keyword continuing to match.
 */
export const EASE = {
  in: { x: 0.42, y: 0 },
  out: { x: 0.58, y: 1 },
} as const;

/** SMIL `keySplines` value for one segment between two keyframes. */
export function easeSpline(): string {
  return `${EASE.in.x} ${EASE.in.y} ${EASE.out.x} ${EASE.out.y}`;
}

/** CSS `cubic-bezier(...)`, the same curve as `easeSpline()` and the Lottie's easing. */
export function easeCss(): string {
  return `cubic-bezier(${EASE.in.x}, ${EASE.in.y}, ${EASE.out.x}, ${EASE.out.y})`;
}

/**
 * Two decimals — enough precision to be smooth, few enough to be stable output.
 * Normalises -0 to 0: Object.is(-0, 0) is false, so an unnormalised -0 makes
 * loop-seam assertions fail and puts a stray "-0" in generated path strings.
 */
const r = (n: number): number => {
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
};

export interface Hem {
  /** Depth each of the three lobes hangs below the hem line. */
  depths: [number, number, number];
  /** Height each of the two cusps rises above the hem line. */
  lifts: [number, number];
}

/**
 * The hem at a given phase. Each lobe is phase-offset from its neighbour so the
 * cloth ripples left-to-right rather than pulsing in unison.
 */
export function hemShape(phase: number): Hem {
  const w = (i: number): number => 2 * Math.PI * (phase + i * 0.22);
  return {
    depths: [
      LOBE_DEPTH + LOBE_WOBBLE * Math.sin(w(0)),
      LOBE_DEPTH + LOBE_WOBBLE * Math.sin(w(1)),
      LOBE_DEPTH + LOBE_WOBBLE * Math.sin(w(2)),
    ],
    lifts: [
      CUSP_LIFT + CUSP_WOBBLE * Math.sin(w(0.5)),
      CUSP_LIFT + CUSP_WOBBLE * Math.sin(w(1.5)),
    ],
  };
}

export interface BezierShape {
  /** Vertices. */
  v: Pt[];
  /** In-tangents, relative to their vertex. */
  i: Pt[];
  /** Out-tangents, relative to their vertex. */
  o: Pt[];
}

/**
 * The ghost outline as a closed cubic bezier, traversed clockwise from the
 * bottom-left: up the left side, over the dome, down the right side, then the
 * hem right-to-left. Lottie needs vertices-and-tangents; SVG needs a path
 * string. Producing the bezier once and deriving the path from it guarantees
 * the two formats describe the same curve.
 */
export function ghostBodyBezier(phase: number): BezierShape {
  const { depths, lifts } = hemShape(phase);
  const [d0, d1, d2] = depths;
  const [l0, l1] = lifts;
  const [cuspL, cuspR] = CUSP_X;

  const v: Pt[] = [
    [LEFT, HEM_Y], // 0 bottom-left
    [LEFT, SHOULDER_Y], // 1 left shoulder
    [120, APEX_Y], // 2 apex
    [RIGHT, SHOULDER_Y], // 3 right shoulder
    [RIGHT, HEM_Y], // 4 bottom-right
    [cuspR, HEM_Y - l1], // 5 right cusp
    [cuspL, HEM_Y - l0], // 6 left cusp
  ];

  const o: Pt[] = [
    [0, 0], // 0 straight up the left side
    [0, 62 - SHOULDER_Y], // 1 into the dome
    [54, 0], // 2 out of the apex
    [0, 0], // 3 straight down the right side
    [0, d2], // 4 vertical, so the hem meets the side seamlessly
    [132 - cuspR, d1 + l1], // 5 into the middle lobe
    [68 - cuspL, d0 + l0], // 6 into the left lobe
  ];

  const i: Pt[] = [
    [0, d0], // 0 vertical, closing the left lobe into the side
    [0, 0], // 1 straight
    [-54, 0], // 2 into the apex
    [0, 62 - SHOULDER_Y], // 3 out of the dome
    [0, 0], // 4 straight
    [172 - cuspR, d2 + l1], // 5 closing the right lobe
    [108 - cuspL, d1 + l0], // 6 closing the middle lobe
  ];

  return { v, i, o };
}

/**
 * Converts a bezier to an SVG path. Straight runs become zero-tangent curves.
 * Closed (the default) wraps the last segment back to the first vertex and
 * appends `Z`; open stops after the last vertex, for strokes like the mouth
 * that aren't a filled outline.
 */
export function bezierToPath(s: BezierShape, closed = true): string {
  const n = s.v.length;
  const start = s.v[0]!;
  const parts: string[] = [`M ${r(start[0])} ${r(start[1])}`];
  const segments = closed ? n : n - 1;
  for (let k = 1; k <= segments; k++) {
    const a = s.v[(k - 1) % n]!;
    const b = s.v[k % n]!;
    const ao = s.o[(k - 1) % n]!;
    const bi = s.i[k % n]!;
    parts.push(
      `C ${r(a[0] + ao[0])} ${r(a[1] + ao[1])}` +
        ` ${r(b[0] + bi[0])} ${r(b[1] + bi[1])}` +
        ` ${r(b[0])} ${r(b[1])}`,
    );
  }
  if (closed) parts.push("Z");
  return parts.join(" ");
}

/** The ghost outline at a phase, as an SVG path string. */
export function ghostBodyPath(phase: number): string {
  return bezierToPath(ghostBodyBezier(phase));
}

/**
 * Raises a quadratic bezier segment (start P0, control Q, end P2) to its
 * exact cubic equivalent: C1 = P0 + (2/3)(Q - P0), C2 = P2 + (2/3)(Q - P2).
 * The rendered curve is identical — only the notation changes.
 */
function quadraticToCubic(p0: Pt, q: Pt, p2: Pt): { c1: Pt; c2: Pt } {
  return {
    c1: [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])],
    c2: [p2[0] + (2 / 3) * (q[0] - p2[0]), p2[1] + (2 / 3) * (q[1] - p2[1])],
  };
}

/**
 * The mouth as an open 2-vertex bezier, in the same convention as
 * ghostBodyBezier: tangents relative to their vertex. Raised from its natural
 * quadratic form (MOUTH_START, MOUTH_CONTROL, MOUTH_END) so both emitters
 * derive the same curve instead of restating it.
 */
export function mouthBezier(): BezierShape {
  const { c1, c2 } = quadraticToCubic(MOUTH_START, MOUTH_CONTROL, MOUTH_END);
  return {
    v: [MOUTH_START, MOUTH_END],
    i: [
      [0, 0],
      [r(c2[0] - MOUTH_END[0]), r(c2[1] - MOUTH_END[1])],
    ],
    o: [
      [r(c1[0] - MOUTH_START[0]), r(c1[1] - MOUTH_START[1])],
      [0, 0],
    ],
  };
}

/** Vertical offset at normalised time t. Negative means risen. */
export function bob(t: number): number {
  return r(-BOB_AMPLITUDE * Math.sin(2 * Math.PI * t));
}

/**
 * The shadow tightens and fades as the ghost rises. This is the cue that reads
 * as "hovering" rather than "sliding".
 */
export function shadowAt(t: number): { scale: number; opacity: number } {
  const u = (Math.sin(2 * Math.PI * t) + 1) / 2; // 0 at the lowest point, 1 at the highest
  return {
    scale: r(1 - 0.14 * u),
    opacity: r(palette.shadowOpacity - 0.1 * u),
  };
}
