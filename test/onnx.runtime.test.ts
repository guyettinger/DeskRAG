import { afterEach, describe, expect, it } from "vitest";
import { OnnxRuntime, makeTensor } from "../src/embed/onnx/runtime.js";

afterEach(() => OnnxRuntime.reset());

describe("makeTensor", () => {
  it("builds a float32 tensor with the given dims", () => {
    const t = makeTensor("float32", Float32Array.from([1, 2, 3, 4]), [2, 2]);
    expect(t.dims).toEqual([2, 2]);
    expect(Array.from(t.data as Float32Array)).toEqual([1, 2, 3, 4]);
  });

  it("builds an int64 tensor", () => {
    const t = makeTensor("int64", BigInt64Array.from([1n, 2n]), [1, 2]);
    expect(t.dims).toEqual([1, 2]);
    expect(Array.from(t.data as BigInt64Array)).toEqual([1n, 2n]);
  });
});

describe("OnnxRuntime.session", () => {
  it("rejects with a clear message when the weights file is missing", async () => {
    await expect(
      OnnxRuntime.session("/definitely/not/here/model.onnx"),
    ).rejects.toThrow(/ONNX weights not found/);
  });

  it("returns the same promise for the same path (session cache)", async () => {
    const a = OnnxRuntime.session("/definitely/not/here/model.onnx");
    const b = OnnxRuntime.session("/definitely/not/here/model.onnx");
    expect(a).toBe(b);
    await Promise.allSettled([a, b]);
  });

  it("reset() clears the cache", async () => {
    const a = OnnxRuntime.session("/definitely/not/here/model.onnx");
    OnnxRuntime.reset();
    const b = OnnxRuntime.session("/definitely/not/here/model.onnx");
    expect(a).not.toBe(b);
    await Promise.allSettled([a, b]);
  });

  it("does not cache a failed load — weights arriving later must be retried", async () => {
    // Weights are downloaded lazily on first use, so a miss is expected once.
    // Caching the rejection would strand the user until an app restart.
    const first = OnnxRuntime.session("/definitely/not/here/model.onnx");
    await expect(first).rejects.toThrow();
    const second = OnnxRuntime.session("/definitely/not/here/model.onnx");
    expect(second).not.toBe(first);
    await Promise.allSettled([second]);
  });
});
