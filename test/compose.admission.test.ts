import { describe, expect, it } from "vitest";
import { LEVEL_GRANULARITY, levelQualifies } from "../src/represent/compose/admission.js";

describe("levelQualifies", () => {
  it("requires at least one node holding 2+ children", () => {
    // Six tasks that each became their own process is not a level.
    expect(levelQualifies([1, 1, 1, 1, 1, 1], 6)).toBe(false);
    expect(levelQualifies([2, 1, 1], 4)).toBe(true);
  });

  it("requires strictly fewer nodes than the level below", () => {
    expect(levelQualifies([2, 2], 4)).toBe(true);
    expect(levelQualifies([2, 1, 1], 4)).toBe(true);
    // Same count as below: nothing was composed.
    expect(levelQualifies([2, 1, 1, 1], 4)).toBe(false);
  });

  it("rejects an empty level", () => {
    expect(levelQualifies([], 4)).toBe(false);
  });

  it("accepts a single node that swallows everything", () => {
    // One phase covering six tasks IS a level — it says the recording was one
    // phase, which is a real answer.
    expect(levelQualifies([6], 6)).toBe(true);
  });
});

describe("LEVEL_GRANULARITY", () => {
  it("maps each kind to the granularity stored on the row", () => {
    expect(LEVEL_GRANULARITY.task).toBe("level:1");
    expect(LEVEL_GRANULARITY.process).toBe("level:2");
    expect(LEVEL_GRANULARITY.session).toBe("session");
  });
});
