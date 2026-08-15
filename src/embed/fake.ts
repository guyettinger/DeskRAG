/**
 * Deterministic, offline embedding provider for tests.
 *
 * Same input string -> same unit vector, every run, no network. This lets the
 * scoped-ANN and crash-recovery tests place vectors at controlled positions
 * (including a nearer *out-of-scope* vector) and assert exact behaviour.
 *
 The multivector fake below is the image side; there is no single-vector image
 * provider any more, in the fakes or anywhere else.
 */

import {
  DEFAULT_TILE_CONFIG,
  computeTileGeometry,
  expectedTokenCount,
  type TileConfig,
} from "./onnx/geometry.js";
import type {
  EmbedOptions,
  EmbeddingProvider,
  MultiVectorProvider,
  QueryEmbedding,
} from "./types.js";

/** xmur3 string hasher -> seed for a small PRNG. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deterministicUnitVector(seedStr: string, dims: number): Float32Array {
  const seed = xmur3(seedStr)();
  const rand = mulberry32(seed);
  const v = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    // Box-Muller-ish spread via two uniforms; sign centered on 0.
    const x = rand() * 2 - 1;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i]! /= norm;
  return v;
}

export interface FakeEmbeddingOptions {
  id?: string;
  model?: string;
  dimensions?: number;
  sharedTextSpace?: boolean;
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  readonly sharedTextSpace: boolean;

  constructor(opts: FakeEmbeddingOptions = {}) {
    this.id = opts.id ?? "fake";
    this.model = opts.model ?? "fake-embed-v1";
    this.dimensions = opts.dimensions ?? 8;
    this.sharedTextSpace = opts.sharedTextSpace ?? true;
  }

  /**
   * `opts` is accepted and ignored: the fake stays a pure function of its input
   * so tests can place exact-match items at controlled positions regardless of
   * document/query role.
   */
  async embed(inputs: string[], _opts?: EmbedOptions): Promise<Float32Array[]> {
    return inputs.map((s) => deterministicUnitVector(s, this.dimensions));
  }

  /**
   * Escape hatch for tests that need a specific vector at a specific position
   * (e.g. the nearer out-of-scope frame). Not part of the provider interface.
   */
  fixedVector(values: number[]): Float32Array {
    if (values.length !== this.dimensions) {
      throw new Error(
        `fixedVector length ${values.length} != dimensions ${this.dimensions}`,
      );
    }
    return Float32Array.from(values);
  }
}

/**
 * Deterministic multivector fake. Every vector is a stable function of the input
 * and its index, so a query built from the same bytes MaxSim-matches exactly.
 *
 * An IMAGE gets a geometry-consistent patch set — `expectedTokenCount` vectors
 * for the declared frame size — while a QUERY gets `queryVectorCount`. That
 * asymmetry is the real shape, and it is load-bearing: the highlighter REJECTS a
 * patch count that disagrees with the grid it computed, so a fake emitting four
 * patches for a 1280x800 frame silently produced no highlights at all. The frame
 * size is declared rather than read from the bytes because the bytes are fake.
 */
export class FakeMultiVectorProvider implements MultiVectorProvider {
  readonly id = "fake";
  readonly model = "fake-mv";
  readonly multiVector = true as const;
  /**
   * Overridable so a test can declare a geometry that is DELIBERATELY not the
   * default — which is the only way to assert that the highlighter reads the
   * provider's config rather than `DEFAULT_TILE_CONFIG`. With both the same,
   * the wrong code and the right code produce identical boxes.
   */
  readonly tileConfig: TileConfig;
  /** How many patches an image gets: the token count for this declared size. */
  private readonly patchCount: number;

  constructor(
    readonly dimensions = 128,
    private readonly queryVectorCount = 4,
    opts: {
      tileConfig?: TileConfig;
      /** The size every fake image pretends to be. 1280x800 and 1920x1080 both
       *  tile 4x3, so one default serves the frames the suite actually uses. */
      frameWidth?: number;
      frameHeight?: number;
    } = {},
  ) {
    this.tileConfig = opts.tileConfig ?? DEFAULT_TILE_CONFIG;
    this.patchCount = expectedTokenCount(
      computeTileGeometry(opts.frameWidth ?? 1280, opts.frameHeight ?? 800, this.tileConfig),
    );
  }

  private setFor(seed: string, n: number): Float32Array[] {
    return Array.from({ length: n }, (_, k) =>
      deterministicUnitVector(`${seed}#${k}`, this.dimensions),
    );
  }

  async embedImages(images: Uint8Array[]): Promise<Float32Array[][]> {
    return images.map((bytes) => this.setFor(`img:${bytesKey(bytes)}`, this.patchCount));
  }

  async embedQueries(texts: string[]): Promise<QueryEmbedding[]> {
    return texts.map((t) => ({
      vectors: this.setFor(`txt:${t}`, this.queryVectorCount),
      // The fake builds no prompt, so it declares the smallest honest shape: the
      // FIRST vector stands for the query's words and the rest for padding. A
      // fake whose every vector was content is what let the highlight bug ship
      // — every highlight test agreed with the code because both assumed it.
      contentIndices: [0],
    }));
  }
}

function bytesKey(bytes: Uint8Array): string {
  // Cheap stable key: length + a rolling sum. Enough for deterministic tests.
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]! * (i + 1)) >>> 0;
  return `${bytes.length}:${sum}`;
}
