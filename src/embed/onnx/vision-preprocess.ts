/**
 * sharp-backed preprocessing for the single-vector vision encoder: resize,
 * rescale, normalize. Mirrors HuggingFace's CLIPImageProcessor as the model's
 * own preprocessor_config.json declares it.
 *
 * Loads sharp, so it lives apart from image.ts and is imported lazily — the
 * adapter can be unit-tested without a native module, exactly like
 * colsmol-tiler.ts.
 *
 * Three details that are easy to get wrong:
 *
 *  - The resize is ANISOTROPIC. `size` in preprocessor_config.json is
 *    {height, width} rather than {shortest_edge}, which sends
 *    CLIPImageProcessor down its `default_to_square` path: it resizes straight
 *    to 224x224 and the subsequent center-crop is a no-op. A desktop frame gets
 *    squashed, not letterboxed, and matching that is what keeps our vectors
 *    comparable to the reference implementation.
 *  - Normalization is per-CHANNEL: x/255 then (x - mean[c]) / std[c] with CLIP's
 *    asymmetric constants, unlike ColSmol's single 0.5/0.5 for every channel.
 *  - Unlike the ColSmol tiler, there is no upscale hazard here. Keyframes are
 *    captured at >= 1280px wide, so 224 is always a REDUCTION, which is the only
 *    path where sharp's kernel choice applies and matches PIL closely.
 */

/** The parts of preprocessor_config.json this needs. */
export interface VisionPreprocessConfig {
  width: number;
  height: number;
  /** Per-channel, in RGB order. */
  mean: [number, number, number];
  std: [number, number, number];
  /** Applied before mean/std; 1/255 for every CLIP-family processor. */
  rescale: number;
}

export const CLIP_PREPROCESS: VisionPreprocessConfig = {
  width: 224,
  height: 224,
  mean: [0.48145466, 0.4578275, 0.40821073],
  std: [0.26862954, 0.26130258, 0.27577711],
  rescale: 1 / 255,
};

/**
 * Read the constants from the model's own config rather than assuming them —
 * the same discipline `readTileConfig` applies for ColSmol. Anything absent
 * falls back to the CLIP defaults above.
 */
export async function readVisionPreprocessConfig(
  preprocessorPath: string,
): Promise<VisionPreprocessConfig> {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(preprocessorPath, "utf8")) as {
    size?: { height?: number; width?: number };
    crop_size?: { height?: number; width?: number };
    image_mean?: number[];
    image_std?: number[];
    rescale_factor?: number;
  };
  const triple = (v: number[] | undefined, fallback: [number, number, number]) =>
    v && v.length === 3 ? ([v[0]!, v[1]!, v[2]!] as [number, number, number]) : fallback;

  return {
    width: raw.size?.width ?? raw.crop_size?.width ?? CLIP_PREPROCESS.width,
    height: raw.size?.height ?? raw.crop_size?.height ?? CLIP_PREPROCESS.height,
    mean: triple(raw.image_mean, CLIP_PREPROCESS.mean),
    std: triple(raw.image_std, CLIP_PREPROCESS.std),
    rescale: raw.rescale_factor ?? CLIP_PREPROCESS.rescale,
  };
}

/** Interleaved RGB bytes -> normalized CHW float32. */
export function toNormalizedChw(
  rgb: Uint8Array,
  width: number,
  height: number,
  cfg: VisionPreprocessConfig,
): Float32Array {
  const n = width * height;
  const out = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    const mean = cfg.mean[c]!;
    const std = cfg.std[c]!;
    const plane = c * n;
    for (let i = 0; i < n; i++) {
      out[plane + i] = (rgb[i * 3 + c]! * cfg.rescale - mean) / std;
    }
  }
  return out;
}

/** Decode, resize to the model's input size, and normalize. One image. */
export async function preprocessImageWithSharp(
  image: Uint8Array,
  cfg: VisionPreprocessConfig = CLIP_PREPROCESS,
): Promise<Float32Array> {
  const sharpMod = await import(/* @vite-ignore */ "sharp");
  const sharp = sharpMod.default;

  const raw = await sharp(Buffer.from(image))
    // `fill` is deliberate: aspect ratio is NOT preserved, matching the
    // processor's default_to_square path.
    .resize(cfg.width, cfg.height, { fit: "fill" })
    // do_convert_rgb — force 3 interleaved channels whatever came in
    // (grayscale keyframes, PNGs with alpha).
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer();

  return toNormalizedChw(raw, cfg.width, cfg.height, cfg);
}
