import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/main/onnx-worker-core.js";
import type { OnnxSessionLike, OnnxTensorDTO } from "../src/shared/onnx-protocol.js";

const feeds = (): Record<string, OnnxTensorDTO> => ({
  input_ids: { data: new BigInt64Array([1n]), dims: [1, 1] },
});

const sessionReturning = (n: number): OnnxSessionLike => ({
  run: async () => ({ embeddings: { data: new Float32Array([n]), dims: [1, 1] } }),
});

describe("onnx worker handleRequest", () => {
  it("runs the session for the requested model and returns its outputs", async () => {
    const res = await handleRequest({ kind: "run", id: 3, modelPath: "/a.onnx", feeds: feeds() }, async () =>
      sessionReturning(42),
    );
    expect(res).toEqual({
      kind: "ok",
      id: 3,
      outputs: { embeddings: { data: new Float32Array([42]), dims: [1, 1] } },
    });
  });

  it("passes the model path through so the worker caches per model", async () => {
    const asked: string[] = [];
    await handleRequest({ kind: "run", id: 1, modelPath: "/colsmol.onnx", feeds: feeds() }, async (p) => {
      asked.push(p);
      return sessionReturning(1);
    });
    expect(asked).toEqual(["/colsmol.onnx"]);
  });

  it("returns tensors that survive structured clone", async () => {
    // onnxruntime's Tensor exposes `data` as a PROTOTYPE GETTER over an own
    // `cpuData` field. structuredClone copies own properties only, so posting
    // an ORT tensor straight across the process boundary delivers an object
    // whose `data` is undefined — which is what broke indexing.
    class FakeOrtTensor {
      constructor(
        readonly cpuData: Float32Array,
        readonly dims: number[],
      ) {}
      get data(): Float32Array {
        return this.cpuData;
      }
    }

    const res = await handleRequest(
      { kind: "run", id: 1, modelPath: "/a.onnx", feeds: feeds() },
      async () => ({
        run: async () =>
          ({
            embeddings: new FakeOrtTensor(new Float32Array([1, 2]), [1, 2]),
          }) as unknown as Record<string, OnnxTensorDTO>,
      }),
    );

    const cloned = structuredClone(res);
    expect(cloned.kind).toBe("ok");
    if (cloned.kind !== "ok") throw new Error("unreachable");
    expect(Array.from(cloned.outputs.embeddings!.data)).toEqual([1, 2]);
    expect(cloned.outputs.embeddings!.dims).toEqual([1, 2]);
  });

  it("reports a failed run as an error response rather than throwing", async () => {
    const res = await handleRequest({ kind: "run", id: 5, modelPath: "/a.onnx", feeds: feeds() }, async () => ({
      run: () => Promise.reject(new Error("invalid input shape")),
    }));
    expect(res).toEqual({ kind: "err", id: 5, message: "invalid input shape" });
  });

  it("reports a session that will not load as an error response", async () => {
    const res = await handleRequest({ kind: "run", id: 8, modelPath: "/missing.onnx", feeds: feeds() }, () =>
      Promise.reject(new Error("ONNX weights not found at /missing.onnx")),
    );
    expect(res).toEqual({
      kind: "err",
      id: 8,
      message: "ONNX weights not found at /missing.onnx",
    });
  });
});
