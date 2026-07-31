import { describe, expect, it } from "vitest";
import { DEFAULT_VISUAL_THRESHOLD, matchNode } from "../src/trace/identity.js";
import type { FrameRef, Predicate, TraceNode, VisualMatcher } from "../src/trace/types.js";

const p = (label: string): Predicate => ({
  kind: "ax_exists",
  args: { role: "AXButton", label },
  reach: "achievable",
});

const node = (id: string, labels: string[], phash?: string): TraceNode => ({
  id,
  predicates: labels.map(p),
  ...(phash !== undefined ? { visual: { frameBlobId: `b_${id}`, phash } } : {}),
  intervene: "select",
  observations: 1,
});

/** Scores by a caller-supplied table keyed on the candidate's phash. */
const matcher = (scores: Record<string, number>): VisualMatcher => ({
  similar: async (_ref: FrameRef, candidates: readonly FrameRef[]) =>
    candidates.map((c) => scores[c.phash] ?? 0),
});

describe("matchNode", () => {
  it("matches on an identical predicate set", async () => {
    const r = await matchNode(node("new", ["Send"]), [node("a", ["Send"]), node("b", ["Cancel"])]);
    expect(r).toEqual({ nodeId: "a", layer: "predicate", confidence: 1, ambiguous: false });
  });

  it("does not match a merely overlapping predicate set", async () => {
    const r = await matchNode(node("new", ["Send"]), [node("a", ["Send", "Cancel"])]);
    expect(r.nodeId).toBeUndefined();
    expect(r.layer).toBe("none");
  });

  it("REFUSES to merge when two existing nodes match equally — the asymmetric bias", async () => {
    const r = await matchNode(node("new", ["Send"]), [node("a", ["Send"]), node("b", ["Send"])]);
    expect(r.nodeId).toBeUndefined();
    expect(r.ambiguous).toBe(true);
    expect(r.layer).toBe("predicate");
  });

  it("falls back to visual corroboration above the threshold", async () => {
    const r = await matchNode(
      node("new", ["Send"], "aaaa"),
      [node("a", ["Different"], "bbbb"), node("b", ["Other"], "cccc")],
      { visual: matcher({ bbbb: 0.97, cccc: 0.4 }) },
    );
    expect(r.nodeId).toBe("a");
    expect(r.layer).toBe("visual");
    expect(r.confidence).toBeCloseTo(0.97, 6);
  });

  it("does not visual-match below the threshold", async () => {
    const r = await matchNode(node("new", ["Send"], "aaaa"), [node("a", ["Other"], "bbbb")], {
      visual: matcher({ bbbb: DEFAULT_VISUAL_THRESHOLD - 0.01 }),
    });
    expect(r.nodeId).toBeUndefined();
    expect(r.layer).toBe("none");
  });

  it("REFUSES to merge when two visual candidates sit within the margin", async () => {
    const r = await matchNode(
      node("new", ["Send"], "aaaa"),
      [node("a", ["X"], "bbbb"), node("b", ["Y"], "cccc")],
      { visual: matcher({ bbbb: 0.97, cccc: 0.96 }) },
    );
    expect(r.nodeId).toBeUndefined();
    expect(r.ambiguous).toBe(true);
    expect(r.layer).toBe("visual");
  });

  it("degrades to predicate-only without a matcher, recording the layer", async () => {
    const r = await matchNode(node("new", ["Send"], "aaaa"), [node("a", ["Other"], "bbbb")]);
    expect(r.layer).toBe("none");
    expect(r.ambiguous).toBe(false);
  });

  it("skips visual corroboration when the candidate has no visual of its own", async () => {
    const r = await matchNode(node("new", ["Send"]), [node("a", ["Other"], "bbbb")], {
      visual: matcher({ bbbb: 0.99 }),
    });
    expect(r.nodeId).toBeUndefined();
    expect(r.layer).toBe("none");
  });

  it("returns none against an empty graph", async () => {
    const r = await matchNode(node("new", ["Send"]), []);
    expect(r).toEqual({ layer: "none", confidence: 0, ambiguous: false });
  });
});
