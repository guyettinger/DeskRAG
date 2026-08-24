import { describe, expect, it } from "vitest";
import {
  droppedEarlyOf,
  habitCautions,
  habitFork,
  habitSlots,
  habitTimings,
  habitWays,
  walkFits,
} from "../app/src/main/habit-marks.js";
import { cautionsFor } from "../app/src/main/habit-doc.js";
import { flowWalks } from "../app/src/main/flow-steps.js";
import type { FlowRouteDTO, FlowsDTO, GraphEdgeDTO, GraphNodeDTO } from "@shared/types";

/**
 * The mapping from B's projection to the three DTO fields the screen draws.
 *
 * In a pure module and not in `deskrag-service.ts`, which imports electron and
 * so cannot be constructed by the root suite at all — the same constraint that
 * produced `habit-doc.ts` and `probe:merge`.
 */

const node = (id: string, label: string, extra: Partial<GraphNodeDTO> = {}): GraphNodeDTO => ({
  id,
  label,
  chip: id,
  observations: 2,
  predicates: ["app(TextEdit)"],
  locatable: true,
  intervene: "none",
  rank: 0,
  sources: [],
  ...extra,
});

const T_TUE = Date.UTC(2026, 2, 3, 12, 0, 0);
const DAY_MS = 86_400_000;

/**
 * The same three-hop, three-Way fixture the record's own tests use.
 *
 *   s1 (Tue) e0,e1        1 skipped,              stops short
 *   s2 (Wed) e0,e3        2 skipped, 1 inserted,  stops short
 *   s3 (Thu) e0,e1,e2     the standard (newest, wins the 3-way tie)
 */
function divergent(): FlowsDTO {
  const mk = (
    id: string,
    from: string,
    to: string,
    sources: { sessionId: string; startedAt: number; atSec: number; throughSec: number }[],
  ): GraphEdgeDTO => ({
    id,
    from,
    to,
    actions: [],
    back: false,
    provenance: "recorded",
    observations: Math.max(1, sources.length),
    sources,
  });
  const at = (sessionId: string, day: number, atSec: number, throughSec: number) => ({
    sessionId,
    startedAt: T_TUE + day * DAY_MS,
    atSec,
    throughSec,
  });

  return {
    graph: {
      id: "g",
      entry: "n0",
      nodes: [
        node("n0", "Calculator", { app: "Calculator" }),
        node("n1", "TextEdit", { app: "TextEdit" }),
        node("n2", "Finder", { app: "Finder" }),
      ],
      edges: [
        mk("e0", "n0", "n1", [at("s1", 0, 2, 6), at("s2", 1, 2, 5), at("s3", 2, 2, 6)]),
        mk("e1", "n1", "n2", [at("s1", 0, 8, 12), at("s3", 2, 8, 11)]),
        mk("e2", "n2", "n0", [at("s3", 2, 14, 18)]),
        mk("e3", "n1", "n0", [at("s2", 1, 9, 10)]),
      ],
      slots: [],
    },
    excludedApps: [],
    routes: [
      {
        id: "Calculator → TextEdit",
        count: 3,
        label: "Calculator → TextEdit",
        name: null,
        nameObservations: 0,
        nodeIds: ["n0", "n1", "n2"],
        edgeIds: ["e0", "e1", "e2", "e3"],
        sessionIds: ["s1", "s2", "s3"],
        variants: [],
        walks: [
          { sessionId: "s1", edgeIds: ["e0", "e1"], atSec: 2, throughSec: 12 },
          { sessionId: "s2", edgeIds: ["e0", "e3"], atSec: 2, throughSec: 10 },
          { sessionId: "s3", edgeIds: ["e0", "e1", "e2"], atSec: 2, throughSec: 18 },
        ],
      },
    ],
  };
}

/** One recording, one edge — the case with no standard to compare against. */
function once(): FlowsDTO {
  const f = divergent();
  f.routes[0]!.count = 1;
  f.routes[0]!.sessionIds = ["s3"];
  f.routes[0]!.walks = [{ sessionId: "s3", edgeIds: ["e0"], atSec: 2, throughSec: 6 }];
  return f;
}

/**
 * TWO ways over one route, with DISTINCT EDGE IDS PER SESSION — the real
 * store's shape, and the whole reason the fork aligns on places rather than
 * edges. The two ways share `Calculator → Calculator` and nothing else.
 */
function buildTwoWayRoute(): { flows: FlowsDTO; route: FlowRouteDTO } {
  const mk = (
    id: string,
    from: string,
    to: string,
    sources: { sessionId: string; startedAt: number; atSec: number; throughSec: number }[],
  ): GraphEdgeDTO => ({
    id,
    from,
    to,
    actions: [],
    back: false,
    provenance: "recorded",
    observations: Math.max(1, sources.length),
    sources,
  });
  const at = (sessionId: string, day: number, atSec: number, throughSec: number) => ({
    sessionId,
    startedAt: T_TUE + day * DAY_MS,
    atSec,
    throughSec,
  });

  const route: FlowRouteDTO = {
    id: "Calculator → TextEdit",
    count: 2,
    label: "Calculator → TextEdit",
    name: null,
    nameObservations: 0,
    nodeIds: ["n0", "n1", "n2"],
    edgeIds: ["s1:e0", "s1:e1", "s2:e0", "s2:e1", "s2:e2"],
    sessionIds: ["s1", "s2"],
    variants: [],
    walks: [
      { sessionId: "s1", edgeIds: ["s1:e0", "s1:e1"], atSec: 0, throughSec: 8 },
      { sessionId: "s2", edgeIds: ["s2:e0", "s2:e1", "s2:e2"], atSec: 0, throughSec: 12 },
    ],
  };
  return {
    flows: {
      graph: {
        id: "g",
        entry: "n0",
        nodes: [
          node("n0", "Calculator", { app: "Calculator" }),
          node("n1", "TextEdit", { app: "TextEdit" }),
          node("n2", "Finder", { app: "Finder" }),
        ],
        edges: [
          mk("s1:e0", "n0", "n0", [at("s1", 0, 0, 5)]),
          mk("s1:e1", "n0", "n1", [at("s1", 0, 5, 8)]),
          mk("s2:e0", "n0", "n0", [at("s2", 1, 0, 4)]),
          mk("s2:e1", "n0", "n2", [at("s2", 1, 4, 9)]),
          mk("s2:e2", "n2", "n1", [at("s2", 1, 9, 12)]),
        ],
        slots: [],
      },
      excludedApps: [],
      routes: [route],
    },
    route,
  };
}

describe("walkFits", () => {
  it("gives one fit per recording that walked the route", () => {
    const f = divergent();
    const fits = walkFits(f, f.routes[0]!);
    expect([...fits.keys()].sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("counts the deviations by kind, and never a ratio", () => {
    const f = divergent();
    const fits = walkFits(f, f.routes[0]!);
    expect(fits.get("s2")).toEqual({ inserted: 1, skipped: 2, reordered: 0, reachedEnd: false });
  });

  it("gives the standard's own walk a clean fit", () => {
    const f = divergent();
    expect(walkFits(f, f.routes[0]!).get("s3")).toEqual({
      inserted: 0,
      skipped: 0,
      reordered: 0,
      reachedEnd: true,
    });
  });

  it("says a walk stopped before the end", () => {
    const f = divergent();
    expect(walkFits(f, f.routes[0]!).get("s1")?.reachedEnd).toBe(false);
  });

  it("is EMPTY for a route recorded once — null is not conformant", () => {
    // The record's own guard. One walk has nothing to be consistent with, and a
    // fit here would claim it passed a check that was never run.
    const f = once();
    expect(walkFits(f, f.routes[0]!).size).toBe(0);
  });
});

describe("habitWays", () => {
  it("returns one way per distinct path, lettered as the record letters them", () => {
    const f = divergent();
    const ways = habitWays(f, f.routes[0]!);
    expect(ways.map((w) => w.letter)).toEqual(["A", "B", "C"]);
  });

  it("carries the recordings that took each way", () => {
    const f = divergent();
    const all = habitWays(f, f.routes[0]!).flatMap((w) => w.sessionIds);
    expect(all.sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("carries each step's own moment, with the recording to open it in", () => {
    const f = divergent();
    const step = habitWays(f, f.routes[0]!)[0]!.steps[0]!;
    expect(step.firstAt?.sessionId).toBe("s1");
    expect(step.firstAt?.atSec).toBe(2);
  });

  it("names the places a step moves between", () => {
    const f = divergent();
    const step = habitWays(f, f.routes[0]!)[0]!.steps[0]!;
    expect(step.from).toBe("Calculator");
    expect(step.to).toBe("TextEdit");
  });

  it("carries no slot samples — a recorded keystroke never reaches the screen twice", () => {
    // `showSamples` is a per-habit toggle honoured by the RENDERED FILE. The DTO
    // that draws the instrument has no toggle, so it carries no values at all.
    const f = divergent();
    const json = JSON.stringify(habitWays(f, f.routes[0]!));
    expect(json).not.toMatch(/samples/);
  });
});

describe("droppedEarlyOf", () => {
  it("is empty when no route is a prefix of this one", () => {
    const f = divergent();
    expect(droppedEarlyOf(f, f.routes[0]!)).toEqual([]);
  });

  it("names the places a prefix route reached, and how many did it", () => {
    const f = divergent();
    f.routes.push({
      id: "Calculator",
      count: 2,
      label: "Calculator",
      name: null,
      nameObservations: 0,
      nodeIds: ["n0"],
      edgeIds: [],
      sessionIds: ["s8", "s9"],
      variants: [],
      walks: [],
    });
    expect(droppedEarlyOf(f, f.routes[0]!)).toEqual([{ places: ["Calculator"], count: 2 }]);
  });
});

describe("habitFork", () => {
  it("is null for a single-way route", () => {
    const { flows, route } = buildTwoWayRoute();
    const one = { ...route, count: 1, sessionIds: ["s1"], walks: [route.walks[0]!] };
    expect(habitFork(flows, one)).toBeNull();
  });

  it("references steps by index, never by embedding them", () => {
    const { flows, route } = buildTwoWayRoute();
    const fork = habitFork(flows, route)!;
    const ways = habitWays(flows, route);
    for (const row of fork.rows) {
      if (row.kind === "spine") {
        for (const a of row.at) expect(ways[a.way]?.steps[a.step]).toBeDefined();
      } else {
        for (const r of row.runs)
          for (const st of r.steps) expect(ways[r.way]?.steps[st]).toBeDefined();
      }
    }
  });

  it("carries the run phrase so the screen composes no words of its own", () => {
    const { flows, route } = buildTwoWayRoute();
    const fork = habitFork(flows, route)!;
    const forks = fork.rows.filter((r) => r.kind === "fork");
    expect(forks.length).toBeGreaterThan(0);
    for (const row of forks) {
      if (row.kind === "fork") for (const r of row.runs) expect(r.phrase.length).toBeGreaterThan(0);
    }
  });

  it("fills each way's own totals", () => {
    const { flows, route } = buildTwoWayRoute();
    expect(habitWays(flows, route).map((w) => w.totalsMs)).toEqual([[8000], [12000]]);
  });
});

/**
 * THE RECORD'S OTHER THREE BLOCKS, as the screen's own shape.
 *
 * The Habits screen used to dump the generated markdown into a `<pre>`. It now
 * draws these, which means the facts have to cross the process boundary as
 * data — and being here rather than in `deskrag-service.ts` is what lets the
 * root suite watch them, the reason the rest of this file exists.
 */
describe("what varies, as data", () => {
  const withSlot = (samples: string[]): FlowsDTO => {
    const f = divergent();
    f.graph.edges[0]!.actions = [
      { action: "type", target: "slot textarea", slot: { name: "textarea", samples } },
    ];
    return f;
  };

  it("names a slot and counts its values", () => {
    const f = withSlot(["one", "two"]);
    expect(habitSlots(f, f.routes[0]!)).toEqual([
      { name: "textarea", samples: 2, note: "2 recorded values, varies between recordings" },
    ]);
  });

  /**
   * THE RULE THAT MATTERS, and it is structural rather than a promise: a DTO
   * has no `showSamples` toggle, so it can carry no values — `habit-marks.ts`'s
   * own rule, the one `steps.json` already obeys. A count is not a value.
   */
  it("carries no recorded value anywhere in the payload", () => {
    const f = withSlot(["hunter2", "correct horse battery staple"]);
    const json = JSON.stringify(habitSlots(f, f.routes[0]!));
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("correct horse");
    expect(json).toContain("textarea");
  });

  it("is empty when nothing was typed, rather than absent", () => {
    const f = divergent();
    expect(habitSlots(f, f.routes[0]!)).toEqual([]);
  });
});

describe("where the time goes, as data", () => {
  it("reads the baseline Way's steps, with each step's own extent", () => {
    const f = divergent();
    const t = habitTimings(f, f.routes[0]!);
    expect(t).not.toBeNull();
    // s3 is the standard, and its three steps are e0, e1, e2. A step carries
    // EVERY recording that walked that edge, not just the baseline's own: all
    // three sessions walked e0 (4s, 3s, 4s), two walked e1 (4s, 3s), one e2.
    expect(t!.steps.map((x) => x.ms)).toEqual([[4000, 3000, 4000], [4000, 3000], [4000]]);
    expect(t!.steps[0]!.from).toBe("Calculator");
    expect(t!.steps[0]!.to).toBe("TextEdit");
  });

  /**
   * A step's duration is its OWN extent, never the gap to the next step.
   * Differencing consecutive starts would report e0 as 6s (2→8) rather than 4s,
   * folding the idle before e1 into e0's cost and hiding the hesitation.
   */
  it("never differences consecutive starts", () => {
    const f = divergent();
    const t = habitTimings(f, f.routes[0]!);
    // s3's e0 spans 2→6, so its own extent is 4s. Differencing e0's start from
    // e1's would report 6s (2→8) and fold the idle before e1 into e0's cost.
    expect(t!.steps[0]!.ms).toContain(4000);
    expect(t!.steps[0]!.ms).not.toContain(6000);
  });

  it("names the baseline Way, so the screen can say which one it is", () => {
    const f = divergent();
    expect(habitTimings(f, f.routes[0]!)!.wayLetter).toMatch(/^[A-Z]$/);
  });

  /**
   * Every step holding one duration reads like a comparison and is not one, so
   * the flag exists to let the screen say so. BOTH branches are checked:
   * `divergent()` shares edges between recordings and so is a real comparison,
   * while `buildTwoWayRoute()` is the REAL STORE'S shape — ways with distinct
   * edge ids per session, where a step can only ever hold one duration.
   */
  it("says when every step was walked by exactly one recording", () => {
    const { flows, route } = buildTwoWayRoute();
    expect(habitTimings(flows, route)!.single).toBe(true);
  });

  it("says so is false when recordings genuinely share a step", () => {
    const f = divergent();
    expect(habitTimings(f, f.routes[0]!)!.single).toBe(false);
  });

  /**
   * SILENT TOGETHER WITH THE FILE. One recording's timings are a fact about one
   * afternoon, not about a habit, and the record applies the same guard — so a
   * screen that drew a chart here would claim more than the document beside it.
   */
  it("is null for a route recorded once", () => {
    const f = once();
    expect(habitTimings(f, f.routes[0]!)).toBeNull();
  });
});

describe("what this evidence does not say, as data", () => {
  const lifted = (): FlowsDTO => {
    const f = divergent();
    f.graph.edges[0]!.liftWarnings = ["key event at 40598.79 has no resolved char (keycode 42)"];
    return f;
  };

  /**
   * THE SPLIT. The notes are rebuilt on screen from the per-step
   * `liftWarnings` the renderer already holds; carrying them here would put 53
   * of 56 bullets in the field, which is the burial this change undoes.
   */
  it("excludes the lifting notes", () => {
    const f = lifted();
    const c = habitCautions(f, f.routes[0]!);
    expect(c.some((x) => /Lifting note/.test(x))).toBe(false);
    expect(c.some((x) => /keycode 42/.test(x))).toBe(false);
  });

  it("keeps every caution that is not a lifting note", () => {
    const f = lifted();
    const c = habitCautions(f, f.routes[0]!);
    expect(c.length).toBeGreaterThan(0);
    expect(c.some((x) => /did NOT do this the same way/.test(x))).toBe(true);
  });

  /** The FILE is untouched: it still prints every note, interleaved. */
  it("leaves the rendered record printing them all", () => {
    const f = lifted();
    const all = cautionsFor(f, f.routes[0]!, flowWalks(f, f.routes[0]!));
    expect(all.some((x) => /keycode 42/.test(x))).toBe(true);
    expect(all.length).toBeGreaterThan(habitCautions(f, f.routes[0]!).length);
  });
});
