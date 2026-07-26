import { afterEach, describe, expect, it } from "vitest";
import { OnnxRuntime, SESSION_OPTIONS, makeTensor } from "../src/embed/onnx/runtime.js";

afterEach(() => OnnxRuntime.reset());

describe("SESSION_OPTIONS", () => {
  it("disables the CPU memory arena", () => {
    // NOT stylistic. MEASURED with real ColSmol weights at 13 tiles, running
    // under the Electron binary's allocator:
    //   arena on  -> SIGTRAP (V8 fatal error), peak ~5GB
    //   arena off -> completes, peak ~1.33GB
    // ORT's BFCArena requests a single ~2GiB block. Chromium's PartitionAlloc,
    // which the Electron binary uses for `operator new`, refuses it and aborts
    // the process. Plain Node's malloc allows it — which is exactly why this
    // suite passes either way and only the packaged app crashes. Removing this
    // line reintroduces that crash silently.
    expect(SESSION_OPTIONS.enableCpuMemArena).toBe(false);
  });

  it("keeps full graph optimization", () => {
    // The arena is the memory problem; optimization is not. Disabling it would
    // cost speed and fix nothing — verified: mem-pattern alone still SIGTRAPs.
    expect(SESSION_OPTIONS.graphOptimizationLevel).toBe("all");
  });
});

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
