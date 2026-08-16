import { describe, expect, it } from "vitest";
import { NOMIC_PREFIX, OnnxTextEmbedding } from "../src/embed/onnx/text.js";
import { textProfile } from "../src/embed/text-profiles.js";
import type { OnnxSession, OnnxTensor } from "../src/embed/onnx/runtime.js";

/**
 * Records feeds and returns a hidden state of all-ones so pooling is predictable.
 *
 * Enforces the REAL input contract: nomic's export declares input_ids,
 * token_type_ids and attention_mask as required, and a permissive stub let a
 * missing token_type_ids ship — it only surfaced against real weights.
 */
const REQUIRED_INPUTS = ["input_ids", "token_type_ids", "attention_mask"] as const;

function stubSession(seen: Record<string, OnnxTensor>[]): OnnxSession {
  return {
    async run(feeds) {
      for (const name of REQUIRED_INPUTS) {
        if (!feeds[name]) throw new Error(`input '${name}' is missing in 'feeds'.`);
      }
      seen.push(feeds);
      const [batch, seq] = feeds.input_ids!.dims as [number, number];
      const dims = 4;
      return {
        last_hidden_state: {
          data: Float32Array.from({ length: batch * seq * dims }, () => 1),
          dims: [batch, seq, dims],
        },
      };
    },
  };
}

const opts = (session: OnnxSession) => ({
  modelPath: "/unused",
  tokenizerPath: "/unused",
  dimensions: 4,
  session,
  // deterministic stand-in for the real tokenizer
  tokenize: (text: string) => ({
    ids: [...text].slice(0, 6).map((c) => c.charCodeAt(0)),
  }),
});

describe("OnnxTextEmbedding", () => {
  it("namespaces without a colon in the model id", () => {
    const e = new OnnxTextEmbedding(opts(stubSession([])));
    expect(e.id).toBe("onnx");
    expect(e.model).toBe("nomic-embed-text-v1.5");
    expect(e.model).not.toContain(":");
  });

  it("prefixes documents by default and queries when asked", async () => {
    const texts: string[] = [];
    const e = new OnnxTextEmbedding({
      ...opts(stubSession([])),
      tokenize: (text: string) => {
        texts.push(text);
        return { ids: [1, 2, 3] };
      },
    });
    await e.embed(["hello"]);
    await e.embed(["hello"], { role: "query" });
    expect(texts[0]).toBe(`${NOMIC_PREFIX.document}hello`);
    expect(texts[1]).toBe(`${NOMIC_PREFIX.query}hello`);
  });

  it("returns one unit-length vector per input", async () => {
    const e = new OnnxTextEmbedding(opts(stubSession([])));
    const out = await e.embed(["a", "bb"]);
    expect(out.length).toBe(2);
    for (const v of out) {
      expect(v.length).toBe(4);
      const norm = Math.sqrt(Array.from(v).reduce((n, x) => n + x * x, 0));
      expect(norm).toBeCloseTo(1, 5);
    }
  });

  it("pads a ragged batch to the longest sequence and masks the padding", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const e = new OnnxTextEmbedding({
      ...opts(stubSession(seen)),
      // NB: the tokenizer sees the PREFIXED text, e.g. "search_document: short".
      tokenize: (t: string) => ({ ids: t.includes("short") ? [1] : [1, 2, 3, 4] }),
    });
    await e.embed(["short", "longer"]);
    expect(seen[0]!.input_ids!.dims).toEqual([2, 4]);
    const mask = Array.from(seen[0]!.attention_mask!.data as BigInt64Array);
    expect(mask).toEqual([1n, 0n, 0n, 0n, 1n, 1n, 1n, 1n]);
  });

  it("truncates input beyond maxTokens instead of throwing", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const e = new OnnxTextEmbedding({
      ...opts(stubSession(seen)),
      maxTokens: 3,
      tokenize: () => ({ ids: [1, 2, 3, 4, 5, 6, 7, 8] }),
    });
    await e.embed(["anything long"]);
    expect(seen[0]!.input_ids!.dims).toEqual([1, 3]);
  });

  it("sends token_type_ids, which nomic's export requires", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const e = new OnnxTextEmbedding(opts(stubSession(seen)));
    await e.embed(["hello"]);
    expect(Object.keys(seen[0]!).sort()).toEqual([
      "attention_mask",
      "input_ids",
      "token_type_ids",
    ]);
    // Single sequence -> all zeros, same shape as the ids.
    expect(seen[0]!.token_type_ids!.dims).toEqual(seen[0]!.input_ids!.dims);
    expect(
      Array.from(seen[0]!.token_type_ids!.data as BigInt64Array).every((v) => v === 0n),
    ).toBe(true);
  });

  it("returns [] for no inputs without touching the session", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const e = new OnnxTextEmbedding(opts(stubSession(seen)));
    expect(await e.embed([])).toEqual([]);
    expect(seen.length).toBe(0);
  });
});

/**
 * The second shape of text export: the graph already did the pooling.
 *
 * EmbeddingGemma's ONNX export bakes mean-pooling, both sentence-transformers
 * Dense heads and normalization in, and emits `sentence_embedding`. Feeding
 * `last_hidden_state` through meanPool here would silently return the PRE-Dense
 * representation — right length, plausible cosines, wrong space. Gemma3 has no
 * segment embeddings either, so token_type_ids must NOT be sent.
 */
describe("OnnxTextEmbedding — a graph-pooled export", () => {
  /** Rejects token_type_ids the way an export without that input would. */
  function pooledSession(seen: Record<string, OnnxTensor>[]): OnnxSession {
    return {
      async run(feeds) {
        if (feeds.token_type_ids) {
          throw new Error("Invalid input name: token_type_ids");
        }
        seen.push(feeds);
        const [batch] = feeds.input_ids!.dims as [number, number];
        const dims = 4;
        // Deliberately NOT unit length: the adapter must not assume.
        return {
          sentence_embedding: {
            data: Float32Array.from({ length: batch * dims }, () => 3),
            dims: [batch, dims],
          },
        };
      },
    };
  }

  const gemmaOpts = (session: OnnxSession) => ({
    modelPath: "/unused",
    tokenizerPath: "/unused",
    profile: textProfile("embeddinggemma-300m"),
    dimensions: 4,
    session,
    tokenize: (text: string) => ({ ids: [...text].slice(0, 6).map((c) => c.charCodeAt(0)) }),
  });

  it("omits token_type_ids, which this export does not declare", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const e = new OnnxTextEmbedding(gemmaOpts(pooledSession(seen)));
    await e.embed(["hello"]);
    expect(Object.keys(seen[0]!).sort()).toEqual(["attention_mask", "input_ids"]);
  });

  it("reads sentence_embedding rather than pooling last_hidden_state", async () => {
    const e = new OnnxTextEmbedding(gemmaOpts(pooledSession([])));
    const out = await e.embed(["a", "bb"]);
    expect(out.length).toBe(2);
    // One vector per INPUT, not one per token — the graph already reduced.
    for (const v of out) expect(v.length).toBe(4);
  });

  it("normalizes the graph's output rather than trusting it to be unit length", async () => {
    const e = new OnnxTextEmbedding(gemmaOpts(pooledSession([])));
    const [v] = await e.embed(["hello"]);
    const norm = Math.sqrt(Array.from(v!).reduce((n, x) => n + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("applies this model's own prefixes, not nomic's", async () => {
    const texts: string[] = [];
    const e = new OnnxTextEmbedding({
      ...gemmaOpts(pooledSession([])),
      tokenize: (text: string) => {
        texts.push(text);
        return { ids: [1, 2, 3] };
      },
    });
    await e.embed(["hello"]);
    await e.embed(["hello"], { role: "query" });
    expect(texts[0]).toBe("title: none | text: hello");
    expect(texts[1]).toBe("task: search result | query: hello");
  });

  it("takes its model id and dimensions from the profile", () => {
    const e = new OnnxTextEmbedding({
      modelPath: "/unused",
      tokenizerPath: "/unused",
      profile: textProfile("embeddinggemma-300m"),
      session: pooledSession([]),
      tokenize: () => ({ ids: [1] }),
    });
    expect(e.model).toBe("embeddinggemma-300m");
    expect(e.dimensions).toBe(768);
  });
});
