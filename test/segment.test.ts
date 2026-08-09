import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { Segmenter } from "../src/segment/segmenter.js";
import { computeBoundaries } from "../src/segment/boundaries.js";
import { windowSegments } from "../src/segment/windowing.js";
import {
  BASE_GRANULARITIES,
  resolveGranularities,
  type Boundary,
  type GranularityConfig,
} from "../src/segment/types.js";
import type { EventInsert } from "../src/store/types.js";

const ev = (tMono: number, kind: string): { tMono: number; kind: string } => ({ tMono, kind });

describe("computeBoundaries", () => {
  it("brackets with session_start/end and cuts at focus changes", () => {
    const b = computeBoundaries(
      [ev(0, "mouse_move"), ev(1000, "mouse_move"), ev(5000, "focus_change"), ev(6000, "key_down")],
      8000,
      3000,
    );
    expect(b).toEqual([
      { tMono: 0, reason: "session_start" },
      { tMono: 5000, reason: "focus_change" }, // focus wins over the dwell gap here
      { tMono: 8000, reason: "session_end" },
    ]);
  });

  it("marks a dwell gap when activity resumes after an idle stretch", () => {
    const b = computeBoundaries([ev(0, "mouse_move"), ev(10_000, "mouse_move")], 12_000, 3000);
    expect(b).toEqual([
      { tMono: 0, reason: "session_start" },
      { tMono: 10_000, reason: "dwell_gap" },
      { tMono: 12_000, reason: "session_end" },
    ]);
  });

  it("prefers the more specific reason on a t_mono tie (bookmark > dwell)", () => {
    const b = computeBoundaries([ev(0, "mouse_move"), ev(9000, "bookmark")], 10_000, 3000);
    expect(b[1]).toEqual({ tMono: 9000, reason: "bookmark" });
  });

  it("clamps boundaries outside [0, endTMono]", () => {
    const b = computeBoundaries([ev(0, "mouse_move"), ev(15_000, "focus_change")], 10_000, 3000);
    expect(b).toEqual([
      { tMono: 0, reason: "session_start" },
      { tMono: 10_000, reason: "session_end" },
    ]);
  });

  it("marks a burst gap on a pause between meaningful input events, ignoring mouse_move in between", () => {
    const b = computeBoundaries(
      [
        ev(0, "mouse_down"),
        ev(200, "mouse_move"),
        ev(400, "mouse_move"),
        ev(1900, "mouse_move"), // mouse keeps moving through the pause
        ev(2000, "key_down"),   // 2000ms since the last MEANINGFUL event (mouse_down at 0)
      ],
      5000,
      3000, // dwellGapMs — no all-events gap here is big enough to fire dwell_gap
      1500, // burstGapMs
    );
    expect(b).toEqual([
      { tMono: 0, reason: "session_start" },
      { tMono: 2000, reason: "burst_gap" },
      { tMono: 5000, reason: "session_end" },
    ]);
  });

  it("does not fire burst_gap on continuous mouse_move alone", () => {
    const b = computeBoundaries(
      [ev(0, "mouse_move"), ev(1000, "mouse_move"), ev(2000, "mouse_move")],
      3000,
      3000,
      1500,
    );
    expect(b).toEqual([
      { tMono: 0, reason: "session_start" },
      { tMono: 3000, reason: "session_end" },
    ]);
  });

  it("prefers focus_change over a burst_gap when they land on the same t_mono", () => {
    const b = computeBoundaries(
      [ev(0, "key_down"), ev(2000, "key_down"), ev(2000, "focus_change")],
      5000,
      3000,
      1500,
    );
    expect(b[1]).toEqual({ tMono: 2000, reason: "focus_change" });
  });

  it("marks a scene change from a kept frame's t_mono", () => {
    const b = computeBoundaries([ev(0, "mouse_move")], 8000, 3000, 1500, [4000]);
    expect(b).toEqual([
      { tMono: 0, reason: "session_start" },
      { tMono: 4000, reason: "scene_change" },
      { tMono: 8000, reason: "session_end" },
    ]);
  });

  it("prefers focus_change over a scene_change on the same t_mono, and scene_change over a gap", () => {
    const b = computeBoundaries([ev(0, "key_down"), ev(4000, "focus_change")], 8000, 3000, 1500, [
      4000, 6000,
    ]);
    expect(b[1]).toEqual({ tMono: 4000, reason: "focus_change" });
    expect(b[2]).toEqual({ tMono: 6000, reason: "scene_change" });
  });

  it("scene changes do NOT suppress a dwell gap — they are not input", () => {
    // dwell_gap means "no input at all". A frame arriving mid-gap is the screen
    // changing by itself, which is precisely NOT the user being active, so it
    // must not close the gap. This is why scene times are a separate parameter
    // rather than merged into the event list.
    const b = computeBoundaries([ev(0, "key_down"), ev(9000, "key_down")], 10_000, 3000, 1500, [
      4000,
    ]);
    expect(b.map((x) => x.reason)).toContain("dwell_gap");
  });
});

describe("windowSegments", () => {
  const action: GranularityConfig = { name: "action", targetMs: 10_000, strideMs: 10_000, boundaryAware: true };

  it("cuts actions at boundaries, carrying the boundary reason on the first window", () => {
    const bounds: Boundary[] = [
      { tMono: 0, reason: "session_start" },
      { tMono: 5000, reason: "focus_change" },
      { tMono: 8000, reason: "session_end" },
    ];
    const segs = windowSegments("s", action, bounds, ulid);
    expect(segs.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 5000, "session_start"],
      [5000, 8000, "focus_change"],
    ]);
  });

  it("subdivides a long span into target-sized windows (first=reason, rest=window)", () => {
    const bounds: Boundary[] = [
      { tMono: 0, reason: "session_start" },
      { tMono: 25_000, reason: "session_end" },
    ];
    const segs = windowSegments("s", action, bounds, ulid);
    expect(segs.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 10_000, "session_start"],
      [10_000, 20_000, "window"],
      [20_000, 25_000, "window"],
    ]);
  });

  it("produces overlapping sliding windows for a non-boundary-aware granularity", () => {
    const task: GranularityConfig = { name: "task", targetMs: 100, strideMs: 50, boundaryAware: false };
    const bounds: Boundary[] = [
      { tMono: 0, reason: "session_start" },
      { tMono: 120, reason: "focus_change" }, // intermediate boundary is ignored
      { tMono: 250, reason: "session_end" },
    ];
    const segs = windowSegments("s", task, bounds, ulid);
    expect(segs.map((s) => [s.tMonoStart, s.tMonoEnd])).toEqual([
      [0, 100],
      [50, 150],
      [100, 200],
      [150, 250],
    ]);
    expect(segs.every((s) => s.boundaryReason === "window")).toBe(true);
  });

  it("ignores boundaries outside cutReasons (task-style filtering)", () => {
    const taskLike: GranularityConfig = {
      name: "task",
      targetMs: 100_000,
      strideMs: 50_000,
      boundaryAware: true,
      cutReasons: ["focus_change", "bookmark"],
    };
    const bounds: Boundary[] = [
      { tMono: 0, reason: "session_start" },
      { tMono: 2000, reason: "burst_gap" }, // filtered out — not in cutReasons
      { tMono: 5000, reason: "focus_change" }, // kept
      { tMono: 8000, reason: "session_end" },
    ];
    const segs = windowSegments("s", taskLike, bounds, ulid);
    expect(segs.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 5000, "session_start"],
      [5000, 8000, "focus_change"],
    ]);
  });

  it("does not emit a bogus trailing window when a boundary-aware span is shorter than targetMs but longer than strideMs", () => {
    // Found by driving a real recording: task (targetMs 30_000, strideMs
    // 15_000 once adaptive-resolved) cutting a 16.5s focus_change span used
    // to emit a second "window" segment that was a near-duplicate of the
    // first's tail, because the boundaryAware loop kept sliding by strideMs
    // even after the first window already reached the span's end.
    const taskLike: GranularityConfig = {
      name: "task",
      targetMs: 30_000,
      strideMs: 15_000,
      boundaryAware: true,
      cutReasons: ["focus_change", "bookmark"],
    };
    const bounds: Boundary[] = [
      { tMono: 0, reason: "session_start" },
      { tMono: 2187, reason: "focus_change" },
      { tMono: 18692, reason: "focus_change" }, // span length 16_505 < targetMs, > strideMs
      { tMono: 19101, reason: "session_end" },
    ];
    const segs = windowSegments("s", taskLike, bounds, ulid);
    expect(segs.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 2187, "session_start"],
      [2187, 18692, "focus_change"],
      [18692, 19101, "focus_change"],
    ]);
  });

  it("an undefined cutReasons keeps every boundary (today's behavior)", () => {
    const bounds: Boundary[] = [
      { tMono: 0, reason: "session_start" },
      { tMono: 2000, reason: "burst_gap" },
      { tMono: 8000, reason: "session_end" },
    ];
    const segs = windowSegments("s", action, bounds, ulid); // `action` has no cutReasons
    expect(segs.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 2000, "session_start"],
      [2000, 8000, "burst_gap"],
    ]);
  });

  it("subdivide:false emits ONE segment per span, however long", () => {
    const g: GranularityConfig = {
      name: "action",
      targetMs: 10_000,
      strideMs: 10_000,
      boundaryAware: true,
      subdivide: false,
    };
    const bounds: Boundary[] = [
      { tMono: 0, reason: "session_start" },
      { tMono: 45_000, reason: "session_end" },
    ];
    const segs = windowSegments("s", g, bounds, ulid);
    expect(segs.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 45_000, "session_start"],
    ]);
  });
});

describe("BASE_GRANULARITIES", () => {
  it("cuts action at visual state change, never at inactivity", () => {
    const action = BASE_GRANULARITIES.find((g) => g.name === "action")!;
    expect(action.cutReasons).toEqual(["scene_change", "focus_change", "bookmark"]);
    expect(action.cutReasons).not.toContain("dwell_gap");
    expect(action.cutReasons).not.toContain("burst_gap");
    // A sub-window contains no keyframe, so subdividing by clock reintroduces
    // exactly the caption-extent defect this design removes.
    expect(action.subdivide).toBe(false);
  });

  it("produces ONE granularity — everything above action is composed, not windowed", () => {
    // `task` used to live here as a longer window over the same timeline, which
    // is why the rail drew ACTION and TASK as one signal twice. A bigger box
    // cannot yield a higher altitude; `represent/compose/` builds those levels.
    expect(BASE_GRANULARITIES.map((g) => g.name)).toEqual(["action"]);
  });
});

describe("resolveGranularities", () => {
  it("returns the base set unchanged at any session length", () => {
    // The clamping this used to do existed solely for `task`. `action`'s 10s cap
    // only ever subdivides a span between real boundaries, so it needs no
    // scaling — it is meaningful for an 8s recording and a 17m one alike.
    for (const endTMono of [8_000, 200_000, 1_000_000]) {
      const gs = resolveGranularities(endTMono);
      expect(gs.map((g) => g.name)).toEqual(["action"]);
      expect(gs.find((g) => g.name === "action")!.targetMs).toBe(10_000);
    }
  });

  it("passes an explicit base through untouched", () => {
    const base = [
      { name: "custom", targetMs: 1234, strideMs: 1234, boundaryAware: true },
    ];
    expect(resolveGranularities(999_999, base)).toEqual(base);
  });
});

describe("Segmenter (integration)", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-seg-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed(sessionId: string, startedAt: number, endedAt: number | null, events: EventInsert[]) {
    await store.putSession({ id: sessionId, startedAt, epochMono: 0 });
    await store.putEvents(events);
    if (endedAt !== null) await store.endSession(sessionId, endedAt);
  }

  it("segments a session into level-0 actions and persists them", async () => {
    const sessionId = ulid();
    const mkEv = (tMono: number, kind: string): EventInsert => ({ id: ulid(), sessionId, tMono, kind });
    // started at wall 1000, ended at 9000 -> wall duration 8000ms; last event 6000 -> endTMono = 8000.
    await seed(sessionId, 1000, 9000, [
      mkEv(0, "mouse_move"),
      mkEv(5000, "focus_change"),
      mkEv(6000, "key_down"),
    ]);

    const result = await new Segmenter(store).segment(sessionId);
    expect(result.endTMono).toBe(8000);
    expect(result.byGranularity.action).toHaveLength(2);
    // Segmenting produces level 0 ONLY. Levels above it are composed from what
    // these actions mean together, by `represent/compose/`, and do not exist
    // until that stage runs.
    expect(Object.keys(result.byGranularity)).toEqual(["action"]);

    const segs = store.getSegmentsBySession(sessionId);
    expect(segs).toHaveLength(2);

    const actions = segs.filter((s) => s.granularity === "action");
    expect(actions.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 5000, "session_start"],
      [5000, 8000, "focus_change"],
    ]);

    // represent/ fills these later; they're empty now.
    expect(actions[0]!.transcript).toBeNull();
    expect(actions[0]!.caption).toBeNull();
  });

  it("segments a still-running session up to its last event", async () => {
    const sessionId = ulid();
    const mkEv = (tMono: number, kind: string): EventInsert => ({ id: ulid(), sessionId, tMono, kind });
    await seed(sessionId, 1000, null, [mkEv(0, "mouse_move"), mkEv(6000, "key_down")]);

    const result = await new Segmenter(store).segment(sessionId);
    expect(result.endTMono).toBe(6000); // no endedAt -> falls back to last event
    expect(store.getSegmentsBySession(sessionId).length).toBeGreaterThan(0);
  });
});
