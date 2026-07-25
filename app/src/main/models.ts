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
 * TWO KINDS OF ENTRY:
 *
 *   source: "download" — fetched from HuggingFace and verified against sha256.
 *
 *   source: "local"    — produced ON THIS MACHINE by a setup script. ColSmol is
 *     one of these. The published export (onnx-community/colSmol-256M-ONNX) is
 *     traced at exactly 13 tiles and rejects any other count; DeskRAG frames
 *     tile to 13 only at landscape ratios, and a 5:4 or square display needs 17.
 *     scripts/export-colsmol.py re-exports with a dynamic tile count. The result
 *     is ~950MB and generated per-machine, so there is nothing to download and
 *     no checksum to pin — ModelStore verifies presence and reports the exact
 *     command when the files are missing.
 */

export interface ModelFile {
  /** Path within the repo (download) or basename on disk (local). */
  path: string;
  sha256?: string;
  bytes?: number;
}

export interface ModelSpec {
  id: string;
  source: "download" | "local";
  /** HuggingFace repo id. Download entries only. */
  repo?: string;
  /** Commit SHA — never "main". Download entries only. */
  revision?: string;
  files: ModelFile[];
  /** Shown when a local-source model is absent. */
  setupHint?: string;
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
    source: "local",
    files: [
      { path: "model.onnx" },
      { path: "tokenizer.json" },
      { path: "tokenizer_config.json" },
      { path: "preprocessor_config.json" },
      { path: "config.json" },
    ],
    setupHint:
      "Local image search needs a dynamic-tile ColSmol export, which is built on " +
      "this machine because the published one only accepts 13 tiles.\n" +
      "  pip install torch transformers colpali-engine onnx\n" +
      "  python scripts/export-colsmol.py --out <modelsDir>/colSmol-256M-dynamic/model.onnx\n" +
      "Then copy tokenizer.json, tokenizer_config.json and preprocessor_config.json " +
      "from onnx-community/colSmol-256M-ONNX, and config.json from vidore/colSmol-256M, " +
      "into the same directory.",
  },
} satisfies Record<string, ModelSpec>;

export type ModelKey = keyof typeof MODELS;
