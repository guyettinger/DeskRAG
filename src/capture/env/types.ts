/**
 * Environment capture contracts — display topology and keyboard layout.
 *
 * Both are facts that can change mid-session and both fail SILENTLY when they do
 * (a coordinate attributed to the wrong display, text resolved against the wrong
 * layout), so both are emitted as t_mono-stamped events rather than stored as
 * session configuration.
 *
 * Both sources are best-effort by contract, exactly like `AxSource`: a missing
 * binary, non-zero exit, timeout, or malformed output resolves to empty/undefined
 * and never throws.
 */

export interface DisplayInfo {
  /** Stable for the boot; the NSScreen display id as a string. */
  id: string;
  /** Global screen coordinates, TOP-left origin — the same space as AX and mouse. */
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  primary: boolean;
}

export interface Keymap {
  /** e.g. "com.apple.keylayout.US" */
  layoutId: string;
  /** macOS virtual keycode -> [plain, shift, alt, altShift]. */
  entries: Record<number, [string, string, string, string]>;
}

export interface DisplaySource {
  query(): Promise<DisplayInfo[]>;
  close?(): void;
}

export interface KeymapSource {
  query(): Promise<Keymap | undefined>;
  close?(): void;
}

/**
 * Reads the capture device's timebase (`ax-dump --clock`), in milliseconds.
 *
 * Unlike the other sources here it has NO best-effort contract: it rejects
 * rather than resolving undefined, because a session with no calibration would
 * store timestamps meaning something different from every other session. See
 * `parseDeviceClock`.
 */
export interface DeviceClockSource {
  read(): Promise<number>;
}
