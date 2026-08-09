/**
 * Pure view logic for the timeline track rail.
 *
 * `.ts`, never `.tsx`: the ROOT tsconfig sets no `jsx`, so a root test that
 * reaches into a `.tsx` — even only for a type — breaks `npm run typecheck`.
 * `graph-layout.ts` sits beside `GraphCanvas.tsx` for exactly this reason.
 */

import {
  TRACK_GROUPS,
  type KeyframeMarkerDTO,
  type SessionTracksDTO,
  type TrackDensityDTO,
  type TrackGroup,
  type TrackLaneDTO,
  type TrackTone,
} from "@shared/types";

/**
 * Which keyframes get an image and which degrade to a tick.
 *
 * Walks in time order and keeps an image only where it clears the previous
 * image's right edge. The decision depends solely on the gaps between
 * neighbours, never on absolute position, so the layout is unchanged by a
 * uniform time shift — a rule that flipped under translation would make the
 * strip twitch as the axis rescales.
 *
 * The epsilon is load-bearing, not defensive rounding. `0.2 + 0.1` is
 * `0.30000000000000004`, so a thumbnail landing EXACTLY on the previous one's
 * right edge was kept at one offset and dropped at another — floating-point
 * noise alone deciding the layout, which is the same trap `Path.curve` span
 * splitting hit. Without it the translation-invariance test below fails.
 *
 * @param thumbFrac thumbnail width as a fraction of the rail's width
 */
const TOUCH_EPS = 1e-9;

export function thumbPlacement(
  atSecs: readonly number[],
  totalSec: number,
  thumbFrac: number,
): boolean[] {
  const out: boolean[] = [];
  let lastRight = -Infinity;
  for (const sec of atSecs) {
    const left = totalSec > 0 ? sec / totalSec : 0;
    const show = left >= lastRight - TOUCH_EPS;
    out.push(show);
    if (show) lastRight = left + thumbFrac;
  }
  return out;
}

/**
 * An SVG path for a density lane, 0 at the baseline and `height` at full scale.
 *
 * A `null` STARTS A NEW SUBPATH rather than drawing through it: an uncovered
 * stretch has to look like a hole, because "no audio was captured here" and "it
 * was silent here" are different facts.
 */
export function densityPath(values: readonly (number | null)[], height: number): string {
  if (values.length === 0) return "";
  const step = 100 / values.length; // percent of the viewBox width per bucket
  let d = "";
  let open = false;
  values.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    const x = i * step;
    // Inset by one unit at both ends. A zero drawn at exactly `height` sits on
    // the clipped bottom edge and half the stroke disappears, which made a
    // recorded-silent audio lane look identical to an absent one — the one
    // distinction this lane exists to draw. Measured on a real recording whose
    // microphone captured digital silence.
    const y = height - 1 - v * (height - 2);
    d += `${open ? "L" : "M"}${x.toFixed(3)},${y.toFixed(3)}`;
    open = true;
  });
  return d;
}

/**
 * Average glyph advance for `.tracks__span-label` (11px system stack), in px,
 * plus its horizontal padding (5px each side).
 *
 * A constant rather than a DOM measurement, deliberately: this module is pure
 * and root-tested, and measuring text would put the rule behind a canvas or a
 * layout pass. The cost of the approximation is that a borderline label may be
 * withheld when it would just have fitted, which is the safe direction — the
 * text is one hover away either way.
 */
const LABEL_CH_PX = 6.2;
const LABEL_PAD_PX = 10;

/**
 * May this span paint its label into the bar?
 *
 * Only when it fits UNTRUNCATED. The rail used to stamp a caption into every
 * 10s segment and clip it, so adjacent bars read as one run-on paragraph and
 * every one of them ended in an ellipsis. Nothing truncates now: a label either
 * fits or it is not drawn.
 *
 * It depends on the span's DURATION and never its position, so — like
 * thumbPlacement — the answer cannot flip under a uniform time shift.
 */
export function labelFits(
  spanSec: number,
  totalSec: number,
  axisWidth: number,
  text: string,
): boolean {
  if (totalSec <= 0 || axisWidth <= 0 || text.length === 0) return false;
  const spanPx = (spanSec / totalSec) * axisWidth;
  return spanPx >= text.length * LABEL_CH_PX + LABEL_PAD_PX;
}

export interface SpanRects {
  /** The visual bar, as percentages — no measurement needed, so it never flashes. */
  leftPct: number;
  widthPct: number;
  /** The hit target in px, padded to `minHitPx`. Null until the axis is measured. */
  hit: { leftPx: number; widthPx: number } | null;
  /**
   * The signal began before the axis does, or ran past its end, and the bar has
   * been cut to fit. The renderer draws a notched edge — never a plain one, or
   * the cut reads as the signal's real boundary.
   */
  clippedStart: boolean;
  clippedEnd: boolean;
}

/**
 * The bar and its hit target, which are NOT the same rectangle.
 *
 * The bar is the signal's true extent, down to a sub-pixel sliver. Widening it
 * so it can be clicked is exactly the overstatement this rail was rebuilt to
 * remove — a bar that claims two seconds for an instantaneous click is a lie
 * told for the mouse's benefit. So the target is a separate transparent rect,
 * padded to `minHitPx` and centred on the bar. Same principle as the Flows
 * canvas drawing every wire twice with a fat transparent stroke underneath.
 *
 * The target is CLAMPED into the axis: centred on a span at t=0 it would hang
 * into the title gutter, which is the transport's column.
 *
 * THE BAR IS CLAMPED TOO, and that is not a retreat from the extent rule above.
 * Lane offsets are measured from the video's first frame, so a signal recorded
 * before ffmpeg produced one has a NEGATIVE start — measured on a real session,
 * the `action` and `task` lanes began at −1.9s and painted 57px across the lane
 * titles. The part outside the axis is not merely inconvenient, it is
 * unrepresentable: there is no pixel that means "before zero". So the bar is cut
 * to the axis and the cut is DECLARED (`clippedStart` / `clippedEnd`) for the
 * renderer to notch, which is the same disclosure the rail already makes when it
 * distinguishes recorded silence from no coverage at all.
 */
export function spanRects(
  startSec: number,
  endSec: number,
  totalSec: number,
  axisWidth: number,
  minHitPx: number,
): SpanRects {
  const frac = totalSec > 0 ? 1 / totalSec : 0;
  const clippedStart = startSec < 0;
  const clippedEnd = endSec > totalSec;
  // Ordered max-then-min so a span lying entirely off the axis collapses to zero
  // width at the edge it fell off, rather than inverting into a negative bar.
  const start = Math.min(Math.max(startSec, 0), totalSec);
  const end = Math.min(Math.max(endSec, start), totalSec);

  const leftPct = start * frac * 100;
  const widthPct = Math.max(0, (end - start) * frac * 100);
  if (axisWidth <= 0) return { leftPct, widthPct, hit: null, clippedStart, clippedEnd };

  const left = start * frac * axisWidth;
  const width = Math.max(0, (end - start) * frac * axisWidth);
  const widthPx = Math.max(width, minHitPx);
  const leftPx = Math.max(0, Math.min(axisWidth - widthPx, left + width / 2 - widthPx / 2));
  return { leftPct, widthPct, hit: { leftPx, widthPx }, clippedStart, clippedEnd };
}

/**
 * How much signal was recorded BEFORE the axis begins, in seconds.
 *
 * Zero when nothing precedes it. Offsets are measured from the video's first
 * frame, and capture starts before ffmpeg delivers one, so a real session
 * routinely carries a second or two of events with negative offsets. That time
 * cannot be drawn — it is off the axis by construction — so the ruler names it
 * instead. Reported from the DTO rather than the store because it is exactly
 * what the clipped bars are about to show, and the two must agree.
 */
export function preRollSec(lanes: readonly TrackLaneDTO[]): number {
  let earliest = 0;
  for (const lane of lanes) {
    for (const s of lane.spans ?? []) if (s.startSec < earliest) earliest = s.startSec;
    for (const m of lane.marks ?? []) if (m.atSec < earliest) earliest = m.atSec;
    for (const t of lane.thumbs ?? []) if (t.atSec < earliest) earliest = t.atSec;
  }
  return earliest < 0 ? -earliest : 0;
}

export interface RulerTick {
  atSec: number;
  label: string;
}

/**
 * Nice labelled ticks for the shared time ruler.
 *
 * The step comes from a fixed ladder rather than `totalSec / n`, so the numbers
 * a reader sees are the ones they would have chosen — :05, :10, :15 — and they
 * do not renumber into arbitrary values as the window resizes. Only the DENSITY
 * of ticks changes with width; a tick that exists at one width sits at the same
 * second at every other. Sub-second steps keep a tenth so two ticks never print
 * the same label.
 */
const TICK_LADDER = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export function rulerTicks(totalSec: number, axisWidth: number, minGapPx = 88): RulerTick[] {
  if (totalSec <= 0 || axisWidth <= 0) return [];
  const minStep = (minGapPx / axisWidth) * totalSec;
  const step = TICK_LADDER.find((s) => s >= minStep) ?? TICK_LADDER[TICK_LADDER.length - 1]!;
  const out: RulerTick[] = [];
  // Count in integers: accumulating `at += step` drifts on 0.1, which is exactly
  // the floating-point trap `thumbPlacement` and `Path.curve` both document.
  for (let i = 0; i * step <= totalSec + 1e-9; i++) {
    const atSec = i * step;
    out.push({ atSec, label: tickLabel(atSec, step) });
  }
  return out;
}

function tickLabel(sec: number, step: number): string {
  const whole = Math.floor(sec);
  const mm = Math.floor(whole / 60);
  const ss = String(whole % 60).padStart(2, "0");
  // A tenth only where the step needs one — otherwise consecutive sub-second
  // ticks would print the same string.
  const frac = step < 1 ? `.${Math.round((sec - whole) * 10)}` : "";
  return `${mm}:${ss}${frac}`;
}

export interface LaneBand {
  id: TrackGroup;
  title: string;
  lanes: TrackLaneDTO[];
  /** How many of them are legitimately empty — shown on a collapsed band. */
  emptyCount: number;
}

/**
 * Lanes gathered into their bands, in `TRACK_GROUPS` order.
 *
 * A band with no lanes is dropped rather than rendered empty: an absent band
 * says nothing, whereas an empty LANE says why it is empty, which is the payload.
 * Within a band, `buildSessionTracks`'s order is preserved untouched.
 */
export function groupLanes(lanes: readonly TrackLaneDTO[]): LaneBand[] {
  return TRACK_GROUPS.map(({ id, title }) => {
    const inBand = lanes.filter((l) => l.group === id);
    return {
      id,
      title,
      lanes: inBand,
      emptyCount: inBand.filter((l) => l.emptyReason !== null).length,
    };
  }).filter((band) => band.lanes.length > 0);
}

function timecodeShort(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function densityReadout(d: TrackDensityDTO, sec: number, totalSec: number): string | null {
  const i =
    totalSec > 0
      ? Math.min(d.values.length - 1, Math.floor((sec / totalSec) * d.values.length))
      : 0;
  const v = d.values[i];
  // No coverage is omitted entirely. Reporting it as 0 would assert silence
  // where nothing was recorded at all.
  if (v === null || v === undefined) return null;
  const real = v * d.peak;
  return `${real >= 10 ? Math.round(real) : Number(real.toFixed(2))} ${d.unit}`;
}

/** The nearest of `items` to `sec`, or null when the closest is past `tolSec`. */
function nearest<T>(items: readonly T[], at: (t: T) => number, sec: number, tolSec: number): T | null {
  let best: T | null = null;
  let bestGap = Infinity;
  for (const item of items) {
    const gap = Math.abs(at(item) - sec);
    if (gap < bestGap) {
      best = item;
      bestGap = gap;
    }
  }
  return bestGap <= tolSec ? best : null;
}

export interface ReadoutRow {
  laneId: string;
  /** The lane's own title, so the card's left column matches the rail's gutter. */
  title: string;
  text: string;
  tone: TrackTone | null;
}

export interface Readout {
  timecode: string;
  /**
   * The lane the cursor is on, resolved — the card's answer to the gesture.
   *
   * Null when the cursor is over NO lane (a band header, or the space below
   * the last lane). There is no pointing gesture there to honour, so the card
   * answers about everything, which is the card this focus block replaced.
   */
  focus: ReadoutRow | null;
  /** Every OTHER lane carrying a value, in rail order. Never contains `focus`. */
  rows: ReadoutRow[];
}

export interface ReadoutOptions {
  /**
   * How far from the cursor a point event still counts as "here", in seconds.
   * A parameter, not a constant: it is a PIXEL tolerance, so only the rail knows
   * it — it depends on the measured width of the axis.
   */
  tolSec: number;
  /**
   * `keyframeLabel`, injected. It lives in `api.ts`, which evaluates
   * `window.deskrag` at module scope and so cannot be imported by a root test;
   * injecting it keeps this module a leaf AND keeps that function the one label
   * rule. Same pattern as `LiftInput.axAt` in the library.
   */
  label: (marker: KeyframeMarkerDTO) => string;
  /**
   * The lane under the cursor, or null when it is over none.
   *
   * OMITTING IT IS THE DEFAULT, not a branch: it yields `focus: null` and the
   * full row list, so the no-lane state costs no second code path and every
   * caller that predates focusing is unchanged.
   *
   * A named lane ALWAYS produces a `focus` row, even where it carries nothing
   * at this instant. A card that answered about five other lanes and not the
   * one under the cursor reads as broken rather than as informative.
   */
  focusLaneId?: string | null;
}

/**
 * What a focused lane says when it says nothing.
 *
 * Distinct from an `emptyReason`, which is a property of the whole recording
 * ("no scrolling recorded"). This one is about the instant.
 */
const NOTHING_HERE = "nothing here";

/**
 * One lane resolved at one instant, or null where it has nothing to say.
 *
 * Lifted out of `readoutAt` so the SAME resolution serves both the focus row
 * and the context rows — two copies of these four branches is exactly how the
 * card would come to disagree with itself about what a lane says.
 */
function resolveLane(
  lane: TrackLaneDTO,
  sec: number,
  totalSec: number,
  { tolSec, label }: ReadoutOptions,
): ReadoutRow | null {
  if (lane.emptyReason !== null) return null;
  const row = (text: string, tone: TrackTone | null): ReadoutRow => ({
    laneId: lane.id,
    title: lane.title,
    text,
    tone,
  });
  if (lane.shape === "span") {
    const span = lane.spans?.find((s) => sec >= s.startSec && sec < s.endSec);
    return span ? row(span.label, span.tone) : null;
  }
  if (lane.shape === "density" && lane.density) {
    const text = densityReadout(lane.density, sec, totalSec);
    // No coverage is omitted entirely. Reporting it as 0 would assert silence
    // where nothing was recorded at all.
    return text === null ? null : row(text, null);
  }
  if (lane.shape === "mark") {
    const mark = nearest(lane.marks ?? [], (m) => m.atSec, sec, tolSec);
    return mark ? row(mark.label, mark.tone) : null;
  }
  if (lane.shape === "thumb") {
    const thumb = nearest(lane.thumbs ?? [], (t) => t.atSec, sec, tolSec);
    return thumb
      ? row(`${label(thumb.marker)} · ${thumb.regionCount} regions`, "accent")
      : null;
  }
  return null;
}

/**
 * Every lane resolved at one instant, partitioned by what the cursor pointed at.
 *
 * ONE card for all lanes, never one per lane — the question is "what was
 * happening here", and asking it sixteen times is not the same question. But a
 * hover CARRIES AN ARGUMENT: the lane under the pointer. That lane becomes
 * `focus` and every other lane with a value becomes context, because a card
 * that returned sixteen equally-weighted rows put the answer — `Calculator` —
 * second in ~550px behind four near-identical VLM captions.
 *
 * EVERY lane is still resolved, including those in a collapsed band. Collapsing
 * is a choice about how much of the PLOT to show and must not silently cost
 * evidence; focusing is a pointing gesture and is answered as one. The two are
 * different acts, and the card now distinguishes them rather than flattening
 * both into a list.
 */
export function readoutAt(
  tracks: SessionTracksDTO,
  sec: number,
  options: ReadoutOptions,
): Readout {
  const focusLaneId = options.focusLaneId ?? null;
  const rows: ReadoutRow[] = [];
  let focus: ReadoutRow | null = null;

  for (const lane of tracks.lanes) {
    const resolved = resolveLane(lane, sec, tracks.totalSec, options);
    if (focusLaneId !== null && lane.id === focusLaneId) {
      // A focused lane always answers. Where it resolved to nothing, the
      // lane's own reason is the answer; where it has no reason either, saying
      // so beats omitting the one row the cursor asked for.
      focus = resolved ?? {
        laneId: lane.id,
        title: lane.title,
        text: lane.emptyReason ?? NOTHING_HERE,
        tone: null,
      };
    } else if (resolved) {
      rows.push(resolved);
    }
  }

  return { timecode: timecodeShort(sec), focus, rows };
}
