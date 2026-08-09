import { describe, expect, it } from "vitest";
import { composeLevels } from "../src/represent/compose/levels.js";
import type { Block, ChildSummary, ComposeGroup } from "../src/represent/compose/types.js";

function leaves(n: number, over: (i: number) => Partial<ChildSummary> = () => ({})) {
  return Array.from(
    { length: n },
    (_, i): ChildSummary => ({
      index: i,
      text: `action ${i}`,
      app: "Calculator",
      url: null,
      startSec: i,
      endSec: i + 1,
      barrier: false,
      ...over(i),
    }),
  );
}

/** Pairs children up and names each pair — a well-behaved model. */
const pairwise = async (
  _children: readonly ChildSummary[],
  block: Block,
): Promise<ComposeGroup[]> => {
  const out: ComposeGroup[] = [];
  for (let i = block.start; i < block.end; i += 2) {
    out.push({ start: i, end: Math.min(i + 2, block.end), summary: `run ${i}` });
  }
  return out;
};

describe("composeLevels", () => {
  it("recurses to exactly one root", async () => {
    const out = await composeLevels(leaves(8), { partitioner: pairwise });
    expect(out.length).toBeGreaterThan(0);
    expect(out[out.length - 1]!.nodes).toHaveLength(1);
  });

  it("numbers levels from 1 upward", async () => {
    const out = await composeLevels(leaves(8), { partitioner: pairwise });
    expect(out.map((l) => l.level)).toEqual(out.map((_, i) => i + 1));
  });

  it("every level is strictly smaller than the one below", async () => {
    const out = await composeLevels(leaves(16), { partitioner: pairwise });
    let prev = 16;
    for (const l of out) {
      expect(l.nodes.length).toBeLessThan(prev);
      prev = l.nodes.length;
    }
  });

  it("each level covers its children exactly, contiguously", async () => {
    const out = await composeLevels(leaves(9), { partitioner: pairwise });
    let below = 9;
    for (const l of out) {
      let cursor = 0;
      for (const n of l.nodes) {
        expect(n.range.start).toBe(cursor);
        cursor = n.range.end;
      }
      expect(cursor).toBe(below);
      below = l.nodes.length;
    }
  });

  it("marks LLM-named nodes 'llm' and rolled-up ones 'template'", async () => {
    const withModel = await composeLevels(leaves(4), { partitioner: pairwise });
    expect(withModel[0]!.nodes.every((n) => n.source === "llm")).toBe(true);
    expect(withModel[0]!.nodes[0]!.summary).toBe("run 0");

    const noModel = await composeLevels(leaves(4));
    expect(noModel[0]!.nodes.every((n) => n.source === "template")).toBe(true);
    expect(noModel[0]!.nodes[0]!.summary).toContain("Calculator");
  });

  it("REJECTS a malformed partition wholesale rather than repairing it", async () => {
    const broken = async (): Promise<ComposeGroup[]> => [
      { start: 0, end: 2, summary: "a" },
      { start: 3, end: 4, summary: "b" }, // gap at 2
    ];
    const out = await composeLevels(leaves(4), { partitioner: broken });
    // Nothing the model said survives — not the ranges, not the names.
    expect(out[0]!.nodes.every((n) => n.source === "template")).toBe(true);
    expect(out[0]!.nodes.map((n) => n.summary)).not.toContain("a");
  });

  it("falls back when a partition does not shrink its block", async () => {
    const identity = async (
      _c: readonly ChildSummary[],
      block: Block,
    ): Promise<ComposeGroup[]> =>
      Array.from({ length: block.end - block.start }, (_, k) => ({
        start: block.start + k,
        end: block.start + k + 1,
        summary: "no",
      }));
    const out = await composeLevels(leaves(4), { partitioner: identity });
    expect(out[out.length - 1]!.nodes).toHaveLength(1);
    expect(out[0]!.nodes.every((n) => n.source === "template")).toBe(true);
  });

  it("falls back when the partitioner throws — composing never fails the run", async () => {
    const boom = async (): Promise<ComposeGroup[]> => {
      throw new Error("ollama is not running");
    };
    const out = await composeLevels(leaves(4), { partitioner: boom });
    expect(out[out.length - 1]!.nodes).toHaveLength(1);
    expect(out[0]!.nodes.every((n) => n.source === "template")).toBe(true);
  });

  it("rolls up a group the model left unnamed, rather than storing an empty label", async () => {
    const unnamed = async (
      _c: readonly ChildSummary[],
      block: Block,
    ): Promise<ComposeGroup[]> => [
      { start: block.start, end: block.start + 2, summary: "   " },
      { start: block.start + 2, end: block.end, summary: "named" },
    ];
    const out = await composeLevels(leaves(4), { partitioner: unnamed });
    expect(out[0]!.nodes[0]!.summary).toContain("Calculator");
    expect(out[0]!.nodes[1]!.summary).toBe("named");
  });

  it("never merges across a barrier", async () => {
    const kids = leaves(4, (i) => (i === 2 ? { barrier: true } : {}));
    const out = await composeLevels(kids, { partitioner: pairwise });
    expect(out[0]!.nodes.some((n) => n.range.start < 2 && n.range.end > 2)).toBe(false);
  });

  it("returns one root node for a single leaf", async () => {
    const out = await composeLevels(leaves(1), { partitioner: pairwise });
    expect(out[out.length - 1]!.nodes).toHaveLength(1);
    expect(out[out.length - 1]!.nodes[0]!.range).toEqual({ start: 0, end: 1 });
  });

  it("returns [] for no leaves", async () => {
    expect(await composeLevels([])).toEqual([]);
  });

  it("still reaches one root when the depth cap bites", async () => {
    const out = await composeLevels(leaves(64), { partitioner: pairwise, maxDepth: 2 });
    expect(out[out.length - 1]!.nodes).toHaveLength(1);
  });

  it("is translation invariant", async () => {
    const base = leaves(8);
    const shifted = base.map((c) => ({
      ...c,
      startSec: c.startSec + 4242.4242,
      endSec: c.endSec + 4242.4242,
    }));
    expect(await composeLevels(shifted)).toEqual(await composeLevels(base));
  });
});
