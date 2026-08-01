import { describe, expect, it } from "vitest";
import { isRepairStep } from "../src/replay/types.js";
import type { PlanStep, RepairStep } from "../src/replay/types.js";
import type { Action } from "../src/trace/types.js";

const repair: RepairStep = {
  repair: "activate",
  edgeId: "e0",
  app: "TextEdit",
  launch: false,
  reason: 'app(app="TextEdit") does not hold',
};

const action: PlanStep = {
  edgeId: "e0",
  action: { kind: "chord", keys: ["cmd", "s"] } as Action,
};

describe("isRepairStep", () => {
  it("identifies a repair step", () => {
    expect(isRepairStep(repair)).toBe(true);
  });

  // The discriminator is the presence of `repair`, so no field had to be added
  // to PlannedAction and every existing step shape stays untouched.
  it("does not mistake a planned action for one", () => {
    expect(isRepairStep(action)).toBe(false);
  });

  it("narrows the type so `app` is reachable", () => {
    const step: PlanStep = repair;
    expect(isRepairStep(step) ? step.app : "").toBe("TextEdit");
  });
});
