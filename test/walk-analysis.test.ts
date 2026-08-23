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

describe("walkAnalysis — walks", () => {
  it("returns one fit per RECORDING, not one per Way", () => {
    // Two recordings walked identically, so `flowWalks` collapses them into one
    // Way. A fit is per recording: the count is what the recurrence argument
    // rests on, and reporting one row for two walks would lose a recording.
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1"], startedAt: T0 + DAY },
    ]);
    const out = walkAnalysis(input(f));
    expect(out.walks.map((w) => w.sessionId)).toEqual(["s1", "s2"]);
  });

  it("orders oldest first", () => {
    const f = fixture(1, [
      { sessionId: "late", edgeIds: ["e0"], startedAt: T0 + DAY },
      { sessionId: "early", edgeIds: ["e0"], startedAt: T0 },
    ]);
    expect(walkAnalysis(input(f)).walks.map((w) => w.sessionId)).toEqual(["early", "late"]);
  });

  it("names a skipped step against the baseline, with the label the record prints", () => {
    const f = fixture(3, [
      { sessionId: "s1", edgeIds: ["e0", "e1", "e2"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1", "e2"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0", "e2"], startedAt: T0 + 2 * DAY },
    ]);
    const out = walkAnalysis(input(f));
    const odd = out.walks.find((w) => w.sessionId === "s3");
    expect(odd?.deviations).toEqual([
      { kind: "skipped", stepIndex: 1, edgeId: "e1", label: "Place 1 → Place 2" },
    ]);
    expect(odd?.reachedEnd).toBe(true);
  });

  it("gives the baseline's own recordings no deviations", () => {
    const f = fixture(3, [
      { sessionId: "s1", edgeIds: ["e0", "e1", "e2"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1", "e2"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0", "e2"], startedAt: T0 + 2 * DAY },
    ]);
    const out = walkAnalysis(input(f));
    expect(out.walks.filter((w) => w.deviations.length === 0).map((w) => w.sessionId)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("labels an edge missing from the graph rather than dropping the deviation", () => {
    // `FlowStep.missing` exists because a step that vanished makes a flow read
    // as shorter than it was. The same holds for a deviation.
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1"], startedAt: T0 + DAY },
    ]);
    f.route.walks.push(routeWalk("s3", ["e0", "gone"]));
    f.route.sessionIds.push("s3");
    const out = walkAnalysis(input(f));
    const odd = out.walks.find((w) => w.sessionId === "s3");
    expect(odd?.deviations).toContainEqual({
      kind: "inserted",
      stepIndex: 1,
      edgeId: "gone",
      label: "edge gone is not in the graph",
    });
  });

  it("carries a null wall clock rather than inventing one", () => {
    const f = fixture(1, [{ sessionId: "s1", edgeIds: ["e0"], startedAt: T0 }]);
    f.route.walks.push(routeWalk("ghost", ["e0"]));
    f.route.sessionIds.push("ghost");
    const out = walkAnalysis(input(f));
    expect(out.walks.find((w) => w.sessionId === "ghost")?.at).toBeNull();
  });

  it("sorts undated walks LAST, so an unknown date never reads as the oldest", () => {
    const f = fixture(1, [{ sessionId: "s1", edgeIds: ["e0"], startedAt: T0 }]);
    f.route.walks.unshift(routeWalk("ghost", ["e0"]));
    f.route.sessionIds.unshift("ghost");
    expect(walkAnalysis(input(f)).walks.map((w) => w.sessionId)).toEqual(["s1", "ghost"]);
  });

  it("calls no walk deviant under `none`", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0"], startedAt: T0 + DAY },
    ]);
    const out = walkAnalysis(input(f, "none"));
    expect(out.walks).toHaveLength(2);
    expect(out.walks.every((w) => w.deviations.length === 0)).toBe(true);
    expect(out.walks.every((w) => w.reachedEnd)).toBe(true);
  });
});

describe("walkAnalysis — steps", () => {
  it("measures a step by its OWN span, not by the gap to the next edge", () => {
    // `EdgeSourceDTO` carries atSec AND throughSec per recording, so a step's
    // extent is its own. Differencing consecutive atSec would fold the idle
    // time before the next step into this one's cost and hide the hesitation.
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0, secPerStep: 5 },
    ]);
    const out = walkAnalysis(input(f));
    // sources are atSec = i*5, throughSec = i*5 + 1 -> every step lasts 1s
    expect(out.steps.map((s) => s.durations)).toEqual([
      [{ sessionId: "s1", ms: 1000 }],
      [{ sessionId: "s1", ms: 1000 }],
    ]);
  });

  it("reports the idle between steps separately", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0, secPerStep: 5 },
    ]);
    const out = walkAnalysis(input(f));
    // e0 ends at 1s, e1 begins at 5s -> 4s of hesitation
    expect(out.steps[0]?.gapsAfter).toEqual([{ sessionId: "s1", ms: 4000 }]);
    expect(out.steps[1]?.gapsAfter).toEqual([]);
  });

  it("omits a recording that did not walk the step, rather than recording a zero", () => {
    const f = fixture(3, [
      { sessionId: "s1", edgeIds: ["e0", "e1", "e2"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0", "e1", "e2"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0", "e2"], startedAt: T0 + 2 * DAY },
    ]);
    const out = walkAnalysis(input(f));
    expect(out.steps[1]?.durations.map((d) => d.sessionId)).toEqual(["s1", "s2"]);
  });

  it("indexes and identifies each step against the baseline Way", () => {
    const f = fixture(2, [
      { sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 },
    ]);
    const out = walkAnalysis(input(f));
    expect(out.steps.map((s) => [s.stepIndex, s.edgeId])).toEqual([
      [0, "e0"],
      [1, "e1"],
    ]);
  });

  it("has no steps under `none`, because there is no baseline to have them", () => {
    const f = fixture(2, [{ sessionId: "s1", edgeIds: ["e0", "e1"], startedAt: T0 }]);
    expect(walkAnalysis(input(f, "none")).steps).toEqual([]);
  });

  it("orders durations oldest recording first, matching `walks`", () => {
    const f = fixture(1, [
      { sessionId: "late", edgeIds: ["e0"], startedAt: T0 + DAY },
      { sessionId: "early", edgeIds: ["e0"], startedAt: T0 },
    ]);
    expect(walkAnalysis(input(f)).steps[0]?.durations.map((d) => d.sessionId)).toEqual([
      "early",
      "late",
    ]);
  });
});

describe("walkAnalysis — rhythm", () => {
  it("reports the gaps between consecutive walks, oldest first", () => {
    const f = fixture(1, [
      { sessionId: "s1", edgeIds: ["e0"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0"], startedAt: T0 + 4 * DAY },
    ]);
    expect(walkAnalysis(input(f)).rhythm.intervalsMs).toEqual([DAY, 3 * DAY]);
  });

  it("has no intervals below two dated walks", () => {
    const f = fixture(1, [{ sessionId: "s1", edgeIds: ["e0"], startedAt: T0 }]);
    expect(walkAnalysis(input(f)).rhythm.intervalsMs).toEqual([]);
  });

  it("reports each walk's local hour and day", () => {
    const f = fixture(1, [
      { sessionId: "s1", edgeIds: ["e0"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0"], startedAt: T0 + DAY },
    ]);
    const { hours, days } = walkAnalysis(input(f)).rhythm;
    expect(hours).toHaveLength(2);
    expect(days).toHaveLength(2);
    // Local, deliberately: the question is when in this person's day it
    // happened. Asserted against Date rather than a constant so the suite is
    // not pinned to the machine's zone.
    expect(hours[0]).toBe(new Date(T0).getHours());
    expect(days[0]).toBe(new Date(T0).getDay());
    // Consecutive days differ by one, whatever the zone.
    expect((days[0]! + 1) % 7).toBe(days[1]);
  });

  it("excludes an undated walk from every rhythm reading", () => {
    // An interval computed across a gap of unknown length is not a long gap,
    // it is no measurement at all.
    const f = fixture(1, [
      { sessionId: "s1", edgeIds: ["e0"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0"], startedAt: T0 + DAY },
    ]);
    f.route.walks.push(routeWalk("ghost", ["e0"]));
    f.route.sessionIds.push("ghost");
    const r = walkAnalysis(input(f)).rhythm;
    expect(r.intervalsMs).toEqual([DAY]);
    expect(r.hours).toHaveLength(2);
    expect(r.days).toHaveLength(2);
  });
});

describe("walkAnalysis — antecedents", () => {
  const f3 = () =>
    fixture(1, [
      { sessionId: "s1", edgeIds: ["e0"], startedAt: T0 },
      { sessionId: "s2", edgeIds: ["e0"], startedAt: T0 + DAY },
      { sessionId: "s3", edgeIds: ["e0"], startedAt: T0 + 2 * DAY },
    ]);

  it("is empty with no hook — never a guess", () => {
    expect(walkAnalysis(input(f3())).antecedents).toEqual([]);
  });

  it("counts agreement across walks and carries the denominator", () => {
    const out = walkAnalysis(input(f3()), {
      antecedentAt: (sessionId) =>
        sessionId === "s3" ? { what: "Mail", kind: "app" } : { what: "Slack", kind: "app" },
    });
    expect(out.antecedents).toEqual([
      { what: "Slack", kind: "app", observations: 2, of: 3 },
      { what: "Mail", kind: "app", observations: 1, of: 3 },
    ]);
  });

  it("counts a walk that returned null in the denominator, not out of it", () => {
    // Two of three walks showed Slack is a different claim from two of two.
    // Dropping the silent walk would report unanimity that was not observed.
    const out = walkAnalysis(input(f3()), {
      antecedentAt: (sessionId) => (sessionId === "s1" ? null : { what: "Slack", kind: "app" }),
    });
    expect(out.antecedents).toEqual([{ what: "Slack", kind: "app", observations: 2, of: 3 }]);
  });

  it("keeps the same text under two kinds apart", () => {
    const out = walkAnalysis(input(f3()), {
      antecedentAt: (sessionId) =>
        sessionId === "s1"
          ? { what: "Slack", kind: "app" }
          : { what: "Slack", kind: "place" },
    });
    expect(out.antecedents).toEqual([
      { what: "Slack", kind: "place", observations: 2, of: 3 },
      { what: "Slack", kind: "app", observations: 1, of: 3 },
    ]);
  });

  it("is asked at the moment THIS recording walked the route", () => {
    const f = f3();
    f.route.walks[1] = { sessionId: "s2", edgeIds: ["e0"], atSec: 42, throughSec: 50 };
    const asked: { sessionId: string; atSec: number }[] = [];
    walkAnalysis(input(f), {
      antecedentAt: (sessionId, atSec) => {
        asked.push({ sessionId, atSec });
        return null;
      },
    });
    expect(asked).toContainEqual({ sessionId: "s2", atSec: 42 });
  });

  it("orders most-observed first, ties broken on the text so the order is stable", () => {
    const out = walkAnalysis(input(f3()), {
      antecedentAt: (sessionId) =>
        sessionId === "s1"
          ? { what: "Zed", kind: "app" }
          : sessionId === "s2"
            ? { what: "Ada", kind: "app" }
            : { what: "Mail", kind: "app" },
    });
    expect(out.antecedents.map((a) => a.what)).toEqual(["Ada", "Mail", "Zed"]);
  });
});
