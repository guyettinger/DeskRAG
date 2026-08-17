/**
 * What a signal card says. A pure renderer module, so it lives in the ROOT suite
 * like `track-view.ts` and `index-graph-view.ts` — which is the whole reason it
 * is `.ts` and not `.tsx`.
 */

import { describe, expect, it } from "vitest";
import {
  peakDb,
  signalReadout,
  wavePath,
  type SignalGate,
} from "../app/src/renderer/src/screens/signal-view.js";
import type { RecordingSignalDTO } from "../app/src/shared/types.js";

const open: SignalGate = { enabled: true, granted: true };

describe("signalReadout — the gate, before any recording", () => {
  it("says OFF for a signal that is switched off", () => {
    const r = signalReadout("screen", { enabled: false, granted: true }, false, undefined);
    expect(r).toEqual({ led: "off", figure: "Off", idle: true });
  });

  it("names the missing tool when an environment gate fails", () => {
    const r = signalReadout(
      "screen",
      { enabled: true, granted: true, blockedBy: "ffmpeg not found on PATH" },
      false,
      undefined,
    );
    expect(r.led).toBe("warn");
    expect(r.figure).toBe("ffmpeg not found on PATH");
  });

  it("says it is waiting on permission rather than going green", () => {
    const r = signalReadout("audio", { enabled: true, granted: false }, false, undefined);
    expect(r.led).toBe("warn");
  });

  it("says READY when it is enabled and nothing is recording", () => {
    expect(signalReadout("ax", open, false, undefined)).toEqual({
      led: "ok",
      figure: "Ready",
      idle: true,
    });
  });

  it("A WELL ALWAYS ANSWERS — every state produces a non-empty figure", () => {
    // A card that simply went blank would be indistinguishable from one nobody
    // finished, the same reason a skipped index stage is drawn and states why.
    const gates: SignalGate[] = [
      { enabled: false, granted: true },
      { enabled: true, granted: false },
      { enabled: true, granted: true, blockedBy: "sidecar missing" },
      open,
    ];
    for (const kind of ["screen", "input", "active-win", "audio", "ax"] as const) {
      for (const g of gates) {
        for (const live of [false, true]) {
          expect(signalReadout(kind, g, live, undefined).figure.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("signalReadout — while recording", () => {
  it("says NOT CAPTURING for a signal that never attached", () => {
    // The correctness fix: green used to mean "enabled in Settings". A screen
    // producer that found no display returns without spawning, and a microphone
    // whose permission is refused is dropped — both showed green.
    const r = signalReadout("screen", open, true, { attached: false, keyframes: 0 });
    expect(r.led).toBe("warn");
    expect(r.figure).toBe("Not capturing");
  });

  it("reports ZERO as a fact, never as a stall", () => {
    const r = signalReadout("screen", open, true, { attached: true, keyframes: 0 });
    expect(r.led).toBe("ok");
    expect(r.figure).toBe("0 keyframes");
    expect(r.warning).toBeUndefined();
  });

  it("counts keyframes and carries the frame just kept", () => {
    const r = signalReadout("screen", open, true, {
      attached: true,
      keyframes: 1,
      lastFrameBlobId: "01BLOB",
    });
    expect(r.figure).toBe("1 keyframe"); // singular, not "1 keyframes"
    expect(r.glyph).toEqual({ kind: "frame", blobId: "01BLOB" });
  });

  it("puts keys on the left and clicks on the right", () => {
    const r = signalReadout("input", open, true, { attached: true, keys: 312, clicks: 48 });
    expect(r.figure).toBe("312 keys");
    expect(r.glyph).toEqual({ kind: "count", text: "48 clicks" });
  });

  it("names the app in focus and carries its tone", () => {
    const r = signalReadout("active-win", open, true, {
      attached: true,
      app: "Electron",
      appTone: "app-2",
      focusChanges: 4,
    });
    expect(r.figure).toBe("Electron");
    expect(r.tone).toBe("app-2");
    expect(r.glyph).toEqual({ kind: "count", text: "4 switches" });
  });

  it("says so plainly before the first window is seen", () => {
    const r = signalReadout("active-win", open, true, { attached: true, focusChanges: 0 });
    expect(r.figure).toBe("No window yet");
    expect(r.idle).toBe(true);
  });

  it("reports a peak in dBFS once a chunk lands", () => {
    const r = signalReadout("audio", open, true, { attached: true, chunks: 1, peaks: [0.5, 0.25] });
    expect(r.figure).toBe("peak -6.0 dB");
    expect(r.glyph).toEqual({ kind: "wave", peaks: [0.5, 0.25] });
  });

  it("CALLS DIGITAL SILENCE OUT, because a healthy-looking store hides it", () => {
    // The measured failure: an audio device index recorded −91 dB for a whole
    // session — two blobs, exact byte counts, contiguous spans, no error
    // anywhere, and every sample zero. Twelve seconds of recording found it.
    const r = signalReadout("audio", open, true, { attached: true, chunks: 2, peaks: [0, 0, 0] });
    expect(r.led).toBe("warn");
    expect(r.figure).toBe("No signal");
    expect(r.warning).toMatch(/every sample is zero/i);
    // Still draws the envelope: a flat line IS the reading.
    expect(r.glyph?.kind).toBe("wave");
  });

  it("keeps UNREADABLE bytes apart from silence, and both from no chunk yet", () => {
    const unreadable = signalReadout("audio", open, true, {
      attached: true,
      chunks: 1,
      peaks: null,
    });
    expect(unreadable.figure).toBe("Cannot read the audio");
    expect(unreadable.led).toBe("warn");

    const waiting = signalReadout("audio", open, true, { attached: true, chunks: 0 });
    expect(waiting.figure).toBe("Waiting for the first chunk");
    expect(waiting.led).toBe("ok");
  });

  it("reports the LAST walk's element count, and says as much", () => {
    const r = signalReadout("ax", open, true, { attached: true, walks: 12, elements: 486 });
    expect(r.figure).toBe("12 walks");
    expect(r.glyph).toEqual({ kind: "count", text: "486 elements" });
    expect(r.note).toMatch(/not a total/i);
  });

  it("holds nothing over from a signal that is now switched off", () => {
    const live: RecordingSignalDTO = { attached: true, keyframes: 99 };
    expect(signalReadout("screen", { enabled: false, granted: true }, true, live).figure).toBe("Off");
  });
});

describe("peakDb", () => {
  it("is dBFS against full scale", () => {
    expect(peakDb(1)).toBe("0.0 dB");
    expect(peakDb(0.5)).toBe("-6.0 dB");
    expect(peakDb(0.001)).toBe("-60.0 dB");
  });
});

describe("wavePath", () => {
  it("is a closed shape mirrored about the centre", () => {
    const d = wavePath([1, 1], 64, 20);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("0.00"); // the top, at full amplitude
    expect(d).toContain("20.00"); // and the bottom
  });

  it("DRAWS SILENCE, because a zero-height fill paints nothing", () => {
    // An empty box would read as "this card has no envelope", which is a
    // different claim from "this chunk was silent".
    const silent = wavePath([0, 0, 0], 64, 20);
    expect(silent).toContain("9.60");
    expect(silent).toContain("10.40");
  });

  it("survives an empty envelope", () => {
    expect(wavePath([], 64, 20)).toBe("M0 9.6H64V10.4H0Z");
  });

  it("clamps a peak outside 0..1 rather than drawing outside the box", () => {
    const d = wavePath([2], 64, 20);
    expect(d).toContain("0.00");
    expect(d).not.toContain("-");
  });
});
