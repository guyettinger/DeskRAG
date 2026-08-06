import { beforeEach, describe, expect, it } from "vitest";
import {
  listAvfoundationDevices,
  parseAvfoundationDevices,
  resetDeviceCache,
  resolveAudioInput,
  screenDeviceIndex,
} from "../src/capture/producers/avfoundation-devices.js";

/**
 * Verbatim output from `ffmpeg -f avfoundation -list_devices true -i ""` on a
 * MacBook with a paired iPhone — the exact machine where the hard-coded input
 * "1" selected "Guy's iPhone XS Camera" and capture died with
 * "Selected framerate (10.000000) is not supported by the device".
 */
const SAMPLE = `[AVFoundation indev @ 0x8d6808140] AVFoundation video devices:
[AVFoundation indev @ 0x8d6808140] [0] FaceTime HD Camera
[AVFoundation indev @ 0x8d6808140] [1] Guy’s iPhone XS Camera
[AVFoundation indev @ 0x8d6808140] [2] Capture screen 0
[AVFoundation indev @ 0x8d6808140] [3] Capture screen 1
[AVFoundation indev @ 0x8d6808140] AVFoundation audio devices:
[AVFoundation indev @ 0x8d6808140] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x8d6808140] [1] Virtual Desktop Mic
[in#0 @ 0x8d6808000] Error opening input: Input/output error
Error opening input file .
`;

describe("parseAvfoundationDevices", () => {
  it("splits the video and audio tables", () => {
    const d = parseAvfoundationDevices(SAMPLE);
    expect(d.video.map((v) => v.index)).toEqual(["0", "1", "2", "3"]);
    expect(d.video[2]!.name).toBe("Capture screen 0");
    expect(d.audio.map((a) => a.name)).toEqual([
      "MacBook Pro Microphone",
      "Virtual Desktop Mic",
    ]);
  });

  it("ignores the trailing error lines ffmpeg always prints", () => {
    const d = parseAvfoundationDevices(SAMPLE);
    expect(d.video.some((v) => v.name.includes("Error"))).toBe(false);
    expect(d.audio.some((a) => a.name.includes("Error"))).toBe(false);
  });

  it("yields nothing for unrelated output", () => {
    expect(parseAvfoundationDevices("ffmpeg version 7.1\n")).toEqual({
      video: [],
      audio: [],
    });
  });
});

describe("screenDeviceIndex", () => {
  // The whole point: the display is NOT index 1 here, and picking a camera is
  // what produced the unsupported-framerate failure.
  it("picks the first display, past every camera", () => {
    expect(screenDeviceIndex(parseAvfoundationDevices(SAMPLE))).toBe("2");
  });

  it("is undefined when no display is listed (Screen Recording not granted)", () => {
    const noScreens = parseAvfoundationDevices(
      "AVFoundation video devices:\n[0] FaceTime HD Camera\n",
    );
    expect(screenDeviceIndex(noScreens)).toBeUndefined();
  });
});

/** What the table looks like before Screen Recording is granted: cameras only. */
const NO_SCREENS = `AVFoundation video devices:
[0] FaceTime HD Camera
AVFoundation audio devices:
[0] MacBook Pro Microphone
`;

describe("listAvfoundationDevices caching", () => {
  beforeEach(resetDeviceCache);

  it("caches a table that has a display — the probe costs ~0.5s", () => {
    let calls = 0;
    const probe = (): string => {
      calls++;
      return SAMPLE;
    };
    expect(listAvfoundationDevices({ probe }).video).toHaveLength(4);
    expect(listAvfoundationDevices({ probe }).video).toHaveLength(4);
    expect(calls).toBe(1);
  });

  /**
   * The regression this rule exists for: a screen-less table means Screen
   * Recording has not been granted YET (TCC hides displays until it is). The
   * user then grants it and presses Record again in the same process — caching
   * the pre-grant answer would keep capture broken until an app restart, with
   * nothing on screen to say why.
   */
  it("never caches a screen-less table, so a grant is picked up without a restart", () => {
    let granted = false;
    let calls = 0;
    const probe = (): string => {
      calls++;
      return granted ? SAMPLE : NO_SCREENS;
    };
    expect(screenDeviceIndex(listAvfoundationDevices({ probe }))).toBeUndefined();
    expect(screenDeviceIndex(listAvfoundationDevices({ probe }))).toBeUndefined();
    granted = true;
    expect(screenDeviceIndex(listAvfoundationDevices({ probe }))).toBe("2");
    expect(calls).toBe(3);
  });

  it("re-probes on demand", () => {
    let calls = 0;
    const probe = (): string => {
      calls++;
      return SAMPLE;
    };
    listAvfoundationDevices({ probe });
    listAvfoundationDevices({ probe, refresh: true });
    expect(calls).toBe(2);
  });

  it("yields an empty table when the probe throws, and does not cache it", () => {
    const probe = (): string => {
      throw new Error("ffmpeg missing");
    };
    expect(listAvfoundationDevices({ probe })).toEqual({ video: [], audio: [] });
    let recovered = 0;
    listAvfoundationDevices({
      probe: () => {
        recovered++;
        return SAMPLE;
      },
    });
    expect(recovered).toBe(1);
  });
});

describe("resolveAudioInput", () => {
  const devices = parseAvfoundationDevices(SAMPLE);

  it("keeps a device that exists", () => {
    expect(resolveAudioInput(":1", devices)).toEqual({ input: ":1" });
  });

  it("matches by name as well as index", () => {
    expect(resolveAudioInput(":Virtual Desktop Mic", devices).input).toBe(
      ":Virtual Desktop Mic",
    );
  });

  // avfoundation's -i is "[VIDEO]:[AUDIO]", so a bare "0" names a *video*
  // device and records no audio at all.
  it("adds the missing colon rather than recording a video device", () => {
    const r = resolveAudioInput("1", devices);
    expect(r.input).toBe(":1");
    expect(r.warning).toContain('"1"');
  });

  it("falls back to the first real device when the configured one is gone", () => {
    const r = resolveAudioInput(":7", devices);
    expect(r.input).toBe(":0");
    expect(r.warning).toContain("MacBook Pro Microphone");
  });

  // Nothing was learned, so nothing is overridden: a failed probe must not
  // change which device a working configuration records from.
  it("uses the configured value verbatim when the table is empty", () => {
    const r = resolveAudioInput(":3", { video: [], audio: [] });
    expect(r.input).toBe(":3");
    expect(r.warning).toContain("could not enumerate");
  });

  // Taking the default is not a correction. Warning on it meant every recording
  // by an unconfigured producer logged a device warning — found by recording.
  it("defaults silently to the system input, not to index 0", () => {
    expect(resolveAudioInput(undefined, devices)).toEqual({ input: ":default" });
    expect(resolveAudioInput("", devices)).toEqual({ input: ":default" });
  });

  /**
   * Measured on a real Mac: `:0` was "Virtual Desktop Mic" and recorded digital
   * silence at -91 dB for a whole session, while the built-in mic sat at index
   * 1 and read -41 dB on the same phrase. `:default` read -40 dB. Nothing errors
   * on the silent path — the only symptom is an empty transcript.
   */
  it("never validates :default against the table — it is not in one", () => {
    expect(resolveAudioInput(":default", devices)).toEqual({ input: ":default" });
    // Even with no table at all, it must survive untouched.
    expect(resolveAudioInput(":default", { video: [], audio: [] })).toEqual({
      input: ":default",
    });
  });
});
