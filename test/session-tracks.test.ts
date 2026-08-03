import { describe, expect, it } from "vitest";
import type { EventRow } from "../src/store/types.js";
import {
  appTone,
  appsLane,
  clicksLane,
  markersLane,
  mouseSpeedLane,
  mouseXyLane,
  scrollLane,
  typingLane,
  webLane,
  type LaneInput,
} from "../app/src/main/session-tracks.js";

let seq = 0;
const ev = (kind: string, tMono: number, extra: Partial<EventRow> = {}): EventRow => ({
  id: `e${seq++}`,
  sessionId: "s1",
  tMono,
  kind,
  x: null,
  y: null,
  data: null,
  ...extra,
});

/** A LaneInput with a 10s axis and 10 buckets — small enough to assert exactly. */
const input = (events: EventRow[], over: Partial<LaneInput> = {}): LaneInput => ({
  originMono: 0,
  totalSec: 10,
  buckets: 10,
  events,
  segments: [],
  frames: [],
  axSnapshots: [],
  keyframes: [],
  regionCounts: new Map(),
  audio: [],
  ...over,
});

describe("appTone", () => {
  it("gives one app one colour, stably", () => {
    expect(appTone("Google Chrome")).toBe(appTone("Google Chrome"));
    expect(appTone("Google Chrome")).toMatch(/^app-[0-7]$/);
  });
});

describe("appsLane", () => {
  it("closes the last span at the END OF THE SESSION — focus does not end, the recording does", () => {
    const lane = appsLane(
      input([
        ev("focus_change", 0, { data: { app: "TextEdit" } }),
        ev("focus_change", 4000, { data: { app: "Google Chrome" } }),
      ]),
    );
    expect(lane.spans).toEqual([
      { startSec: 0, endSec: 4, label: "TextEdit", tone: appTone("TextEdit") },
      { startSec: 4, endSec: 10, label: "Google Chrome", tone: appTone("Google Chrome") },
    ]);
    expect(lane.emptyReason).toBeNull();
  });

  it("says why it is empty rather than rendering nothing", () => {
    expect(appsLane(input([])).emptyReason).toBeTruthy();
  });
});

describe("webLane", () => {
  it("reduces a URL with the SAME prefix rule node identity uses", () => {
    const lane = webLane(
      input([ev("url_change", 1000, { data: { url: "https://github.com/a/b/pull/123/files" } })]),
    );
    // urlPrefix drops id-like segments and caps at 3 — two PRs in one repo read
    // as one site, which is the whole point of sharing the rule.
    expect(lane.marks![0]!.label).toBe("github.com/a/b/pull");
  });
});

describe("typingLane", () => {
  it("WARNS when there are keys but no keymap — the lane is not empty, it is untrustworthy", () => {
    const lane = typingLane(input([ev("key_down", 1000), ev("key_down", 1100)]));
    expect(lane.emptyReason).toBeNull();
    expect(lane.warning).toContain("dropped at lift");
  });

  it("has no warning once a keymap was captured", () => {
    const lane = typingLane(input([ev("keymap_change", 0), ev("key_down", 1000)]));
    expect(lane.warning).toBeNull();
  });

  it("reports its peak in keys per second", () => {
    // 10s over 10 buckets = 1s each; three keys in bucket 1 is 3 keys/s.
    const lane = typingLane(
      input([
        ev("keymap_change", 0),
        ev("key_down", 1000),
        ev("key_down", 1200),
        ev("key_down", 1400),
      ]),
    );
    expect(lane.density!.unit).toBe("keys/s");
    expect(lane.density!.peak).toBeCloseTo(3, 5);
    expect(lane.density!.values[1]).toBe(1);
    expect(lane.density!.values[5]).toBe(0); // absence of typing IS zero, not null
  });
});

describe("clicksLane", () => {
  it("labels a press that travelled as a drag, and one that did not as a click", () => {
    const lane = clicksLane(
      input([
        ev("mouse_down", 1000, { x: 10, y: 10 }),
        ev("mouse_up", 1200, { x: 11, y: 10 }),
        ev("mouse_down", 3000, { x: 10, y: 10 }),
        ev("mouse_up", 3400, { x: 200, y: 90 }),
      ]),
    );
    expect(lane.marks![0]!.label).toBe("click");
    expect(lane.marks![1]!.label).toMatch(/^drag 400ms · \d+px$/);
  });
});

describe("scrollLane", () => {
  it("counts scroll events per bucket", () => {
    const lane = scrollLane(input([ev("scroll", 2000), ev("scroll", 2500)]));
    expect(lane.density!.values[2]).toBe(1);
    expect(lane.density!.peak).toBeCloseTo(2, 5);
  });
});

describe("mouseSpeedLane", () => {
  it("takes the peak speed in a bucket, in px/s", () => {
    const lane = mouseSpeedLane(
      input([
        ev("mouse_move", 1000, { x: 0, y: 0 }),
        ev("mouse_move", 1100, { x: 100, y: 0 }), // 1000 px/s
        ev("mouse_move", 1200, { x: 101, y: 0 }), // 10 px/s
      ]),
    );
    expect(lane.density!.unit).toBe("px/s");
    expect(lane.density!.peak).toBeCloseTo(1000, 0);
  });
});

describe("mouseXyLane", () => {
  it("normalizes against recorded display topology when there is any", () => {
    const lane = mouseXyLane(
      input([
        ev("display_change", 0, {
          data: { displays: [{ id: "1", x: 0, y: 0, w: 2000, h: 1000, scale: 2, primary: true }] },
        }),
        ev("mouse_move", 1000, { x: 1000, y: 500 }),
      ]),
    );
    expect(lane.density!.values[1]).toBeCloseTo(0.5, 5);
    expect(lane.density!.values2![1]).toBeCloseTo(0.5, 5);
  });

  it("is null before the pointer was first seen — no position is not the origin", () => {
    const lane = mouseXyLane(input([ev("mouse_move", 5000, { x: 10, y: 10 })]));
    expect(lane.density!.values[0]).toBeNull();
  });
});

describe("markersLane", () => {
  it("carries bookmarks and environment changes, which are rare and high-signal", () => {
    const lane = markersLane(
      input([ev("keymap_change", 0), ev("bookmark", 5000), ev("display_change", 9000)]),
    );
    expect(lane.marks!.map((m) => m.label)).toEqual([
      "keyboard layout",
      "bookmark",
      "displays changed",
    ]);
  });
});
