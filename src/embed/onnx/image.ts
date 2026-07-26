/**
 * nomic-embed-vision-v1.5 via onnxruntime-node — the single-vector visual path.
 *
 * NOT in the package barrel — loads onnxruntime-node and (via the preprocessor)
 * sharp. Import from this path.
 *
 * This is the adapter behind `frame_image` and `region_image`, and therefore
 * behind Tier-2 frame ANN, Tier-3 region ANN, and the AX-label FTS highlights.
 * It is the alternative to ColSmol, not a companion: they index different vector
 * spaces and `Retriever` rejects both at once.
 *
 * POOLING IS THE CLS TOKEN, NOT A MEAN. The graph emits
 * `last_hidden_state [B, 197, 768]` — one CLS token plus 14x14 patches — and the
 * model card takes `last_hidden_state[:, 0]` then L2-normalizes. Mean-pooling
 * here would produce plausible-looking vectors that quietly retrieve worse, with
 * nothing to signal the mistake.
 *
 * BATCH INVARIANCE — why `batchSize` defaults to 1. Measured on the real int8
 * weights, the SAME image embedded at batch 1 vs batch 2 returns cosine 0.992,
 * not 1.0: onnxruntime picks a different kernel per batch dimension and int8
 * rounds differently along each. The fp32 export is bit-exact across batch
 * sizes, which is how we know this is quantization rather than an indexing bug
 * here (and the vectors stay correctly matched to their images either way —
 * position within a batch is bit-identical).
 *
 * That would be harmless if both sides batched alike, but they are asymmetric by
 * construction: `FrameRepresenter` and `RegionRepresenter` hand every pending
 * image to ONE call, while Tier 2 and Tier 3 always embed a query as a single
 * `[image]`. Batching would therefore put stored vectors and query vectors on
 * different kernel paths permanently, and leave each session's last partial
 * batch inconsistent with its full ones — incomparable vectors inside one
 * namespace, which is the exact failure the namespacing discipline exists to
 * prevent. One image per pass costs ~16% throughput (72ms vs 60ms per image on
 * an M-series CPU) and buys exact comparability. Re-measure before raising it.
 *
 * `sharedTextSpace` is FALSE, deliberately. nomic-embed-vision-v1.5 is aligned
 * with nomic-embed-text-v1.5, so a shared space is available in principle — but
 * only when the text side applies `F.layer_norm` before normalizing, which
 * `OnnxTextEmbedding` does not do (adding it would silently change every vector
 * already written to the digest/caption/transcript spaces). Until the text path
 * gains that step under a new namespace, claiming a shared space would be a
 * promise nothing keeps. Nothing in retrieval reads the flag today — Tier 2/3
 * only ever call `embedImages` — so this costs no capability.
 */

import type { ImageEmbeddingProvider } from "../types.js";
import { l2Normalize } from "./pooling.js";
import { OnnxRuntime, makeTensor, type OnnxSession } from "./runtime.js";
// Static: vision-preprocess.ts loads sharp lazily INSIDE its resize function, so
// importing it here costs nothing until an image is actually embedded.
import {
  CLIP_PREPROCESS,
  preprocessImageWithSharp,
  readVisionPreprocessConfig,
  type VisionPreprocessConfig,
} from "./vision-preprocess.js";

export interface OnnxImageOptions {
  /** Absolute path to the .onnx weights. */
  modelPath: string;
  /** preprocessor_config.json, to read input size + normalization rather than assume it. */
  preprocessorPath?: string;
  model?: string;
  dimensions?: number;
  /**
   * Images per forward pass. Defaults to 1 — see the note on BATCH INVARIANCE
   * in this file's header before raising it.
   */
  batchSize?: number;
  /** Injected session (tests). Defaults to the cached runtime session. */
  session?: OnnxSession;
  /** Injected preprocessor (tests). Defaults to the sharp-backed one. */
  preprocess?: (image: Uint8Array, cfg: VisionPreprocessConfig) => Promise<Float32Array>;
  /** Injected config (tests) — skips reading preprocessorPath. */
  preprocessConfig?: VisionPreprocessConfig;
}

export class OnnxImageEmbedding implements ImageEmbeddingProvider {
  readonly id = "onnx";
  readonly model: string;
  readonly dimensions: number;
  readonly sharedTextSpace = false;

  private readonly modelPath: string;
  private readonly preprocessorPath: string | undefined;
  private readonly batchSize: number;
  private readonly injectedSession: OnnxSession | undefined;
  private readonly injectedPreprocess: OnnxImageOptions["preprocess"];
  private readonly injectedConfig: VisionPreprocessConfig | undefined;
  private loadedConfig: Promise<VisionPreprocessConfig> | undefined;

  constructor(opts: OnnxImageOptions) {
    this.model = opts.model ?? "nomic-embed-vision-v1.5";
    this.dimensions = opts.dimensions ?? 768;
    this.modelPath = opts.modelPath;
    this.preprocessorPath = opts.preprocessorPath;
    this.batchSize = opts.batchSize ?? 1;
    this.injectedSession = opts.session;
    this.injectedPreprocess = opts.preprocess;
    this.injectedConfig = opts.preprocessConfig;
  }

  private session(): Promise<OnnxSession> {
    return this.injectedSession
      ? Promise.resolve(this.injectedSession)
      : OnnxRuntime.session(this.modelPath);
  }

  private config(): Promise<VisionPreprocessConfig> {
    if (this.injectedConfig) return Promise.resolve(this.injectedConfig);
    this.loadedConfig ??= this.preprocessorPath
      ? readVisionPreprocessConfig(this.preprocessorPath)
      : Promise.resolve(CLIP_PREPROCESS);
    return this.loadedConfig;
  }

  async embedImages(images: Uint8Array[]): Promise<Float32Array[]> {
    if (images.length === 0) return [];
    const preprocess = this.injectedPreprocess ?? preprocessImageWithSharp;
    const [cfg, sess] = await Promise.all([this.config(), this.session()]);
    const pixelsPerImage = 3 * cfg.height * cfg.width;
    const vectors: Float32Array[] = [];

    for (let start = 0; start < images.length; start += this.batchSize) {
      const slice = images.slice(start, start + this.batchSize);
      const planes = await Promise.all(slice.map((img) => preprocess(img, cfg)));

      const batch = planes.length;
      const pixels = new Float32Array(batch * pixelsPerImage);
      for (let b = 0; b < batch; b++) pixels.set(planes[b]!, b * pixelsPerImage);

      const out = await sess.run({
        pixel_values: makeTensor("float32", pixels, [batch, 3, cfg.height, cfg.width]),
      });
      const hidden = (out.last_hidden_state ?? Object.values(out)[0]!) as {
        data: Float32Array;
        dims: number[];
      };
      // [batch, tokens, dims] — token 0 is CLS.
      const tokens = hidden.dims[1] ?? 1;
      const dims = hidden.dims[2] ?? this.dimensions;
      for (let b = 0; b < batch; b++) {
        const cls = hidden.data.slice(b * tokens * dims, b * tokens * dims + dims);
        vectors.push(l2Normalize(cls));
      }
    }

    return vectors;
  }
}
