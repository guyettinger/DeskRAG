import { describe, expect, it } from "vitest";
import type { HabitForkDTO, HabitStepDTO, HabitWayDTO } from "@shared/types";
import { appTones } from "../app/src/renderer/src/habit-record-view.js";
import {
  LANE_GAP,
  LNODE_W,
  layoutWays,
  wayWireWidth,
} from "../app/src/renderer/src/way-lattice.js";

/**
 * Where the ways fork, placed as a graph.
 *
 * A `.ts` module so the root suite can reach it — the root tsconfig sets no
 * `jsx`, so a test touching a `.tsx` even for a type breaks `npm run typecheck`.
 * Layout for data a person reads before trusting a habit has real failure
 * modes, which is why `graph-layout.ts` is in this suite too.
 */

const stepOf = (over: Partial<HabitStepDTO> & { index: number; edgeId: string }): HabitStepDTO => ({
  from: "Calculator",
  to: "Calculator",
  app: "Calculator",
  actions: [],
  observations: 1,
  everyRecording: false,
  liftWarnings: [],
  missing: false,
  firstAt: null,
  ...over,
});

const wayOf = (letter: string, steps: HabitStepDTO[]): HabitWayDTO => ({
  letter,
  sessionIds: [`s${letter}`],
  steps,
  totalsMs: [1000],
});

/**
 * THE AUTHOR'S REAL ROUTE, reduced to the shape that matters.
 *
 * Six ways over `Calculator → TextEdit`, dumped from the running app:
 *
 *   - B, D and E open at `n0 — no state`; A, C and F open at `Calculator`.
 *   - Every way then takes `Calculator → Calculator`  (spine 0)
 *   - A, B, C and F take a second `Calculator → Calculator`; D and E do not.
 *   - Every way takes `Calculator → TextEdit`          (spine 1)
 *   - Every way takes `TextEdit → TextEdit`            (spine 2)
 *   - A adds one step; F adds NINE, through Finder; the rest stop.
 */
function realRoute(): { fork: HabitForkDTO; ways: HabitWayDTO[] } {
  const lead = (): HabitStepDTO =>
    stepOf({ index: 0, edgeId: "lead", from: "n0 — no state", to: "Calculator" });
  const pad = (index: number): HabitStepDTO => stepOf({ index, edgeId: "pad", to: "Calculator" });
  const cross = (index: number): HabitStepDTO =>
    stepOf({ index, edgeId: "cross", from: "Calculator", to: "TextEdit", app: "TextEdit" });
  const settle = (index: number): HabitStepDTO =>
    stepOf({ index, edgeId: "settle", from: "TextEdit", to: "TextEdit", app: "TextEdit" });

  const ways: HabitWayDTO[] = [
    // A: pad, pad, cross, settle, tail
    wayOf("A", [
      stepOf({ index: 0, edgeId: "core", to: "Calculator" }),
      pad(1),
      cross(2),
      settle(3),
      stepOf({ index: 4, edgeId: "tailA", from: "TextEdit", to: "TextEdit", app: "TextEdit" }),
    ]),
    // B: lead, core, pad, cross, settle
    wayOf("B", [lead(), stepOf({ index: 1, edgeId: "core" }), pad(2), cross(3), settle(4)]),
    // C: core, pad, cross, settle
    wayOf("C", [stepOf({ index: 0, edgeId: "core" }), pad(1), cross(2), settle(3)]),
    // D: lead, core, cross, settle
    wayOf("D", [lead(), stepOf({ index: 1, edgeId: "core" }), cross(2), settle(3)]),
    // E: lead, core, cross, settle
    wayOf("E", [lead(), stepOf({ index: 1, edgeId: "core" }), cross(2), settle(3)]),
    // F: core, pad, cross, settle, then NINE through Finder
    wayOf("F", [
      stepOf({ index: 0, edgeId: "core" }),
      pad(1),
      cross(2),
      settle(3),
      ...Array.from({ length: 9 }, (_, i) =>
        stepOf({
          index: 4 + i,
          edgeId: `f${i}`,
          from: i >= 4 && i <= 6 ? "Finder" : "TextEdit",
          to: i >= 4 && i <= 6 ? "Finder" : "TextEdit",
          app: i >= 4 && i <= 6 ? "Finder" : "TextEdit",
        }),
      ),
    ]),
  ];

  const fork: HabitForkDTO = {
    rows: [
      {
        kind: "fork",
        after: -1,
        runs: [
          { way: 0, steps: [], phrase: "nothing here" },
          { way: 1, steps: [0], phrase: "first, 1 step" },
          { way: 2, steps: [], phrase: "nothing here" },
          { way: 3, steps: [0], phrase: "first, 1 step" },
          { way: 4, steps: [0], phrase: "first, 1 step" },
          { way: 5, steps: [], phrase: "nothing here" },
        ],
      },
      {
        kind: "spine",
        from: "Calculator",
        to: "Calculator",
        at: [
          { way: 0, step: 0 },
          { way: 1, step: 1 },
          { way: 2, step: 0 },
          { way: 3, step: 1 },
          { way: 4, step: 1 },
          { way: 5, step: 0 },
        ],
      },
      {
        kind: "fork",
        after: 0,
        runs: [
          { way: 0, steps: [1], phrase: "then 1 step" },
          { way: 1, steps: [2], phrase: "then 1 step" },
          { way: 2, steps: [1], phrase: "then 1 step" },
          { way: 3, steps: [], phrase: "nothing here" },
          { way: 4, steps: [], phrase: "nothing here" },
          { way: 5, steps: [1], phrase: "then 1 step" },
        ],
      },
      {
        kind: "spine",
        from: "Calculator",
        to: "TextEdit",
        at: [
          { way: 0, step: 2 },
          { way: 1, step: 3 },
          { way: 2, step: 2 },
          { way: 3, step: 2 },
          { way: 4, step: 2 },
          { way: 5, step: 2 },
        ],
      },
      {
        kind: "spine",
        from: "TextEdit",
        to: "TextEdit",
        at: [
          { way: 0, step: 3 },
          { way: 1, step: 4 },
          { way: 2, step: 3 },
          { way: 3, step: 3 },
          { way: 4, step: 3 },
          { way: 5, step: 3 },
        ],
      },
      {
        kind: "fork",
        after: 2,
        runs: [
          { way: 0, steps: [4], phrase: "then 1 step" },
          { way: 1, steps: [], phrase: "nothing here" },
          { way: 2, steps: [], phrase: "nothing here" },
          { way: 3, steps: [], phrase: "nothing here" },
          { way: 4, steps: [], phrase: "nothing here" },
          { way: 5, steps: [4, 5, 6, 7, 8, 9, 10, 11, 12], phrase: "then 9 steps" },
        ],
      },
    ],
    verdict: { kind: "withheld", reason: "not enough timed recordings" },
  };
  return { fork, ways };
}

const tones = appTones(["Calculator", "TextEdit", "Finder"]);
const build = () => {
  const { fork, ways } = realRoute();
  return layoutWays(fork, ways, tones);
};

describe("the ways, as one graph", () => {
  it("collapses ways that take the IDENTICAL run into one branch", () => {
    // B, D and E all take the same opening step. Three parallel copies of one
    // step would say they differ, which is the opposite of the truth.
    const lattice = build();
    const leading = lattice.nodes.filter((n) => n.id.startsWith("b:-1:"));
    expect(leading).toHaveLength(1);
    expect(leading[0]!.ways).toEqual([1, 3, 4]);
  });

  /**
   * GROUPED ON PLACE LABELS, NOT ON EDGE IDS, and this is the case that
   * decides it. `way-fork.ts` records the measurement: the real store's Ways
   * share EXACTLY ONE EDGE between them, because a node's identity is what the
   * task does next, so two recordings of the same button mashing lift to
   * different nodes and different edges.
   *
   * This grouped on edge ids first, and the running app showed exactly that —
   * B, D and E drew as three separate pills of one identical step.
   */
  it("collapses ways whose run is the same PLACES on different edges", () => {
    const { fork, ways } = realRoute();
    // The real store's shape: one step, one edge id per recording.
    ways[1]!.steps[0] = stepOf({
      index: 0,
      edgeId: "lead-b",
      from: "n0 — no state",
      to: "Calculator",
    });
    ways[3]!.steps[0] = stepOf({
      index: 0,
      edgeId: "lead-d",
      from: "n0 — no state",
      to: "Calculator",
    });
    const lattice = layoutWays(fork, ways, tones);
    const leading = lattice.nodes.filter((n) => n.id.startsWith("b:-1:"));
    expect(leading).toHaveLength(1);
    expect(leading[0]!.ways).toEqual([1, 3, 4]);
  });

  it("keeps two runs apart when they pass through DIFFERENT places", () => {
    const { fork, ways } = realRoute();
    ways[3]!.steps[0] = stepOf({
      index: 0,
      edgeId: "lead-d",
      from: "n0 — no state",
      to: "Finder",
      app: "Finder",
    });
    const lattice = layoutWays(fork, ways, tones);
    expect(lattice.nodes.filter((n) => n.id.startsWith("b:-1:"))).toHaveLength(2);
  });

  it("draws an origin per DISTINCT starting place, never one shared root", () => {
    // Three ways open at `n0 — no state` and three at `Calculator`. A single
    // origin would assert a shared beginning that is not there.
    const origins = build().nodes.filter((n) => n.kind === "origin");
    expect(origins.map((o) => o.place)).toEqual(["Calculator", "n0 — no state"]);
    expect(origins.map((o) => o.ways)).toEqual([
      [0, 2, 5],
      [1, 3, 4],
    ]);
  });

  it("keeps the SPINE on the centre column at every row", () => {
    const lattice = build();
    const spine = lattice.nodes.filter((n) => n.kind === "spine");
    expect(spine).toHaveLength(3);
    expect(new Set(spine.map((n) => n.x)).size).toBe(1);
  });

  it("puts a branch beside the trunk, never on top of it", () => {
    const lattice = build();
    const spineX = lattice.nodes.find((n) => n.kind === "spine")!.x;
    for (const node of lattice.nodes.filter((n) => n.kind === "branch")) {
      expect(Math.abs(node.x - spineX)).toBeGreaterThanOrEqual(LNODE_W + LANE_GAP);
    }
  });

  it("gives a nine-step detour nine nodes — nothing collapses", () => {
    // NOTHING TRUNCATES. The height is honest, and each pill carries its own
    // action tally, so the run is not nine repetitions of one word.
    const tail = build().nodes.filter((n) => n.id.startsWith("b:2:"));
    expect(tail.filter((n) => n.ways.includes(5))).toHaveLength(9);
    expect(tail.filter((n) => n.ways.includes(0))).toHaveLength(1);
  });

  it("stacks a branch's own steps down consecutive rows", () => {
    const tail = build()
      .nodes.filter((n) => n.ways.includes(5) && n.id.startsWith("b:2:"))
      .map((n) => n.y);
    const gaps = tail.slice(1).map((y, i) => y - tail[i]!);
    expect(new Set(gaps).size).toBe(1);
    expect(gaps[0]).toBeGreaterThan(0);
  });

  it("never places a node at a negative coordinate", () => {
    // A lane is a SIGNED offset from the spine, so the leftmost branch starts
    // negative and would be clipped by the viewport. The world is translated
    // once, BEFORE any wire is drawn.
    const lattice = build();
    for (const n of lattice.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
    }
    expect(lattice.width).toBeGreaterThan(Math.max(...lattice.nodes.map((n) => n.x)));
  });

  it("draws every wire against the coordinates the nodes ended up at", () => {
    const lattice = build();
    for (const e of lattice.edges) {
      const from = lattice.nodes.find((n) => n.id === e.from)!;
      expect(e.d.startsWith(`M ${from.x + LNODE_W / 2} `)).toBe(true);
    }
  });
});

describe("a way's path is the highlight", () => {
  it("gives every way a path that starts at an origin and ends at its last step", () => {
    const lattice = build();
    expect(lattice.paths.map((p) => p.letter)).toEqual(["A", "B", "C", "D", "E", "F"]);
    for (const path of lattice.paths) {
      expect(lattice.nodes.find((n) => n.id === path.nodes[0])!.kind).toBe("origin");
    }
  });

  it("has a path through as many nodes as the way has steps, plus its origin", () => {
    const { ways } = realRoute();
    for (const path of build().paths) {
      expect(path.nodes).toHaveLength(ways[path.way]!.steps.length + 1);
    }
  });

  /**
   * THE PICTURE AND THE HIGHLIGHT CANNOT DISAGREE, and that is structural
   * rather than tested into place: an edge exists BECAUSE some way crosses it,
   * so there is no wire a highlight can miss and no highlighted wire that is
   * not drawn.
   */
  it("names only edges that are actually drawn", () => {
    const lattice = build();
    const drawn = new Set(lattice.edges.map((e) => e.id));
    for (const path of lattice.paths) {
      for (const id of path.edges) expect(drawn.has(id)).toBe(true);
    }
  });

  it("puts every drawn edge on at least one way's path", () => {
    const lattice = build();
    const claimed = new Set(lattice.paths.flatMap((p) => p.edges));
    for (const e of lattice.edges) expect(claimed.has(e.id)).toBe(true);
  });

  it("carries a wire's ways ascending, so its weight is a count of paths", () => {
    for (const e of build().edges) {
      expect(e.ways).toEqual([...e.ways].sort((a, b) => a - b));
      expect(e.ways.length).toBeGreaterThan(0);
    }
  });

  it("routes the ways that did nothing in a gap STRAIGHT from spine to spine", () => {
    // D and E skip the second `Calculator → Calculator`, so their wire out of
    // spine 0 lands on spine 1 with no node between.
    const lattice = build();
    const straight = lattice.edges.find((e) => e.from === "s:0" && e.to === "s:1");
    expect(straight).toBeDefined();
    expect(straight!.ways).toEqual([3, 4]);
  });
});

describe("what a node carries", () => {
  it("reads the tone from the step's own application", () => {
    const lattice = build();
    const finder = lattice.nodes.filter((n) => n.place === "Finder");
    expect(finder.length).toBeGreaterThan(0);
    expect(new Set(finder.map((n) => n.toneSlot))).toEqual(new Set([2]));
  });

  it("summarizes a step's actions rather than listing them", () => {
    const { fork, ways } = realRoute();
    ways[0]!.steps[1] = stepOf({
      index: 1,
      edgeId: "pad",
      actions: [
        { action: "3× click", target: "Button" },
        { action: "type", target: "Field", slot: { name: "note" } },
      ],
    });
    const lattice = layoutWays(fork, ways, tones);
    const node = lattice.nodes.find((n) => n.ways.includes(0) && n.summary !== "");
    expect(node!.summary).toBe("3 clicks · types {note}");
  });

  it("carries no summary for an origin, which is a place and not a step", () => {
    for (const n of build().nodes.filter((x) => x.kind === "origin")) {
      expect(n.summary).toBe("");
      expect(n.firstAt).toBeNull();
    }
  });
});

describe("a fork with nothing in it", () => {
  it("draws a world of zero size rather than one of negative size", () => {
    // `Math.max()` over an empty list is -Infinity, which renders as a blank
    // SVG with no error anywhere.
    const lattice = layoutWays({ rows: [], verdict: { kind: "withheld", reason: "" } }, [], tones);
    expect(lattice.nodes).toEqual([]);
    expect(lattice.width).toBe(0);
    expect(lattice.height).toBe(0);
  });
});

describe("wire weight", () => {
  it("grows by a CONSTANT per doubling, never in proportion to the count", () => {
    // The reading is "trunk or detour", not "by exactly how many". Six ways
    // must be visibly heavier than two and nowhere near three times as wide.
    expect(wayWireWidth(1)).toBeCloseTo(1.4);
    expect(wayWireWidth(6)).toBeGreaterThan(wayWireWidth(2));
    // Below the cap, each doubling adds the same amount — 8 is already capped.
    expect(wayWireWidth(2) - wayWireWidth(1)).toBeCloseTo(wayWireWidth(4) - wayWireWidth(2));
    expect(wayWireWidth(6) / wayWireWidth(1)).toBeLessThan(6);
  });

  it("is capped, so no count can hide what crosses it", () => {
    expect(wayWireWidth(64)).toBe(5);
    expect(wayWireWidth(10_000)).toBe(5);
  });
});
