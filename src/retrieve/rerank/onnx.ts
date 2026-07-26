/**
 * Local Tier-4 reranker: a cross-encoder scoring each (query, candidate) pair in
 * a single forward pass, replacing the Claude call with a 37.8M-param model.
 *
 * NOT in the package barrel — loads onnxruntime-node. Import from this path.
 *
 * Default weights: jina-reranker-v1-turbo-en (Apache-2.0). Its v2 and m0
 * successors are CC-BY-NC-4.0 — do not "upgrade" without re-checking the licence.
 *
 * Tier 4 is a refinement, never load-bearing, so EVERY failure path returns the
 * input order rather than throwing — matching LLMReranker's behaviour.
 */

import { makeTensor, OnnxRuntime, type OnnxSession } from "../../embed/onnx/runtime.js";
import type { Reranker, RerankCandidate } from "./types.js";

export interface TokenizedPair {
  ids: number[];
  typeIds: number[];
}

export interface OnnxRerankerOptions {
  modelPath: string;
  tokenizerPath: string;
  tokenizerConfigPath?: string;
  maxTokens?: number;
  batchSize?: number;
  session?: OnnxSession;
  tokenizePair?: (query: string, doc: string) => TokenizedPair;
}

export class OnnxCrossEncoderReranker implements Reranker {
  private readonly modelPath: string;
  private readonly tokenizerPath: string;
  private readonly tokenizerConfigPath: string;
  private readonly maxTokens: number;
  private readonly batchSize: number;
  private readonly injectedSession: OnnxSession | undefined;
  private readonly injectedTokenize: OnnxRerankerOptions["tokenizePair"];
  private loadedTokenizer: Promise<(q: string, d: string) => TokenizedPair> | undefined;

  constructor(opts: OnnxRerankerOptions) {
    this.modelPath = opts.modelPath;
    this.tokenizerPath = opts.tokenizerPath;
    this.tokenizerConfigPath =
      opts.tokenizerConfigPath ??
      opts.tokenizerPath.replace(/tokenizer\.json$/, "tokenizer_config.json");
    this.maxTokens = opts.maxTokens ?? 512;
    this.batchSize = opts.batchSize ?? 16;
    this.injectedSession = opts.session;
    this.injectedTokenize = opts.tokenizePair;
  }

  private session(): Promise<OnnxSession> {
    return this.injectedSession
      ? Promise.resolve(this.injectedSession)
      : OnnxRuntime.session(this.modelPath);
  }

  private async tokenizer(): Promise<(q: string, d: string) => TokenizedPair> {
    if (this.injectedTokenize) return this.injectedTokenize;
    this.loadedTokenizer ??= (async () => {
      const { readFile } = await import("node:fs/promises");
      const { Tokenizer } = await import(/* @vite-ignore */ "@huggingface/tokenizers");
      const [tokJson, cfgJson] = await Promise.all([
        readFile(this.tokenizerPath, "utf8"),
        readFile(this.tokenizerConfigPath, "utf8").catch(() => "{}"),
      ]);
      const tok = new Tokenizer(
        JSON.parse(tokJson) as object,
        JSON.parse(cfgJson) as object,
      );
      return (q: string, d: string) => {
        // Cross-encoders score a PAIR, so the document rides in text_pair and
        // token_type_ids marks the boundary.
        const e = tok.encode(q, { text_pair: d, return_token_type_ids: true });
        return { ids: e.ids, typeIds: e.token_type_ids ?? e.ids.map(() => 0) };
      };
    })();
    return this.loadedTokenizer;
  }

  async rerank(query: string, candidates: RerankCandidate[]): Promise<string[]> {
    if (candidates.length === 0) return [];
    try {
      const tokenize = await this.tokenizer();
      const sess = await this.session();
      const scores: number[] = [];

      for (let start = 0; start < candidates.length; start += this.batchSize) {
        const slice = candidates.slice(start, start + this.batchSize);
        const encoded = slice.map((c) => {
          const e = tokenize(query, c.text);
          return {
            ids: e.ids.slice(0, this.maxTokens),
            typeIds: e.typeIds.slice(0, this.maxTokens),
          };
        });
        const seq = Math.max(1, ...encoded.map((e) => e.ids.length));
        const batch = encoded.length;

        const ids = new BigInt64Array(batch * seq);
        const mask = new BigInt64Array(batch * seq);
        const types = new BigInt64Array(batch * seq);
        for (let b = 0; b < batch; b++) {
          const e = encoded[b]!;
          for (let t = 0; t < seq; t++) {
            const present = t < e.ids.length;
            ids[b * seq + t] = BigInt(present ? e.ids[t]! : 0);
            mask[b * seq + t] = present ? 1n : 0n;
            types[b * seq + t] = BigInt(present ? (e.typeIds[t] ?? 0) : 0);
          }
        }

        const out = await sess.run({
          input_ids: makeTensor("int64", ids, [batch, seq]),
          attention_mask: makeTensor("int64", mask, [batch, seq]),
          token_type_ids: makeTensor("int64", types, [batch, seq]),
        });
        const logits = (out.logits ?? Object.values(out)[0]!) as { data: Float32Array };
        for (let b = 0; b < batch; b++) scores.push(logits.data[b] ?? 0);
      }

      return candidates
        .map((c, i) => ({ id: c.id, score: scores[i] ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.id);
    } catch {
      return candidates.map((c) => c.id); // fall back to input order
    }
  }
}
