import { describe, expect, it } from "vitest";
import { OnnxCrossEncoderReranker } from "../src/retrieve/rerank/onnx.js";
import type { OnnxSession, OnnxTensor } from "../src/embed/onnx/runtime.js";

/** Returns caller-supplied scores, consumed in batch order. */
function stubSession(scores: number[]): OnnxSession {
  let cursor = 0;
  return {
    async run(feeds) {
      const [batch] = feeds.input_ids!.dims as [number, number];
      const out = scores.slice(cursor, cursor + batch);
      cursor += batch;
      return { logits: { data: Float32Array.from(out), dims: [batch, 1] } };
    },
  };
}

const opts = (session: OnnxSession) => ({
  modelPath: "/unused",
  tokenizerPath: "/unused",
  session,
  tokenizePair: (q: string, d: string) => ({
    ids: [q.length, d.length],
    typeIds: [0, 1],
  }),
});

const candidates = [
  { id: "a", text: "unrelated" },
  { id: "b", text: "the login form" },
  { id: "c", text: "also unrelated" },
];

describe("OnnxCrossEncoderReranker", () => {
  it("orders by descending score", async () => {
    const r = new OnnxCrossEncoderReranker(opts(stubSession([0.1, 0.9, 0.2])));
    expect(await r.rerank("login", candidates)).toEqual(["b", "c", "a"]);
  });

  it("returns [] for no candidates without touching the session", async () => {
    let ran = false;
    const r = new OnnxCrossEncoderReranker(
      opts({
        async run() {
          ran = true;
          return {};
        },
      }),
    );
    expect(await r.rerank("q", [])).toEqual([]);
    expect(ran).toBe(false);
  });

  it("returns every id exactly once", async () => {
    const r = new OnnxCrossEncoderReranker(opts(stubSession([0.5, 0.5, 0.5])));
    const out = await r.rerank("q", candidates);
    expect([...out].sort()).toEqual(["a", "b", "c"]);
  });

  it("falls back to input order when the session throws", async () => {
    const r = new OnnxCrossEncoderReranker(
      opts({
        async run() {
          throw new Error("boom");
        },
      }),
    );
    expect(await r.rerank("q", candidates)).toEqual(["a", "b", "c"]);
  });

  it("falls back to input order when the tokenizer throws", async () => {
    const r = new OnnxCrossEncoderReranker({
      ...opts(stubSession([1, 2, 3])),
      tokenizePair: () => {
        throw new Error("no tokenizer");
      },
    });
    expect(await r.rerank("q", candidates)).toEqual(["a", "b", "c"]);
  });

  it("batches without losing or reordering candidates", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, text: `t${i}` }));
    const r = new OnnxCrossEncoderReranker({
      ...opts(stubSession(many.map((_, i) => i))), // ascending -> reversed output
      batchSize: 3,
    });
    const out = await r.rerank("q", many);
    expect(out[0]).toBe("c9");
    expect(out.at(-1)).toBe("c0");
    expect(out.length).toBe(10);
  });

  it("pads a ragged batch and masks the padding", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const r = new OnnxCrossEncoderReranker({
      modelPath: "/unused",
      tokenizerPath: "/unused",
      session: {
        async run(feeds) {
          seen.push(feeds);
          const [batch] = feeds.input_ids!.dims as [number, number];
          return { logits: { data: new Float32Array(batch), dims: [batch, 1] } };
        },
      },
      tokenizePair: (_q, d) => ({
        ids: d === "short" ? [1] : [1, 2, 3],
        typeIds: d === "short" ? [0] : [0, 1, 1],
      }),
    });
    await r.rerank("q", [
      { id: "s", text: "short" },
      { id: "l", text: "longer" },
    ]);
    expect(seen[0]!.input_ids!.dims).toEqual([2, 3]);
    expect(Array.from(seen[0]!.attention_mask!.data as BigInt64Array)).toEqual([
      1n, 0n, 0n, 1n, 1n, 1n,
    ]);
  });

  it("truncates a long pair rather than throwing", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const r = new OnnxCrossEncoderReranker({
      modelPath: "/unused",
      tokenizerPath: "/unused",
      maxTokens: 4,
      session: {
        async run(feeds) {
          seen.push(feeds);
          return { logits: { data: new Float32Array(1), dims: [1, 1] } };
        },
      },
      tokenizePair: () => ({
        ids: [1, 2, 3, 4, 5, 6, 7],
        typeIds: [0, 0, 0, 1, 1, 1, 1],
      }),
    });
    await r.rerank("q", [{ id: "x", text: "y" }]);
    expect(seen[0]!.input_ids!.dims).toEqual([1, 4]);
  });
});
