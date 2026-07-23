import type { DeskRagApi } from "@shared/types";

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
