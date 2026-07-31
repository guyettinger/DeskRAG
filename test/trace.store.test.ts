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
