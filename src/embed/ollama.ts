/**
 * Local Ollama text embeddings. Default model nomic-embed-text (768-dim).
 * Talks to the local daemon at OLLAMA_HOST (default http://localhost:11434).
 *
 * Throws on failure, unlike the caption adapter: a missing embedding is a
 * missing vector, and returning nothing would leave a relational row the
 * reconciler cannot tell apart from a crash between the two stores.
 */

import { postJson, resolveOllamaHost } from "./ollama-client.js";
import type { EmbeddingProvider } from "./types.js";

export interface OllamaOptions {
  model?: string;
  dimensions?: number;
  host?: string;
  /** Injected fetch (tests). */
  fetchImpl?: typeof globalThis.fetch;
}

export class OllamaTextEmbedding implements EmbeddingProvider {
  readonly id = "ollama";
  readonly model: string;
  readonly dimensions: number;
  private readonly host: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OllamaOptions = {}) {
    this.model = opts.model ?? "nomic-embed-text";
    this.dimensions = opts.dimensions ?? 768;
    this.host = resolveOllamaHost(opts.host);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async embed(inputs: string[]): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    const json = await postJson<{ embeddings: number[][] }>(
      this.host,
      "/api/embed",
      { model: this.model, input: inputs },
      this.fetchImpl,
    );
    return json.embeddings.map((e) => Float32Array.from(e));
  }
}
