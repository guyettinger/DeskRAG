/**
 * Pinned model manifest.
 *
 * Acquisition policy lives in the app, never the library — `deskrag` is
 * published to npm and must not fetch anything at install or runtime.
 *
 * `revision` is a commit SHA, never a branch. If `main` moved, the weights would
 * change while the namespace kept claiming the same model, and vectors would
 * silently stop being comparable to those already in that Lance table.
 *
 * Every entry is fetched from HuggingFace and verified against sha256.
 *
 * ColSmol is a re-export, not the upstream weights: the published export
 * (onnx-community/colSmol-256M-ONNX) is traced at exactly 13 tiles and rejects
 * any other count, while DeskRAG's 16:10 frames tile to 7 and a 5:4 display
 * needs 17. scripts/export-colsmol.py re-exports with a dynamic tile count;
 * the result is published to guyettinger/colSmol-256M-dynamic-onnx so users
 * download it like any other model rather than building it locally.
 */

export interface ModelFile {
  /** Path within the repo; the basename is what lands on disk. */
  path: string;
  sha256?: string;
  bytes?: number;
}

export interface ModelSpec {
  id: string;
  source: "download";
  /** HuggingFace repo id. Download entries only. */
  repo?: string;
  /** Commit SHA — never "main". Download entries only. */
  revision?: string;
  files: ModelFile[];
}

export const MODELS = {
  text: {
    id: "nomic-embed-text-v1.5",
    source: "download",
    repo: "nomic-ai/nomic-embed-text-v1.5",
    revision: "e9b6763023c676ca8431644204f50c2b100d9aab",
    files: [
      {
        path: "onnx/model_int8.onnx",
        sha256: "b4342336debaea79de872370664b0aaeb67dea4605513d00ee236ea871a81f27",
        bytes: 137296292,
      },
      {
        path: "tokenizer.json",
        sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
        bytes: 711396,
      },
      {
        // Required: @huggingface/tokenizers takes parsed tokenizer.json AND
        // tokenizer_config.json in its constructor.
        path: "tokenizer_config.json",
        sha256: "d7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc",
        bytes: 1191,
      },
    ],
  },
  vision: {
    id: "nomic-embed-vision-v1.5",
    source: "download",
    repo: "nomic-ai/nomic-embed-vision-v1.5",
    revision: "e3a725bce72db07ca4adb1d83da08903f3ee02f8",
    files: [
      {
        // int8, matching the text model's quantization. The fp32 export
        // (onnx/model.onnx, 374MB) is bit-exact across batch sizes where int8 is
        // not — which is why OnnxImageEmbedding embeds one image per pass. Swap
        // to fp32 only with that note in mind.
        path: "onnx/model_int8.onnx",
        sha256: "ba9107df6e412828dae8c675096209aa39f6536de8ec8d9a872665b54dc750c3",
        bytes: 96745606,
      },
      {
        // Required: the adapter reads input size + CLIP mean/std from here
        // rather than hardcoding them.
        path: "preprocessor_config.json",
        sha256: "77436fccc0108364dd52185181d65cace7e830113e3b81b2bad8009a47f59b34",
        bytes: 791,
      },
      {
        path: "config.json",
        sha256: "8ba755dcfdd6f6ddd05c81b1b3c812818f48e3828c420e424ae667e8c32ec1fe",
        bytes: 2140,
      },
    ],
    // No tokenizer: this is a vision tower only. Text never enters this model.
  },
  reranker: {
    id: "jina-reranker-v1-turbo-en",
    source: "download",
    repo: "jinaai/jina-reranker-v1-turbo-en",
    revision: "b8c14f4e723d9e0aab4732a7b7b93741eeeb77c2",
    files: [
      {
        path: "onnx/model_int8.onnx",
        sha256: "3defdef1ae34e119bd704216087743e79665934c96aebabcb6077c239dc3ae66",
        bytes: 38295104,
      },
      {
        path: "tokenizer.json",
        sha256: "0046da43cc8c424b317f56b092b0512aaaa65c4f925d2f16af9d9eeb4d0ef902",
        bytes: 2030772,
      },
      {
        path: "tokenizer_config.json",
        sha256: "d291c6652d96d56ffdbcf1ea19d9bae5ed79003f7648c627e725a619227ce8fa",
        bytes: 1215,
      },
    ],
  },
  colsmol: {
    id: "colSmol-256M-dynamic",
    source: "download",
    repo: "guyettinger/colSmol-256M-dynamic-onnx",
    revision: "93956db0e440eebd497bc776e7bf34a06830b0c6",
    files: [
      {
        path: "model.onnx",
        sha256: "cf13ca0c6951a4607c303dbe15fd9c8161289ff624f8582ce539cca2ccd99084",
        bytes: 953919521,
      },
      {
        path: "tokenizer.json",
        sha256: "77eaa5071d562289dbd9c18f8a998124d899a4a0a4311b1a4b6964a873d306b8",
        bytes: 3548416,
      },
      {
        path: "tokenizer_config.json",
        sha256: "e5bc53ee738178fca59eac1df6dc821576d1082ffedb7b8f8dfe97ceab43eb92",
        bytes: 28274,
      },
      {
        path: "preprocessor_config.json",
        sha256: "6b8e11369a62e97e3b2f37a0dd1440b9018d177f7ecd2cfc2492e316b930a78a",
        bytes: 489,
      },
      {
        path: "config.json",
        sha256: "e68e589bbc081d258f585d32ff90d41f0eededdddd5d5d38f006d80ff7de0c0d",
        bytes: 7268,
      },
    ],
  },
} satisfies Record<string, ModelSpec>;

export type ModelKey = keyof typeof MODELS;
