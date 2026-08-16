/**
 * Local text embeddings via onnxruntime-node.
 *
 * NOT in the package barrel — loads a native module. Import from this path.
 *
 * Which model it runs is a {@link TextModelProfile}, not a branch: the two
 * exports on the menu disagree about task prefixes, about whether
 * `token_type_ids` is required, and about whether the graph has already pooled.
 * All three fail SILENTLY when guessed — see `../text-profiles.ts` for why each
 * one is data rather than a constant here.
 *
 * Task prefixes are load-bearing: an asymmetric model expects one string on
 * stored text and another on queries. Omitting them raises no error, it just
 * quietly degrades retrieval, so the role rides on `embed()`'s opts and
 * `TextViewSearcher` passes "query".
 */

import { NOMIC_PROFILE, type TextModelProfile } from "../text-profiles.js";
import type { EmbedOptions, EmbeddingProvider } from "../types.js";
import { l2Normalize, meanPool } from "./pooling.js";
import { OnnxRuntime, makeTensor, type OnnxSession } from "./runtime.js";
import { defaultConfigPath, loadTokenizer } from "./tokenizer.js";

/** Kept as a named export: it is nomic's contract, and tests assert on it. */
export const NOMIC_PREFIX = NOMIC_PROFILE.prefixes;

export interface TokenizeResult {
  ids: number[];
  /** Segment ids. Absent for a single sequence, where they are all zero. */
  typeIds?: number[];
}

export interface OnnxTextOptions {
  /** Absolute path to the .onnx weights. */
  modelPath: string;
  /** Absolute path to tokenizer.json. */
  tokenizerPath: string;
  /** Absolute path to tokenizer_config.json; defaults to a sibling of the above. */
  tokenizerConfigPath?: string;
  /** Which model this is. Defaults to nomic, the model this adapter began as. */
  profile?: TextModelProfile;
  /** Overrides on top of the profile, mostly so tests can shrink the width. */
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
  private readonly profile: TextModelProfile;
  private readonly modelPath: string;
  private readonly tokenizerPath: string;
  private readonly tokenizerConfigPath: string;
  private readonly maxTokens: number;
  private readonly injectedSession: OnnxSession | undefined;
  private readonly injectedTokenize: ((t: string) => TokenizeResult) | undefined;
  private loadedTokenizer: Promise<(t: string) => TokenizeResult> | undefined;

  constructor(opts: OnnxTextOptions) {
    this.profile = opts.profile ?? NOMIC_PROFILE;
    this.model = opts.model ?? this.profile.model;
    this.dimensions = opts.dimensions ?? this.profile.dimensions;
    this.modelPath = opts.modelPath;
    this.tokenizerPath = opts.tokenizerPath;
    this.tokenizerConfigPath =
      opts.tokenizerConfigPath ?? defaultConfigPath(opts.tokenizerPath);
    this.maxTokens = opts.maxTokens ?? this.profile.maxTokens;
    this.injectedSession = opts.session;
    this.injectedTokenize = opts.tokenize;
  }

  /** A single sequence — token_type_ids are all zero where a model wants them. */
  private async tokenizer(): Promise<(t: string) => TokenizeResult> {
    if (this.injectedTokenize) return this.injectedTokenize;
    this.loadedTokenizer ??= (async () => {
      const tok = await loadTokenizer(this.tokenizerPath, this.tokenizerConfigPath);
      return (t: string) => {
        const e = tok.encode(t, { return_token_type_ids: true });
        return {
          ids: e.ids,
          ...(e.token_type_ids ? { typeIds: e.token_type_ids } : {}),
        };
      };
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
    const prefix = this.profile.prefixes[opts?.role ?? "document"];
    const tokenize = await this.tokenizer();

    // Truncate explicitly: an over-length sequence is a tensor shape error on the
    // ONNX path, not the graceful clamp Ollama's `truncate: true` gave us.
    const encoded = inputs.map((t) => {
      const e = tokenize(`${prefix}${t}`);
      return {
        ids: e.ids.slice(0, this.maxTokens),
        typeIds: (e.typeIds ?? e.ids.map(() => 0)).slice(0, this.maxTokens),
      };
    });
    const seq = Math.max(1, ...encoded.map((e) => e.ids.length));
    const batch = encoded.length;

    const ids = new BigInt64Array(batch * seq);
    const mask = new BigInt64Array(batch * seq);
    // All zeros for a single sequence, but nomic's export declares the tensor
    // REQUIRED and rejects the call without it, while Gemma3 has no segment
    // embeddings and rejects the call WITH it. Hence the profile flag.
    const types = new BigInt64Array(batch * seq);
    const masks: number[][] = [];
    for (let b = 0; b < batch; b++) {
      const row = encoded[b]!;
      const m: number[] = [];
      for (let t = 0; t < seq; t++) {
        const present = t < row.ids.length;
        ids[b * seq + t] = BigInt(present ? row.ids[t]! : 0);
        mask[b * seq + t] = present ? 1n : 0n;
        types[b * seq + t] = BigInt(present ? (row.typeIds[t] ?? 0) : 0);
        m.push(present ? 1 : 0);
      }
      masks.push(m);
    }

    const sess = await this.session();
    const out = await sess.run({
      input_ids: makeTensor("int64", ids, [batch, seq]),
      ...(this.profile.tokenTypeIds
        ? { token_type_ids: makeTensor("int64", types, [batch, seq]) }
        : {}),
      attention_mask: makeTensor("int64", mask, [batch, seq]),
    });

    return this.profile.output === "sentence_embedding"
      ? readPooled(out, batch, this.dimensions)
      : poolHidden(out, batch, seq, this.dimensions, masks);
  }
}

interface OnnxOutput {
  data: Float32Array;
  dims: number[];
}

/**
 * A graph that already pooled: one row per INPUT, not per token.
 *
 * Normalized anyway rather than trusted. EmbeddingGemma's pipeline ends in a
 * normalization step so this is a no-op on the real weights — but an export that
 * traced without it would otherwise put un-normalized vectors into a store whose
 * every similarity is a bare dot product, and that is not worth assuming to save
 * one pass over 768 floats.
 */
function readPooled(
  out: Record<string, unknown>,
  batch: number,
  fallbackDims: number,
): Float32Array[] {
  const pooled = (out.sentence_embedding ?? Object.values(out)[0]!) as OnnxOutput;
  const dims = pooled.dims[1] ?? fallbackDims;
  const vectors: Float32Array[] = [];
  for (let b = 0; b < batch; b++) {
    vectors.push(l2Normalize(pooled.data.slice(b * dims, (b + 1) * dims)));
  }
  return vectors;
}

/** A bare encoder: mean-pool over the attention mask, then normalize. */
function poolHidden(
  out: Record<string, unknown>,
  batch: number,
  seq: number,
  fallbackDims: number,
  masks: number[][],
): Float32Array[] {
  const hidden = (out.last_hidden_state ?? Object.values(out)[0]!) as OnnxOutput;
  const dims = hidden.dims[2] ?? fallbackDims;
  const vectors: Float32Array[] = [];
  for (let b = 0; b < batch; b++) {
    const slice = hidden.data.slice(b * seq * dims, (b + 1) * seq * dims);
    vectors.push(l2Normalize(meanPool(slice, masks[b]!, seq, dims)));
  }
  return vectors;
}
