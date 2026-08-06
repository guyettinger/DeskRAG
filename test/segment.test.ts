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
});

describe("resolveGranularities", () => {
  it("keeps action fixed and scales task's window to session length, floored at 30s", () => {
    const gs = resolveGranularities(8000); // 8s session
    const action = gs.find((g) => g.name === "action")!;
    const task = gs.find((g) => g.name === "task")!;
    expect(action.targetMs).toBe(10_000);
    expect(task.targetMs).toBe(30_000); // clamp(4000, 30_000, 180_000) -> floor
    expect(task.strideMs).toBe(15_000);
  });

  it("caps task's window at 180s for a long session", () => {
    const gs = resolveGranularities(1_000_000); // ~16.7 minutes
    const task = gs.find((g) => g.name === "task")!;
    expect(task.targetMs).toBe(180_000);
    expect(task.strideMs).toBe(90_000);
  });

  it("scales smoothly between the floor and the ceiling", () => {
    const gs = resolveGranularities(200_000); // 200s session -> raw 100s, within bounds
    const task = gs.find((g) => g.name === "task")!;
    expect(task.targetMs).toBe(100_000);
    expect(task.strideMs).toBe(50_000);
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

  it("segments a session at multiple granularities and persists them", async () => {
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
    expect(result.byGranularity.task).toHaveLength(2); // was 1 — task now cuts at focus_change too

    const segs = store.getSegmentsBySession(sessionId);
    expect(segs).toHaveLength(4); // was 3

    const actions = segs.filter((s) => s.granularity === "action");
    expect(actions.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
      [0, 5000, "session_start"],
      [5000, 8000, "focus_change"],
    ]);
    const tasks = segs.filter((s) => s.granularity === "task");
    expect(tasks.map((s) => [s.tMonoStart, s.tMonoEnd, s.boundaryReason])).toEqual([
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
