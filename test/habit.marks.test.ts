import { describe, expect, it } from "vitest";
import { droppedEarlyOf, habitWays, walkFits } from "../app/src/main/habit-marks.js";
import type { FlowsDTO, GraphEdgeDTO, GraphNodeDTO } from "@shared/types";

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
