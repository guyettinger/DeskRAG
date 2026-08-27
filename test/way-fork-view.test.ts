import { describe, expect, it } from "vitest";
import { foldFork, waySecs } from "../app/src/renderer/src/way-fork-view.js";
import type { HabitForkDTO, HabitWayDTO } from "@shared/types";

const way = (letter: string, n: number): HabitWayDTO => ({
  letter,
  sessionIds: ["s"],
  totalsMs: [1000],
  steps: Array.from({ length: n }, (_, i) => ({
    index: i,
    edgeId: `e${i}`,
    from: "A",
    to: "B",
    app: null,
    actions: [],
    observations: 1,
    everyRecording: true,
    liftWarnings: [],
    missing: false,
    firstAt: null,
  })),
});

const fork: HabitForkDTO = {
  rows: [
    {
      kind: "fork",
      after: -1,
      runs: [
        { way: 0, steps: [], phrase: "nothing here" },
        { way: 1, steps: [0], phrase: "first, 1 step: X → Y" },
      ],
    },
    {
      kind: "spine",
      from: "A",
      to: "B",
      at: [
        { way: 0, step: 0 },
        { way: 1, step: 1 },
      ],
    },
    {
      kind: "fork",
      after: 0,
      runs: [
        { way: 0, steps: [1, 2], phrase: "then 2 steps, via B" },
        { way: 1, steps: [], phrase: "nothing here" },
      ],
    },
  ],
  verdict: { kind: "withheld", reason: "one each" },
};

describe("foldFork", () => {
  const view = foldFork(fork, [way("A", 3), way("B", 2)]);

  it("hoists a leading fork out of the numbered list", () => {
    // There is no step 0 for it to sit under.
    expect(view.leading.map((r) => r.letter)).toEqual(["A", "B"]);
    expect(view.steps).toHaveLength(1);
  });

  it("numbers the spine from one", () => {
    expect(view.steps[0]?.n).toBe(1);
  });

  it("attaches a trailing fork to the step it followed", () => {
    expect(view.steps[0]?.after.map((r) => r.phrase)).toEqual([
      "then 2 steps, via B",
      "nothing here",
    ]);
  });

  it("resolves every way index to its letter", () => {
    expect(view.steps[0]?.at.map((a) => a.letter)).toEqual(["A", "B"]);
  });

  it("composes no words of its own — every phrase comes from the DTO", () => {
    const phrases = [...view.leading, ...view.steps.flatMap((s) => s.after)].map((r) => r.phrase);
    const fromDto = fork.rows.flatMap((r) => (r.kind === "fork" ? r.runs.map((x) => x.phrase) : []));
    expect(phrases).toEqual(fromDto);
  });
});

describe("waySecs", () => {
  it("matches the record's one-decimal form", () => {
    expect(waySecs(24_000)).toBe("24.0s");
    expect(waySecs(62_349)).toBe("62.3s");
  });
});
