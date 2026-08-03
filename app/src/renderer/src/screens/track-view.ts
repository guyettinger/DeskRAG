/**
 * Pure view logic for the timeline track rail.
 *
 * `.ts`, never `.tsx`: the ROOT tsconfig sets no `jsx`, so a root test that
 * reaches into a `.tsx` — even only for a type — breaks `npm run typecheck`.
 * `run-log.ts` lives beside `RunLog.tsx` for exactly this reason.
 */

import type { SessionTracksDTO, TrackDensityDTO } from "@shared/types";

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
    const y = height - v * height;
    d += `${open ? "L" : "M"}${x.toFixed(3)},${y.toFixed(3)}`;
    open = true;
  });
  return d;
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

/**
 * Every lane resolved at one instant — the crosshair readout.
 *
 * One line answering "what was happening here" across all lanes is what makes
 * the rail readable; per-lane tooltips would make you hover fifteen times to
 * ask one question.
 */
export function readoutAt(tracks: SessionTracksDTO, sec: number): string[] {
  const parts: string[] = [timecodeShort(sec)];
  for (const lane of tracks.lanes) {
    if (lane.emptyReason !== null) continue;
    if (lane.shape === "span") {
      const span = lane.spans?.find((s) => sec >= s.startSec && sec < s.endSec);
      if (span) parts.push(span.label);
    } else if (lane.shape === "density" && lane.density) {
      const text = densityReadout(lane.density, sec, tracks.totalSec);
      if (text) parts.push(text);
    }
  }
  return parts;
}
