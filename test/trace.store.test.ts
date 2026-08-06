import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DualStore } from "../src/store/store.js";
import type { Graph } from "../src/trace/types.js";

let dir: string;
let store: DualStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "deskrag-trace-"));
  store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const graph = (id: string): Graph => ({
  id,
  entry: "n0",
  nodes: [
    {
      id: "n0",
      predicates: [{ kind: "app", args: { app: "Mail" }, reach: "achievable" }],
      visual: { frameBlobId: "b_1", phash: "0f1e" },
      intervene: "select",
      observations: 3,
    },
    { id: "n1", predicates: [], intervene: "none", observations: 1 },
  ],
  edges: [
    {
      id: "e0",
      from: "n0",
      to: "n1",
      actions: [{ kind: "chord", keys: ["cmd", "s"] }],
      guard: [{ kind: "window", args: { title: "New Message" }, reach: "achievable" }],
      provenance: "recorded",
      observations: 2,
      outcomes: { attempts: 5, successes: 4 },
      liftWarnings: ["one warning"],
    },
  ],
  slots: [{ name: "recipient", samples: ["a@b.com", "c@d.com"], secret: false }],
});

describe("graph persistence", () => {
  it("round-trips a graph", async () => {
    await store.putGraph(graph("g1"));
    expect(store.getGraph("g1")).toEqual(graph("g1"));
  });

  it("returns undefined for an unknown id", () => {
    expect(store.getGraph("nope")).toBeUndefined();
  });

  it("upserts — writing twice does not duplicate nodes or edges", async () => {
    await store.putGraph(graph("g1"));
    const grown = graph("g1");
    grown.nodes[0]!.observations = 9;
    await store.putGraph(grown);
    const read = store.getGraph("g1")!;
    expect(read.nodes).toHaveLength(2);
    expect(read.edges).toHaveLength(1);
    expect(read.nodes[0]!.observations).toBe(9);
  });

  it("drops nodes that a later write removed", async () => {
    await store.putGraph(graph("g1"));
    const shrunk: Graph = { ...graph("g1"), nodes: [graph("g1").nodes[0]!], edges: [] };
    await store.putGraph(shrunk);
    expect(store.getGraph("g1")!.nodes).toHaveLength(1);
    expect(store.getGraph("g1")!.edges).toHaveLength(0);
  });

  it("lists graphs with their counts", async () => {
    await store.putGraph(graph("g1"));
    await store.putGraph(graph("g2"));
    const list = store.listGraphs();
    expect(list.map((g) => g.id).sort()).toEqual(["g1", "g2"]);
    expect(list.find((g) => g.id === "g1")).toMatchObject({ nodes: 2, edges: 1 });
  });

  it("deletes a graph and everything under it", async () => {
    await store.putGraph(graph("g1"));
    await store.deleteGraph("g1");
    expect(store.getGraph("g1")).toBeUndefined();
    expect(store.listGraphs()).toHaveLength(0);
  });

  it("registers NO vector space — the graph reuses existing vectors by id", async () => {
    const before = store.listVectorSpaces();
    await store.putGraph(graph("g1"));
    expect(store.listVectorSpaces()).toEqual(before);
  });

  it("preserves an absent optional rather than materializing null", async () => {
    const bare: Graph = {
      id: "g3",
      entry: "n0",
      nodes: [{ id: "n0", predicates: [], intervene: "select", observations: 1 }],
      edges: [],
      slots: [],
    };
    await store.putGraph(bare);
    const read = store.getGraph("g3")!;
    expect(read.nodes[0]!.visual).toBeUndefined();
    expect("visual" in read.nodes[0]!).toBe(false);
  });

  it("keeps two graphs independent", async () => {
    await store.putGraph(graph("g1"));
    await store.putGraph(graph("g2"));
    await store.deleteGraph("g1");
    expect(store.getGraph("g2")).toEqual(graph("g2"));
  });
});

/**
 * Provenance — which recording a node/edge came from.
 *
 * The sources tables are the only thing in the graph that points OUT of the
 * graph, so they are the only place a foreign key and a cascade are in play.
 */
describe("graph provenance", () => {
  /** A graph whose sources name real recordings, so the FK is satisfiable. */
  const sourced = (id: string): Graph => ({
    ...graph(id),
    nodes: [
      { ...graph(id).nodes[0]!, sources: [{ sessionId: "s1", tMono: 1200 }, { sessionId: "s2", tMono: 400 }] },
      { ...graph(id).nodes[1]!, sources: [{ sessionId: "s1", tMono: 3400 }] },
    ],
    edges: [
      {
        ...graph(id).edges[0]!,
        sources: [{ sessionId: "s1", tMonoStart: 1200, tMonoEnd: 3400 }],
      },
    ],
  });

  const putSessions = async (...ids: string[]): Promise<void> => {
    for (const id of ids) {
      await store.putSession({ id, startedAt: Date.now(), epochMono: 0 });
    }
  };

  it("round-trips node and edge sources in order", async () => {
    await putSessions("s1", "s2");
    await store.putGraph(sourced("g1"));
    expect(store.getGraph("g1")).toEqual(sourced("g1"));
  });

  it("does not duplicate sources when the same graph is written twice", async () => {
    await putSessions("s1", "s2");
    await store.putGraph(sourced("g1"));
    await store.putGraph(sourced("g1"));
    const read = store.getGraph("g1")!;
    expect(read.nodes[0]!.sources).toHaveLength(2);
    expect(read.edges[0]!.sources).toHaveLength(1);
  });

  /**
   * The cascade is the point: evidence pointing at a deleted recording is a
   * dead link. `observations` is deliberately NOT decremented — it counts what
   * was seen, and a reader showing 1 of 3 is telling the truth about both.
   */
  it("drops a deleted recording's sources and leaves the observation count", async () => {
    await putSessions("s1", "s2");
    await store.putGraph(sourced("g1"));
    await store.deleteSession("s1");

    const read = store.getGraph("g1")!;
    expect(read.nodes[0]!.sources).toEqual([{ sessionId: "s2", tMono: 400 }]);
    expect(read.nodes[0]!.observations).toBe(3);
    // n1 and e0 were observed only by s1, so their evidence is gone entirely.
    expect(read.nodes[1]!.sources).toBeUndefined();
    expect(read.edges[0]!.sources).toBeUndefined();
    expect(read.edges[0]!.observations).toBe(2);
  });

  /**
   * A source whose session was deleted between lift and write cannot be
   * inserted — session_id is a foreign key, and an FK violation aborts the
   * whole transaction regardless of ON CONFLICT. Dropping it must not cost the
   * graph.
   */
  it("writes the graph even when a source names a recording that is gone", async () => {
    await putSessions("s2");
    await store.putGraph(sourced("g1"));
    const read = store.getGraph("g1")!;
    expect(read.nodes).toHaveLength(2);
    expect(read.nodes[0]!.sources).toEqual([{ sessionId: "s2", tMono: 400 }]);
    expect(read.edges[0]!.sources).toBeUndefined();
  });

  /** A graph written before the source tables existed reads back unchanged. */
  it("leaves sources absent, not empty, when a graph has none", async () => {
    await store.putGraph(graph("g1"));
    const read = store.getGraph("g1")!;
    expect("sources" in read.nodes[0]!).toBe(false);
    expect("sources" in read.edges[0]!).toBe(false);
  });

  it("keeps two graphs' sources independent", async () => {
    await putSessions("s1", "s2");
    await store.putGraph(sourced("g1"));
    await store.putGraph(sourced("g2"));
    await store.deleteGraph("g1");
    expect(store.getGraph("g2")).toEqual(sourced("g2"));
  });
});
