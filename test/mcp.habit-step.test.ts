import { describe, expect, it } from "vitest";
import { renderStep, resolveStep } from "../app/src/main/mcp/habit-step.js";
import type { StepMoment } from "../app/src/main/mcp/reader.js";
import type { HabitDTO, HabitStepDTO, HabitWayDTO } from "@shared/types";

const EPOCH = 1_754_000_000_000;

const step = (over: Partial<HabitStepDTO> = {}): HabitStepDTO => ({
  index: 0,
  edgeId: "e0",
  from: "Calculator",
  to: "TextEdit",
  app: null,
  actions: [{ action: "click", target: 'Button "="' }],
  observations: 2,
  everyRecording: true,
  missing: false,
  liftWarnings: [],
  firstAt: { sessionId: "s1", startedAt: EPOCH, atSec: 22.157 },
  ...over,
});

const way = (letter: string, steps: HabitStepDTO[]): HabitWayDTO => ({
  letter,
  sessionIds: ["s1"],
  steps,
  totalsMs: [39_300],
});

const habit = (ways: HabitWayDTO[]): HabitDTO => ({
  id: "01HABIT",
  state: "active",
  pinned: false,
  createdAt: EPOCH,
  updatedAt: EPOCH,
  version: "0.1.0",
  history: [],
  duplicates: [],
  ways,
  fork: null,
  droppedEarly: [],
  slots: [],
  timings: null,
  runs: [],
  cautions: [],
  apps: ["Calculator", "TextEdit"],
  slug: "add-up-and-note",
  title: "Add up and note the total",
  description: "",
  body: "",
  bodySource: "template",
  bodyModel: null,
  edited: false,
  showSamples: false,
  generateNote: null,
  markdown: "---\n---\n",
  binding: {
    state: "exact",
    routeKey: "Calculator → TextEdit",
    liveRouteKey: "Calculator → TextEdit",
    routeLabel: "Calculator → TextEdit",
    boundAt: EPOCH,
    boundSessionIds: ["s1"],
    overlap: 1,
    lostSessionIds: [],
    gainedSessionIds: [],
    recordings: 1,
    candidates: [],
    note: null,
    walks: [],
  },
});

const oneWay = habit([way("A", [step(), step({ index: 1, edgeId: "e1" })])]);
const twoWays = habit([way("A", [step()]), way("B", [step({ edgeId: "eB" })])]);

describe("resolveStep", () => {
  it("finds a step by its printed number when there is one way", () => {
    const r = resolveStep(oneWay, 2, null);
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.step.edgeId).toBe("e1");
    expect(r.wayLetter).toBe("A");
    expect(r.manyWays).toBe(false);
  });

  it("refuses a way letter when the recordings agreed", () => {
    const r = resolveStep(oneWay, 1, "B");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toMatch(/one recorded way/);
  });

  it("refuses to guess when there are several ways", () => {
    // Defaulting to A would answer about a different path than the agent read,
    // and the file it read prints the letters.
    const r = resolveStep(twoWays, 1, null);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toMatch(/`way` is required/);
    expect(r.message).toMatch(/A, B/);
  });

  it("names the letters it has when given one it does not", () => {
    const r = resolveStep(twoWays, 1, "Q");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toMatch(/No way Q/);
    expect(r.message).toMatch(/A, B/);
  });

  it("accepts a lowercase letter", () => {
    expect(resolveStep(twoWays, 1, "b").kind).toBe("found");
  });

  it("says how many steps a way has when the number is out of range", () => {
    const r = resolveStep(oneWay, 5, null);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toMatch(/has 2 steps/);
  });

  it("refuses an orphaned habit with the reason, not a stale snapshot", () => {
    const r = resolveStep(habit([]), 1, null);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toMatch(/no longer in the trace graph/);
  });
});

describe("renderStep", () => {
  const moment = (over: Partial<StepMoment> = {}): StepMoment => ({
    frameId: "f1",
    offsetSec: 22.0,
    after: false,
    regions: [
      { role: "Button", label: "=", bbox: { x: 10, y: 20, w: 30, h: 40 } },
      { role: "TextField", label: null, bbox: { x: 0, y: 0, w: 100, h: 20 } },
    ],
    ...over,
  });

  it("prints the step, its actions and where the evidence came from", () => {
    const out = renderStep({
      habit: oneWay,
      wayLetter: "A",
      manyWays: false,
      step: step(),
      moment: moment(),
    });
    expect(out).toMatch(/Step 1 of 2/);
    expect(out).toMatch(/Calculator → TextEdit/);
    expect(out).toMatch(/click.*Button "="/);
    expect(out).toMatch(/Walked by 2 recordings/);
    expect(out).toMatch(/s1/);
  });

  it("names the way only when there is more than one", () => {
    expect(
      renderStep({ habit: twoWays, wayLetter: "B", manyWays: true, step: step(), moment: null }),
    ).toMatch(/Way B/);
    expect(
      renderStep({ habit: oneWay, wayLetter: "A", manyWays: false, step: step(), moment: null }),
    ).not.toMatch(/Way A/);
  });

  it("labels the regions and counts the unlabelled ones", () => {
    const out = renderStep({
      habit: oneWay,
      wayLetter: "A",
      manyWays: false,
      step: step(),
      moment: moment(),
    });
    expect(out).toMatch(/Button "="/);
    expect(out).toMatch(/1 further region/);
  });

  it("discloses a keyframe taken after the step rather than before it", () => {
    const out = renderStep({
      habit: oneWay,
      wayLetter: "A",
      manyWays: false,
      step: step(),
      moment: moment({ after: true, offsetSec: 25 }),
    });
    expect(out).toMatch(/AFTER/);
  });

  it("states the reason when a step has no moment to open", () => {
    const out = renderStep({
      habit: oneWay,
      wayLetter: "A",
      manyWays: false,
      step: step({ firstAt: null }),
      moment: null,
    });
    expect(out).toMatch(/carries no recording sources/);
  });

  it("states the reason when the recording has no keyframe", () => {
    const out = renderStep({
      habit: oneWay,
      wayLetter: "A",
      manyWays: false,
      step: step(),
      moment: null,
    });
    expect(out).toMatch(/no keyframe/);
  });

  it("says a step not every recording took is exactly that", () => {
    const out = renderStep({
      habit: oneWay,
      wayLetter: "A",
      manyWays: false,
      step: step({ everyRecording: false, observations: 1 }),
      moment: null,
    });
    expect(out).toMatch(/Not every recording took this step/);
  });
});
