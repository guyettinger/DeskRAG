/**
 * ColSmol-256M late-interaction embeddings via onnxruntime-node.
 *
 * NOT in the package barrel — loads onnxruntime-node and (via the tiler) sharp.
 * Import from this path directly.
 *
 * ONNX I/O contract, verified with scripts/inspect-onnx.mjs:
 *   inputs : input_ids, attention_mask, pixel_values, pixel_attention_mask
 *   output : embeddings  [batch, seq, 128]
 *
 * Two consequences that shape this file:
 *
 *   1. `input_ids` is required even to embed an IMAGE. Patches are placeholder
 *      tokens inside a templated sequence (see colsmol-prompt.ts), so pixels
 *      alone are not a valid call.
 *   2. The output covers the WHOLE sequence, most of which is text. Patch
 *      vectors are the positions where input_ids == <image>, in order — which is
 *      what makes patchIndexToBox applicable to the selected vectors.
 *
 * The stock export at onnx-community/colSmol-256M-ONNX is traced at exactly 13
 * tiles and rejects anything else; use scripts/export-colsmol.py to produce a
 * dynamic one.
 */

import { readFile } from "node:fs/promises";
import type { MultiVectorProvider, QueryEmbedding } from "../types.js";
import { l2Normalize } from "./pooling.js";
import {
  DEFAULT_TILE_CONFIG,
  computeTileGeometry,
  expectedTokenCount,
  type TileConfig,
  type TiledImage,
} from "./geometry.js";
import {
  buildImagePrompt,
  buildQueryPrompt,
  imageTokenPositions,
  queryContentPositions,
} from "./colsmol-prompt.js";
import { OnnxRuntime, makeTensor, type OnnxSession } from "./runtime.js";
import { defaultConfigPath, loadTokenizer } from "./tokenizer.js";

export interface ColSmolOptions {
  modelPath: string;
  tokenizerPath: string;
  tokenizerConfigPath?: string;
  /** preprocessor_config.json + config.json, to read tiling rather than assume it. */
  preprocessorPath?: string;
  configPath?: string;
  model?: string;
  dimensions?: number;
  tileConfig?: TileConfig;
  /** Injected session (tests). */
  session?: OnnxSession;
  /** Injected tokenizer (tests). */
  tokenize?: (text: string) => { ids: number[] };
  /** Injected tiler (tests) — avoids loading sharp. */
  tileImage?: (image: Uint8Array, cfg: TileConfig) => Promise<TiledImage>;
}

/** Read tiling parameters from the model's own config files. */
export async function readTileConfig(
  preprocessorPath: string,
  configPath: string,
): Promise<TileConfig> {
  const [preRaw, cfgRaw] = await Promise.all([
    readFile(preprocessorPath, "utf8"),
    readFile(configPath, "utf8"),
  ]);
  const pre = JSON.parse(preRaw) as {
    size?: { longest_edge?: number };
    max_image_size?: { longest_edge?: number };
  };
  const cfg = JSON.parse(cfgRaw) as {
    vision_config?: { patch_size?: number };
    text_config?: { pixel_shuffle_factor?: number };
  };
  return {
    maxEdge: pre.size?.longest_edge ?? DEFAULT_TILE_CONFIG.maxEdge,
    tileSize: pre.max_image_size?.longest_edge ?? DEFAULT_TILE_CONFIG.tileSize,
    patchSize: cfg.vision_config?.patch_size ?? DEFAULT_TILE_CONFIG.patchSize,
    shuffleFactor:
      cfg.text_config?.pixel_shuffle_factor ?? DEFAULT_TILE_CONFIG.shuffleFactor,
    globalTile: true,
  };
}

export class ColSmolMultiVector implements MultiVectorProvider {
  readonly id = "onnx";
  readonly model: string;
  readonly dimensions: number;
  readonly multiVector = true as const;
  readonly tileConfig: TileConfig;

  private readonly modelPath: string;
  private readonly tokenizerPath: string;
  private readonly tokenizerConfigPath: string;
  private readonly injectedSession: OnnxSession | undefined;
  private readonly injectedTokenize: ((t: string) => { ids: number[] }) | undefined;
  private readonly injectedTiler: ColSmolOptions["tileImage"];
  private loadedTokenizer: Promise<(t: string) => { ids: number[] }> | undefined;

  constructor(opts: ColSmolOptions) {
    this.model = opts.model ?? "colsmol-256m";
    this.dimensions = opts.dimensions ?? 128;
    this.tileConfig = opts.tileConfig ?? DEFAULT_TILE_CONFIG;
    this.modelPath = opts.modelPath;
    this.tokenizerPath = opts.tokenizerPath;
    this.tokenizerConfigPath =
      opts.tokenizerConfigPath ?? defaultConfigPath(opts.tokenizerPath);
    this.injectedSession = opts.session;
    this.injectedTokenize = opts.tokenize;
    this.injectedTiler = opts.tileImage;
  }

  private session(): Promise<OnnxSession> {
    return this.injectedSession
      ? Promise.resolve(this.injectedSession)
      : OnnxRuntime.session(this.modelPath);
  }

  /** Ids only — ColSmol's prompt builder handles the special tokens itself. */
  private async tokenizer(): Promise<(t: string) => { ids: number[] }> {
    if (this.injectedTokenize) return this.injectedTokenize;
    this.loadedTokenizer ??= (async () => {
      const tok = await loadTokenizer(this.tokenizerPath, this.tokenizerConfigPath);
      return (t: string) => ({ ids: tok.encode(t).ids });
    })();
    return this.loadedTokenizer;
  }

  private async tile(image: Uint8Array): Promise<TiledImage> {
    if (this.injectedTiler) return this.injectedTiler(image, this.tileConfig);
    const { tileImageWithSharp } = await import(/* @vite-ignore */ "./colsmol-tiler.js");
    return tileImageWithSharp(image, this.tileConfig);
  }

  /** Run one sequence and return the per-position vectors at `positions`. */
  private async runAndSelect(
    ids: number[],
    pixels: Float32Array,
    tileCount: number,
    positions: number[] | null,
  ): Promise<Float32Array[]> {
    const seq = ids.length;
    const side = this.tileConfig.tileSize;
    const sess = await this.session();

    const out = await sess.run({
      input_ids: makeTensor("int64", BigInt64Array.from(ids.map((n) => BigInt(n))), [1, seq]),
      attention_mask: makeTensor(
        "int64",
        BigInt64Array.from(new Array<bigint>(seq).fill(1n)),
        [1, seq],
      ),
      pixel_values: makeTensor("float32", pixels, [1, tileCount, 3, side, side]),
      pixel_attention_mask: makeTensor(
        "int64",
        BigInt64Array.from(new Array<bigint>(tileCount * side * side).fill(1n)),
        [1, tileCount, side, side],
      ),
    });

    const emb = (out.embeddings ?? Object.values(out)[0]!) as {
      data: Float32Array;
      dims: number[];
    };
    const dims = emb.dims[emb.dims.length - 1]!;
    const take = positions ?? Array.from({ length: seq }, (_, i) => i);
    return take.map((p) =>
      l2Normalize(emb.data.slice(p * dims, (p + 1) * dims)),
    );
  }

  async embedImages(images: Uint8Array[]): Promise<Float32Array[][]> {
    if (images.length === 0) return [];
    const side = this.tileConfig.tileSize;
    const results: Float32Array[][] = [];

    // One image per run: tile count varies with aspect ratio, so batching would
    // need padding plus a mask over patch positions.
    for (const image of images) {
      const tiled = await this.tile(image);
      const geo = computeTileGeometry(tiled.width, tiled.height, this.tileConfig);
      const expectedTiles = geo.cols * geo.rows + (geo.hasGlobalTile ? 1 : 0);
      if (tiled.tiles.length !== expectedTiles) {
        throw new Error(
          `ColSmol tiling mismatch: tiler produced ${tiled.tiles.length} tiles, ` +
            `geometry predicts ${expectedTiles} for ${tiled.width}x${tiled.height} ` +
            `(${geo.cols}x${geo.rows}${geo.hasGlobalTile ? " + global" : ""}).`,
        );
      }

      const pixels = new Float32Array(tiled.tiles.length * 3 * side * side);
      tiled.tiles.forEach((t, i) => pixels.set(t, i * 3 * side * side));

      const ids = buildImagePrompt(geo);
      const positions = imageTokenPositions(ids);
      const expectedTokens = expectedTokenCount(geo);
      if (positions.length !== expectedTokens) {
        throw new Error(
          `ColSmol prompt mismatch: ${positions.length} image tokens, ` +
            `geometry predicts ${expectedTokens}.`,
        );
      }

      results.push(
        await this.runAndSelect(ids, pixels, tiled.tiles.length, positions),
      );
    }
    return results;
  }

  async embedQueries(texts: string[]): Promise<QueryEmbedding[]> {
    if (texts.length === 0) return [];
    const tokenize = await this.tokenizer();
    const side = this.tileConfig.tileSize;
    // The graph declares pixel inputs as required, but a query carries no image.
    // One zero tile satisfies the signature; with no <image> tokens in the
    // prompt its vision output is never merged into the sequence.
    const dummy = new Float32Array(3 * side * side);

    const results: QueryEmbedding[] = [];
    for (const text of texts) {
      const queryIds = tokenize(text).ids;
      const ids = buildQueryPrompt(queryIds);
      // Every query position is kept, buffer tokens included: those are the
      // learned expansion slots late interaction relies on. WHICH of them are
      // the user's words is reported separately, for highlighting.
      results.push({
        vectors: await this.runAndSelect(ids, dummy, 1, null),
        contentIndices: queryContentPositions(queryIds),
      });
    }
    return results;
  }
}
