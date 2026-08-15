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
 *
 * ColModernVBERT is the UPSTREAM export, not a re-export: Qdrant's ONNX
 * (Qdrant/colmodernvbert, MIT) already builds input_ids from the actual patch
 * count, so it takes any tile count and needs no re-trace. That is the whole
 * reason scripts/export-colsmol.py has no counterpart here. It is a selectable
 * `imageProvider` like any other — `ColModernVBertMultiVector` reads these files
 * through `models.ensure`, so it downloads on first use rather than by hand.
 *
 * Whisper is the one entry that is NOT ONNX: it is a GGML file consumed by an
 * external whisper.cpp binary. It lives here anyway so speech-to-text works out
 * of the box — the previous "bring your own model path" default meant
 * transcription was silently off for everyone. base.en at q5_1 is 57MB, which is
 * small enough to fetch on first use and accurate enough for desktop speech.
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
  colmodernvbert: {
    id: "colmodernvbert-250m",
    source: "download",
    repo: "Qdrant/colmodernvbert",
    revision: "6d54b9924e54e7c0061173d134dec496b15b3842",
    files: [
      {
        path: "model.onnx",
        sha256: "b795e84e70ca6fc549f59c22a5d87e785bd741ce73a74bacfaf0caa967b546ab",
        bytes: 1012467143,
      },
      {
        path: "tokenizer.json",
        sha256: "948b2ac5b46b1890f2fa4c43f41add4a6c04432e9cf529d788d1d7b10a3dea00",
        bytes: 3591055,
      },
      {
        path: "tokenizer_config.json",
        sha256: "28ee34309f2fad3bc30514f6a15f743f612fa814d3d4d9ddcc3c79e810f29c79",
        bytes: 28427,
      },
      {
        path: "preprocessor_config.json",
        sha256: "2b2cad11a008b42c73c451398858fcbb6eb5e75b2ad5a55536b8994ea8711731",
        bytes: 492,
      },
      {
        path: "config.json",
        sha256: "1b9d0e70c4a6786ff2bedfba4ebdd0e67037ebf4067e792771826c88fb76a453",
        bytes: 902,
      },
      {
        path: "processor_config.json",
        sha256: "0401bd1f5d81d93daf50349e3796b2866296c71544a1922ae50dc3028f20b0a5",
        bytes: 74,
      },
    ],
  },
  whisper: {
    id: "whisper-base.en-q5_1",
    source: "download",
    repo: "ggerganov/whisper.cpp",
    revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
    files: [
      {
        path: "ggml-base.en-q5_1.bin",
        sha256: "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f",
        bytes: 59721011,
      },
    ],
  },
} satisfies Record<string, ModelSpec>;

export type ModelKey = keyof typeof MODELS;
