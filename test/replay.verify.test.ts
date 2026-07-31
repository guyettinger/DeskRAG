import { describe, expect, it } from "vitest";
import { blockersOf, repairableOf, verifyNode } from "../src/replay/verify.js";
import type { Predicate } from "../src/trace/types.js";

const p = (
  kind: Predicate["kind"],
  args: Predicate["args"],
  reach: Predicate["reach"],
): Predicate => ({ kind, args, reach });

const app = p("app", { app: "TextEdit" }, "achievable");
const sendBtn = p("ax_exists", { role: "Button", label: "Send" }, "achievable");
const display = p("display", { id: "5", w: 3840, h: 2160 }, "assertable");

describe("verifyNode", () => {
  it("is satisfied when every expected predicate holds", () => {
    const r = verifyNode([app, sendBtn], [app, sendBtn]);
    expect(r.satisfied).toBe(true);
    expect(r.violations).toEqual([]);
  });

  // This is the semantic that must differ from node identity: merging asks "is
  // this the same state?", verifying asks "is this state still true?".
  it("tolerates EXTRA observed predicates — a screen that gained something", () => {
    const extra = p("ax_exists", { role: "Button", label: "Archive" }, "achievable");
    const r = verifyNode([app, sendBtn], [app, sendBtn, extra]);
    expect(r.satisfied).toBe(true);
  });

  it("reports a missing predicate as a violation", () => {
    const r = verifyNode([app, sendBtn], [app]);
    expect(r.satisfied).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.predicate).toEqual(sendBtn);
  });

  it("carries the reach through, so callers can tell repair from refusal", () => {
    const r = verifyNode([sendBtn, display], []);
    expect(r.violations.map((v) => v.reach).sort()).toEqual(["achievable", "assertable"]);
  });

  it("treats an empty expectation as satisfied by anything", () => {
    expect(verifyNode([], []).satisfied).toBe(true);
    expect(verifyNode([], [app]).satisfied).toBe(true);
  });
});

describe("violation classification", () => {
  it("splits assertable blockers from achievable repairs", () => {
    const { violations } = verifyNode([sendBtn, display], []);
    expect(blockersOf(violations).map((v) => v.predicate.kind)).toEqual(["display"]);
    expect(repairableOf(violations).map((v) => v.predicate.kind)).toEqual(["ax_exists"]);
  });
});
