import { describe, expect, it } from "vitest";
import { composeLadder } from "../src/represent/compose/levels.js";
import type { ChildSummary, ComposeGroup, Ladder, LevelKind } from "../src/represent/compose/types.js";

function leaves(n: number, over: (i: number) => Partial<ChildSummary> = () => ({})) {
  return Array.from(
    { length: n },
    (_, i): ChildSummary => ({
      index: i, text: `action ${i}`, app: "Calculator", url: null,
      startSec: i, endSec: i + 1, barrier: false, ...over(i),
    }),
  );
}

const grans = (l: Ladder): string[] => l.nodes.map((n) => n.granularity);
const root = (l: Ladder) => l.nodes[l.nodes.length - 1]!;

/** Groups children into runs of `size`, naming each. */
const chunk =
  (size: number) =>
  async (children: readonly ChildSummary[], kind: LevelKind): Promise<ComposeGroup[]> => {
    if (kind === "session") return [{ start: 0, end: children.length, summary: "the session" }];
    const out: ComposeGroup[] = [];
    for (let i = 0; i < children.length; i += size) {
      out.push({ start: i, end: Math.min(i + size, children.length), summary: `${kind} ${i}` });
    }
    return out;
  };

describe("composeLadder", () => {
  it("produces AT MOST three composed levels, whatever the input", async () => {
    const l = await composeLadder(leaves(200), { compose: chunk(2) });
    const kinds = new Set(grans(l));
    expect([...kinds].every((g) => ["level:1", "level:2", "session"].includes(g))).toBe(true);
  });

  it("builds Task, Process and Session when both levels qualify", async () => {
    const l = await composeLadder(leaves(16), { compose: chunk(2) });
    expect(grans(l)).toContain("level:1");
    expect(grans(l)).toContain("level:2");
    expect(root(l).granularity).toBe("session");
  });

  it("orders nodes topologically — a child always precedes its parent", async () => {
    const l = await composeLadder(leaves(16), { compose: chunk(2) });
    l.nodes.forEach((n, i) => {
      for (const c of n.children) if (c.kind === "node") expect(c.index).toBeLessThan(i);
    });
  });

  it("SKIPS a level that does not shrink, and the level above adopts its children", async () => {
    // One group per task at the process level: no shrink, so no level:2 at all.
    const noProcess = async (
      children: readonly ChildSummary[],
      kind: LevelKind,
    ): Promise<ComposeGroup[]> => {
      if (kind === "session") return [{ start: 0, end: children.length, summary: "s" }];
      if (kind === "process")
        return children.map((_, i) => ({ start: i, end: i + 1, summary: `p${i}` }));
      return chunk(2)(children, kind);
    };
    const l = await composeLadder(leaves(8), { compose: noProcess });
    expect(grans(l)).not.toContain("level:2");
    // The root adopted the TASKS directly.
    expect(root(l).children.length).toBeGreaterThan(1);
    for (const c of root(l).children) {
      expect(c.kind === "node" && l.nodes[c.index]!.granularity === "level:1").toBe(true);
    }
  });

  it("falls back structurally at TASK when the model returns one group per child, and SKIPS process", async () => {
    // One group per child never shrinks, so the reply is rejected wholesale at
    // both levels. `task` has a structural fallback and therefore still
    // qualifies; `process` is model-only, so it is skipped and the root adopts
    // the tasks.
    const onePer = async (
      children: readonly ChildSummary[],
      kind: LevelKind,
    ): Promise<ComposeGroup[]> => {
      if (kind === "session") return [{ start: 0, end: children.length, summary: "s" }];
      return children.map((_, i) => ({ start: i, end: i + 1, summary: `x${i}` }));
    };
    const l = await composeLadder(leaves(6), { compose: onePer });
    const tasks = l.nodes.filter((n) => n.granularity === "level:1");
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((n) => n.source === "template")).toBe(true);
    expect(grans(l)).not.toContain("level:2");
    // Elision means the root adopts leftover ACTIONS directly beside the task:
    // structural halving is LOPSIDED (six uniform actions merge leftmost-first
    // into 4 + 1 + 1), so the two singleton groups are elided rather than
    // wrapped in nodes that could only restate them.
    expect(
      root(l).children.some(
        (c) => c.kind === "node" && l.nodes[c.index]!.granularity === "level:1",
      ),
    ).toBe(true);
    expect(root(l).children.some((c) => c.kind === "leaf")).toBe(true);
  });

  it("SKIPS level:1 when a bookmark bars every pair — the root adopts the ACTIONS", async () => {
    // Every child is its own block, so every group holds exactly one child and
    // the level composes nothing. A barrier between every pair is the ONE way
    // level:1 fails admission: the structural fallback always halves otherwise.
    const kids = leaves(4, (i) => (i > 0 ? { barrier: true } : {}));
    const l = await composeLadder(kids, { compose: chunk(2) });
    expect(grans(l)).toEqual(["session"]);
    expect(root(l).children).toHaveLength(4);
    expect(root(l).children.every((c) => c.kind === "leaf")).toBe(true);
  });

  it("ELIDES a single-child node — the grandparent adopts the child", async () => {
    // Level 1 pairs; level 2 leaves the last task alone.
    const lonely = async (
      children: readonly ChildSummary[],
      kind: LevelKind,
    ): Promise<ComposeGroup[]> => {
      if (kind === "session") return [{ start: 0, end: children.length, summary: "s" }];
      if (kind === "process")
        return [
          { start: 0, end: children.length - 1, summary: "phase" },
          { start: children.length - 1, end: children.length, summary: "alone" },
        ];
      return chunk(2)(children, kind);
    };
    const l = await composeLadder(leaves(12), { compose: lonely });
    // No node anywhere holds exactly one child...
    for (const n of l.nodes) {
      if (n.granularity === "session") continue;
      expect(n.children.length).toBeGreaterThan(1);
    }
    // ...and the lone task was adopted by the root, so an edge spans two levels.
    const adopted = root(l).children.filter(
      (c) => c.kind === "node" && l.nodes[c.index]!.granularity === "level:1",
    );
    expect(adopted.length).toBe(1);
  });

  it("the ROOT is exempt from elision — one child is correct there", async () => {
    const oneProcess = async (
      children: readonly ChildSummary[],
      kind: LevelKind,
    ): Promise<ComposeGroup[]> => {
      if (kind === "session") return [{ start: 0, end: children.length, summary: "the whole thing" }];
      if (kind === "process") return [{ start: 0, end: children.length, summary: "one phase" }];
      return chunk(2)(children, kind);
    };
    const l = await composeLadder(leaves(8), { compose: oneProcess });
    expect(root(l).granularity).toBe("session");
    expect(root(l).children).toHaveLength(1);
    expect(root(l).summary).toBe("the whole thing");
  });

  it("PROCESS IS MODEL-ONLY — no summarizer means no level:2", async () => {
    const l = await composeLadder(leaves(12));
    expect(grans(l)).toContain("level:1");
    expect(grans(l)).not.toContain("level:2");
    expect(root(l).granularity).toBe("session");
  });

  it("still builds TASKS structurally with no summarizer", async () => {
    const l = await composeLadder(leaves(12));
    const tasks = l.nodes.filter((n) => n.granularity === "level:1");
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((n) => n.source === "template")).toBe(true);
  });

  it("rejects a malformed partition WHOLESALE and falls back structurally", async () => {
    const broken = async (
      children: readonly ChildSummary[],
      kind: LevelKind,
    ): Promise<ComposeGroup[]> => {
      if (kind === "session") return [{ start: 0, end: children.length, summary: "s" }];
      // A gap: neither the ranges nor the names may survive.
      return [
        { start: 0, end: 2, summary: "a" },
        { start: 3, end: children.length, summary: "b" },
      ];
    };
    const l = await composeLadder(leaves(8), { compose: broken });
    const tasks = l.nodes.filter((n) => n.granularity === "level:1");
    expect(tasks.every((n) => n.source === "template")).toBe(true);
    expect(tasks.map((n) => n.summary)).not.toContain("a");
  });

  it("never fails the run when the model throws", async () => {
    const boom = async (): Promise<ComposeGroup[]> => {
      throw new Error("ollama is not running");
    };
    const l = await composeLadder(leaves(8), { compose: boom });
    expect(root(l).granularity).toBe("session");
    expect(root(l).source).toBe("template");
  });

  it("returns an empty ladder for no leaves", async () => {
    expect((await composeLadder([])).nodes).toEqual([]);
  });

  it("gives a single leaf a root of its own", async () => {
    const l = await composeLadder(leaves(1), { compose: chunk(2) });
    expect(root(l).granularity).toBe("session");
    expect(root(l).children).toEqual([{ kind: "leaf", index: 0 }]);
  });

  it("never merges across a barrier", async () => {
    const kids = leaves(8, (i) => (i === 4 ? { barrier: true } : {}));
    const l = await composeLadder(kids, { compose: chunk(8) });
    const leafIdx = (n: { children: { kind: string; index: number }[] }) =>
      n.children.filter((c) => c.kind === "leaf").map((c) => c.index);
    for (const n of l.nodes) {
      if (n.granularity !== "level:1") continue;
      const idx = leafIdx(n);
      // No task may contain leaves from both sides of the bookmark.
      expect(idx.some((i) => i < 4) && idx.some((i) => i >= 4)).toBe(false);
    }
  });

  it("is translation invariant", async () => {
    const base = leaves(12);
    const shifted = base.map((c) => ({
      ...c, startSec: c.startSec + 4242.4242, endSec: c.endSec + 4242.4242,
    }));
    expect(await composeLadder(shifted)).toEqual(await composeLadder(base));
  });
});
