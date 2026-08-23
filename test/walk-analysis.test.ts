import { describe, expect, it } from "vitest";
import {
  chooseBaseline,
  sessionStartedAt,
  walkAnalysis,
  type WalkAnalysisInput,
} from "../app/src/main/walk-analysis.js";
import { flowWalks } from "../app/src/main/flow-steps.js";
import type {
  EdgeSourceDTO,
  FlowRouteDTO,
  FlowsDTO,
  GraphEdgeDTO,
  GraphNodeDTO,
  RouteWalkDTO,
} from "@shared/types";

const DAY = 86_400_000;
/** 2026-03-02T09:00:00Z — a fixed Monday, so day/hour assertions are stable. */
const T0 = Date.UTC(2026, 2, 2, 9, 0, 0);

const node = (id: string, label: string): GraphNodeDTO => ({
  id,
  label,
  chip: id,
  observations: 1,
  predicates: ["app(Test)"],
  locatable: true,
  intervene: "none",
  rank: 0,
  sources: [],
});

const source = (
  sessionId: string,
  startedAt: number,
  atSec: number,
  throughSec: number,
): EdgeSourceDTO => ({ sessionId, startedAt, atSec, throughSec });

const edge = (
  id: string,
  from: string,
  to: string,
  sources: EdgeSourceDTO[] = [],
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

const routeWalk = (sessionId: string, edgeIds: string[]): RouteWalkDTO => ({
  sessionId,
  edgeIds,
  atSec: 0,
  throughSec: 10,
});

/** A route over nodes n0..nN with one edge per hop, named e0, e1, … */
const chain = (n: number): { nodes: GraphNodeDTO[]; edgeIds: string[] } => {
  const nodes = Array.from({ length: n + 1 }, (_, i) => node(`n${i}`, `Place ${i}`));
  const edgeIds = Array.from({ length: n }, (_, i) => `e${i}`);
  return { nodes, edgeIds };
};

interface Fixture {
  flows: FlowsDTO;
  route: FlowRouteDTO;
}

/**
 * A route plus the graph it lives in, from a list of `[sessionId, edgeIds]`.
 *
 * Every edge carries a source for each session that walked it, because that is
 * where BOTH the wall clock and the per-step extent come from — the projection
 * reads `EdgeSourceDTO`, never `RouteWalkDTO`, for timing.
 */
const fixture = (
  hops: number,
  walks: { sessionId: string; edgeIds: string[]; startedAt: number; secPerStep?: number }[],
  extraRoutes: FlowRouteDTO[] = [],
): Fixture => {
  const { nodes, edgeIds } = chain(hops);
  const sourcesByEdge = new Map<string, EdgeSourceDTO[]>();
  for (const w of walks) {
    const step = w.secPerStep ?? 2;
    w.edgeIds.forEach((id, i) => {
      const list = sourcesByEdge.get(id) ?? [];
      list.push(source(w.sessionId, w.startedAt, i * step, i * step + 1));
      sourcesByEdge.set(id, list);
    });
  }
  const edges = edgeIds.map((id, i) => edge(id, `n${i}`, `n${i + 1}`, sourcesByEdge.get(id) ?? []));
  const route: FlowRouteDTO = {
    id: nodes.map((n) => n.label).join(" → "),
    count: walks.length,
    label: nodes.map((n) => n.label).join(" → "),
    name: null,
    nameObservations: 0,
    nodeIds: nodes.map((n) => n.id),
    edgeIds,
    sessionIds: walks.map((w) => w.sessionId),
    walks: walks.map((w) => routeWalk(w.sessionId, w.edgeIds)),
    variants: [],
  };
  const flows: FlowsDTO = {
    graph: { id: "g", entry: "n0", nodes, edges, slots: [] },
    routes: [route, ...extraRoutes],
    excludedApps: [],
  };
  return { flows, route };
};

const input = (f: Fixture, rule?: WalkAnalysisInput["rule"]): WalkAnalysisInput =>
  rule === undefined ? { flows: f.flows, route: f.route } : { flows: f.flows, route: f.route, rule };

describe("sessionStartedAt", () => {
  it("resolves a wall clock per session from the graph's edge sources", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1"], startedAt: T0 + DAY },
    ]);
    const map = sessionStartedAt(f.flows);
    expect(map.get("s1")).toBe(T0);
    expect(map.get("s2")).toBe(T0 + DAY);
  });

  it("has no entry for a session with no sources — evidence was deleted", () => {
    const f = fixture(1, [{ sessionId: "s1", edgeIds: ["e0"], startedAt: T0 }]);
    expect(sessionStartedAt(f.flows).has("ghost")).toBe(false);
  });
});

describe("chooseBaseline", () => {
  const startedAt = new Map([
    ["s1", T0],
    ["s2", T0 + DAY],
    ["s3", T0 + 2 * DAY],
  ]);

  it("picks the Way most recordings took, and says how many", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0"], startedAt: T0 + 2 * DAY },
    ]);
    const ways = flowWalks(f.flows, f.route);
    const out = chooseBaseline(ways, "majority", startedAt);
    expect(out.rule).toBe("majority");
    expect(out.wayIndex).toBe(0);
    expect(out.reason).toBe("The Way 2 of the 3 recordings took.");
  });

  it("breaks a majority tie on the newest walk, and SAYS it was a tie", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s3", edgeIds: ["e0"], startedAt: T0 + 2 * DAY },
    ]);
    const ways = flowWalks(f.flows, f.route);
    const out = chooseBaseline(ways, "majority", startedAt);
    // The tiebreak carries the whole decision here, and a standard chosen that
    // way is one recording away from moving. Saying so is the point.
    expect(out.reason).toBe(
      "2 Ways tie at 1 recording each; the standard is the one holding the newest walk.",
    );
    expect(out.wayIndex).toBe(1);
  });

  it("picks the Way the newest recording took under `recent`", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0"], startedAt: T0 + 2 * DAY },
    ]);
    const ways = flowWalks(f.flows, f.route);
    const out = chooseBaseline(ways, "recent", startedAt);
    expect(out.wayIndex).toBe(1);
    expect(out.reason).toBe("The Way the newest recording took, on 2026-03-04.");
  });

  it("names no Way under `none`", () => {
    const f = fixture(1, [{ sessionId: "s1", edgeIds: ["e0"], startedAt: T0 }]);
    const out = chooseBaseline(flowWalks(f.flows, f.route), "none", startedAt);
    expect(out.wayIndex).toBeNull();
    expect(out.reason).toBe("No Way is the standard, so no walk is called deviant.");
  });

  it("names no Way when the route has none", () => {
    const out = chooseBaseline([], "majority", startedAt);
    expect(out.wayIndex).toBeNull();
    expect(out.reason).toBe("This route has no recorded walks.");
  });
});

describe("walkAnalysis", () => {
  it("returns the baseline and defaults the rule to majority", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1"], startedAt: T0 + DAY },
    ]);
    const out = walkAnalysis(input(f));
    expect(out.baseline.rule).toBe("majority");
    expect(out.baseline.wayIndex).toBe(0);
  });
});
