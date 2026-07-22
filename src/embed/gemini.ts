/**
 * Google Gemini embeddings via gemini-embedding-2 — natively multimodal, so ONE
 * class backs both text and image in a shared embedding space (sharedTextSpace).
 * Pinned to 3072 dims (the space's dimensionality; part of the namespace).
 * Requires GEMINI_API_KEY (or GOOGLE_API_KEY).
 */

import type { EmbeddingProvider, ImageEmbeddingProvider } from "./types.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function keyOrThrow(explicit?: string): string {
  const key = explicit ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  return key;
}

export interface GeminiOptions {
  model?: string;
  dimensions?: number;
  apiKey?: string;
}

interface Part {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

export class GeminiEmbedding
  implements EmbeddingProvider, ImageEmbeddingProvider
{
  readonly id = "gemini";
  readonly model: string;
  readonly dimensions: number;
  readonly sharedTextSpace = true;
  private readonly apiKey: string;

  constructor(opts: GeminiOptions = {}) {
    this.model = opts.model ?? "gemini-embedding-2";
    this.dimensions = opts.dimensions ?? 3072;
    this.apiKey = keyOrThrow(opts.apiKey);
  }

  async embed(inputs: string[]): Promise<Float32Array[]> {
    return this.embedParts(inputs.map((text) => [{ text }]));
  }

  async embedImages(images: Uint8Array[]): Promise<Float32Array[]> {
    return this.embedParts(
      images.map((bytes) => [
        {
          inline_data: {
            mime_type: "image/png",
            data: Buffer.from(bytes).toString("base64"),
          },
        },
      ]),
    );
  }

  private async embedParts(items: Part[][]): Promise<Float32Array[]> {
    if (items.length === 0) return [];
    const requests = items.map((parts) => ({
      model: `models/${this.model}`,
      content: { parts },
      outputDimensionality: this.dimensions,
    }));
    const res = await fetch(
      `${BASE}/models/${this.model}:batchEmbedContents?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests }),
      },
    );
    if (!res.ok) throw new Error(`Gemini embed failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { embeddings: { values: number[] }[] };
    return json.embeddings.map((e) => Float32Array.from(e.values));
  }
}
