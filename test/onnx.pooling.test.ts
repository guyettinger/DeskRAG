import { describe, expect, it } from "vitest";
import { l2Normalize, meanPool, sliceRows } from "../src/embed/onnx/pooling.js";

describe("meanPool", () => {
  it("averages only unmasked positions", () => {
    // seqLen 3, dims 2; third token masked out
    const hidden = Float32Array.from([1, 1, 3, 3, 100, 100]);
    const out = meanPool(hidden, [1, 1, 0], 3, 2);
    expect(Array.from(out)).toEqual([2, 2]);
  });

  it("returns zeros when everything is masked", () => {
    const hidden = Float32Array.from([5, 5, 7, 7]);
    const out = meanPool(hidden, [0, 0], 2, 2);
    expect(Array.from(out)).toEqual([0, 0]);
  });
});

describe("l2Normalize", () => {
  it("scales to unit length", () => {
    const v = l2Normalize(Float32Array.from([3, 4]));
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });

  it("leaves a zero vector alone rather than dividing by zero", () => {
    const v = l2Normalize(Float32Array.from([0, 0]));
    expect(Array.from(v)).toEqual([0, 0]);
  });
});

describe("sliceRows", () => {
  it("splits a flat [rows*dims] buffer into per-row vectors", () => {
    const rows = sliceRows(Float32Array.from([1, 2, 3, 4, 5, 6]), 3, 2);
    expect(rows.length).toBe(3);
    expect(Array.from(rows[1]!)).toEqual([3, 4]);
  });
});
