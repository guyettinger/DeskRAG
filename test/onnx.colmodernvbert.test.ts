import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ColModernVBertMultiVector,
  readTileConfig,
} from "../src/embed/onnx/colmodernvbert.js";
import { computeTileGeometry, expectedTokenCount } from "../src/embed/onnx/geometry.js";
import { MV_TOK, QUERY_BUFFER_TOKENS } from "../src/embed/onnx/colmodernvbert-prompt.js";
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

describe("ColModernVBertMultiVector", () => {
  it("namespaces itself apart from ColSmol", () => {
    const p = new ColModernVBertMultiVector(opts(stubSession([])));
    expect(p.id).toBe("onnx");
    expect(p.model).toBe("colmodernvbert-250m");
    expect(p.dimensions).toBe(128);
    expect(p.multiVector).toBe(true);
    expect(p.model).not.toContain(":");
  });

  it("returns one vector per patch the geometry predicts", async () => {
    const p = new ColModernVBertMultiVector(opts(stubSession([])));
    const [patches] = await p.embedImages([Uint8Array.from([1, 2, 3])]);
    expect(patches!.length).toBe(832); // 13 tiles x 64
    expect(patches!.length).toBe(expectedTokenCount(computeTileGeometry(1280, 800)));
    expect(patches![0]!.length).toBe(D);
  });

  it("selects the IMAGE positions, not the leading positions", async () => {
    const p = new ColModernVBertMultiVector(opts(stubSession([])));
    const [patches] = await p.embedImages([Uint8Array.from([1, 2, 3])]);

    // The first image token sits at index 13: [CLS], ten prefix tokens, then
    // <fake_token_around_image> <row_1_col_1>. Taking position 0 instead would
    // silently embed the chat prefix as if it were a patch.
    const first = 1 + MV_TOK.prefix.length + 2;
    expect(first).toBe(13);
    expect(hotIndex(patches![0]!)).toBe(first % D);
    // The next 63 are contiguous, then the run breaks for the next tile's
    // fake + marker pair — proving markers are skipped, not swept up.
    expect(hotIndex(patches![1]!)).toBe((first + 1) % D);
    expect(hotIndex(patches![63]!)).toBe((first + 63) % D);
    expect(hotIndex(patches![64]!)).toBe((first + 66) % D);
  });

  it("feeds three inputs and NO pixel_attention_mask", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    await p.embedImages([Uint8Array.from([1])]);
    expect(Object.keys(seen[0]!).sort()).toEqual([
      "attention_mask",
      "input_ids",
      "pixel_values",
    ]);
  });

  it("feeds pixel_values as (1, tiles, 3, side, side) with the measured seq length", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    await p.embedImages([Uint8Array.from([1])]);
    expect(seen[0]!.input_ids!.dims).toEqual([1, 884]);
    expect(seen[0]!.pixel_values!.dims).toEqual([1, 13, 3, SIDE, SIDE]);
    expect(seen[0]!.attention_mask!.dims).toEqual([1, 884]);
  });

  it("returns unit-length vectors", async () => {
    const p = new ColModernVBertMultiVector(opts(stubSession([])));
    const [patches] = await p.embedImages([Uint8Array.from([1])]);
    for (const v of patches!.slice(0, 20)) {
      const n = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));
      expect(n).toBeCloseTo(1, 5);
    }
  });

  it("throws when the tiler disagrees with the geometry", async () => {
    const badTiler = async () => ({
      tiles: [new Float32Array(3 * SIDE * SIDE)], // 1 tile, geometry says 13
      width: 1280,
      height: 800,
    });
    const p = new ColModernVBertMultiVector(opts(stubSession([]), badTiler));
    await expect(p.embedImages([Uint8Array.from([1])])).rejects.toThrow(/tiling mismatch/i);
  });

  it("adapts to a different frame shape", async () => {
    const p = new ColModernVBertMultiVector(opts(stubSession([]), fakeTiler(512, 512)));
    const [patches] = await p.embedImages([Uint8Array.from([1])]);
    expect(patches!.length).toBe(17 * 64); // 4x4 grid + global
  });

  it("keeps every query position, buffer tokens and wrapper included", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    const [q] = await p.embedQueries(["abc"]);
    expect(q!.length).toBe(3 + QUERY_BUFFER_TOKENS + 2);
    const ids = Array.from(seen[0]!.input_ids!.data as BigInt64Array).map(Number);
    expect(ids[0]).toBe(MV_TOK.cls);
    expect(ids[ids.length - 1]).toBe(MV_TOK.sep);
    expect(ids.slice(-1 - QUERY_BUFFER_TOKENS, -1).every((t) => t === MV_TOK.endOfUtterance)).toBe(
      true,
    );
  });

  it("feeds exactly one dummy tile for a query", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    await p.embedQueries(["abc"]);
    expect(seen[0]!.pixel_values!.dims).toEqual([1, 1, 3, SIDE, SIDE]);
  });

  it("puts no image token in a query, so nothing is selected as a patch", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    await p.embedQueries(["abc"]);
    const ids = Array.from(seen[0]!.input_ids!.data as BigInt64Array).map(Number);
    expect(ids.includes(MV_TOK.image)).toBe(false);
  });

  it("returns [] for empty input without touching the session", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    expect(await p.embedImages([])).toEqual([]);
    expect(await p.embedQueries([])).toEqual([]);
    expect(seen.length).toBe(0);
  });
});

describe("readTileConfig", () => {
  const write = (pre: unknown, cfg: unknown): [string, string] => {
    const dir = mkdtempSync(join(tmpdir(), "cmv-cfg-"));
    const a = join(dir, "preprocessor_config.json");
    const b = join(dir, "config.json");
    writeFileSync(a, JSON.stringify(pre));
    writeFileSync(b, JSON.stringify(cfg));
    return [a, b];
  };

  it("reads pixel_shuffle_factor from the TOP level, where this model puts it", async () => {
    // The whole reason this function is not ColSmol's: ColSmol nests the field
    // under text_config, ColModernVBERT does not. Reusing ColSmol's reader falls
    // through to the default — which is also 4, so it would be right by luck and
    // wrong the moment either export changes.
    const [pre, cfg] = write(
      { size: { longest_edge: 2048 }, max_image_size: { longest_edge: 512 } },
      { vision_config: { patch_size: 16 }, pixel_shuffle_factor: 3 },
    );
    expect(await readTileConfig(pre, cfg)).toEqual({
      maxEdge: 2048,
      tileSize: 512,
      patchSize: 16,
      shuffleFactor: 3,
      globalTile: true,
    });
  });

  it("still accepts the nested spelling", async () => {
    const [pre, cfg] = write(
      { size: { longest_edge: 1024 }, max_image_size: { longest_edge: 256 } },
      { vision_config: { patch_size: 8 }, text_config: { pixel_shuffle_factor: 2 } },
    );
    const c = await readTileConfig(pre, cfg);
    expect(c.shuffleFactor).toBe(2);
    expect(c.maxEdge).toBe(1024);
    expect(c.tileSize).toBe(256);
    expect(c.patchSize).toBe(8);
  });

  it("falls back to the defaults field by field", async () => {
    const [pre, cfg] = write({}, {});
    expect(await readTileConfig(pre, cfg)).toEqual({
      maxEdge: 2048,
      tileSize: 512,
      patchSize: 16,
      shuffleFactor: 4,
      globalTile: true,
    });
  });

  it("matches the real ColModernVBERT geometry: 13 tiles for a 1280x800 frame", async () => {
    const [pre, cfg] = write(
      {
        image_processor_type: "Idefics3ImageProcessor",
        size: { longest_edge: 2048 },
        max_image_size: { longest_edge: 512 },
      },
      { vision_config: { image_size: 512, patch_size: 16 }, pixel_shuffle_factor: 4 },
    );
    const g = computeTileGeometry(1280, 800, await readTileConfig(pre, cfg));
    expect(g.cols * g.rows + (g.hasGlobalTile ? 1 : 0)).toBe(13);
    expect(g.tokensPerTile).toBe(64);
  });
});

describe("ColModernVBertMultiVector — empty input", () => {
  it("touches nothing", async () => {
    const seen: Record<string, OnnxTensor>[] = [];
    const p = new ColModernVBertMultiVector(opts(stubSession(seen)));
    expect(await p.embedImages([])).toEqual([]);
    expect(await p.embedQueries([])).toEqual([]);
    expect(seen.length).toBe(0);
  });
});
