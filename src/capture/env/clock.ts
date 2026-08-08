/**
 * The device timebase reading, parsed from `ax-dump --clock`.
 *
 * The number is `clock_gettime_nsec_np(CLOCK_UPTIME_RAW)` in ms — the
 * `mach_absolute_time` base, which EXCLUDES sleep. That is the base
 * avfoundation stamps capture timestamps on (verified: ffmpeg's `-copyts`
 * output tracks it), and it sits 4.78 days away from what Node reports
 * (`mach_continuous_time`, which includes sleep). This reading is the ONLY
 * bridge between them.
 *
 * It throws rather than returning a fallback. A stale binary predating this
 * mode prints usage or nothing, and inventing a number there would mis-time a
 * whole recording silently — the failure this design exists to remove.
 */
export function parseDeviceClock(stdout: string): number {
  const text = stdout.trim();
  let ms: unknown;
  try {
    ms = (JSON.parse(text) as { deviceMs?: unknown }).deviceMs;
  } catch {
    throw new Error(
      `ax-dump --clock produced no clock reading: ${JSON.stringify(text.slice(0, 80))}`,
    );
  }
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new Error(
      `ax-dump --clock produced no clock reading: ${JSON.stringify(text.slice(0, 80))}`,
    );
  }
  return ms;
}
