import { describe, it, expect } from "vitest";
import type { IndexJobDTO, IndexJobState, IndexQueueDTO, RecordingStatus } from "@shared/types";
import {
  trayFaceAsset,
  trayIndexing,
  trayStatusLine,
  trayTooltip,
} from "../app/src/main/tray-face.js";

const job = (id: string, state: IndexJobState): IndexJobDTO => ({
  id,
  kind: "record",
  sessionId: id,
  sessionLabel: null,
  posterUrl: null,
  state,
  enqueuedAt: 0,
  startedAt: null,
  endedAt: null,
  error: null,
  batchId: null,
  stages: [],
  done: 0,
  total: 0,
});

const queue = (jobs: IndexJobDTO[], runningJobId: string | null): IndexQueueDTO => ({
  jobs,
  runningJobId,
  held: runningJobId === null && jobs.length > 0 ? "recording" : null,
  heldMessage: null,
});

const idleQueue = queue([], null);
const idle: RecordingStatus = { state: "idle", activeSignals: [] };
const recording: RecordingStatus = {
  state: "recording",
  sessionId: "s1",
  startedAt: 1_700_000_000_000,
  activeSignals: [],
};

/** A fixed formatter, so nothing here depends on the machine's locale. */
const at = (): string => "2:41 PM";

describe("tray face", () => {
  it("maps the two axes onto the four committed assets", () => {
    expect(trayFaceAsset(false, false)).toBe("trayTemplate");
    expect(trayFaceAsset(true, false)).toBe("trayRecordingTemplate");
    expect(trayFaceAsset(false, true)).toBe("trayIndexingTemplate");
    expect(trayFaceAsset(true, true)).toBe("trayRecordingIndexingTemplate");
  });

  it("keeps the idle basename, so an older build still finds an icon", () => {
    expect(trayFaceAsset(false, false)).toBe("trayTemplate");
  });

  it("shows the indexing face only while a stage is actually running", () => {
    expect(trayIndexing(queue([job("a", "running")], "a"))).toBe(true);
  });

  it("does NOT show it for a queue merely holding work", () => {
    // The worker holds while a recording is in flight, so during a capture
    // there are usually jobs waiting and nothing being done to them. Dots there
    // would claim work that is not happening.
    const held = queue([job("a", "queued"), job("b", "queued")], null);
    expect(held.held).toBe("recording");
    expect(trayIndexing(held)).toBe(false);
    expect(trayFaceAsset(true, trayIndexing(held))).toBe("trayRecordingTemplate");
  });

  it("draws both axes at once rather than arbitrating between them", () => {
    // A stage already in flight keeps running for minutes after a capture
    // starts. The retired tray title picked one; the face says both.
    const q = queue([job("a", "running")], "a");
    expect(trayFaceAsset(true, trayIndexing(q))).toBe("trayRecordingIndexingTemplate");
  });
});

describe("tray status line", () => {
  it("names the next action when there is nothing to report", () => {
    expect(trayStatusLine(idle, idleQueue, at)).toBe("Ready to record");
  });

  it("reports a START TIME, never an elapsed count", () => {
    const line = trayStatusLine(recording, idleQueue, at);
    expect(line).toBe("Recording since 2:41 PM");
    // The menu is rebuilt only on state transitions, so a duration would be
    // stale the moment after it was drawn — and a live one would need a timer
    // in the menu bar, which is exactly what this design rules out.
    expect(line).not.toMatch(/\d+:\d\d(:\d\d)?\s*(elapsed|ago)/i);
  });

  it("falls back to the bare word when a recording has no start stamp", () => {
    expect(trayStatusLine({ state: "recording", activeSignals: [] }, idleQueue, at)).toBe(
      "Recording",
    );
  });

  it("counts outstanding jobs, and says nothing about a ratio of one", () => {
    expect(trayStatusLine(idle, queue([job("a", "running")], "a"), at)).toBe("Indexing");
    const three = queue([job("a", "done"), job("b", "running"), job("c", "queued")], "b");
    expect(trayStatusLine(idle, three, at)).toBe("Indexing 1 of 2");
  });

  it("carries both states in one line, recording first", () => {
    const q = queue([job("a", "running")], "a");
    expect(trayStatusLine(recording, q, at)).toBe("Recording since 2:41 PM · indexing");
  });

  it("is the tooltip's whole body", () => {
    expect(trayTooltip(recording, idleQueue, at)).toBe("DeskRAG — Recording since 2:41 PM");
  });
});
