import { describe, expect, it } from "vitest";
import { locateNode } from "../src/replay/locate.js";
import type { Predicate } from "../src/replay/types.js";
import type { TraceNode } from "../src/trace/types.js";

const app = (name: string): Predicate => ({
  kind: "app",
  args: { app: name },
  reach: "achievable",
});
const exists = (role: string, label: string): Predicate => ({
  kind: "ax_exists",
  args: { role, label },
  reach: "achievable",
});

const node = (id: string, predicates: Predicate[]): TraceNode => ({
  id,
  predicates,
  intervene: "select",
  observations: 1,
});

describe("locateNode", () => {
  it("locates the node whose every predicate holds", () => {
    const nodes = [node("n1", [app("TextEdit"), exists("Button", "Save")])];
    const r = locateNode([app("TextEdit"), exists("Button", "Save")], nodes);
    expect(r.nodeId).toBe("n1");
    expect(r.candidates).toBe(1);
    expect(r.ambiguous).toBe(false);
  });

  /**
   * Verification is SUBSET, so extra observed predicates are not violations.
   * That is what lets a node match a screen which gained something since it was
   * recorded — the common case, given how aggressive the stability filter is.
   */
  it("tolerates observed predicates the node never claimed", () => {
    const nodes = [node("n1", [app("TextEdit")])];
    const r = locateNode([app("TextEdit"), exists("Button", "New")], nodes);
    expect(r.nodeId).toBe("n1");
  });

  /**
   * Subset matching is MONOTONE: a node carrying only `app` is satisfied by
   * every observation in that app. So the most specific description that still
   * holds wins, or a two-predicate node would beat a twenty-predicate one.
   */
  it("prefers the most specific candidate over one that is a strict subset", () => {
    const nodes = [
      node("broad", [app("TextEdit")]),
      node("specific", [app("TextEdit"), exists("Button", "Save"), exists("Button", "New")]),
    ];
    const r = locateNode(
      [app("TextEdit"), exists("Button", "Save"), exists("Button", "New")],
      nodes,
    );
    expect(r.nodeId).toBe("specific");
    expect(r.candidates).toBe(2);
  });

  /**
   * A redundant node is visible and fixable; a wrong match sends replay down
   * another context's branch. Ambiguity never guesses.
   */
  it("declines when two candidates are equally specific", () => {
    const nodes = [
      node("a", [app("TextEdit"), exists("Button", "Save")]),
      node("b", [app("TextEdit"), exists("Button", "New")]),
    ];
    const r = locateNode(
      [app("TextEdit"), exists("Button", "Save"), exists("Button", "New")],
      nodes,
    );
    expect(r.nodeId).toBeUndefined();
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toBe(2);
  });

  it("reports nothing found rather than throwing", () => {
    const r = locateNode([app("WebStorm")], [node("n1", [app("TextEdit")])]);
    expect(r.nodeId).toBeUndefined();
    expect(r.candidates).toBe(0);
    expect(r.ambiguous).toBe(false);
  });

  /**
   * Not a hypothetical: `n0` in the recorded graph carries no predicates. An
   * empty set is vacuously a subset of EVERY observation, so it would verify
   * against any desktop at all. Ranking it last is not enough — it would still
   * be returned when it is the only candidate.
   */
  it("never returns a zero-predicate node, even as the only candidate", () => {
    const r = locateNode([app("TextEdit")], [node("n0", [])]);
    expect(r.nodeId).toBeUndefined();
    expect(r.candidates).toBe(0);
  });
});
