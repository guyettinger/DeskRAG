import { describe, expect, it } from "vitest";
import { edgeSignature, mergeTrace } from "../src/trace/merge.js";
import type { Anchor, Predicate, Trace, TraceEdge, TraceNode } from "../src/trace/types.js";

const p = (label: string): Predicate => ({
  kind: "ax_exists",
  args: { role: "AXButton", label },
  reach: "achievable",
});

const anchor = (path: string): Anchor => ({
  ax: { role: "AXButton", path },
  point: { x: 0, y: 0, displayId: "D1" },
});

const node = (id: string, labels: string[]): TraceNode => ({
  id,
  predicates: labels.map(p),
  intervene: "select",
  observations: 1,
});

const edge = (id: string, from: string, to: string, actions: TraceEdge["actions"]): TraceEdge => ({
  id,
  from,
  to,
  actions,
  provenance: "recorded",
  observations: 1,
  outcomes: { attempts: 0, successes: 0 },
});

/** compose -> type -> sent, with the typed text supplied by the caller. */
const typingTrace = (sessionId: string, text: string): Trace => ({
  sessionId,
  nodes: [node(`${sessionId}:n0`, ["Compose"]), node(`${sessionId}:n1`, ["Sent"])],
  edges: [
    edge(`${sessionId}:e0`, `${sessionId}:n0`, `${sessionId}:n1`, [
      { kind: "click", anchor: anchor("W>To"), button: 1, count: 1 },
      { kind: "type", slot: "axtextfield_to", recorded: text },
      { kind: "click", anchor: anchor("W>Send"), button: 1, count: 1 },
    ]),
  ],
  slots: [{ name: "axtextfield_to", samples: [text], secret: false }],
});

describe("edgeSignature", () => {
  it("ignores typed content — that is what makes slots discoverable", () => {
    const a = typingTrace("s1", "alice@example.com").edges[0]!;
    const b = typingTrace("s2", "bob@example.com").edges[0]!;
    expect(edgeSignature(a)).toBe(edgeSignature(b));
  });

  it("distinguishes different anchors", () => {
    const a = edge("e", "n0", "n1", [{ kind: "click", anchor: anchor("W>Send"), button: 1, count: 1 }]);
    const b = edge("e", "n0", "n1", [{ kind: "click", anchor: anchor("W>Cancel"), button: 1, count: 1 }]);
    expect(edgeSignature(a)).not.toBe(edgeSignature(b));
  });

  it("distinguishes different action order", () => {
    const a = edge("e", "n0", "n1", [
      { kind: "click", anchor: anchor("W>A"), button: 1, count: 1 },
      { kind: "chord", keys: ["cmd", "s"] },
    ]);
    const b = edge("e", "n0", "n1", [
      { kind: "chord", keys: ["cmd", "s"] },
      { kind: "click", anchor: anchor("W>A"), button: 1, count: 1 },
    ]);
    expect(edgeSignature(a)).not.toBe(edgeSignature(b));
  });
});

describe("mergeTrace", () => {
  it("seeds an empty graph from the first trace and sets the entry node", async () => {
    const g = await mergeTrace(undefined, typingTrace("s1", "alice@example.com"));
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(g.entry).toBe(g.nodes[0]!.id);
  });

  it("THE SLOT ASSERTION: two traces differing only in typed text merge to one edge with two samples", async () => {
    const g1 = await mergeTrace(undefined, typingTrace("s1", "alice@example.com"));
    const g2 = await mergeTrace(g1, typingTrace("s2", "bob@example.com"));

    expect(g2.nodes).toHaveLength(2);
    expect(g2.edges).toHaveLength(1);
    expect(g2.edges[0]!.observations).toBe(2);
    expect(g2.slots).toHaveLength(1);
    expect(g2.slots[0]!.samples).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("does not duplicate a sample recorded twice", async () => {
    const g1 = await mergeTrace(undefined, typingTrace("s1", "alice@example.com"));
    const g2 = await mergeTrace(g1, typingTrace("s2", "alice@example.com"));
    expect(g2.slots[0]!.samples).toEqual(["alice@example.com"]);
    expect(g2.edges[0]!.observations).toBe(2);
  });

  it("THE BRANCH ASSERTION: traces that diverge produce a parallel edge, not a rewritten one", async () => {
    const base = typingTrace("s1", "alice@example.com");
    const divergent: Trace = {
      sessionId: "s2",
      nodes: [node("s2:n0", ["Compose"]), node("s2:n1", ["Draft Saved"])],
      edges: [
        edge("s2:e0", "s2:n0", "s2:n1", [{ kind: "chord", keys: ["cmd", "s"] }]),
      ],
      slots: [],
    };
    const g1 = await mergeTrace(undefined, base);
    const g2 = await mergeTrace(g1, divergent);

    // The shared "Compose" state merged; the outcomes did not.
    expect(g2.nodes).toHaveLength(3);
    const fromCompose = g2.edges.filter((e) => e.from === g2.entry);
    expect(fromCompose).toHaveLength(2);
    expect(fromCompose.every((e) => e.provenance === "recorded")).toBe(true);
  });

  it("increments node observations on a merge", async () => {
    const g1 = await mergeTrace(undefined, typingTrace("s1", "a"));
    const g2 = await mergeTrace(g1, typingTrace("s2", "b"));
    expect(g2.nodes.every((n) => n.observations === 2)).toBe(true);
  });

  it("collapses a revisited state into a loop rather than a duplicate node", async () => {
    // A trace that returns to a state it has already been in: n0 and n2 carry the
    // same predicate set. Merging is what turns that into a cycle — the thing a
    // linear model cannot express and the graph was chosen for.
    const loop: Trace = {
      sessionId: "s1",
      nodes: [node("s1:n0", ["List"]), node("s1:n1", ["Detail"]), node("s1:n2", ["List"])],
      edges: [
        edge("s1:e0", "s1:n0", "s1:n1", [{ kind: "click", anchor: anchor("W>Row"), button: 1, count: 1 }]),
        edge("s1:e1", "s1:n1", "s1:n2", [{ kind: "chord", keys: ["esc"] }]),
      ],
      slots: [],
    };
    const g = await mergeTrace(undefined, loop);

    expect(g.nodes).toHaveLength(2);
    const list = g.nodes.find((n) => n.predicates.some((x) => x.args.label === "List"))!;
    const detail = g.nodes.find((n) => n.predicates.some((x) => x.args.label === "Detail"))!;
    expect(list.observations).toBe(2); // visited twice in one recording

    // The cycle closed: out of List into Detail, and back again.
    expect(g.edges.map((e) => [e.from, e.to])).toEqual([
      [list.id, detail.id],
      [detail.id, list.id],
    ]);
  });

  // NOTE: the ambiguous-identity case (two existing nodes matching equally, so
  // the merge declines) is unreachable through mergeTrace — an exact predicate
  // match always collapses the second node into the first, so a graph can never
  // hold two nodes with the same predicate set. That branch is exercised
  // directly against matchNode in trace.identity.test.ts.

  it("leaves the input graph untouched", async () => {
    const g1 = await mergeTrace(undefined, typingTrace("s1", "alice@example.com"));
    const before = JSON.stringify(g1);
    await mergeTrace(g1, typingTrace("s2", "bob@example.com"));
    expect(JSON.stringify(g1)).toBe(before);
  });

  it("preserves the entry node across merges", async () => {
    const g1 = await mergeTrace(undefined, typingTrace("s1", "a"));
    const g2 = await mergeTrace(g1, typingTrace("s2", "b"));
    expect(g2.entry).toBe(g1.entry);
  });
});

/**
 * A merge is where a second recording's evidence for a shared state would be
 * lost: the merged-away node is discarded, so the surviving one has to take its
 * provenance. Without this the graph can count observations it cannot show you.
 */
describe("mergeTrace provenance", () => {
  /** `typingTrace` with sources, so both halves of a merge carry evidence. */
  const sourced = (sessionId: string, text: string, at: number): Trace => {
    const t = typingTrace(sessionId, text);
    return {
      ...t,
      nodes: t.nodes.map((n, i) => ({ ...n, sources: [{ sessionId, tMono: at + i * 1000 }] })),
      edges: t.edges.map((e) => ({
        ...e,
        sources: [{ sessionId, tMonoStart: at, tMonoEnd: at + 1000 }],
      })),
    };
  };

  it("collects both recordings' sources onto the node they merged into", async () => {
    const g1 = await mergeTrace(undefined, sourced("s1", "alice@example.com", 500));
    const g2 = await mergeTrace(g1, sourced("s2", "bob@example.com", 9000));

    expect(g2.nodes).toHaveLength(2);
    expect(g2.nodes[0]!.observations).toBe(2);
    expect(g2.nodes[0]!.sources).toEqual([
      { sessionId: "s1", tMono: 500 },
      { sessionId: "s2", tMono: 9000 },
    ]);
  });

  it("collects them onto the merged edge too — the same edge, two recordings", async () => {
    const g1 = await mergeTrace(undefined, sourced("s1", "alice@example.com", 500));
    const g2 = await mergeTrace(g1, sourced("s2", "bob@example.com", 9000));

    expect(g2.edges).toHaveLength(1);
    expect(g2.edges[0]!.observations).toBe(2);
    expect(g2.edges[0]!.sources).toEqual([
      { sessionId: "s1", tMonoStart: 500, tMonoEnd: 1500 },
      { sessionId: "s2", tMonoStart: 9000, tMonoEnd: 10000 },
    ]);
  });

  /**
   * The failure this guards is silent and only appears on the SECOND merge: an
   * uncopied array is shared with the input graph, so appending to the result
   * appends to the input as well.
   */
  it("does not append to the input graph's source arrays", async () => {
    const g1 = await mergeTrace(undefined, sourced("s1", "alice@example.com", 500));
    const before = JSON.stringify(g1);
    await mergeTrace(g1, sourced("s2", "bob@example.com", 9000));
    expect(JSON.stringify(g1)).toBe(before);
    expect(g1.nodes[0]!.sources).toHaveLength(1);
  });

  it("leaves sources absent when the trace carries none", async () => {
    const g = await mergeTrace(undefined, typingTrace("s1", "a"));
    expect(g.nodes[0]!.sources).toBeUndefined();
  });
});
