import { describe, expect, it } from "vitest";
import { habitStepsJson } from "../app/src/main/mcp/habit-steps-json.js";
import type { FlowsDTO, HabitDTO, HabitWayDTO } from "@shared/types";

const EPOCH = 1_754_000_000_000;
const SECRET = "hunter2-do-not-leak";

const ways: HabitWayDTO[] = [
  {
    letter: "A",
    sessionIds: ["s1"],
    totalsMs: [39_300],
    steps: [
      {
        index: 0,
        edgeId: "e0",
        from: "Calculator",
        to: "TextEdit",
        app: null,
        actions: [
          { action: "click", target: 'Button "="' },
          { action: "type", target: "slot textarea", slot: { name: "textarea" } },
        ],
        observations: 2,
        everyRecording: true,
        missing: false,
        liftWarnings: ["a wait was dropped"],
        firstAt: { sessionId: "s1", startedAt: EPOCH, atSec: 22.157 },
      },
      {
        index: 1,
        edgeId: "gone",
        from: "TextEdit",
        to: "TextEdit",
        app: null,
        actions: [],
        observations: 1,
        everyRecording: false,
        missing: true,
        liftWarnings: [],
        firstAt: null,
      },
    ],
  },
];

const habit = (over: Partial<HabitDTO> = {}): HabitDTO => ({
  id: "01HABIT",
  state: "active",
  pinned: false,
  createdAt: EPOCH,
  updatedAt: EPOCH,
  version: "0.1.4",
  history: [],
  duplicates: [],
  ways,
  fork: null,
  slots: [],
  timings: null,
  runs: [],
  cautions: [],
  droppedEarly: [],
  apps: ["Calculator", "TextEdit"],
  slug: "add-up-and-note",
  title: "Add up and note the total",
  description: "",
  // The record only prints values with showSamples on, so a leak would most
  // plausibly arrive through the rendered markdown.
  body: "",
  bodySource: "template",
  bodyModel: null,
  edited: false,
  showSamples: true,
  generateNote: null,
  markdown: `---\n---\n\nsamples: ${SECRET}\n`,
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
  ...over,
});

const flows = (): FlowsDTO => ({
  graph: {
    id: "g",
    entry: "n0",
    nodes: [
      {
        id: "n0",
        label: "Calculator",
        chip: "n0",
        observations: 2,
        predicates: ["app is Calculator"],
        locatable: true,
        intervene: "none",
        rank: 0,
        sources: [],
      },
      {
        id: "n1",
        label: "TextEdit",
        chip: "n1",
        observations: 1,
        predicates: ["app is TextEdit", 'window titled "Untitled"'],
        locatable: true,
        intervene: "none",
        rank: 1,
        sources: [],
      },
    ],
    edges: [
      {
        id: "e0",
        from: "n0",
        to: "n1",
        actions: [],
        back: false,
        provenance: "recorded",
        observations: 2,
        sources: [],
      },
    ],
    slots: [],
  },
  excludedApps: [],
  routes: [],
});

const parse = (habitArg: HabitDTO, flowsArg: FlowsDTO | null): Record<string, unknown> => {
  const out = habitStepsJson(habitArg, flowsArg);
  if (typeof out !== "string") throw new Error(`expected JSON, got: ${out.error}`);
  return JSON.parse(out) as Record<string, unknown>;
};

describe("habitStepsJson", () => {
  it("is valid JSON carrying the habit's identity and its ways", () => {
    const doc = parse(habit(), flows());
    expect(doc["habitId"]).toBe("01HABIT");
    expect(doc["slug"]).toBe("add-up-and-note");
    expect(doc["version"]).toBe("0.1.4");
    expect(doc["routeKey"]).toBe("Calculator → TextEdit");
    expect(Array.isArray(doc["ways"])).toBe(true);
  });

  it("carries the destination state's predicates for a live edge", () => {
    const doc = parse(habit(), flows());
    const step = (doc["ways"] as { steps: Record<string, unknown>[] }[])[0]!.steps[0]!;
    expect(step["toNodeId"]).toBe("n1");
    expect(step["arrivesWhen"]).toEqual(["app is TextEdit", 'window titled "Untitled"']);
    expect(step["locatable"]).toBe(true);
  });

  it("states the absence of predicates rather than faking them from a label", () => {
    const doc = parse(habit(), flows());
    const step = (doc["ways"] as { steps: Record<string, unknown>[] }[])[0]!.steps[1]!;
    expect(step["arrivesWhen"]).toBeNull();
    expect(step["arrivesWhenAbsent"]).toMatch(/not in the trace graph/);
  });

  it("says the same when there is no graph at all", () => {
    const doc = parse(habit(), null);
    const step = (doc["ways"] as { steps: Record<string, unknown>[] }[])[0]!.steps[0]!;
    expect(step["arrivesWhen"]).toBeNull();
    expect(step["arrivesWhenAbsent"]).toMatch(/no trace graph/);
  });

  it("carries the slot NAME and the lift warnings", () => {
    const doc = parse(habit(), flows());
    const step = (doc["ways"] as { steps: Record<string, unknown>[] }[])[0]!.steps[0]!;
    expect(step["actions"]).toEqual([
      { action: "click", target: 'Button "="' },
      { action: "type", target: "slot textarea", slot: "textarea" },
    ]);
    expect(step["liftWarnings"]).toEqual(["a wait was dropped"]);
  });

  it("leaks NO recorded value, even with showSamples on", () => {
    // The strong form. `habit-marks.ts` drops the samples one level down
    // because a DTO has no toggle; this asserts nothing put them back, and
    // that the whole rendered markdown never reaches the payload.
    const out = habitStepsJson(habit({ showSamples: true }), flows());
    expect(typeof out).toBe("string");
    expect(out as string).not.toContain(SECRET);
  });

  it("refuses an orphaned habit with its reason", () => {
    const out = habitStepsJson(habit({ ways: [] }), flows());
    expect(typeof out).not.toBe("string");
    expect((out as { error: string }).error).toMatch(/no longer in the trace graph/);
  });
});
