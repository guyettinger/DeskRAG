/**
 * The bridge between the capture device's timebase and the session's t_mono.
 *
 * avfoundation stamps capture timestamps on `mach_absolute_time`
 * (`CLOCK_UPTIME_RAW`, excluding sleep); Node's clock is
 * `mach_continuous_time`, which includes it — measured 4.78 days apart on one
 * machine. Nothing in Node reads the other base, so the offset is established
 * ONCE from a sidecar reading (`ax-dump --clock`) paired with a `clock.now()`
 * taken beside it, and every device timestamp in the session is converted
 * through it.
 *
 * This is what makes t_mono universal rather than nominal: a frame's timestamp
 * becomes when its pixels were captured, not when Node happened to receive
 * them — which measured 3.05s late on a real device, and left the rail's event
 * lanes about a second away from the video they describe.
 *
 * `timeline/` never spawns. `CaptureSession` runs the sidecar and passes the
 * number in.
 */
export class DeviceClock {
  private constructor(readonly offsetMs: number) {}

  /** Pair a device reading with the `t_mono` at which it was taken. */
  static calibrate(deviceMs: number, tMono: number): DeviceClock {
    return new DeviceClock(tMono - deviceMs);
  }

  toTMono(deviceMs: number): number {
    return deviceMs + this.offsetMs;
  }
}
