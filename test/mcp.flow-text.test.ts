import { describe, expect, it } from "vitest";
import { renderFlow, renderFlowList } from "../app/src/main/mcp/flow-text.js";
import type { FlowsDTO, GraphEdgeDTO, GraphNodeDTO } from "@shared/types";

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
        node("n0", "TextEdit"),
        node("n1", "TextEdit — Save"),
        node("n2", "Google Chrome — github.com/user/repo"),
      ],
      edges: [
        edge("e0", "n0", "n1", {
          actions: [
            { action: "3× click", target: 'Button "Bold"' },
            {
              action: "type",
              target: 'TextArea "#First Text View"',
              slot: { name: "note", samples: ["hello there", "second run"] },
            },
          ],
          observations: 2,
          sources: [
            { sessionId: "s1", startedAt: 1_754_000_000_000, atSec: 2.5, throughSec: 6 },
            { sessionId: "s2", startedAt: 1_754_090_000_000, atSec: 3, throughSec: 7 },
          ],
        }),
        edge("e1", "n1", "n2", {
          actions: [{ action: "click", target: "point (1204, 38)" }],
          liftWarnings: ["dropped a wait whose predicate was already true"],
        }),
      ],
      slots: [{ name: "note", samples: ["hello there", "second run"] }],
    },
    routes: [
      {
        id: "e0|e1",
        count: 2,
        label: "TextEdit → TextEdit — Save → Google Chrome — github.com/user/repo",
        name: "Write a note and open the repo",
        nameObservations: 2,
        nodeIds: ["n0", "n1", "n2"],
        edgeIds: ["e0", "e1"],
        sessionIds: ["s1", "s2"],
      },
    ],
  };
}

describe("renderFlow", () => {
  it("walks the route's edges in order, naming the state each step moves between", () => {
    const text = renderFlow(flows(), flows().routes[0]!);
    expect(text).toMatch(/Write a note and open the repo/);
    expect(text.indexOf("Step 1")).toBeLessThan(text.indexOf("Step 2"));
    expect(text).toMatch(/Step 1.*TextEdit.*TextEdit — Save/s);
    expect(text).toMatch(/Step 2.*Google Chrome/s);
  });

  it("prints each action with the descriptors that were RECORDED", () => {
    const text = renderFlow(flows(), flows().routes[0]!);
    expect(text).toMatch(/3× click/);
    expect(text).toMatch(/Button "Bold"/);
    expect(text).toMatch(/point \(1204, 38\)/);
  });

  it("carries the slot samples — the recorded answer to 'what varies each time'", () => {
    // A slot exists precisely because two recordings of one task differed there.
    // It is the IR's whole claim that variation comes from recording twice
    // rather than from a model inventing alternatives, so it is the half of this
    // output an agent actually needs to decide anything.
    const text = renderFlow(flows(), flows().routes[0]!);
    expect(text).toMatch(/note/);
    expect(text).toMatch(/hello there/);
    expect(text).toMatch(/second run/);
    expect(text).toMatch(/varies/i);
  });

  it("distinguishes a slot with ONE sample from a discovered variable", () => {
    const f = flows();
    f.graph.edges[0]!.actions[1]!.slot = { name: "note", samples: ["only ever this"] };
    f.graph.slots = [{ name: "note", samples: ["only ever this"] }];
    const text = renderFlow(f, f.routes[0]!);
    // One sample is a value that happened to be typed once, not a variable.
    expect(text).not.toMatch(/varies/i);
    expect(text).toMatch(/only ever this/);
  });

  it("reports how many recordings walked each step, and when", () => {
    const text = renderFlow(flows(), flows().routes[0]!);
    expect(text).toMatch(/2 recording/);
    expect(text).toMatch(/2025|2026/);
  });

  it("shows what lifting could not do rather than hiding it", () => {
    expect(renderFlow(flows(), flows().routes[0]!)).toMatch(/dropped a wait/);
  });

  it("names a missing edge instead of skipping it silently", () => {
    const f = flows();
    f.routes[0]!.edgeIds = ["e0", "nope"];
    const text = renderFlow(f, f.routes[0]!);
    // A step that vanished would make the flow read as shorter than it was.
    expect(text).toMatch(/nope/);
    expect(text).toMatch(/not in the graph|missing/i);
  });

  it("says when a route was walked only once", () => {
    const f = flows();
    f.routes[0]!.count = 1;
    // One recording is not a habit, and an agent treating it as one would be
    // over-reading the evidence.
    expect(renderFlow(f, f.routes[0]!)).toMatch(/once/i);
  });

  it("discloses disagreement about the route's name", () => {
    const f = flows();
    f.routes[0]!.count = 4;
    f.routes[0]!.nameObservations = 2;
    // Several recordings sharing a shape can disagree about what they were for.
    // The dominant name winning is not the same as unanimity.
    expect(renderFlow(f, f.routes[0]!)).toMatch(/2 of 4/);
  });

  it("falls back to the state label when no composed level named the route", () => {
    const f = flows();
    f.routes[0]!.name = null;
    const text = renderFlow(f, f.routes[0]!);
    expect(text).toMatch(/TextEdit → TextEdit — Save/);
  });
});

describe("renderFlowList", () => {
  it("lists routes with their counts", () => {
    const text = renderFlowList(flows());
    expect(text).toMatch(/Write a note and open the repo/);
    expect(text).toMatch(/e0\|e1/);
    expect(text).toMatch(/2/);
  });

  it("explains an empty list rather than returning nothing", () => {
    // A graph with no provenance yields ZERO routes by design: routes are never
    // synthesized from traversal, because a merged graph composes paths no
    // recording ever walked. "Nothing here" and "rebuild to get it" are
    // different states and the second is actionable.
    const f = flows();
    f.routes = [];
    const text = renderFlowList(f);
    expect(text).toMatch(/no recorded routes/i);
    expect(text).toMatch(/rebuild/i);
  });
});
