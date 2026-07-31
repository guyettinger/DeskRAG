import { describe, expect, it } from "vitest";
import { parseGraph, parseInterventionResponse, printGraph, printInterventionRequest } from "../src/trace/language.js";
import type { Graph, InterventionRequest } from "../src/trace/types.js";

const graph: Graph = {
  id: "g_01",
  entry: "n0",
  nodes: [
    {
      id: "n0",
      predicates: [
        { kind: "app", args: { app: "Mail" }, reach: "achievable" },
        { kind: "window", args: { title: "New Message" }, reach: "achievable" },
        { kind: "ax_exists", args: { role: "AXButton", label: "Send" }, reach: "achievable" },
        { kind: "display", args: { id: "D1", w: 2560, h: 1440 }, reach: "assertable" },
      ],
      visual: { frameBlobId: "b_1", phash: "0f1e2d3c4b5a6978" },
      intervene: "select",
      observations: 3,
    },
    { id: "n1", predicates: [], intervene: "synthesize", observations: 1 },
  ],
  edges: [
    {
      id: "e0",
      from: "n0",
      to: "n1",
      actions: [
        {
          kind: "click",
          anchor: {
            ax: { role: "AXButton", label: "Send", path: "AXWindow[0]>AXButton[0]" },
            visual: { regionId: "r_1", framePhash: "0f1e", bbox: { x: 1, y: 2, w: 3, h: 4 } },
            point: { x: 1420, y: 386, displayId: "D1", windowRelative: { x: 220, y: 118 } },
          },
          button: 1,
          count: 1,
        },
        { kind: "type", slot: "recipient", recorded: 'a "quoted" value' },
        { kind: "chord", keys: ["cmd", "s"] },
        { kind: "hover", anchor: { point: { x: 5, y: 6, displayId: "D1" } }, dwellMs: 1200 },
        { kind: "scroll", anchor: { point: { x: 5, y: 6, displayId: "D1" } }, delta: { x: 0, y: -450 }, steps: 6 },
        {
          kind: "drag",
          from: { point: { x: 0, y: 0, displayId: "D1" } },
          to: { point: { x: 100, y: 0, displayId: "D1" } },
          path: {
            curve: [{ c1: { x: 0.33, y: -0.2 }, c2: { x: 0.66, y: -0.2 }, end: { x: 1, y: 0 } }],
            durationMs: 840,
            velocity: [0, 0.5, 1],
            fitConfidence: 0.87,
          },
          button: 1,
        },
        {
          kind: "wait",
          until: { kind: "ax_exists", args: { role: "AXSheet" }, reach: "achievable" },
          timeoutMs: 3000,
        },
      ],
      provenance: "recorded",
      observations: 2,
      outcomes: { attempts: 5, successes: 4 },
      liftWarnings: ["a warning with \"quotes\""],
    },
  ],
  slots: [{ name: "recipient", samples: ["alice@example.com", "bob@example.com"], secret: false }],
};

describe("printGraph / parseGraph", () => {
  it("round-trips a graph exercising every action kind", () => {
    expect(parseGraph(printGraph(graph))).toEqual(graph);
  });

  it("round-trips twice to the identical text — printing is canonical", () => {
    const once = printGraph(graph);
    expect(printGraph(parseGraph(once))).toBe(once);
  });

  it("marks assertable predicates with a leading bang", () => {
    const text = printGraph(graph);
    expect(text).toMatch(/^\s*! display /m);
    expect(text).toMatch(/^\s*app app="Mail"/m);
  });

  it("round-trips an empty graph", () => {
    const empty: Graph = { id: "g", entry: "", nodes: [], edges: [], slots: [] };
    expect(parseGraph(printGraph(empty))).toEqual(empty);
  });

  it("throws on malformed input rather than returning a partial graph", () => {
    expect(() => parseGraph("this is not a graph")).toThrow();
    expect(() => parseGraph("graph g entry=n0\n\nedge e0 n0 -> ")).toThrow();
  });
});

describe("parseInterventionResponse", () => {
  const req: InterventionRequest = {
    goal: "send the message",
    atNode: [{ kind: "app", args: { app: "Mail" }, reach: "achievable" }],
    observed: [{ kind: "app", args: { app: "Mail" }, reach: "achievable" }],
    options: [
      { edgeId: "e0", summary: "click Send" },
      { edgeId: "e1", summary: "save a draft" },
    ],
    slots: [{ name: "recipient", samples: ["alice@example.com"] }],
    allow: "select",
  };

  it("accepts a valid choice with slot bindings", () => {
    const r = parseInterventionResponse('choose e0\nbind recipient="carol@example.com"', req);
    expect(r).toEqual({ choose: "e0", bind: { recipient: "carol@example.com" } });
  });

  it("accepts a bare abort with its reason", () => {
    expect(parseInterventionResponse("abort the window is not open", req)).toEqual({
      abort: "the window is not open",
    });
  });

  it("REJECTS an unknown edge id", () => {
    const r = parseInterventionResponse("choose e_does_not_exist", req);
    expect(r.choose).toBeUndefined();
    expect(r.abort).toMatch(/unknown edge/i);
  });

  it("REJECTS an undeclared slot", () => {
    const r = parseInterventionResponse('choose e0\nbind nickname="x"', req);
    expect(r.choose).toBeUndefined();
    expect(r.abort).toMatch(/undeclared slot/i);
  });

  it("REJECTS synthesis when the request only allowed select — no self-widening", () => {
    const r = parseInterventionResponse('synthesize\n  chord cmd+s', req);
    expect(r.synthesize).toBeUndefined();
    expect(r.abort).toMatch(/not permitted/i);
  });

  it("accepts synthesis when the request allowed it", () => {
    const r = parseInterventionResponse("synthesize\n  chord cmd+s", { ...req, allow: "synthesize" });
    expect(r.synthesize).toEqual([{ kind: "chord", keys: ["cmd", "s"] }]);
    expect(r.abort).toBeUndefined();
  });

  it("REJECTS unparseable text", () => {
    for (const bad of ["", "  ", "yes please", "{\"choose\":\"e0\"}", "choose"]) {
      expect(parseInterventionResponse(bad, req).abort, bad).toBeTruthy();
    }
  });

  it("never returns both a choice and an abort", () => {
    const r = parseInterventionResponse("choose e_nope", req);
    expect(r.choose === undefined || r.abort === undefined).toBe(true);
  });
});

describe("printInterventionRequest", () => {
  it("shows expectation and reality as a diff the model can read", () => {
    const text = printInterventionRequest({
      goal: "send",
      atNode: [{ kind: "app", args: { app: "Mail" }, reach: "achievable" }],
      observed: [{ kind: "app", args: { app: "Safari" }, reach: "achievable" }],
      options: [{ edgeId: "e0", summary: "click Send" }],
      slots: [],
      allow: "select",
    });
    expect(text).toMatch(/goal: send/);
    expect(text).toMatch(/expected/i);
    expect(text).toMatch(/observed/i);
    expect(text).toMatch(/e0/);
    expect(text).toMatch(/allow: select/);
  });
});
