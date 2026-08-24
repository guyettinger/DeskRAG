/**
 * sharpDownscaler — the real ImageDownscaler, backed by sharp (libvips). Decodes
 * the stored keyframe, resizes it to fit a maximum width, and re-encodes it for
 * the captioner.
 *
 * Not exported from the package barrel, so importing the package never loads
 * libvips — import it directly from this path when you want real downscaling.
 * Same arrangement as `represent/regions/sharp-cropper.ts`, and for the same
 * reason: the line is NATIVE MODULE, not subprocess.
 *
 * `withoutEnlargement` is load-bearing, not a nicety. A library holds keyframes
 * from every width the user has ever had configured, and a recording captured at
 * 1280px must not be upscaled to meet a 1280px cap — that would spend encode time
 * to hand the model exactly the pixels it already had, and on a narrower frame it
 * would invent detail. Under the cap, this is a decode/re-encode of the same
 * image; the cap is a ceiling, never a target.
 *
 * A failure here must never cost the caption. The caller treats a null
 * downscaler as "send the original", and this function preserves that contract by
 * returning the input unchanged when sharp cannot read the image — a keyframe
 * that fails to decode is one the captioner should still get a chance at, and a
 * throw would fail the whole stage over one frame.
 */

import sharp from "sharp";
import type { ImageDownscaler } from "./downscale.js";

/** Encoder quality for the re-encoded caption image. Matches SharpRegionCropper. */
export const DEFAULT_CAPTION_QUALITY = 80;

export interface SharpDownscalerOptions {
  /** Encoder quality for the re-encoded image (default 80). */
  quality?: number;
}

export function sharpDownscaler(
  maxWidth: number,
  opts: SharpDownscalerOptions = {},
): ImageDownscaler {
  const quality = opts.quality ?? DEFAULT_CAPTION_QUALITY;
  return async (image: Uint8Array): Promise<Uint8Array> => {
    try {
      const out = await sharp(image)
        .resize({ width: maxWidth, withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      return new Uint8Array(out);
    } catch {
      // One unreadable keyframe must not fail the stage; see the header.
      return image;
    }
  };
}
