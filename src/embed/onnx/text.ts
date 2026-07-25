/**
 * nomic-embed-text-v1.5 via onnxruntime-node.
 *
 * NOT in the package barrel — loads a native module. Import from this path.
 *
 * Task prefixes are load-bearing: nomic-embed-v1.5 expects `search_document: `
 * on stored text and `search_query: ` on queries. Omitting them raises no error,
 * it just quietly degrades retrieval, so the role rides on `embed()`'s opts and
 * `TextViewSearcher` passes "query".
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmbedOptions, EmbeddingProvider } from "../types.js";
import { l2Normalize, meanPool } from "./pooling.js";
import { OnnxRuntime, makeTensor, type OnnxSession } from "./runtime.js";

export const NOMIC_PREFIX = {
  document: "search_document: ",
  query: "search_query: ",
} as const;

export interface TokenizeResult {
  ids: number[];
}

export interface OnnxTextOptions {
  /** Absolute path to the .onnx weights. */
  modelPath: string;
  /** Absolute path to tokenizer.json. */
  tokenizerPath: string;
  /** Absolute path to tokenizer_config.json; defaults to a sibling of the above. */
  tokenizerConfigPath?: string;
  model?: string;
  dimensions?: number;
  maxTokens?: number;
  /** Injected session (tests). Defaults to the cached runtime session. */
  session?: OnnxSession;
  /** Injected tokenizer (tests). Defaults to @huggingface/tokenizers. */
  tokenize?: (text: string) => TokenizeResult;
}

export class OnnxTextEmbedding implements EmbeddingProvider {
  readonly id = "onnx";
  readonly model: string;
  readonly dimensions: number;
  private readonly modelPath: string;
  private readonly tokenizerPath: string;
  private readonly tokenizerConfigPath: string;
  private readonly maxTokens: number;
  private readonly injectedSession: OnnxSession | undefined;
  private readonly injectedTokenize: ((t: string) => TokenizeResult) | undefined;
  private loadedTokenizer: Promise<(t: string) => TokenizeResult> | undefined;

  constructor(opts: OnnxTextOptions) {
    this.model = opts.model ?? "nomic-embed-text-v1.5";
    this.dimensions = opts.dimensions ?? 768;
    this.modelPath = opts.modelPath;
    this.tokenizerPath = opts.tokenizerPath;
    this.tokenizerConfigPath =
      opts.tokenizerConfigPath ??
      join(dirname(opts.tokenizerPath), "tokenizer_config.json");
    this.maxTokens = opts.maxTokens ?? 2048;
    this.injectedSession = opts.session;
    this.injectedTokenize = opts.tokenize;
  }

  /**
   * @huggingface/tokenizers takes PARSED JSON in its constructor and encodes
   * synchronously — there is no `fromFile`. tokenizer_config.json is optional;
   * an absent one degrades to defaults rather than failing the load.
   */
  private async tokenizer(): Promise<(t: string) => TokenizeResult> {
    if (this.injectedTokenize) return this.injectedTokenize;
    this.loadedTokenizer ??= (async () => {
      const { Tokenizer } = await import(
        /* @vite-ignore */ "@huggingface/tokenizers"
      );
      const [tokJson, cfgJson] = await Promise.all([
        readFile(this.tokenizerPath, "utf8"),
        readFile(this.tokenizerConfigPath, "utf8").catch(() => "{}"),
      ]);
      const tok = new Tokenizer(
        JSON.parse(tokJson) as object,
        JSON.parse(cfgJson) as object,
      );
      return (t: string) => ({ ids: tok.encode(t).ids });
    })();
    return this.loadedTokenizer;
  }

  private session(): Promise<OnnxSession> {
    return this.injectedSession
      ? Promise.resolve(this.injectedSession)
      : OnnxRuntime.session(this.modelPath);
  }

  async embed(inputs: string[], opts?: EmbedOptions): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    const prefix = NOMIC_PREFIX[opts?.role ?? "document"];
    const tokenize = await this.tokenizer();

    // Truncate explicitly: an over-length sequence is a tensor shape error on the
    // ONNX path, not the graceful clamp Ollama's `truncate: true` gave us.
    const encoded = inputs.map((t) =>
      tokenize(`${prefix}${t}`).ids.slice(0, this.maxTokens),
    );
    const seq = Math.max(1, ...encoded.map((e) => e.length));
    const batch = encoded.length;

    const ids = new BigInt64Array(batch * seq);
    const mask = new BigInt64Array(batch * seq);
    const masks: number[][] = [];
    for (let b = 0; b < batch; b++) {
      const row = encoded[b]!;
      const m: number[] = [];
      for (let t = 0; t < seq; t++) {
        const present = t < row.length;
        ids[b * seq + t] = BigInt(present ? row[t]! : 0);
        mask[b * seq + t] = present ? 1n : 0n;
        m.push(present ? 1 : 0);
      }
      masks.push(m);
    }

    const sess = await this.session();
    const out = await sess.run({
      input_ids: makeTensor("int64", ids, [batch, seq]),
      attention_mask: makeTensor("int64", mask, [batch, seq]),
    });

    const hidden = (out.last_hidden_state ?? Object.values(out)[0]!) as {
      data: Float32Array;
      dims: number[];
    };
    const dims = hidden.dims[2] ?? this.dimensions;
    const vectors: Float32Array[] = [];
    for (let b = 0; b < batch; b++) {
      const slice = hidden.data.slice(b * seq * dims, (b + 1) * seq * dims);
      vectors.push(l2Normalize(meanPool(slice, masks[b]!, seq, dims)));
    }
    return vectors;
  }
}
