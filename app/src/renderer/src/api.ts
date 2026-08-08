import type { DeskRagApi, KeyframeMarkerDTO } from "@shared/types";

export const api: DeskRagApi = window.deskrag;

/** t_mono milliseconds -> HH:MM:SS.mmm monospace readout. */
export function timecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const frac = total % 1000;
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(frac, 3)}`;
}

/**
 * Duration for a LIST row — `0:32`, `1:04:09`.
 *
 * Deliberately coarser than `timecode`: in the Library list the duration
 * identifies a recording rather than measuring one, and the full
 * `00:00:32.807` wrapped its row onto a second line in a 300px column. The
 * precise value belongs to the stage header, which describes one recording
 * instead of ranging over all of them.
 */
export function durationShort(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Wall-clock ms -> human date + time. */
export function wallClock(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function elapsed(fromMs: number): string {
  return timecode(Date.now() - fromMs);
}

/**
 * How a keyframe is named wherever it is labelled — chapter cues, the control
 * bar title, the chapters menu, the track rail's keyframe tooltip.
 *
 * The VLM caption describes what is on screen, so it wins; the templated event
 * digest is the fallback for sessions indexed without a captioner, and the
 * timecode for those with neither view represented.
 */
export function keyframeLabel(k: KeyframeMarkerDTO): string {
  return k.segmentCaption ?? k.segmentDigest ?? timecode(k.tMono);
}

/** Byte count -> a compact human string (1.4 GB). */
export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
