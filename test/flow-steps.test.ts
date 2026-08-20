import { describe, expect, it } from "vitest";
import { allSteps, flowApps, flowVariables, flowWalks } from "../app/src/main/flow-steps.js";
import type { FlowsDTO, GraphEdgeDTO, GraphNodeDTO } from "@shared/types";

/**
 * The walk both formatters share.
 *
 * `renderFlow` used to walk and format in one pass. The SKILL.md renderer needs
 * the same walk in markdown, and two readers of one structure is the
 * ax-dump/ax-exec drift hazard by name — so the walk happens once and the
 * formatters differ only in how they print it.
 */

const node = (id: string, label: string, extra: Partial<GraphNodeDTO> = {}): GraphNodeDTO => ({
  id,
  label,
  chip: id,
  observations: 1,
  predicates: [],
  locatable: true,
  intervene: "none",
  rank: 0,
  sources: [],
  ...extra,
});

const edge = (
  id: string,
  from: string,
  to: string,
  extra: Partial<GraphEdgeDTO> = {},
): GraphEdgeDTO => ({
  id,
  from,
  to,
  actions: [],
  back: false,
  provenance: "recorded",
  observations: 1,
  sources: [],
  ...extra,
});

function flows(): FlowsDTO {
  return {
    graph: {
      id: "g",
      entry: "n0",
      nodes: [
        node("n0", "TextEdit", { app: "TextEdit" }),
        node("n1", "Google Chrome — github.com", { app: "Google Chrome" }),
        node("n2", "Google Chrome — github.com/issues", { app: "Google Chrome" }),
      ],
      edges: [
        edge("e0", "n0", "n1", {
          actions: [
            { action: "click", target: 'Button "Open"' },
            { action: "type", target: "TextField", slot: { name: "q", samples: ["a", "b"] } },
          ],
          observations: 3,
          sources: [{ sessionId: "s1", startedAt: 1_754_000_000_000, atSec: 2, throughSec: 5 }],
        }),
        edge("e1", "n1", "n2", { observations: 3 }),
      ],
      slots: [
        { name: "q", samples: ["a", "b"] },
        { name: "unrelated", samples: ["x", "y"] },
      ],
    },
    routes: [
      {
        id: "TextEdit → Google Chrome — github.com",
        count: 3,
        label: "TextEdit → Google Chrome",
        name: null,
        nameObservations: 0,
        nodeIds: ["n0", "n1", "n2"],
        edgeIds: ["e0", "e1"],
        sessionIds: ["s1", "s2", "s3"],
        // All three walked the SAME path: one way, and the rendering is
        // unchanged from before variants existed.
        walks: [
          { sessionId: "s1", edgeIds: ["e0", "e1"] },
          { sessionId: "s2", edgeIds: ["e0", "e1"] },
          { sessionId: "s3", edgeIds: ["e0", "e1"] },
        ],
      },
    ],
  };
}

describe("flowWalks", () => {
  it("resolves each edge to its state labels, in route order", () => {
    const s = allSteps(flowWalks(flows(), flows().routes[0]!));
    expect(s.map((x: { index: number }) => x.index)).toEqual([0, 1]);
    expect(s[0]!.from).toBe("TextEdit");
    expect(s[0]!.to).toBe("Google Chrome — github.com");
    expect(s[1]!.to).toBe("Google Chrome — github.com/issues");
  });

  it("labels an unknown node rather than dropping the step", () => {
    const f = flows();
    f.graph.edges[0]!.from = "ghost";
    expect(allSteps(flowWalks(f, f.routes[0]!))[0]!.from).toBe("ghost (unknown state)");
  });

  it("CARRIES a missing edge rather than skipping it", () => {
    // A step that vanished would make the flow read as shorter than it was.
    const f = flows();
    for (const w of f.routes[0]!.walks) w.edgeIds = ["e0", "nope"];
    const s = allSteps(flowWalks(f, f.routes[0]!));
    expect(s).toHaveLength(2);
    expect(s[1]!.missing).toBe(true);
    expect(s[1]!.edgeId).toBe("nope");
  });

  /**
   * The defect this function exists to fix. `edgeIds` is the UNION of every
   * recording's walk and is documented as the canvas highlight; on the real
   * store two recordings walked 8 edges each, shared 2, and the old renderer
   * numbered the 14-edge union into a "procedure" no recording ever took.
   */
  it("reads the per-recording WALKS, never the union in edgeIds", () => {
    const f = flows();
    f.routes[0]!.edgeIds = ["e0", "e1", "nope-a", "nope-b"];
    const walks = flowWalks(f, f.routes[0]!);
    expect(walks).toHaveLength(1);
    expect(walks[0]!.steps.map((st) => st.edgeId)).toEqual(["e0", "e1"]);
  });

  it("groups identical walks into ONE way, and keeps distinct ones apart", () => {
    const f = flows();
    // s1 and s2 did the same thing; s3 went another way through the same apps.
    f.routes[0]!.walks = [
      { sessionId: "s1", edgeIds: ["e0", "e1"] },
      { sessionId: "s2", edgeIds: ["e0", "e1"] },
      { sessionId: "s3", edgeIds: ["e1", "e0"] },
    ];
    const walks = flowWalks(f, f.routes[0]!);
    expect(walks).toHaveLength(2);
    // Most-walked first, and the letter comes from the index.
    expect(walks[0]!.sessionIds).toEqual(["s1", "s2"]);
    expect(walks[0]!.index).toBe(0);
    expect(walks[1]!.sessionIds).toEqual(["s3"]);
    expect(walks[1]!.steps.map((st) => st.edgeId)).toEqual(["e1", "e0"]);
  });

  it("falls back to the union only when a route carries no walks at all", () => {
    const f = flows();
    f.routes[0]!.walks = [];
    const walks = flowWalks(f, f.routes[0]!);
    expect(walks).toHaveLength(1);
    expect(walks[0]!.steps.map((st) => st.edgeId)).toEqual(["e0", "e1"]);
  });

  /**
   * The honest replacement for a success rate. `TraceEdge.outcomes` is
   * {attempts: 0, successes: 0} everywhere, so "this step sometimes failed" has
   * no data behind it — "four of the five recordings did this" has.
   */
  it("marks a step fewer recordings walked than walked the route", () => {
    const f = flows();
    f.graph.edges[0]!.observations = 2;
    const s = allSteps(flowWalks(f, f.routes[0]!));
    expect(s[0]!.everyRecording).toBe(false);
    expect(s[1]!.everyRecording).toBe(true);
  });

  it("does not invent a shortfall when the route has no count", () => {
    const f = flows();
    f.routes[0]!.count = 0;
    expect(allSteps(flowWalks(f, f.routes[0]!)).every((s: { everyRecording: boolean }) => s.everyRecording)).toBe(true);
  });

  it("reports sources shorter than observations without deriving one from the other", () => {
    const s = allSteps(flowWalks(flows(), flows().routes[0]!));
    // e0: 3 observations, 1 source — a recording deleted since.
    expect(s[0]!.observations).toBe(3);
    expect(s[0]!.sourcesBelowObservations).toBe(true);
    expect(s[0]!.firstAt).not.toBeNull();
    // e1: 3 observations, no sources at all — a graph lifted before provenance.
    expect(s[1]!.firstAt).toBeNull();
    expect(s[1]!.sourcesBelowObservations).toBe(true);
  });

  it("copies actions and slots rather than aliasing the DTO", () => {
    const f = flows();
    const s = allSteps(flowWalks(f, f.routes[0]!));
    s[0]!.actions[1]!.slot!.samples.push("mutated");
    expect(f.graph.edges[0]!.actions[1]!.slot!.samples).toEqual(["a", "b"]);
  });
});

describe("flowVariables", () => {
  /**
   * From the route's own steps, NOT from `graph.slots`. A route is one path
   * through the graph, and listing another route's variables as this one's
   * inputs is the same category error as synthesising a route from a traversal.
   */
  it("takes only the slots on this route's steps", () => {
    const f = flows();
    const vars = flowVariables(allSteps(flowWalks(f, f.routes[0]!)));
    expect(vars.map((v) => v.name)).toEqual(["q"]);
    expect(vars[0]!.samples).toEqual(["a", "b"]);
  });

  it("unions samples across steps that share a slot name, without duplicating", () => {
    const f = flows();
    f.graph.edges[1]!.actions = [
      { action: "type", target: "T", slot: { name: "q", samples: ["b", "c"] } },
    ];
    expect(flowVariables(allSteps(flowWalks(f, f.routes[0]!)))[0]!.samples).toEqual(["a", "b", "c"]);
  });

  it("is empty when nothing was typed", () => {
    const f = flows();
    f.graph.edges[0]!.actions = [{ action: "click", target: "B" }];
    expect(flowVariables(allSteps(flowWalks(f, f.routes[0]!)))).toEqual([]);
  });
});

describe("flowApps", () => {
  it("lists each application once, in the order reached", () => {
    expect(flowApps(flows(), flows().routes[0]!)).toEqual(["TextEdit", "Google Chrome"]);
  });

  it("skips a state that names no application", () => {
    const f = flows();
    delete f.graph.nodes[0]!.app;
    expect(flowApps(f, f.routes[0]!)).toEqual(["Google Chrome"]);
  });
});
