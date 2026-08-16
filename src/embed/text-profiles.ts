/**
 * What the ONNX text adapter needs to know about each text model, as DATA.
 *
 * Barrel-safe by construction: plain objects, no imports, no native module. That
 * is what lets the app's pinned model manifest (`app/src/main/models.ts`) read
 * the same profile the adapter runs on, instead of restating the prefixes beside
 * a download URL and drifting from them.
 *
 * Every field here is something that fails SILENTLY when wrong — none of them
 * raise, they just return plausible vectors from the wrong space:
 *
 * - `prefixes`  — an asymmetric model trained with task prefixes degrades
 *   quietly without them. nomic wants `search_document: `/`search_query: `;
 *   EmbeddingGemma wants its own pair and neither is a default for the other.
 * - `tokenTypeIds` — nomic's export declares the tensor REQUIRED and rejects the
 *   call without it; Gemma3 has no segment embeddings and rejects the call WITH
 *   it. There is no value that satisfies both.
 * - `output` — see below. The difference is two Dense layers.
 * - `dimensions` — part of the namespace, so a wrong value mints a Lance table
 *   whose declared width is a lie.
 */

/**
 * Which output tensor carries the embedding.
 *
 * `last_hidden_state` is a bare encoder: the adapter must mean-pool over the
 * attention mask and L2-normalize. `sentence_embedding` is a full
 * sentence-transformers pipeline traced into the graph — pooling and any Dense
 * projection heads already applied — and pooling it again would be nonsense.
 *
 * This is not a stylistic difference between exports. EmbeddingGemma's
 * sentence-transformers definition has TWO Dense heads after pooling
 * (`2_Dense/`, `3_Dense/` in google/embeddinggemma-300m). Mean-pooling its
 * `last_hidden_state` skips both and yields the pre-projection representation:
 * right row count, right width, plausible cosines, and not the space the model's
 * scores were ever measured in.
 */
export type TextOutput = "last_hidden_state" | "sentence_embedding";

export interface TextModelProfile {
  /**
   * The model id as it appears in a namespace. Must contain no colon —
   * `parseNamespace` splits on it and a model id carrying one shifts every
   * field after it.
   */
  model: string;
  /** Output dimensionality. Part of the namespace. */
  dimensions: number;
  /** Hard truncation point. Over-length is a tensor shape error, not a clamp. */
  maxTokens: number;
  /** Asymmetric task prefixes, applied by role at embed time. */
  prefixes: { document: string; query: string };
  /** Whether the export declares `token_type_ids` as a required input. */
  tokenTypeIds: boolean;
  output: TextOutput;
}

/**
 * nomic-embed-text-v1.5 — a bare BERT-style encoder.
 *
 * maxTokens is 2048 rather than the model's advertised 8192 ceiling: that is the
 * value this adapter has always truncated at, and raising it is a retrieval
 * change to measure, not a constant to correct in passing.
 */
export const NOMIC_PROFILE: TextModelProfile = {
  model: "nomic-embed-text-v1.5",
  dimensions: 768,
  maxTokens: 2048,
  prefixes: { document: "search_document: ", query: "search_query: " },
  tokenTypeIds: true,
  output: "last_hidden_state",
};

/**
 * EmbeddingGemma 300m, via onnx-community/embeddinggemma-300m-ONNX.
 *
 * The community export is used rather than google/embeddinggemma-300m because
 * the latter is `gated: manual` on HuggingFace and the app downloads
 * anonymously — a gated repo is simply unreachable, not merely inconvenient.
 *
 * `maxTokens` is the export's own `max_position_embeddings` (2048), a quarter of
 * nomic's ceiling. Long transcript clips truncate sooner here.
 *
 * The prefixes are asymmetric in an unusual way: the document side is not a task
 * string at all but the model's title/text framing, and `none` is the literal
 * value its training used for an absent title.
 */
export const EMBEDDINGGEMMA_PROFILE: TextModelProfile = {
  model: "embeddinggemma-300m",
  dimensions: 768,
  maxTokens: 2048,
  prefixes: { document: "title: none | text: ", query: "task: search result | query: " },
  tokenTypeIds: false,
  output: "sentence_embedding",
};

/** Every selectable text model, keyed by the id that appears in its namespace. */
export const TEXT_PROFILES = {
  [NOMIC_PROFILE.model]: NOMIC_PROFILE,
  [EMBEDDINGGEMMA_PROFILE.model]: EMBEDDINGGEMMA_PROFILE,
} as const satisfies Record<string, TextModelProfile>;

export type TextModelId = keyof typeof TEXT_PROFILES;

/**
 * Throws by name rather than falling back to a default.
 *
 * A silent fallback would embed into whichever space the default names while the
 * caller believes it selected another — the exact failure the namespace exists
 * to make impossible.
 */
export function textProfile(model: string): TextModelProfile {
  const profile = (TEXT_PROFILES as Record<string, TextModelProfile>)[model];
  if (!profile) {
    throw new Error(
      `Unknown text model "${model}". Known: ${Object.keys(TEXT_PROFILES).join(", ")}`,
    );
  }
  return profile;
}
