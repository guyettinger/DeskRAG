/**
 * Deterministic, offline embedding provider for tests.
 *
 * Same input string -> same unit vector, every run, no network. This lets the
 * scoped-ANN and crash-recovery tests place vectors at controlled positions
 * (including a nearer *out-of-scope* vector) and assert exact behaviour.
 *
 * It also implements {@link ImageEmbeddingProvider} by hashing the raw bytes, so
 * a single fake can stand in for both text and image spaces in reconciliation.
 */

import type {
  EmbeddingProvider,
  ImageEmbeddingProvider,
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

export class FakeEmbeddingProvider
  implements EmbeddingProvider, ImageEmbeddingProvider
{
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

  async embed(inputs: string[]): Promise<Float32Array[]> {
    return inputs.map((s) => deterministicUnitVector(s, this.dimensions));
  }

  async embedImages(images: Uint8Array[]): Promise<Float32Array[]> {
    return images.map((bytes) =>
      deterministicUnitVector(`img:${bytesKey(bytes)}`, this.dimensions),
    );
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

function bytesKey(bytes: Uint8Array): string {
  // Cheap stable key: length + a rolling sum. Enough for deterministic tests.
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]! * (i + 1)) >>> 0;
  return `${bytes.length}:${sum}`;
}
