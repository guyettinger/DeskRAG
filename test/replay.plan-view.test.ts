import { describe, expect, it } from "vitest";
import { labelNode, rankNodes, toGraphDTO } from "../app/src/main/plan-view.js";
import type { Graph, Predicate, TraceEdge, TraceNode } from "../src/trace/types.js";

// Roles WITHOUT the "AX" prefix — the shape ax-dump actually emits
// (`rawRole.dropFirst(2)`). Matching the prefixed spelling is the bug that
// already shipped once in this repo and produced zero predicates from every
// real recording.
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
const focused = (role: string, label: string): Predicate => ({
  kind: "ax_focused",
  args: { role, label },
  reach: "achievable",
});

const node = (id: string, predicates: Predicate[] = []): TraceNode => ({
  id,
  predicates,
  intervene: "select",
  observations: 1,
});

const edge = (id: string, from: string, to: string): TraceEdge => ({
  id,
  from,
  to,
  actions: [],
  provenance: "recorded",
  observations: 1,
  outcomes: { attempts: 1, successes: 1 },
});

const graph = (nodes: TraceNode[], edges: TraceEdge[], entry = "n0"): Graph => ({
  id: "default",
  nodes,
  edges,
  slots: [],
  entry,
});

describe("labelNode", () => {
  it("names the app, and prefers a Sheet label as the hint", () => {
    const n = node("n1", [app("TextEdit"), exists("Button", "Cancel"), exists("Sheet", "Save")]);
    expect(labelNode(n)).toEqual({ label: "TextEdit — Save", app: "TextEdit", hint: "Save" });
  });

  it("falls back to the focused element when there is no sheet", () => {
    const n = node("n2", [app("TextEdit"), focused("TextArea", "Body")]);
    expect(labelNode(n)).toEqual({ label: "TextEdit — Body", app: "TextEdit", hint: "Body" });
  });

  it("normalizes a prefixed role, because a consumer must never assume", () => {
    const n = node("n3", [app("Chrome"), exists("AXDialog", "Open")]);
    expect(labelNode(n).hint).toBe("Open");
  });

  it("labels two same-app nodes identically rather than inventing a difference", () => {
    const a = node("n4", [app("TextEdit"), exists("Button", "Bold")]);
    const b = node("n5", [app("TextEdit"), exists("Button", "Italic")]);
    expect(labelNode(a).label).toBe("TextEdit");
    expect(labelNode(b).label).toBe(labelNode(a).label);
  });

  it("says a node with no predicates describes no state", () => {
    expect(labelNode(node("n0"))).toEqual({ label: "n0 — no state" });
  });

  it("never labels from a window title, which nodes do not carry", () => {
    // Defensive: PredicateKind lists "window" even though extractPredicates
    // never emits one. If that ever changes, it must not become a label.
    const n = node("n6", [
      app("TextEdit"),
      { kind: "window", args: { title: "report.rtf" }, reach: "achievable" },
    ]);
    expect(labelNode(n).label).toBe("TextEdit");
  });
});

describe("rankNodes", () => {
  it("ranks by BFS distance from the entry", () => {
    const g = graph(
      [node("n0"), node("n1"), node("n2")],
      [edge("e0", "n0", "n1"), edge("e1", "n1", "n2")],
    );
    expect([...rankNodes(g)]).toEqual([
      ["n0", 0],
      ["n1", 1],
      ["n2", 2],
    ]);
  });

  it("keeps the first-seen rank when a loop revisits a node", () => {
    const g = graph(
      [node("n0"), node("n1"), node("n2")],
      [edge("e0", "n0", "n1"), edge("e1", "n1", "n2"), edge("e2", "n2", "n1")],
    );
    expect(rankNodes(g).get("n1")).toBe(1);
  });

  it("ranks a node unreachable from the entry rather than dropping it", () => {
    const g = graph([node("n0"), node("n9")], []);
    expect(rankNodes(g).get("n9")).toBe(0);
  });
});

describe("toGraphDTO", () => {
  it("marks a back edge, and carries the keyframe id through", () => {
    const withFrame: TraceNode = {
      ...node("n1", [app("TextEdit")]),
      visual: { frameBlobId: "blob-1", phash: "ff" },
    };
    const g = graph([node("n0"), withFrame], [edge("e0", "n0", "n1"), edge("e1", "n1", "n0")]);
    const dto = toGraphDTO(g);
    expect(dto.edges.map((e) => e.back)).toEqual([false, true]);
    expect(dto.nodes[1]?.frameBlobId).toBe("blob-1");
    expect(dto.nodes[1]?.rank).toBe(1);
  });
});
