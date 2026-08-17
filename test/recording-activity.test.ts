/**
 * `SignalTally` is a pure projection in main, so it lives in the ROOT suite like
 * `graph-view.ts` and `index-graph.ts` — the app has no test runner of its own.
 */

import { describe, expect, it } from "vitest";
import { SignalTally } from "../app/src/main/recording-activity.js";
import type { CaptureActivity } from "../src/capture/types.js";

const feed = (tally: SignalTally, as: CaptureActivity[]): void => {
  for (const a of as) tally.observe(a);
};

describe("SignalTally", () => {
  it("reports ATTACHED from what started, never from what is enabled", () => {
    // The microphone is dropped when its permission is refused and a native
    // producer that fails to load is never added, so `attached` is the only
    // honest source for a green light. A card driven by Settings alone showed
    // green for a screen producer that found no display and never spawned.
    const t = new SignalTally(["screen", "input", "ax"]);
    const s = t.snapshot("S", 0).signals;
    expect(s.screen.attached).toBe(true);
    expect(s.audio.attached).toBe(false);
    expect(s["active-win"].attached).toBe(false);
    expect(s.ax.attached).toBe(true);
  });

  it("counts keys and clicks, and nothing else from the event firehose", () => {
    const t = new SignalTally(["input"]);
    feed(t, [
      { kind: "event", eventKind: "key_down", tMono: 1 },
      { kind: "event", eventKind: "key_up", tMono: 2 },
      { kind: "event", eventKind: "key_down", tMono: 3 },
      { kind: "event", eventKind: "mouse_down", tMono: 4 },
      { kind: "event", eventKind: "mouse_up", tMono: 5 },
      { kind: "event", eventKind: "mouse_move", tMono: 6 },
      { kind: "event", eventKind: "scroll", tMono: 7 },
    ]);
    const s = t.snapshot("S", 0).signals.input;
    // Down edges only: a keystroke is one key, not two.
    expect(s.keys).toBe(2);
    expect(s.clicks).toBe(1);
  });

  it("names the app in focus from the LAST focus_change, and counts the switches", () => {
    const t = new SignalTally(["active-win"]);
    feed(t, [
      { kind: "event", eventKind: "focus_change", tMono: 1, data: { app: "Mail", title: "Inbox" } },
      { kind: "event", eventKind: "focus_change", tMono: 2, data: { app: "Electron", title: "x" } },
    ]);
    const s = t.snapshot("S", 0).signals["active-win"];
    expect(s.app).toBe("Electron");
    expect(s.focusChanges).toBe(2);
  });

  it("ignores a focus_change with no readable app name", () => {
    const t = new SignalTally(["active-win"]);
    feed(t, [
      { kind: "event", eventKind: "focus_change", tMono: 1, data: { app: "Mail" } },
      { kind: "event", eventKind: "focus_change", tMono: 2, data: { app: "" } },
      { kind: "event", eventKind: "focus_change", tMono: 3, data: undefined },
    ]);
    // Stale beats empty: the last thing actually known is still true of the desktop.
    expect(t.snapshot("S", 0).signals["active-win"].app).toBe("Mail");
  });

  it("counts KEPT keyframes only, and carries the last blob id", () => {
    // A dropped frame means the screen did not change — the pipeline working,
    // not a signal to report. What a reader can act on is how many exist.
    const t = new SignalTally(["screen"]);
    feed(t, [
      { kind: "frame", kept: true, tMono: 1, blobId: "b1" },
      { kind: "frame", kept: false, tMono: 2 },
      { kind: "frame", kept: true, tMono: 3, blobId: "b2" },
    ]);
    const s = t.snapshot("S", 0).signals.screen;
    expect(s.keyframes).toBe(2);
    expect(s.lastFrameBlobId).toBe("b2");
  });

  it("keeps the last readable blob id when a later keyframe has none", () => {
    const t = new SignalTally(["screen"]);
    feed(t, [
      { kind: "frame", kept: true, tMono: 1, blobId: "b1" },
      { kind: "frame", kept: true, tMono: 2 }, // no image stored
    ]);
    const s = t.snapshot("S", 0).signals.screen;
    expect(s.keyframes).toBe(2);
    expect(s.lastFrameBlobId).toBe("b1");
  });

  it("keeps SILENCE and UNREADABLE apart, because a dead mic hides in the gap", () => {
    const silent = new SignalTally(["audio"]);
    feed(silent, [
      { kind: "audio", media: "mic", byteLength: 100, tMonoStart: 0, tMonoEnd: 1, peaks: [0, 0] },
    ]);
    expect(silent.snapshot("S", 0).signals.audio.peaks).toEqual([0, 0]);

    const unreadable = new SignalTally(["audio"]);
    feed(unreadable, [
      { kind: "audio", media: "mic", byteLength: 100, tMonoStart: 0, tMonoEnd: 1, peaks: null },
    ]);
    expect(unreadable.snapshot("S", 0).signals.audio.peaks).toBeNull();

    // And neither is the same as no chunk having arrived at all.
    expect(new SignalTally(["audio"]).snapshot("S", 0).signals.audio.peaks).toBeUndefined();
  });

  it("reports the MOST RECENT walk's element count, not a total", () => {
    const t = new SignalTally(["ax"]);
    feed(t, [
      { kind: "ax", reason: "keyframe", elements: 40 },
      { kind: "ax", reason: "focus_change", elements: 486 },
    ]);
    const s = t.snapshot("S", 0).signals.ax;
    expect(s.walks).toBe(2);
    expect(s.elements).toBe(486);
  });

  it("reports zero for a signal that has produced nothing", () => {
    // The reading that exposes a producer which attached and then never spawned.
    // It is a fact, not a stalled state, and the tally never calls it one.
    const t = new SignalTally(["screen", "audio"]);
    const s = t.snapshot("S", 1234).signals;
    expect(s.screen).toEqual({ attached: true, keyframes: 0 });
    expect(s.audio).toEqual({ attached: true, chunks: 0 });
  });

  it("stamps the snapshot and the session it describes", () => {
    const t = new SignalTally([]);
    const dto = t.snapshot("01J0SESSION", 1_700_000_000_000);
    expect(dto.sessionId).toBe("01J0SESSION");
    expect(dto.atMs).toBe(1_700_000_000_000);
    // Every kind is present whether it attached or not — a card must be able to
    // ask about a signal that is switched off.
    expect(Object.keys(dto.signals).sort()).toEqual(["active-win", "audio", "ax", "input", "screen"]);
  });
});
