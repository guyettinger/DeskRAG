/**
 * avfoundation device discovery (macOS).
 *
 * `-i "1"` is an INDEX into a list that is different on every Mac, and the list
 * is ordered cameras-first: on a machine with a built-in camera and a paired
 * iPhone, index 1 is "Guy's iPhone XS Camera", not a display. Pointing the
 * screen producer at a camera fails in a way that reads as a bug in us:
 *
 *   [avfoundation] Selected framerate (10.000000) is not supported by the device
 *   [avfoundation] Supported modes: 640x480@[1 30]fps  1280x720@[1 30]fps ...
 *   Error opening input: Input/output error
 *
 * — because a camera only offers a fixed set of modes, while screen capture
 * accepts any framerate. So the fix is not to bend the framerate to the camera;
 * it is to stop capturing the camera. This module asks ffmpeg for the actual
 * device table and finds the "Capture screen N" entry.
 *
 * The audio table has the same problem and the same fix (`resolveAudioInput`):
 * `":0"` is an index into a list that a plugged-in interface reorders.
 */

import { spawnSync } from "node:child_process";

export interface AvfDevice {
  /** The number ffmpeg wants in `-i`, as a string. */
  index: string;
  name: string;
}

export interface AvfDevices {
  video: AvfDevice[];
  audio: AvfDevice[];
}

/**
 * Parse the table ffmpeg prints to stderr for
 * `-f avfoundation -list_devices true -i ""`:
 *
 *   [AVFoundation indev @ 0x…] AVFoundation video devices:
 *   [AVFoundation indev @ 0x…] [0] FaceTime HD Camera
 *   [AVFoundation indev @ 0x…] [2] Capture screen 0
 *   [AVFoundation indev @ 0x…] AVFoundation audio devices:
 *   [AVFoundation indev @ 0x…] [0] MacBook Pro Microphone
 *
 * The command always "fails" (there is no input to open); the table is the
 * output, so the exit code is ignored by callers.
 */
export function parseAvfoundationDevices(stderr: string): AvfDevices {
  const devices: AvfDevices = { video: [], audio: [] };
  let section: keyof AvfDevices | undefined;
  for (const raw of stderr.split(/\r?\n/)) {
    // Strip the "[AVFoundation indev @ 0x…] " prefix, if present.
    const line = raw.replace(/^\[AVFoundation indev @ [^\]]*\]\s*/, "").trim();
    if (/^AVFoundation video devices:/i.test(line)) {
      section = "video";
      continue;
    }
    if (/^AVFoundation audio devices:/i.test(line)) {
      section = "audio";
      continue;
    }
    if (!section) continue;
    const m = /^\[(\d+)\]\s+(.*)$/.exec(line);
    if (m) devices[section].push({ index: m[1]!, name: m[2]!.trim() });
    else if (line.length > 0 && !line.startsWith("[")) section = undefined;
  }
  return devices;
}

/** The first display in the video list, e.g. "Capture screen 0". */
export function screenDeviceIndex(devices: AvfDevices): string | undefined {
  return devices.video.find((d) => /capture screen/i.test(d.name))?.index;
}

/** Returns ffmpeg's combined output for a `-list_devices` run. Injected in tests. */
export type DeviceProbe = () => string;

export interface ListDevicesOptions {
  ffmpegPath?: string;
  /** Re-probe even when a table is already cached. */
  refresh?: boolean;
  /** Stands in for the ffmpeg spawn; tests use this instead of a real binary. */
  probe?: DeviceProbe;
}

let cached: AvfDevices | undefined;

/** Drops the cached table. Exists for tests; `refresh` is the runtime path. */
export function resetDeviceCache(): void {
  cached = undefined;
}

function spawnProbe(ffmpegPath: string): string {
  const res = spawnSync(
    ffmpegPath,
    ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    { encoding: "utf8", timeout: 10_000 },
  );
  return `${res.stderr ?? ""}\n${res.stdout ?? ""}`;
}

/**
 * Enumerate avfoundation devices. Spawning ffmpeg costs ~0.5s and the table only
 * changes when hardware is plugged in, so the result is cached for the life of
 * the process; pass `refresh` to re-probe.
 *
 * A table with NO DISPLAY IN IT IS NEVER CACHED. On macOS that reading almost
 * always means Screen Recording has not been granted yet — TCC hides the
 * "Capture screen" entries until it is — and the very next thing a user does is
 * grant it and press Record again, in the same process. Caching the pre-grant
 * answer would keep capture broken until the app was restarted, with nothing on
 * screen to explain why.
 */
export function listAvfoundationDevices(opts: ListDevicesOptions = {}): AvfDevices {
  if (cached && !opts.refresh) return cached;
  let devices: AvfDevices;
  try {
    const probe = opts.probe ?? (() => spawnProbe(opts.ffmpegPath ?? "ffmpeg"));
    devices = parseAvfoundationDevices(probe());
  } catch {
    devices = { video: [], audio: [] };
  }
  cached = screenDeviceIndex(devices) ? devices : undefined;
  return devices;
}

/**
 * The avfoundation input to record the screen from, or undefined when the probe
 * found no display (non-macOS, no ffmpeg, or screen recording not yet permitted
 * — TCC hides the "Capture screen" entries until the app is granted).
 */
export function resolveScreenInput(ffmpegPath = "ffmpeg"): string | undefined {
  return screenDeviceIndex(listAvfoundationDevices({ ffmpegPath }));
}

export interface AudioInputResolution {
  /** The value to hand ffmpeg's `-i`. Always set: there is always a best guess. */
  input: string;
  /** Set whenever the answer is not exactly what was configured. */
  warning?: string;
}

/**
 * avfoundation's own name for "whatever macOS Sound is set to". It is NOT an
 * entry in the device table, so it must never be validated against one.
 */
export const DEFAULT_AUDIO_INPUT = ":default";

/**
 * The avfoundation input to record audio from.
 *
 * avfoundation's `-i` is `[VIDEO]:[AUDIO]`, so an audio-only capture is written
 * `":0"` — a bare `"0"` names a *video* device and records no audio at all. The
 * colon is therefore added when it is missing rather than passed through.
 *
 * **The default is `:default`, not `:0`.** An index is per-machine exactly like
 * the screen one, and index 0 is frequently not a microphone at all: measured on
 * a real Mac, `:0` was "Virtual Desktop Mic" and recorded **digital silence at
 * -91 dB** for a full session while the built-in mic sat at index 1. Nothing
 * errors, nothing warns, and the transcript is simply empty — the failure this
 * whole module exists to stop, in its quietest form. Picking a device by *name*
 * would be a heuristic that guesses at the user's intent; `:default` is the
 * answer the user already gave macOS.
 *
 * A configured index that names nothing falls back to the first real audio
 * device rather than failing: an unplugged interface must not cost the whole
 * signal. A probe that failed entirely is different — nothing was learned, so
 * the configured value is used verbatim.
 */
export function resolveAudioInput(
  configured: string | undefined,
  devices: AvfDevices,
): AudioInputResolution {
  const raw = (configured ?? "").trim();
  const spec =
    raw.length === 0 ? DEFAULT_AUDIO_INPUT : raw.includes(":") ? raw : `:${raw}`;
  const wanted = spec.slice(spec.indexOf(":") + 1).trim();
  // Only when the CALLER's value was rewritten. Taking the default is not a
  // correction and must not warn — an unconfigured producer warned on every
  // single recording until this distinguished the two.
  const noted =
    raw.length > 0 && spec !== raw ? `audio device "${raw}" read as "${spec}"` : undefined;

  // `default` is resolved by avfoundation itself and appears in no table, so
  // validating it would "correct" it to an index — which is the very thing it
  // exists to avoid.
  if (wanted.toLowerCase() === "default") {
    return noted ? { input: spec, warning: noted } : { input: spec };
  }

  if (devices.audio.length === 0) {
    return {
      input: spec,
      warning: `could not enumerate avfoundation audio devices; using "${spec}" as configured`,
    };
  }
  const match = devices.audio.find(
    (d) => d.index === wanted || d.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (match) return noted ? { input: spec, warning: noted } : { input: spec };

  const first = devices.audio[0]!;
  return {
    input: `:${first.index}`,
    warning:
      `audio device "${spec}" is not in this machine's avfoundation table ` +
      `(${devices.audio.map((d) => `${d.index}=${d.name}`).join(", ")}); ` +
      `recording "${first.name}" instead`,
  };
}
