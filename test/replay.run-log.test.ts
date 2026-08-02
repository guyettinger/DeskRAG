import { describe, expect, it } from "vitest";
import type { PlanDTO, RunEventDTO } from "../app/src/shared/types.js";
import {
  reduceRunEvent,
  type LoggedSegment,
} from "../app/src/renderer/src/screens/run-log.js";

const plan = (segment: number): PlanDTO => ({
  id: `p${segment}`,
  segment,
  from: `n${segment}`,
  to: `n${segment + 1}`,
  fromLabel: "TextEdit",
  toLabel: "Chrome",
  steps: [
    { kind: "handoff", app: "TextEdit" },
    { kind: "action", edgeId: "e1", action: "click", target: 'Button "Bold"' },
  ],
  blockers: [],
  brittleness: [],
  remainder: [],
});

const run = (events: RunEventDTO[]): LoggedSegment[] =>
  events.reduce<LoggedSegment[]>(reduceRunEvent, []);

describe("reduceRunEvent", () => {
  it("opens a planned segment awaiting approval", () => {
    const out = run([{ type: "segment-planned", plan: plan(1) }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.outcome.state).toBe("awaiting");
  });

  it("marks it running once armed", () => {
    const out = run([{ type: "segment-planned", plan: plan(1) }, { type: "armed", segment: 1 }]);
    expect(out[0]!.outcome.state).toBe("running");
  });

  it("infers an earlier segment completed when a later one is planned", () => {
    // executeRun only plans segment N+1 if segment N completed, and
    // segment-done for BOTH arrives after the whole run returns.
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "armed", segment: 1 },
      { type: "segment-planned", plan: plan(2) },
    ]);
    expect(out[0]!.outcome.state).toBe("completed");
    expect(out[1]!.outcome.state).toBe("awaiting");
  });

  it("records a failure with its DTO-space step index and reason", () => {
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "armed", segment: 1 },
      {
        type: "segment-done",
        segment: 1,
        completed: false,
        failure: { step: 1, reason: 'ax_exists(label="Stop recording")' },
        telemetry: [],
      },
    ]);
    expect(out[0]!.outcome).toEqual({
      state: "failed",
      failedStep: 1,
      reason: 'ax_exists(label="Stop recording")',
    });
  });

  it("confirms a completion the successor already implied", () => {
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "armed", segment: 1 },
      { type: "segment-planned", plan: plan(2) },
      { type: "segment-done", segment: 1, completed: true, telemetry: [] },
    ]);
    expect(out[0]!.outcome.state).toBe("completed");
  });

  it("leaves a refusal-to-start with no step index", () => {
    // failedStepIndex returns undefined for raw -1, so the event carries no
    // `failure` at all. The segment still failed.
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "armed", segment: 1 },
      { type: "segment-done", segment: 1, completed: false, telemetry: [] },
    ]);
    expect(out[0]!.outcome.state).toBe("failed");
    expect(out[0]!.outcome.failedStep).toBeUndefined();
  });

  it("stops leaves a still-awaiting segment alone — Cancel is not a failure", () => {
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "stopped", reached: false, reason: "cancelled" },
    ]);
    expect(out[0]!.outcome.state).toBe("awaiting");
  });

  it("demotes a segment left running when the run stops without reporting it", () => {
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "armed", segment: 1 },
      { type: "stopped", reached: false, reason: "handoff-failed" },
    ]);
    expect(out[0]!.outcome.state).toBe("failed");
  });

  it("replaces a re-plan of the same segment rather than appending", () => {
    const out = run([
      { type: "segment-planned", plan: plan(1) },
      { type: "segment-planned", plan: { ...plan(1), toLabel: "Safari" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.plan.toLabel).toBe("Safari");
  });
});
