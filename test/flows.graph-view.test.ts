import { describe, expect, it } from "vitest";
import {
  chipIds,
  frequentRoutes,
  labelNode,
  rankNodes,
  toGraphDTO, nameRoute } from "../app/src/main/graph-view.js";
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

  it("ranks EVERY root's chain, not only the declared entry's", () => {
    // A graph accretes across sessions, and two recordings that opened in
    // different applications share no starting state — so an install has as many
    // roots as it has distinct openings. Walking from the entry alone left every
    // other chain flat at rank 0: measured on the real store, 15 of 22 nodes in
    // one row. It was masked until then by a stateless first node, which merged
    // every recording under one fake universal root.
    const g = graph(
      [node("n0"), node("n1"), node("m0"), node("m1"), node("m2")],
      [
        edge("e0", "n0", "n1"),
        edge("e1", "m0", "m1"),
        edge("e2", "m1", "m2"),
      ],
    );
    const ranks = rankNodes(g);
    expect(ranks.get("m0")).toBe(0);
    expect(ranks.get("m1")).toBe(1);
    expect(ranks.get("m2")).toBe(2);
    // and the entry's own chain is untouched
    expect(ranks.get("n0")).toBe(0);
    expect(ranks.get("n1")).toBe(1);
  });

  it("a node in a cycle that no root reaches still ranks rather than vanishing", () => {
    const g = graph(
      [node("n0"), node("c1"), node("c2")],
      [edge("e0", "c1", "c2"), edge("e1", "c2", "c1")],
    );
    const ranks = rankNodes(g);
    expect(ranks.get("c1")).toBe(0);
    expect(ranks.get("c2")).toBe(0);
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

  /**
   * `atSec` is LANE seconds — offsets from the VIDEO's first frame, which is
   * the axis the track rail is drawn in and the axis the Library seeks on.
   * This module used to send raw `tMono / 1000`, and since capture runs while
   * ffmpeg is still spawning (measured: 1.9s of pre-roll on a real session),
   * every jump from this screen landed that much early.
   */
  it("measures a source from the video's first frame, not from t_mono zero", () => {
    const g = graph(
      [sourcedNode("n0", [app("Mail")], [{ sessionId: "s1", tMono: 4500 }]), node("n1")],
      [sourcedEdge("e0", "n0", "n1", [{ sessionId: "s1", tMonoStart: 4500, tMonoEnd: 6250 }])],
    );
    const dto = toGraphDTO(g, { sessionStart: startedAt, laneOrigin: () => 1900 });
    expect(dto.nodes[0]?.sources[0]?.atSec).toBe(2.6);
    expect(dto.edges[0]?.sources[0]).toMatchObject({ atSec: 2.6, throughSec: 4.35 });
  });

  /**
   * Pre-roll is real: a boundary can be recorded BEFORE the first frame exists.
   * No pixel of the axis means "before zero", so the jump lands at the start.
   */
  it("clamps a source recorded before the video started", () => {
    const g = graph(
      [sourcedNode("n0", [app("Mail")], [{ sessionId: "s1", tMono: 300 }]), node("n1")],
      [edge("e0", "n0", "n1")],
    );
    const dto = toGraphDTO(g, { sessionStart: startedAt, laneOrigin: () => 1900 });
    expect(dto.nodes[0]?.sources[0]?.atSec).toBe(0);
  });

  /** No resolver is t_mono zero — what a session with no video already means. */
  it("falls back to t_mono zero when no lane origin is supplied", () => {
    const g = graph([sourcedNode("n0", [app("Mail")], [{ sessionId: "s1", tMono: 4500 }])], []);
    expect(toGraphDTO(g, { sessionStart: startedAt }).nodes[0]?.sources[0]?.atSec).toBe(4.5);
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

  /**
   * A recording that walks one edge TWICE.
   *
   * `walked` pushes one step per SOURCE, so an edge with two sources for one
   * session lands in that session's walk twice — which is correct, and which
   * the loop comment above `ordered` says outright. Measured on the real store:
   * 4 of 5 routes carried duplicate `nodeIds` (up to 8 of 14) and 2 of 5
   * carried duplicate `edgeIds`, always the same edge walked twice in a row.
   *
   * The two fields answer different questions and must diverge here.
   * `edgeIds`/`nodeIds` are the UNION — a SET, "what should light up" — and
   * `habit-doc.ts` prints `nodeIds.length` into a person's HABIT.md as "the N
   * states on this route", so a duplicate is a wrong number in their own file.
   * `walks` is "what did this recording DO", where the repeat is the fact.
   */
  it("de-duplicates the union of a looping walk, and keeps the loop in the walk", () => {
    const g = graph(
      [
        node("n0", [app("TextEdit")]),
        node("n1", [app("Google Chrome")]),
        node("n2", [app("Finder")]),
      ],
      [
        sourcedEdge("e0", "n0", "n1", [{ sessionId: "s1", tMonoStart: 0, tMonoEnd: 900 }]),
        // Walked at 1000 and again at 2000 — one edge, two crossings.
        sourcedEdge("e1", "n1", "n2", [
          { sessionId: "s1", tMonoStart: 1000, tMonoEnd: 1900 },
          { sessionId: "s1", tMonoStart: 2000, tMonoEnd: 2900 },
        ]),
      ],
    );
    const routes = frequentRoutes(g);
    expect(routes).toHaveLength(1);
    // The UNION is a set: each edge and each state once.
    expect(routes[0]!.edgeIds).toEqual(["e0", "e1"]);
    expect(routes[0]!.nodeIds).toEqual(["n0", "n1", "n2"]);
    // The WALK is a history: the second crossing is real and stays.
    expect(routes[0]!.walks?.[0]?.edgeIds).toEqual(["e0", "e1", "e1"]);
  });

  /** The same invariant when a SECOND recording seeds nothing new. */
  it("de-duplicates the union even when the FIRST recording is the looping one", () => {
    const g = graph(
      [node("n0", [app("TextEdit")]), node("n1", [app("Google Chrome")])],
      [
        sourcedEdge("e0", "n0", "n1", [
          { sessionId: "s1", tMonoStart: 0, tMonoEnd: 900 },
          { sessionId: "s1", tMonoStart: 1000, tMonoEnd: 1900 },
          { sessionId: "s2", tMonoStart: 0, tMonoEnd: 900 },
        ]),
      ],
    );
    const routes = frequentRoutes(g);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.count).toBe(2);
    expect(routes[0]!.edgeIds).toEqual(["e0"]);
    expect(routes[0]!.nodeIds).toEqual(["n0", "n1"]);
  });

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
   * THE ACCEPTANCE TEST FOR NEAR-MISS MINING, and the shape came off the real
   * corpus rather than out of the air (`npm run probe:routes`): the same task
   * recorded three times, once with a side trip through Finder, keyed as
   *
   *     ×2   … → Calculator → TextEdit → Electron
   *     ×1   … → Calculator → TextEdit → Finder → TextEdit → Electron
   *
   * — two routes, both of which read as barely-walked. A DETOUR COSTS TWO
   * INSERTIONS, because the walk comes back.
   */
  it("folds a DETOUR into the route it detoured from, and discloses it", () => {
    const g = graph(
      [
        node("n0", [app("TextEdit")]),
        node("n1", [app("Google Chrome")]),
        node("nD", [app("Finder")]),
        node("n1b", [app("Google Chrome")]),
      ],
      [
        sourcedEdge("a0", "n0", "n1", [{ sessionId: "s1", tMonoStart: 0, tMonoEnd: 100 }]),
        sourcedEdge("b0", "n0", "n1b", [{ sessionId: "s2", tMonoStart: 0, tMonoEnd: 100 }]),
        // s2 went to Finder and came BACK — two extra places, not one.
        sourcedEdge("b1", "n1b", "nD", [{ sessionId: "s2", tMonoStart: 100, tMonoEnd: 200 }]),
        sourcedEdge("b2", "nD", "n1", [{ sessionId: "s2", tMonoStart: 200, tMonoEnd: 300 }]),
      ],
    );
    const routes = frequentRoutes(g);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.count).toBe(2);
    // Named after the walk WITHOUT the detour: the detour is the variant.
    expect(routes[0]?.label).toBe("TextEdit → Google Chrome");
    expect(routes[0]?.variants).toEqual([
      {
        key: "TextEdit → Google Chrome → Finder → Google Chrome",
        label: "TextEdit → Google Chrome → Finder → Google Chrome",
        count: 1,
        extraHops: 2,
        sessionIds: ["s2"],
      },
    ]);
    // The union still lights up everywhere they went, detour included.
    expect(routes[0]?.edgeIds).toEqual(["a0", "b0", "b1", "b2"]);
  });

  it("never folds in a recording that merely STOPPED EARLY", () => {
    // A prefix is contained in the longer walk, but it did not take a side
    // trip — it did not finish. Two walks that end somewhere different did not
    // do the same work, and claiming otherwise inflates the recording count.
    const routes = frequentRoutes(chain({ s1: ["e0", "e1"], s2: ["e0", "e1"], s3: ["e0"] }));
    expect(routes.map((r) => [r.count, r.label])).toEqual([
      [2, "TextEdit → Google Chrome → Finder"],
      [1, "TextEdit → Google Chrome"],
    ]);
    expect(routes.every((r) => r.variants.length === 0)).toBe(true);
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

  /**
   * A WALK CARRIES THE MOMENT IT HAPPENED, ON THE LANE AXIS.
   *
   * This is what makes a habit's ledger followable: a mark is a recording, and
   * clicking it seeks the Library. The number has to be LANE seconds — offsets
   * from the video's first frame — because `tMono / 1000` is the same thing
   * only when capture began at t_mono zero, which it never does. That exact
   * mistake shipped once on this screen and landed every jump ~1.9s early.
   */
  it("puts a walk's span on the LANE axis, not on raw t_mono", () => {
    const g = chain({ s1: ["e0", "e1"] });
    // The video's first frame arrived 1.9s into the recording — the measured
    // pre-roll, and the whole reason this resolver exists.
    const routes = frequentRoutes(g, () => [], undefined, () => 1900);
    const walk = routes[0]!.walks[0]!;
    expect(walk.sessionId).toBe("s1");
    // e0 starts at t_mono 0 — BEFORE the video, so the axis floors at 0 rather
    // than reporting a negative second no pixel can mean.
    expect(walk.atSec).toBe(0);
    // e1 ends at t_mono 1900 exactly: lane zero.
    expect(walk.throughSec).toBe(0);
  });

  it("measures a walk from the video's first frame", () => {
    const g = chain({ s1: ["e0", "e1"] });
    const routes = frequentRoutes(g, () => [], undefined, () => 0);
    expect(routes[0]!.walks[0]).toMatchObject({ atSec: 0, throughSec: 1.9 });
    // With no resolver at all, origin 0 — where a session with no video starts.
    expect(frequentRoutes(g)[0]!.walks[0]).toMatchObject({ atSec: 0, throughSec: 1.9 });
  });

  it("gives every recording in a shared route its own moment", () => {
    const g = chain({ s1: ["e0", "e1"], s2: ["e0", "e1"] });
    const routes = frequentRoutes(g, () => [], undefined, (id) => (id === "s2" ? 1000 : 0));
    expect(routes).toHaveLength(1);
    expect(routes[0]!.walks.map((w) => [w.sessionId, w.throughSec])).toEqual([
      ["s1", 1.9],
      ["s2", 0.9],
    ]);
  });
});

/**
 * A route's NAME comes from what its recordings actually did; its KEY does not.
 * Summaries are nondeterministic, so keying on them would change a route's
 * identity on every re-index.
 */
describe("nameRoute", () => {
  const span = (sessionId: string, a: number, b: number) => ({
    sessionId,
    tMonoStart: a,
    tMonoEnd: b,
  });

  it("takes the LOWEST level that covers the majority of the route", () => {
    const covering = () => [
      { text: "filed the expense report", level: 1, coveredMs: 9000 },
      { text: "did admin", level: 2, coveredMs: 10000 },
    ];
    expect(nameRoute([span("s1", 0, 10000)], covering).name).toBe("filed the expense report");
  });

  it("rises a level when no lower node covers the majority", () => {
    const covering = () => [
      { text: "opened the form", level: 1, coveredMs: 3000 },
      { text: "did admin", level: 2, coveredMs: 9000 },
    ];
    expect(nameRoute([span("s1", 0, 10000)], covering).name).toBe("did admin");
  });

  it("returns null when nothing covers the majority — not one task", () => {
    const covering = () => [{ text: "a bit of this", level: 1, coveredMs: 1000 }];
    const out = nameRoute([span("s1", 0, 10000)], covering);
    expect(out.name).toBeNull();
    expect(out.observations).toBe(0);
  });

  it("reports how many recordings agreed, and never merges disagreeing names", () => {
    const covering = (s: { sessionId: string }) =>
      s.sessionId === "s3"
        ? [{ text: "something else", level: 1, coveredMs: 10000 }]
        : [{ text: "filed the expense report", level: 1, coveredMs: 10000 }];
    const out = nameRoute(
      [span("s1", 0, 10000), span("s2", 0, 10000), span("s3", 0, 10000)],
      covering,
    );
    expect(out.name).toBe("filed the expense report");
    expect(out.observations).toBe(2);
  });

  it("returns null for a route with no provenance at all", () => {
    expect(nameRoute([], () => []).name).toBeNull();
  });

  it("ignores a zero-length span rather than dividing by it", () => {
    expect(
      nameRoute([span("s1", 500, 500)], () => [{ text: "x", level: 1, coveredMs: 1 }]).name,
    ).toBeNull();
  });
});
