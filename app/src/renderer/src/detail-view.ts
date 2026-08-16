/**
 * The detail overlay's pure geometry — the loupe's arithmetic, with no DOM in it.
 *
 * A `.ts` and not a `.tsx`, the `search-view.ts` / `track-view.ts` /
 * `graph-layout.ts` precedent: the ROOT tsconfig sets no `jsx`, so a root test
 * that reaches into a `.tsx` — even for a type — breaks `npm run typecheck`. For
 * the same reason nothing here returns a `React.CSSProperties`: React's types
 * live in `app/node_modules` and the root suite cannot see them. `boxRect`
 * returns plain strings and the component spreads them.
 *
 * ONE definition of what "scale" means, because two would drift. Throughout this
 * file `scale` is **displayed CSS pixels per STORED IMAGE pixel**, so the canvas
 * is `imgW * scale` wide and `deviceScale` converts it to the number a reader is
 * actually shown. Frame space (screen points, what AX bboxes and mouse hotspots
 * arrive in) only ever appears as a FRACTION of the frame, so the stored JPEG's
 * own downscale never enters the mapping.
 */

/** Below this the frame is a thumbnail; below it again nothing is legible. */
export const MIN_SCALE = 0.05;
/**
 * 8x the stored bitmap. Past ~4x a default 1280px capture is pure mosaic, but
 * the ceiling is deliberately generous: a reader zooming this far has already
 * been told by the readout that they are past captured detail, and stopping them
 * short of a bbox they are trying to read would be the app second-guessing a
 * decision it just disclosed.
 */
export const MAX_SCALE = 8;

/** One press of `+` / `-`. A ratio, so stepping up then down returns exactly. */
export const SCALE_STEP = 1.5;

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoxRect {
  left: string;
  top: string;
  width: string;
  height: string;
}

function clamp(v: number, lo: number, hi: number): number {
  // `hi` can legitimately fall below `lo` — a canvas smaller than its stage has
  // no scroll range at all — and Math.min/max in this order resolves to `lo`,
  // which is the correct answer (scroll 0) rather than a negative offset.
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Position a bbox over the keyframe, as percentages of the canvas.
 *
 * Everything drawn on the stage — search highlights and AX elements alike — is in
 * frame space (screen points), and the canvas is exactly the painted image rect,
 * so one percentage mapping serves both regardless of how far the stored JPEG was
 * downscaled. It is also why zoom needs no change here: the canvas grows, the
 * percentages do not move.
 */
export function boxRect(b: Bbox, frameW: number, frameH: number): BoxRect {
  return {
    left: `${(b.x / frameW) * 100}%`,
    top: `${(b.y / frameH) * 100}%`,
    width: `${(b.w / frameW) * 100}%`,
    height: `${(b.h / frameH) * 100}%`,
  };
}

/**
 * The scale at which the whole frame fits the stage — the view's resting state.
 *
 * Returns 0 rather than dividing by a zero: a stage that has not been measured
 * yet and an image that has not loaded yet are both real states on the first
 * frame, and `Infinity` would size a canvas nothing can recover from.
 */
export function fitScale(stageW: number, stageH: number, imgW: number, imgH: number): number {
  if (stageW <= 0 || stageH <= 0 || imgW <= 0 || imgH <= 0) return 0;
  return Math.min(stageW / imgW, stageH / imgH);
}

/**
 * The scale at which ONE STORED PIXEL COVERS ONE DEVICE PIXEL — the ceiling of
 * what was actually captured.
 *
 * On a 2x display that is a CSS scale of 0.5, which is the whole reason this is a
 * function and not the literal 1: reading the ceiling in CSS pixels would put the
 * honest limit at 2x on a retina Mac and 1x on an external monitor, i.e. the same
 * recording would claim two different resolutions.
 */
export function oneToOneScale(devicePixelRatio: number): number {
  return devicePixelRatio > 0 ? 1 / devicePixelRatio : 1;
}

/**
 * What the readout prints: stored pixels per DEVICE pixel.
 *
 * Above 1 the image is magnified past anything that was recorded, which is the
 * moment the stage switches to `image-rendering: pixelated`. Smoothing there
 * would invent detail the capture never had — the same reason the highlighter
 * draws no box at all on a grid disagreement.
 */
export function deviceScale(scale: number, devicePixelRatio: number): number {
  return scale * (devicePixelRatio > 0 ? devicePixelRatio : 1);
}

/** Is this scale past the capture's real detail, and therefore drawn hard-edged? */
export function isPastCapture(scale: number, devicePixelRatio: number): boolean {
  // A hair of tolerance so landing exactly on 1:1 is not reported as past it;
  // fitScale rarely produces a round number and float noise is the norm here.
  return deviceScale(scale, devicePixelRatio) > 1.001;
}

/**
 * The scroll offset that keeps the point under the cursor FIXED while zooming.
 *
 * Zooming about the viewport's centre instead is what makes a zoom feel like it
 * fights you: the thing you were looking at slides away exactly when you asked
 * for a closer look. `cursor` is the pointer's offset inside the stage, not the
 * page.
 */
export function zoomAbout(scroll: number, cursor: number, oldScale: number, newScale: number): number {
  if (oldScale <= 0) return scroll;
  const contentPoint = (scroll + cursor) / oldScale;
  return contentPoint * newScale - cursor;
}

export interface StageView {
  scale: number;
  scrollLeft: number;
  scrollTop: number;
}

/**
 * The scale and scroll that FRAME one bbox in the stage — what clicking a matched
 * region or an AX row lands on.
 *
 * `padding` is the fraction of the stage left as margin, so a box never sits flush
 * against an edge with no context around it. The scale is clamped before the
 * scroll is computed, not after: clamping afterwards would centre the box for a
 * scale the stage is not actually at.
 *
 * A degenerate box (zero width or height, which a real AX element can genuinely
 * have) falls back to the caller's current scale rather than dividing by it.
 */
export function frameBox(
  box: Bbox,
  frameW: number,
  frameH: number,
  imgW: number,
  imgH: number,
  stageW: number,
  stageH: number,
  currentScale: number,
  padding = 0.25,
): StageView {
  const safe = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);
  const room = 1 - clamp(padding, 0, 0.9);

  // The box as a fraction of the frame — the one space both the AX walk and the
  // region proposer agree on — then onto the stored image.
  const boxImgW = safe(box.w / frameW) * imgW;
  const boxImgH = safe(box.h / frameH) * imgH;

  const wanted =
    boxImgW > 0 && boxImgH > 0
      ? Math.min((stageW * room) / boxImgW, (stageH * room) / boxImgH)
      : currentScale;
  const scale = clamp(wanted, MIN_SCALE, MAX_SCALE);

  const canvasW = imgW * scale;
  const canvasH = imgH * scale;
  const centreX = ((box.x + box.w / 2) / frameW) * canvasW;
  const centreY = ((box.y + box.h / 2) / frameH) * canvasH;

  return {
    scale,
    scrollLeft: clamp(centreX - stageW / 2, 0, Math.max(0, canvasW - stageW)),
    scrollTop: clamp(centreY - stageH / 2, 0, Math.max(0, canvasH - stageH)),
  };
}

/**
 * Average glyph advance for `.bbox__label` (9px mono) plus its horizontal
 * padding, in px. The same constants-not-measurement trade `labelFits` makes in
 * `track-view.ts`, and for the same reason: this module is pure and root-tested,
 * so measuring text would put the rule behind a canvas or a layout pass.
 */
const LABEL_CH_PX = 5.4;
const LABEL_PAD_PX = 10;

/**
 * May this box paint its label?
 *
 * Only when it fits UNTRUNCATED — `labelFits`' sibling in two dimensions.
 * `.bbox__label` used to carry `text-overflow: ellipsis`, one of the last two
 * violations of the rule that nothing truncates, and on a fit-to-stage keyframe
 * almost every label was clipped to two or three characters: a row of amber tags
 * reading `Ap…`, `Re…`, `Se…` says less than no tags at all.
 *
 * Withholding costs nothing here, because the panel's matched-region list carries
 * every label at full extent — the same division of labour as the rail and its
 * hover card. And because the box grows with the zoom, labels REAPPEAR as a
 * reader zooms in, which is the rule paying for itself rather than merely holding.
 */
export function bboxLabelFits(boxWidthPx: number, text: string): boolean {
  if (boxWidthPx <= 0 || text.length === 0) return false;
  return boxWidthPx >= text.length * LABEL_CH_PX + LABEL_PAD_PX;
}

/**
 * A box's painted width in px at the current scale — what `bboxLabelFits` asks
 * about. Frame space in, canvas pixels out, so the caller never has to know that
 * the stored image and the frame are different sizes.
 */
export function boxWidthPx(box: Bbox, frameW: number, imgW: number, scale: number): number {
  if (frameW <= 0) return 0;
  return (box.w / frameW) * imgW * scale;
}
