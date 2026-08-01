import { describe, expect, it } from "vitest";
import { isRepairStep, isSupersededStep } from "../src/replay/types.js";
import type { PlanStep } from "../src/replay/types.js";

const action = {
  kind: "click",
  anchor: { point: { x: 1, y: 2, displayId: "1" } },
  button: 1,
  count: 1,
} as const;

describe("plan step discrimination", () => {
  const planned: PlanStep = { edgeId: "e0", action };
  const repair: PlanStep = {
    repair: "activate",
    edgeId: "e0",
    app: "Google Chrome",
    launch: false,
    reason: 'app(app="Google Chrome") does not hold',
  };
  const superseded: PlanStep = {
    superseded: "activate",
    edgeId: "e0",
    action,
    reason: "activating Google Chrome replaces this",
  };

  // Each guard keys on a field unique to its variant, so a PlannedAction stays
  // the fall-through case. `app/` will grow a review surface against this shape,
  // and a renderer that only knows about actions must keep working.
  it("tells the three step kinds apart, with PlannedAction as the fall-through", () => {
    expect(isRepairStep(repair)).toBe(true);
    expect(isSupersededStep(repair)).toBe(false);

    expect(isSupersededStep(superseded)).toBe(true);
    expect(isRepairStep(superseded)).toBe(false);

    expect(isRepairStep(planned)).toBe(false);
    expect(isSupersededStep(planned)).toBe(false);
  });
});
