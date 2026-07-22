/**
 * Local Ollama text embeddings. Default model nomic-embed-text (768-dim).
 * Talks to the local daemon at OLLAMA_HOST (default http://localhost:11434).
 */

import type { EmbeddingProvider } from "./types.js";

export interface OllamaOptions {
  model?: string;
  dimensions?: number;
  host?: string;
}

export class OllamaTextEmbedding implements EmbeddingProvider {
  readonly id = "ollama";
  readonly model: string;
  readonly dimensions: number;
  private readonly host: string;

  constructor(opts: OllamaOptions = {}) {
    this.model = opts.model ?? "nomic-embed-text";
    this.dimensions = opts.dimensions ?? 768;
    this.host = opts.host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
  }

  async embed(inputs: string[]): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    const res = await fetch(`${this.host}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: inputs }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { embeddings: number[][] };
    return json.embeddings.map((e) => Float32Array.from(e));
  }
}
