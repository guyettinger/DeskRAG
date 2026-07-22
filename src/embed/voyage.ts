/**
 * Voyage AI adapters.
 *  - VoyageTextEmbedding:  voyage-3 (1024-dim text).
 *  - VoyageImageEmbedding: voyage-multimodal-3 (1024-dim), sharedTextSpace=true
 *    so text queries can hit image vectors directly.
 * Requires VOYAGE_API_KEY.
 */

import type { EmbeddingProvider, ImageEmbeddingProvider } from "./types.js";

const BASE = "https://api.voyageai.com/v1";

function keyOrThrow(explicit?: string): string {
  const key = explicit ?? process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY not set");
  return key;
}

export interface VoyageOptions {
  model?: string;
  dimensions?: number;
  apiKey?: string;
}

export class VoyageTextEmbedding implements EmbeddingProvider {
  readonly id = "voyage";
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;

  constructor(opts: VoyageOptions = {}) {
    this.model = opts.model ?? "voyage-3";
    this.dimensions = opts.dimensions ?? 1024;
    this.apiKey = keyOrThrow(opts.apiKey);
  }

  async embed(inputs: string[]): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    const res = await fetch(`${BASE}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: inputs }),
    });
    if (!res.ok) throw new Error(`Voyage embed failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => Float32Array.from(d.embedding));
  }
}

export class VoyageImageEmbedding implements ImageEmbeddingProvider {
  readonly id = "voyage";
  readonly model: string;
  readonly dimensions: number;
  readonly sharedTextSpace = true;
  private readonly apiKey: string;

  constructor(opts: VoyageOptions = {}) {
    this.model = opts.model ?? "voyage-multimodal-3";
    this.dimensions = opts.dimensions ?? 1024;
    this.apiKey = keyOrThrow(opts.apiKey);
  }

  async embedImages(images: Uint8Array[]): Promise<Float32Array[]> {
    if (images.length === 0) return [];
    const inputs = images.map((bytes) => ({
      content: [
        {
          type: "image_base64",
          image_base64: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
        },
      ],
    }));
    const res = await fetch(`${BASE}/multimodalembeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, inputs }),
    });
    if (!res.ok) throw new Error(`Voyage image embed failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => Float32Array.from(d.embedding));
  }
}
