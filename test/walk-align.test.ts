import { describe, expect, it } from "vitest";
import { alignWalk } from "../app/src/main/walk-align.js";

/**
 * The scan is order-preserving by construction, which is why `reordered` cannot
 * come out of it directly — a swapped pair emerges as one skip plus one insert,
 * and the fact that it is the SAME edge moved is only recoverable afterwards.
 * That post-pass is the interesting half of this file and most of these cases
 * exist to pin it.
 */
describe("alignWalk", () => {
  it("reports nothing when the walk is the baseline", () => {
    const out = alignWalk(["a", "b", "c"], ["a", "b", "c"]);
    expect(out.deviations).toEqual([]);
    expect(out.reachedEnd).toBe(true);
  });

  it("reports a baseline edge the walk never took as skipped, at its baseline index", () => {
    const out = alignWalk(["a", "b", "c"], ["a", "c"]);
    expect(out.deviations).toEqual([{ kind: "skipped", stepIndex: 1, edgeId: "b" }]);
    expect(out.reachedEnd).toBe(true);
  });

  it("reports an edge the baseline does not contain as inserted", () => {
    const out = alignWalk(["a", "b"], ["a", "x", "b"]);
    expect(out.deviations).toEqual([{ kind: "inserted", stepIndex: 1, edgeId: "x" }]);
    expect(out.reachedEnd).toBe(true);
  });

  it("collapses a swapped pair into ONE reordered, not a skip plus an insert", () => {
    const out = alignWalk(["a", "b", "c", "d"], ["a", "c", "b", "d"]);
    // Two deviations would overstate the divergence: doing b and c the other
    // way round is ONE difference. The surviving entry carries the BASELINE
    // index of the edge the scan saw move — here `c`, which the walk performed
    // early and the baseline expects at index 2.
    expect(out.deviations).toEqual([{ kind: "reordered", stepIndex: 2, edgeId: "c" }]);
    expect(out.reachedEnd).toBe(true);
  });

  it("reports a substitution as a skip AND an insert at the same index", () => {
    // Neither edge can ever match, so both cursors advance together. Advancing
    // only the baseline would drag the mismatch down the rest of the sequence
    // and manufacture a `reordered` out of an edge that never moved.
    const out = alignWalk(["a", "b", "c"], ["a", "x", "c"]);
    expect(out.deviations).toEqual([
      { kind: "skipped", stepIndex: 1, edgeId: "b" },
      { kind: "inserted", stepIndex: 1, edgeId: "x" },
    ]);
    expect(out.reachedEnd).toBe(true);
  });

  it("does not call an edge reordered when only one side has it", () => {
    const out = alignWalk(["a", "b"], ["a", "x"]);
    expect(out.deviations).toEqual([
      { kind: "skipped", stepIndex: 1, edgeId: "b" },
      { kind: "inserted", stepIndex: 1, edgeId: "x" },
    ]);
    expect(out.reachedEnd).toBe(false);
  });

  it("reports reachedEnd false when the walk stops before the baseline's last edge", () => {
    const out = alignWalk(["a", "b", "c"], ["a", "b"]);
    expect(out.deviations).toEqual([{ kind: "skipped", stepIndex: 2, edgeId: "c" }]);
    expect(out.reachedEnd).toBe(false);
  });

  it("attributes trailing extra edges to one past the baseline's end", () => {
    const out = alignWalk(["a", "b"], ["a", "b", "z"]);
    expect(out.deviations).toEqual([{ kind: "inserted", stepIndex: 2, edgeId: "z" }]);
    expect(out.reachedEnd).toBe(true);
  });

  it("treats an empty baseline as vacuously reached, and every walk edge as inserted", () => {
    const out = alignWalk([], ["a"]);
    expect(out.deviations).toEqual([{ kind: "inserted", stepIndex: 0, edgeId: "a" }]);
    expect(out.reachedEnd).toBe(true);
  });

  it("handles a repeated edge — a loop — without pairing the two occurrences", () => {
    // A session can walk one edge more than once; `frequentRoutes` orders a
    // walk by the recorded moment precisely because of it. The scan must not
    // match the walk's second `a` against the baseline's first.
    const out = alignWalk(["a", "b", "a"], ["a", "b"]);
    expect(out.deviations).toEqual([{ kind: "skipped", stepIndex: 2, edgeId: "a" }]);
    expect(out.reachedEnd).toBe(false);
  });

  it("returns deviations in baseline order", () => {
    const out = alignWalk(["a", "b", "c", "d"], ["a", "d"]);
    expect(out.deviations.map((d) => d.stepIndex)).toEqual([1, 2]);
  });
});
