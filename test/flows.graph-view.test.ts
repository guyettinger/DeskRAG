import { describe, expect, it } from "vitest";
import {
  chipIds,
  frequentRoutes,
  labelNode,
  rankNodes,
  toGraphDTO,
} from "../app/src/main/graph-view.js";
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

  it("strips the session ULID, which real ids all carry", () => {
    // Measured on the real graph: every id is `<26-char ULID>:nN`, 30 chars,
    // rendered in a 180px card. `n0` there carries no predicates at all.
    expect(labelNode(node("01KYX6DDK2PFXFDAX0XB3PH1DM:n0")).label).toBe("n0 — no state");
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

describe("chipIds", () => {
  it("uses the bare suffix when it is unambiguous", () => {
    expect([...chipIds(["01AAAAAAAAAAAAAAAAAAAAAAAA:n0", "01AAAAAAAAAAAAAAAAAAAAAAAA:n1"])]).toEqual([
      ["01AAAAAAAAAAAAAAAAAAAAAAAA:n0", "n0"],
      ["01AAAAAAAAAAAAAAAAAAAAAAAA:n1", "n1"],
    ]);
  });

  it("widens both sides of a cross-session collision", () => {
    // Exactly what a second recording produces: the real graph showed three
    // "TextEdit" cards chipped n2, n2, n3.
    const chips = chipIds(["01AAAAAAAAAAAAAAAAAAAABBBB:n2", "01AAAAAAAAAAAAAAAAAAAACCCC:n2"]);
    expect(chips.get("01AAAAAAAAAAAAAAAAAAAABBBB:n2")).toBe("BBBB:n2");
    expect(chips.get("01AAAAAAAAAAAAAAAAAAAACCCC:n2")).toBe("CCCC:n2");
  });

  it("leaves an id with no session prefix alone", () => {
    expect(chipIds(["n0"]).get("n0")).toBe("n0");
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
      visual: { frameBlobId: "frame-1", phash: "ff" },
    };
    const g = graph([node("n0"), withFrame], [edge("e0", "n0", "n1"), edge("e1", "n1", "n0")]);
    // `visual.frameBlobId` holds a FRAME id despite the name, so the blob is
    // resolved through the injected callback.
    const dto = toGraphDTO(g, {
      resolveFrameBlob: (frameId) => (frameId === "frame-1" ? "blob-1" : undefined),
    });
    expect(dto.edges.map((e) => e.back)).toEqual([false, true]);
    expect(dto.nodes[1]?.frameBlobId).toBe("blob-1");
    expect(dto.nodes[1]?.rank).toBe(1);
  });

  it("omits the image when the frame has no blob, rather than breaking one", () => {
    const withFrame: TraceNode = {
      ...node("n1", [app("TextEdit")]),
      visual: { frameBlobId: "frame-gone", phash: "ff" },
    };
    const g = graph([node("n0"), withFrame], [edge("e0", "n0", "n1")]);
    expect(toGraphDTO(g, { resolveFrameBlob: () => undefined }).nodes[1]?.frameBlobId).toBeUndefined();
    // No resolver at all behaves the same way.
    expect(toGraphDTO(g).nodes[1]?.frameBlobId).toBeUndefined();
  });
});

describe("labelNode with web scope", () => {
  const url = (prefix: string): Predicate => ({
    kind: "url",
    args: { prefix },
    reach: "assertable",
  });

  it("names the site, which is what distinguishes two browser nodes", () => {
    const a = node("n3", [app("Google Chrome"), url("github.com/o/r/pull")]);
    const b = node("n4", [app("Google Chrome"), url("github.com/o/r/issues")]);
    expect(labelNode(a).label).toBe("Google Chrome — github.com/o/r/pull");
    expect(labelNode(a).label).not.toBe(labelNode(b).label);
  });

  it("still prefers a sheet, which names a state outright", () => {
    const n = node("n5", [
      app("Google Chrome"),
      url("github.com/o/r"),
      exists("Sheet", "Save"),
    ]);
    expect(labelNode(n).hint).toBe("Save");
  });

  it("beats a focused element, which is only where the caret was", () => {
    const n = node("n6", [app("Google Chrome"), url("github.com/o/r"), focused("TextField", "Search")]);
    expect(labelNode(n).hint).toBe("github.com/o/r");
  });
});

describe("toGraphDTO identity fields", () => {
  it("renders every predicate as human-readable text", () => {
    const n = node("n1", [app("TextEdit"), exists("TextArea", "Body")]);
    const dto = toGraphDTO(graph([n], [], "n1"));
    expect(dto.nodes[0]!.predicates).toEqual([
      "app(app=TextEdit)",
      "ax_exists(role=TextArea, label=Body)",
    ]);
  });

  it("marks an app-only node unlocatable — `app` cannot say WHICH state", () => {
    const bare = node("n1", [app("TextEdit")]);
    const rich = node("n2", [app("TextEdit"), focused("TextArea", "Body")]);
    const dto = toGraphDTO(graph([bare, rich], [edge("e1", "n1", "n2")], "n1"));
    expect(dto.nodes[0]!.locatable).toBe(false);
    expect(dto.nodes[1]!.locatable).toBe(true);
  });

  it("gives a predicate-less node an empty list, not undefined", () => {
    const dto = toGraphDTO(graph([node("n1")], [], "n1"));
    expect(dto.nodes[0]!.predicates).toEqual([]);
    expect(dto.nodes[0]!.locatable).toBe(false);
  });
});

// --- provenance and flows ---------------------------------------------------

const sourcedNode = (
  id: string,
  predicates: Predicate[],
  sources: NonNullable<TraceNode["sources"]>,
): TraceNode => ({ ...node(id, predicates), sources });

const sourcedEdge = (
  id: string,
  from: string,
  to: string,
  sources: NonNullable<TraceEdge["sources"]>,
): TraceEdge => ({ ...edge(id, from, to), sources });

/** Every session started at the same instant unless a test says otherwise. */
const startedAt = (): number => 1_700_000_000_000;

describe("toGraphDTO provenance", () => {
  it("converts a source's t_mono to LANE seconds, keeping the session's start", () => {
    const g = graph(
      [sourcedNode("n0", [app("Mail")], [{ sessionId: "s1", tMono: 4500 }]), node("n1")],
      [edge("e0", "n0", "n1")],
    );
    const dto = toGraphDTO(g, { sessionStart: startedAt });
    expect(dto.nodes[0]?.sources).toEqual([
      { sessionId: "s1", startedAt: 1_700_000_000_000, atSec: 4.5 },
    ]);
  });

  it("carries an edge's whole span, so a reader lands on the actions", () => {
    const g = graph(
      [node("n0"), node("n1")],
      [sourcedEdge("e0", "n0", "n1", [{ sessionId: "s1", tMonoStart: 1000, tMonoEnd: 6250 }])],
    );
    const dto = toGraphDTO(g, { sessionStart: startedAt });
    expect(dto.edges[0]?.sources).toEqual([
      { sessionId: "s1", startedAt: 1_700_000_000_000, atSec: 1, throughSec: 6.25 },
    ]);
  });

  /**
   * A source naming a recording the store no longer has is DROPPED, not shown
   * with a fabricated time: the row survives the cascade only in a graph held
   * in memory, and a link that goes nowhere is worse than an absent one.
   */
  it("drops a source whose recording is unknown", () => {
    const g = graph(
      [
        sourcedNode(
          "n0",
          [app("Mail")],
          [
            { sessionId: "s1", tMono: 100 },
            { sessionId: "gone", tMono: 200 },
          ],
        ),
      ],
      [],
    );
    const dto = toGraphDTO(g, { sessionStart: (id) => (id === "s1" ? 42 : undefined) });
    expect(dto.nodes[0]?.sources).toEqual([{ sessionId: "s1", startedAt: 42, atSec: 0.1 }]);
  });

  it("gives an unprovenanced graph empty source lists, never undefined", () => {
    const dto = toGraphDTO(graph([node("n0")], []), { sessionStart: startedAt });
    expect(dto.nodes[0]?.sources).toEqual([]);
  });

  it("describes an edge's actions in words, with the slot's samples", () => {
    const g: Graph = {
      ...graph([node("n0"), node("n1")], []),
      edges: [
        {
          ...edge("e0", "n0", "n1"),
          actions: [
            {
              kind: "click",
              anchor: { point: { x: 5, y: 6, displayId: "d0" }, ax: { role: "Button", label: "Send", path: "W>B" } },
              button: 1,
              count: 2,
            },
            { kind: "type", slot: "recipient", recorded: "alice@example.com" },
          ],
        },
      ],
      slots: [{ name: "recipient", samples: ["alice@example.com", "bob@example.com"], secret: false }],
    };
    const dto = toGraphDTO(g);
    expect(dto.edges[0]?.actions).toEqual([
      { action: "2× click", target: 'Button "Send"' },
      {
        action: "type",
        target: "slot recipient",
        slot: { name: "recipient", samples: ["alice@example.com", "bob@example.com"] },
      },
    ]);
  });
});

/**
 * Routes are keyed by the STATES a recording passed through, named.
 *
 * The two stricter keys were both measured against a real 9-recording graph and
 * both produced nine routes of ×1 — see `frequentRoutes`. These cases pin the
 * behaviour that measurement forced, in both directions: it must still group
 * recordings that differ only in incidental steps, and must still refuse to
 * invent a path nobody walked.
 */
describe("frequentRoutes", () => {
  /** n0 -> n1 -> n2, walked by whichever sessions the caller names. */
  const chain = (walks: Record<string, string[]>): Graph => {
    const sourcesFor = (edgeId: string): NonNullable<TraceEdge["sources"]> =>
      Object.entries(walks)
        .filter(([, edgeIds]) => edgeIds.includes(edgeId))
        .map(([sessionId, edgeIds]) => ({
          sessionId,
          tMonoStart: edgeIds.indexOf(edgeId) * 1000,
          tMonoEnd: edgeIds.indexOf(edgeId) * 1000 + 900,
        }));
    return graph(
      [
        node("n0", [app("TextEdit")]),
        node("n1", [app("Google Chrome")]),
        node("n2", [app("Finder")]),
      ],
      [
        sourcedEdge("e0", "n0", "n1", sourcesFor("e0")),
        sourcedEdge("e1", "n1", "n2", sourcesFor("e1")),
      ],
    );
  };

  it("collapses two recordings of one task into a single route", () => {
    const routes = frequentRoutes(chain({ s1: ["e0", "e1"], s2: ["e0", "e1"] }));
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      count: 2,
      edgeIds: ["e0", "e1"],
      nodeIds: ["n0", "n1", "n2"],
      sessionIds: ["s1", "s2"],
    });
  });

  it("keeps a recording that visited different states separate", () => {
    const routes = frequentRoutes(chain({ s1: ["e0", "e1"], s2: ["e0", "e1"], s3: ["e0"] }));
    expect(routes.map((r) => [r.count, r.label])).toEqual([
      [2, "TextEdit → Google Chrome → Finder"],
      [1, "TextEdit → Google Chrome"],
    ]);
  });

  /**
   * THE CASE REAL DATA FORCED. Five recordings of "open Calculator and come
   * back" differed only in how many buttons were pressed, so their edge
   * sequences ran 4 to 8 steps and an edge-keyed route split all five apart.
   * Equivalent states across recordings do not merge into one node either —
   * identity is task-derived — so node ids cannot express "the same place".
   */
  it("groups recordings that reached the same states by different paths", () => {
    const g = graph(
      [
        node("n0", [app("DeskRAG")]),
        // Two DIFFERENT nodes for the same place: this is what a real graph
        // holds, because their outgoing edges target different buttons.
        node("nA", [app("Calculator")]),
        node("nB", [app("Calculator")]),
        node("nZ", [app("DeskRAG")]),
      ],
      [
        sourcedEdge("short0", "n0", "nA", [{ sessionId: "s1", tMonoStart: 0, tMonoEnd: 100 }]),
        sourcedEdge("short1", "nA", "nZ", [{ sessionId: "s1", tMonoStart: 100, tMonoEnd: 200 }]),
        sourcedEdge("long0", "n0", "nB", [{ sessionId: "s2", tMonoStart: 0, tMonoEnd: 100 }]),
        // The extra button press s1 never made.
        sourcedEdge("long1", "nB", "nB", [{ sessionId: "s2", tMonoStart: 100, tMonoEnd: 200 }]),
        sourcedEdge("long2", "nB", "nZ", [{ sessionId: "s2", tMonoStart: 200, tMonoEnd: 300 }]),
      ],
    );
    const routes = frequentRoutes(g);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.count).toBe(2);
    expect(routes[0]?.label).toBe("DeskRAG → Calculator → DeskRAG");
    // The highlight is the UNION: these recordings share a shape, not a path.
    expect(routes[0]?.edgeIds).toEqual(["short0", "short1", "long0", "long1", "long2"]);
    expect(routes[0]?.nodeIds).toEqual(["n0", "nA", "nZ", "nB"]);
  });

  /**
   * The whole reason routes are not a traversal. A graph with no provenance
   * cannot say what was walked, so it says nothing — the screen then points at
   * the rebuild instead of showing invented paths.
   */
  it("yields NO routes for a graph with no provenance", () => {
    const g = graph([node("n0"), node("n1")], [edge("e0", "n0", "n1")]);
    expect(frequentRoutes(g)).toEqual([]);
  });

  it("names the route by the states it passes through", () => {
    const routes = frequentRoutes(chain({ s1: ["e0", "e1"] }));
    expect(routes[0]?.label).toBe("TextEdit → Google Chrome → Finder");
  });

  /** Six states in one app is one hop: the label answers "where does this go". */
  it("collapses consecutive states in the same application", () => {
    const g = graph(
      [node("n0", [app("TextEdit")]), node("n1", [app("TextEdit")]), node("n2", [app("Finder")])],
      [
        sourcedEdge("e0", "n0", "n1", [{ sessionId: "s1", tMonoStart: 0, tMonoEnd: 500 }]),
        sourcedEdge("e1", "n1", "n2", [{ sessionId: "s1", tMonoStart: 500, tMonoEnd: 900 }]),
      ],
    );
    expect(frequentRoutes(g)[0]?.label).toBe("TextEdit → Finder");
  });

  /**
   * A predicate-less node is vacuously true of every desktop, so it names no
   * place. Every real recording starts at one — leaving it in put a meaningless
   * "n0 — no state" at the head of all nine measured routes.
   */
  it("skips a state that describes nothing", () => {
    const g = graph(
      [node("n0"), node("n1", [app("Finder")])],
      [sourcedEdge("e0", "n0", "n1", [{ sessionId: "s1", tMonoStart: 0, tMonoEnd: 100 }])],
    );
    expect(frequentRoutes(g)[0]?.label).toBe("Finder");
  });

  /**
   * A merged graph revisits states, so one session can walk an edge twice. The
   * order has to come from WHEN it was walked — the graph's own edge order
   * would put the second traversal in the wrong place.
   */
  it("orders a session's edges by when it walked them, not by graph order", () => {
    const g = graph(
      [node("n0", [app("Mail")]), node("n1", [app("Notes")])],
      [
        sourcedEdge("e0", "n0", "n1", [{ sessionId: "s1", tMonoStart: 2000, tMonoEnd: 2500 }]),
        sourcedEdge("e1", "n1", "n0", [{ sessionId: "s1", tMonoStart: 500, tMonoEnd: 900 }]),
      ],
    );
    expect(frequentRoutes(g)[0]?.edgeIds).toEqual(["e1", "e0"]);
    // Notes -> Mail -> Notes: it went back. Reading the graph's edge order
    // instead would have produced "Mail → Notes → Mail", which is the reverse
    // of what was recorded.
    expect(frequentRoutes(g)[0]?.label).toBe("Notes → Mail → Notes");
  });

  it("is stable across calls, so the list does not reshuffle on a reload", () => {
    const g = chain({ s1: ["e0", "e1"], s2: ["e0"], s3: ["e0", "e1"] });
    expect(frequentRoutes(g).map((r) => r.id)).toEqual(frequentRoutes(g).map((r) => r.id));
  });
});
