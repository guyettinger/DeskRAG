import { describe, expect, it } from "vitest";
import { DeviceClock } from "../src/timeline/device-clock.js";

describe("DeviceClock", () => {
  it("maps a device timestamp onto t_mono", () => {
    // The sidecar read 3_477_946_316.602 at t_mono 250.
    const c = DeviceClock.calibrate(3_477_946_316.602, 250);
    expect(c.toTMono(3_477_946_316.602)).toBeCloseTo(250, 6);
    expect(c.toTMono(3_477_947_316.602)).toBeCloseTo(1250, 6); // one second later
  });

  it("maps a timestamp from BEFORE the calibration to a smaller t_mono", () => {
    // Frames arrive after calibration but can be CAPTURED before it — the whole
    // point is that capture time is not arrival time.
    const c = DeviceClock.calibrate(1000, 500);
    expect(c.toTMono(900)).toBe(400);
  });

  it("exposes its offset so the calibration can be persisted and re-read", () => {
    expect(DeviceClock.calibrate(1000, 250).offsetMs).toBe(-750);
  });
});
