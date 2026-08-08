import { describe, expect, it } from "vitest";
import type { AxSnapshotRow, EventRow, SegmentRow } from "../src/store/types.js";
import {
  appTone,
  appsLane,
  audioLanes,
  axLane,
  buildSessionTracks,
  captionLane,
  clicksLane,
  finestGranularity,
  framesLane,
  idleLane,
  laneOriginOf,
  laneSec,
  markersLane,
  mouseSpeedLane,
  mouseXyLane,
  scrollLane,
  segmentLanes,
  transcriptLane,
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
  transcriptClips: [],
  ...over,
});

const seg = (
  id: string,
  granularity: string,
  startMs: number,
  endMs: number,
  over: Partial<SegmentRow> = {},
): SegmentRow => ({
  id,
  sessionId: "s1",
  granularity,
  tMonoStart: startMs,
  tMonoEnd: endMs,
  boundaryReason: "window",
  transcript: null,
  digest: null,
  caption: null,
  ...over,
});

const snap = (
  id: string,
  tMono: number,
  elements: number,
  over: Partial<AxSnapshotRow> = {},
): AxSnapshotRow => ({
  id,
  sessionId: "s1",
  tMono,
  frameId: null,
  reason: "focus_change",
  walkMs: 80,
  elements: new Array(elements).fill({
    role: "Button",
    label: "x",
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  }) as AxSnapshotRow["elements"],
  ...over,
});

/**
 * The one definition of what a moment is. Four surfaces read it — the rail, the
 * keyframe markers, a search hit and the Flows deep link — and the last of them
 * used to compute its own, landing every jump early by the pre-roll.
 */
describe("laneOriginOf / laneSec", () => {
  it("takes the video's first frame as offset zero", () => {
    expect(laneOriginOf({ tMonoStart: 1900 })).toBe(1900);
    expect(laneSec(4500, laneOriginOf({ tMonoStart: 1900 }))).toBe(2.6);
  });

  it("falls back to t_mono zero for a session with no video", () => {
    expect(laneOriginOf(null)).toBe(0);
    expect(laneOriginOf(undefined)).toBe(0);
    expect(laneSec(4500, laneOriginOf(null))).toBe(4.5);
  });

  /**
   * Capture starts while ffmpeg is still spawning, so a session's first signals
   * are genuinely BEFORE the video's first frame. The rail declares that
   * stretch (`preRollSec`, and the hatched clipped edge); a moment to seek to
   * has no such affordance and must land at the start rather than off the axis.
   */
  it("clamps a stamp from before the video started", () => {
    expect(laneSec(300, 1900)).toBe(0);
    expect(laneSec(1900, 1900)).toBe(0);
  });
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

describe("finestGranularity", () => {
  it("picks the granularity with the most segments — action over task", () => {
    expect(
      finestGranularity([
        seg("a1", "action", 0, 1000),
        seg("a2", "action", 1000, 2000),
        seg("t1", "task", 0, 2000),
      ]),
    ).toBe("action");
  });

  it("returns null when there are no segments at all", () => {
    expect(finestGranularity([])).toBeNull();
  });
});

describe("segmentLanes", () => {
  it("emits ONE LANE PER GRANULARITY found in the data, not a hardcoded pair", () => {
    const lanes = segmentLanes(
      input([], { segments: [seg("a1", "action", 0, 4000), seg("t1", "task", 0, 10000)] }),
    );
    expect(lanes.map((l) => l.id)).toEqual(["seg-action", "seg-task"]);
    expect(lanes[0]!.spans).toEqual([
      { startSec: 0, endSec: 4, label: "window", tone: "neutral" },
    ]);
  });

  it("prefers the caption as the span label and falls back to the digest", () => {
    const lanes = segmentLanes(
      input([], {
        segments: [
          seg("a1", "action", 0, 1000, { caption: "the PR page", digest: "clicked Files" }),
          seg("a2", "action", 1000, 2000, { digest: "typed a comment" }),
        ],
      }),
    );
    expect(lanes[0]!.spans!.map((s) => s.label)).toEqual(["the PR page", "typed a comment"]);
  });
});

describe("transcriptLane / captionLane", () => {
  it("covers only the segments that actually carry the view", () => {
    const i = input([], {
      segments: [
        seg("a1", "action", 0, 2000, { transcript: "hello" }),
        seg("a2", "action", 2000, 4000),
      ],
    });
    expect(transcriptLane(i).spans).toHaveLength(1);
    expect(transcriptLane(i).spans![0]!.endSec).toBe(2);
  });

  it("says a provider was probably never configured when NOTHING carries the view", () => {
    const i = input([], { segments: [seg("a1", "action", 0, 2000)] });
    expect(captionLane(i).emptyReason).toContain("captioner");
    expect(transcriptLane(i).emptyReason).toContain("whisper");
  });

  it("draws the UTTERANCE when clips exist, not the segment containing it", () => {
    const lane = transcriptLane(
      input([], {
        segments: [seg("a1", "action", 0, 10_000, { transcript: "one plus one" })],
        transcriptClips: [{ tMonoStart: 1000, tMonoEnd: 2500, text: "one plus one" }],
      }),
    );
    expect(lane.spans).toEqual([
      { startSec: 1, endSec: 2.5, label: "one plus one", tone: "ok" },
    ]);
    expect(lane.warning).toBeNull();
  });

  it("falls back to segment spans WITH a warning when there are no clips", () => {
    const lane = transcriptLane(
      input([], {
        segments: [seg("a1", "action", 0, 10_000, { transcript: "one plus one" })],
      }),
    );
    expect(lane.spans).toHaveLength(1);
    expect(lane.spans![0]!.endSec).toBe(10); // the SEGMENT's span, overstated
    expect(lane.warning).toContain("SEGMENTS");
  });

  it("has no warning when there is simply nothing transcribed", () => {
    const lane = transcriptLane(input([]));
    expect(lane.emptyReason).not.toBeNull();
    expect(lane.warning).toBeNull();
  });
});

describe("showLabels", () => {
  it("is true ONLY for apps — the one identity span lane", () => {
    const tracks = buildSessionTracks({
      ...input([ev("focus_change", 0, { data: { app: "Calculator" } })]),
      sessionId: "s1",
      anchoredToVideo: false,
      clockCalibrated: true,
    });
    const labelled = tracks.lanes.filter((l) => l.showLabels).map((l) => l.id);
    expect(labelled).toEqual(["apps"]);
  });
});

describe("idleLane", () => {
  it("spans a dwell gap from the last event to the one that resumed", () => {
    const lane = idleLane(input([ev("key_down", 0), ev("key_down", 5000)]));
    expect(lane.spans).toHaveLength(1);
    expect(lane.spans![0]!.startSec).toBe(0);
    expect(lane.spans![0]!.endSec).toBe(5);
    expect(lane.spans![0]!.tone).toBe("warn");
  });

  it("reports a burst pause between meaningful input, ignoring mouse_move", () => {
    const lane = idleLane(
      input([ev("mouse_down", 0), ev("mouse_move", 1000), ev("key_down", 2000)]),
    );
    // 2000ms since the last MEANINGFUL event, under the 3000ms dwell gap.
    expect(lane.spans).toHaveLength(1);
    expect(lane.spans![0]!.tone).toBe("neutral");
  });

  it("never reports one gap twice — a dwell gap is not also a pause", () => {
    const lane = idleLane(input([ev("key_down", 0), ev("key_down", 5000)]));
    expect(lane.spans).toHaveLength(1);
  });

  it("says so when nothing was idle", () => {
    const lane = idleLane(input([ev("key_down", 0), ev("key_down", 100)]));
    expect(lane.spans).toEqual([]);
    expect(lane.emptyReason).not.toBeNull();
  });
});

describe("axLane", () => {
  it("flags a walk that returned ZERO elements — that is what `reason` exists to measure", () => {
    const lane = axLane(input([], { axSnapshots: [snap("x1", 1000, 0), snap("x2", 2000, 12)] }));
    expect(lane.marks![0]!.tone).toBe("alarm");
    expect(lane.marks![0]!.label).toContain("0 elements");
    expect(lane.marks![1]!.tone).not.toBe("alarm");
  });
});

describe("framesLane", () => {
  it("carries the marker itself so keyframeLabel() stays the ONE label rule", () => {
    const marker = {
      frameId: "f1",
      tMono: 3000,
      offsetSec: 3,
      thumbUrl: "deskrag://frame/b1",
      segmentCaption: "the PR page",
      segmentDigest: null,
    };
    const lane = framesLane(input([], { keyframes: [marker], regionCounts: new Map([["f1", 14]]) }));
    expect(lane.thumbs).toEqual([{ atSec: 3, marker, regionCount: 14 }]);
  });

  it("says so when nothing was indexed", () => {
    expect(framesLane(input([])).emptyReason).toContain("keyframe");
  });
});

describe("audioLanes", () => {
  it("gives each medium its own lane and leaves uncovered stretches null", () => {
    const lanes = audioLanes(
      input([], {
        audio: [
          { media: "mic", blobs: [{ startSec: 0, durationSec: 2, peaks: [0.4, 0.4] }] },
          {
            media: "desktop_audio",
            blobs: [{ startSec: 0, durationSec: 10, peaks: new Array(40).fill(0.9) }],
          },
        ],
      }),
    );
    expect(lanes.map((l) => l.id)).toEqual(["audio-mic", "audio-desktop_audio"]);
    expect(lanes[0]!.density!.values[9]).toBeNull(); // mic stopped at 2s
    expect(lanes[1]!.density!.values[9]).not.toBeNull();
    expect(lanes[0]!.density!.unit).toBe("amplitude");
  });

  it("produces one empty lane saying why when no audio was captured at all", () => {
    const lanes = audioLanes(input([]));
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.emptyReason).toContain("audio");
  });
});

describe("buildSessionTracks", () => {
  it("puts the lanes in BAND order, so the rail needs no separate sort", () => {
    const dto = buildSessionTracks({
      ...input([ev("focus_change", 0, { data: { app: "TextEdit" } })], {
        segments: [seg("a1", "action", 0, 4000)],
      }),
      sessionId: "s1",
      anchoredToVideo: true,
      clockCalibrated: true,
    });
    expect(dto.lanes.map((l) => l.id)).toEqual([
      "frames",
      "apps",
      "web",
      "ax",
      "seg-action",
      "caption",
      "transcript",
      "audio-none",
      "typing",
      "clicks",
      "scroll",
      "mouse-speed",
      "mouse-xy",
      "idle",
      "markers",
    ]);
    expect(dto.sessionId).toBe("s1");
    expect(dto.totalSec).toBe(10);
    expect(dto.anchoredToVideo).toBe(true);
  });

  it("stamps every lane with a band, and emits them already gathered", () => {
    const dto = buildSessionTracks({
      ...input([ev("focus_change", 0, { data: { app: "TextEdit" } })], {
        segments: [seg("a1", "action", 0, 4000)],
      }),
      sessionId: "s1",
      anchoredToVideo: true,
      clockCalibrated: true,
    });
    expect(dto.lanes.every((l) => typeof l.group === "string")).toBe(true);
    expect(dto.lanes.find((l) => l.id === "frames")?.group).toBe("screen");
    expect(dto.lanes.find((l) => l.id === "seg-action")?.group).toBe("segments");
    expect(dto.lanes.find((l) => l.id === "typing")?.group).toBe("input");
    expect(dto.lanes.find((l) => l.id === "transcript")?.group).toBe("audio");
    expect(dto.lanes.find((l) => l.id === "markers")?.group).toBe("marks");

    // Each band is CONTIGUOUS. The rail renders bands in order without sorting,
    // so a lane escaping its run would silently render under the wrong header.
    const seen = new Set<string>();
    let last: string | null = null;
    for (const lane of dto.lanes) {
      if (lane.group === last) continue;
      expect(seen.has(lane.group)).toBe(false);
      seen.add(lane.group);
      last = lane.group;
    }
  });

  it("renders an empty rail rather than dividing by zero on a session with no span", () => {
    const dto = buildSessionTracks({
      ...input([], { totalSec: 0 }),
      sessionId: "s1",
      anchoredToVideo: false,
      clockCalibrated: true,
    });
    expect(dto.totalSec).toBe(0);
    expect(dto.lanes.every((l) => l.emptyReason !== null || l.shape === "span")).toBe(true);
  });
});
