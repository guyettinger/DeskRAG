import { describe, expect, it } from "vitest";
import { labelNode, rankNodes, toGraphDTO, toPlanDTO } from "../app/src/main/plan-view.js";
import type { Graph, Predicate, TraceEdge, TraceNode } from "../src/trace/types.js";
import type { Anchor, Plan } from "../src/replay/types.js";

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

const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  point: { x: 10, y: 20, displayId: "d0" },
  ...over,
});

describe("toPlanDTO", () => {
  const g = graph(
    [node("n0", [app("TextEdit")]), node("n1", [app("Notes")])],
    [edge("e0", "n0", "n1")],
  );

  const base: Plan = {
    id: "p1",
    graphId: "default",
    from: "n0",
    to: "n1",
    steps: [],
    blockers: [],
    brittleness: [],
    remainder: [],
  };

  it("puts the handoff first, before any recorded action", () => {
    const plan: Plan = {
      ...base,
      steps: [
        {
          edgeId: "e0",
          action: { kind: "click", anchor: anchor(), button: 0, count: 1 },
          resolution: { layer: "identifier", point: { x: 1, y: 2 }, confidence: 1, attempts: [] },
        },
      ],
    };
    const dto = toPlanDTO(plan, g, 1, "TextEdit");
    expect(dto.steps[0]).toEqual({ kind: "handoff", app: "TextEdit" });
    expect(dto.steps[1]).toMatchObject({ kind: "action", layer: "identifier", confidence: 1 });
  });

  it("omits the handoff when there is no app to name", () => {
    expect(toPlanDTO(base, g, 1).steps).toEqual([]);
  });

  it("describes a target from the RECORDED descriptors, not the resolution", () => {
    const plan: Plan = {
      ...base,
      steps: [
        {
          edgeId: "e0",
          action: {
            kind: "click",
            anchor: anchor({
              ax: {
                role: "Button",
                label: "Save",
                identifier: "save-btn",
                path: "Window[0]>Button[1]",
              },
            }),
            button: 0,
            count: 1,
          },
          resolution: { layer: "point", point: { x: 9, y: 9 }, confidence: 0.3, attempts: [] },
        },
      ],
    };
    const step = toPlanDTO(plan, g, 1).steps[0];
    expect(step).toMatchObject({ kind: "action", target: 'Button "Save" #save-btn' });
  });

  it("keeps superseded steps visible, with their reason", () => {
    const plan: Plan = {
      ...base,
      steps: [
        {
          superseded: "activate",
          edgeId: "e0",
          action: { kind: "click", anchor: anchor(), button: 0, count: 1 },
          reason: "the repair activates Notes directly",
        },
      ],
    };
    expect(toPlanDTO(plan, g, 1).steps[0]).toEqual({
      kind: "superseded",
      edgeId: "e0",
      action: "click",
      reason: "the repair activates Notes directly",
    });
  });

  it("carries blockers, the cut and the remainder through intact", () => {
    const plan: Plan = {
      ...base,
      blockers: [{ reason: "no keymap", scope: "segment" }],
      brittleness: [{ edgeId: "e0", axRate: 0.25, belowFloor: true, bound: "measured" }],
      cut: {
        resumeAt: "n1",
        edgeId: "e1",
        attempts: [{ layer: "identifier", rejected: "not found" }],
      },
      remainder: [
        {
          edgeId: "e1",
          toNodeId: "n2",
          actions: [{ kind: "click", descriptors: ["label"], recordedPoint: { x: 5, y: 6 } }],
          repairs: [
            { repair: "activate", edgeId: "e1", app: "Notes", launch: false, reason: "app" },
          ],
        },
      ],
    };
    const dto = toPlanDTO(plan, g, 2);
    expect(dto.blockers).toEqual([{ reason: "no keymap", scope: "segment" }]);
    expect(dto.brittleness[0]?.belowFloor).toBe(true);
    expect(dto.cut?.attempts).toEqual([{ layer: "identifier", rejected: "not found" }]);
    expect(dto.remainder[0]?.actions[0]?.recordedPoint).toEqual({ x: 5, y: 6 });
    expect(dto.remainder[0]?.repairs).toEqual([{ app: "Notes", launch: false }]);
    expect(dto.segment).toBe(2);
    expect(dto.fromLabel).toBe("TextEdit");
  });
});
