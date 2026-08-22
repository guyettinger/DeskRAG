import { describe, expect, it } from "vitest";
import type { FlowRouteDTO } from "@shared/types";
import { routeStepSummary, routeWayLengths } from "../app/src/renderer/src/routes-view.js";

const route = (walks: string[][], union: string[]): FlowRouteDTO => ({
  id: "r",
  count: walks.length,
  label: "A → B",
  name: null,
  nameObservations: 0,
  nodeIds: [],
  edgeIds: union,
  sessionIds: walks.map((_, i) => `s${i}`),
  walks: walks.map((edgeIds, i) => ({ sessionId: `s${i}`, edgeIds, atSec: 0, throughSec: 0 })),
  variants: [],
});

describe("routeStepSummary", () => {
  it("counts ONE way when every recording walked the same path", () => {
    const r = route([["e0", "e1"], ["e0", "e1"]], ["e0", "e1"]);
    expect(routeWayLengths(r)).toEqual([2]);
    expect(routeStepSummary(r)).toBe("2 steps");
  });

  it("singularises a one-step route", () => {
    expect(routeStepSummary(route([["e0"]], ["e0"]))).toBe("1 step");
  });

  /**
   * The defect. The union of two 2-edge walks sharing one edge is 3, and the
   * list said "3 steps" for a path neither recording took. Measured on the real
   * store at 8 and 8 against a union of 14.
   */
  it("never reports the UNION when the recordings took different paths", () => {
    const r = route([["e0", "e1"], ["e0", "e2"]], ["e0", "e1", "e2"]);
    expect(routeWayLengths(r)).toEqual([2, 2]);
    expect(routeStepSummary(r)).toBe("2 ways · 2/2 steps");
    expect(routeStepSummary(r)).not.toMatch(/3/);
  });

  it("orders ways longest first, so the list reads stably", () => {
    const r = route([["e0"], ["e0", "e1", "e2"]], ["e0", "e1", "e2"]);
    expect(routeWayLengths(r)).toEqual([3, 1]);
  });

  it("falls back to the union only when a route carries no walks", () => {
    const r = route([], ["e0", "e1"]);
    expect(routeStepSummary(r)).toBe("2 steps");
  });
});
