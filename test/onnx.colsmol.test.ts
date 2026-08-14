import { describe, expect, it } from "vitest";
import { ColSmolMultiVector } from "../src/embed/onnx/colsmol.js";
import { computeTileGeometry, expectedTokenCount } from "../src/embed/onnx/geometry.js";
import {
  QUERY_BUFFER_TOKENS,
  TOK,
  buildQueryPrompt,
  queryContentPositions,
} from "../src/embed/onnx/colsmol-prompt.js";
import type { OnnxSession, OnnxTensor } from "../src/embed/onnx/runtime.js";

const D = 128;
const SIDE = 512;

/**
 * Encodes each sequence position as a ONE-HOT vector at (p % D). One-hot
 * survives L2 normalisation, so the caller can recover which positions were
 * selected — the thing most likely to be wrong, since the model emits a vector
 * for every position and only the <image> ones are patches.
 */
function stubSession(seen: Record<string, OnnxTensor>[]): OnnxSession {
  return {
    async run(feeds) {
      seen.push(feeds);
      const [, seq] = feeds.input_ids!.dims as [number, number];
      const data = new Float32Array(seq * D);
      for (let p = 0; p < seq; p++) data[p * D + (p % D)] = 1;
      return { embeddings: { data, dims: [1, seq, D] } };
    },
  };
}

/** Recover the encoded position from a one-hot vector. */
function hotIndex(v: Float32Array): number {
  return v.findIndex((x) => x > 0.5);
}

/** Tiler stub reporting a 1280x800 frame — 13 tiles — without loading sharp. */
const fakeTiler = (w = 1280, h = 800) => {
  const g = computeTileGeometry(w, h);
  const n = g.cols * g.rows + (g.hasGlobalTile ? 1 : 0);
  return async () => ({
    tiles: Array.from({ length: n }, () => new Float32Array(3 * SIDE * SIDE)),
    width: w,
    height: h,
  });
};

const opts = (session: OnnxSession, tiler = fakeTiler()) => ({
  modelPath: "/unused",
  tokenizerPath: "/unused",
  session,
  tileImage: tiler,
  tokenize: (t: string) => ({ ids: [...t].map((c) => c.charCodeAt(0)) }),
});

describe("ColSmolMultiVector", () => {
  it("namespaces as a 128-dim multivector provider", () => {
    const p = new ColSmolMultiVector(opts(stubSession([])));
    expect(p.id).toBe("onnx");
    expect(p.model).toBe("colsmol-256m");
    expect(p.dimensions).toBe(128);
    expect(p.multiVector).toBe(true);
    expect(p.model).not.toContain(":");
  });

  it("returns one vector per image token for a 1280x800 frame", async () => {
    const p = new ColSmolMultiVector(opts(stubSession([])));
    const [set] = await p.embedImages([Uint8Array.from([1, 2, 3])]);
    expect(set!.length).toBe(832); // 13 tiles x 64
    expect(set!.length).toBe(expectedTokenCount(computeTileGeometry(1280, 800)));
    expect(set![0]!.length).toBe(D);
  });

  it("selects the IMAGE-token positions, not the leading sequence positions", async () => {
    const p = new ColSmolMultiVector(opts(stubSession([])));
    const [set] = await p.embedImages([Uint8Array.from([1, 2, 3])]);

    // The first image token sits at sequence index 5: <|im_start|> User : then
    // <fake_token_around_image> <row_1_col_1>. Taking position 0 instead would
    // silently embed the chat prefix as if it were a patch.
    expect(hotIndex(set![0]!)).toBe(5 % D);
    // The next 63 are contiguous, then the run breaks for the next tile's
    // fake + marker pair — proving markers are skipped, not swept up.
    expect(hotIndex(set![1]!)).toBe(6 % D);
    expect(hotIndex(set![63]!)).toBe(68 % D);
    expect(hotIndex(set![64]!)).toBe(71 % D); // 69,70 are fake + marker
  });

  it("feeds the model a 4-input contract with matching tile count", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColSmolMultiVector(opts(stubSession(seen)));
    await p.embedImages([Uint8Array.from([1, 2, 3])]);
    const f = seen[0]!;
    expect(Object.keys(f).sort()).toEqual([
      "attention_mask",
      "input_ids",
      "pixel_attention_mask",
      "pixel_values",
    ]);
    expect(f.input_ids!.dims).toEqual([1, 874]);
    expect(f.pixel_values!.dims).toEqual([1, 13, 3, SIDE, SIDE]);
    expect(f.pixel_attention_mask!.dims).toEqual([1, 13, SIDE, SIDE]);
  });

  it("returns unit-length vectors", async () => {
    const p = new ColSmolMultiVector(opts(stubSession([])));
    const [set] = await p.embedImages([Uint8Array.from([1, 2, 3])]);
    for (const v of set!.slice(0, 20)) {
      const n = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));
      expect(n).toBeCloseTo(1, 5);
    }
  });

  it("throws when the tiler disagrees with the geometry", async () => {
    const wrongTiler = async () => ({
      tiles: [new Float32Array(3 * SIDE * SIDE)], // 1 tile, geometry says 13
      width: 1280,
      height: 800,
    });
    const p = new ColSmolMultiVector(opts(stubSession([]), wrongTiler));
    await expect(p.embedImages([Uint8Array.from([1])])).rejects.toThrow(/tiling mismatch/i);
  });

  it("adapts to a different frame shape", async () => {
    const p = new ColSmolMultiVector(opts(stubSession([]), fakeTiler(512, 512)));
    const [set] = await p.embedImages([Uint8Array.from([1])]);
    expect(set!.length).toBe(17 * 64); // 4x4 grid + global
  });

  it("embeds a query as query tokens plus the buffer, with a dummy tile", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColSmolMultiVector(opts(stubSession(seen)));
    const [q] = await p.embedQueries(["abc"]);
    expect(q!.length).toBe(3 + QUERY_BUFFER_TOKENS);
    const f = seen[0]!;
    expect(f.pixel_values!.dims).toEqual([1, 1, 3, SIDE, SIDE]); // one dummy tile
    const ids = Array.from(f.input_ids!.data as BigInt64Array).map(Number);
    expect(ids.slice(-QUERY_BUFFER_TOKENS).every((t) => t === TOK.endOfUtterance)).toBe(true);
  });

  it("keeps every query position, buffer tokens included", async () => {
    const p = new ColSmolMultiVector(opts(stubSession([])));
    const [q] = await p.embedQueries(["a longer query"]);
    expect(q!.length).toBe("a longer query".length + QUERY_BUFFER_TOKENS);
  });

  it("returns [] for empty input without touching the session", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColSmolMultiVector(opts(stubSession(seen)));
    expect(await p.embedImages([])).toEqual([]);
    expect(await p.embedQueries([])).toEqual([]);
    expect(seen.length).toBe(0);
  });
});

describe("queryContentPositions (colsmol)", () => {
  it("names the query's own tokens, which start at position 0 — there is no wrapper", () => {
    const queryIds = [111, 222, 333];
    const ids = buildQueryPrompt(queryIds);
    const positions = queryContentPositions(queryIds);
    expect(positions).toEqual([0, 1, 2]);
    expect(positions.map((p) => ids[p])).toEqual(queryIds);
    expect(ids.length).toBe(queryIds.length + QUERY_BUFFER_TOKENS);
  });

  it("excludes every buffer token", () => {
    const ids = buildQueryPrompt([111, 222]);
    const positions = new Set(queryContentPositions([111, 222]));
    for (let i = 0; i < ids.length; i++) {
      expect(positions.has(i)).toBe(ids[i] !== TOK.endOfUtterance);
    }
  });

  it("returns nothing for an empty query", () => {
    expect(queryContentPositions([])).toEqual([]);
  });
});
