/**
 * Deterministic fakes. The seam that keeps the suite offline: every environment
 * consumer can be exercised without a sidecar, a display, or a keyboard layout.
 */

import type {
  DeviceClockSource,
  DisplayInfo,
  DisplaySource,
  Keymap,
  KeymapSource,
} from "./types.js";

export class FakeDisplaySource implements DisplaySource {
  /** Incremented on each query, so tests can assert re-query behavior. */
  queries = 0;

  constructor(private displays: DisplayInfo[] = []) {}

  /** Swap the topology mid-test, simulating a monitor being plugged in. */
  set(displays: DisplayInfo[]): void {
    this.displays = displays;
  }

  async query(): Promise<DisplayInfo[]> {
    this.queries += 1;
    return this.displays.map((d) => ({ ...d }));
  }
}

export class FakeKeymapSource implements KeymapSource {
  queries = 0;

  constructor(private keymap: Keymap | undefined = undefined) {}

  set(keymap: Keymap | undefined): void {
    this.keymap = keymap;
  }

  async query(): Promise<Keymap | undefined> {
    this.queries += 1;
    return this.keymap === undefined
      ? undefined
      : { layoutId: this.keymap.layoutId, entries: { ...this.keymap.entries } };
  }
}

/**
 * A device clock that returns whatever the test says, so a session can be
 * calibrated deterministically without a sidecar.
 */
export class FakeDeviceClockSource implements DeviceClockSource {
  reads = 0;

  constructor(private readonly deviceMs: number = 0) {}

  async read(): Promise<number> {
    this.reads += 1;
    return this.deviceMs;
  }
}
