/**
 * sharp-backed preprocessing for ColSmol: resize, split into tiles, normalize.
 *
 * Loads sharp, so it lives apart from colsmol.ts and is imported lazily — the
 * adapter can be unit-tested without a native module.
 *
 * Mirrors Idefics3ImageProcessor as MEASURED, not as documented:
 *   - the longest edge is scaled TO 2048 (upscaling small frames), then both
 *     dimensions are rounded up to whole tiles and the image is resized to that
 *     exactly — an anisotropic resize, never padding;
 *   - grid tiles come first in row-major order, with the whole image, resized to
 *     one tile, appended LAST;
 *   - normalization is x/255 then (x - 0.5) / 0.5, i.e. [0,255] -> [-1,1],
 *     from preprocessor_config.json (rescale_factor, image_mean, image_std).
 *
 * CAPTURE FRAMES AT >= 2048 ON THE LONG EDGE.
 *
 * sharp's `kernel` option governs REDUCTION only; libvips magnifies through a
 * separate path that sharp does not expose, and it does not match PIL's LANCZOS.
 * Measured against the reference processor on an identical UI frame:
 *
 *   1280x800  -> 2048x1536 (upscale)    pixels max|d| 0.753, mean 0.0150
 *                                       patch cosine  min 0.772, median 0.992
 *   2560x1600 -> 2048x1536 (downscale)  pixels max|d| 0.047, mean 0.0015
 *                                       patch cosine  min 0.993, median 0.9998
 *
 * So the fidelity gap is not in this file — it is in the capture resolution.
 * Below 2048 the preprocessor upscales and ~1% of patch vectors drift below
 * cosine 0.90 from the reference, silently, with scores still looking sane.
 * Every reduction kernel (lanczos3/lanczos2/cubic/mitchell) produces
 * byte-identical output when enlarging, so this cannot be tuned away here.
 */

import { computeTileGeometry, type TileConfig, type TiledImage } from "./geometry.js";

/** From preprocessor_config.json. */
const MEAN = 0.5;
const STD = 0.5;

/** Convert an RGB byte buffer to normalized CHW float32. */
function toChw(data: Buffer, side: number): Float32Array {
  const n = side * side;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const base = i * 3;
    out[i] = (data[base]! / 255 - MEAN) / STD;
    out[n + i] = (data[base + 1]! / 255 - MEAN) / STD;
    out[2 * n + i] = (data[base + 2]! / 255 - MEAN) / STD;
  }
  return out;
}

export async function tileImageWithSharp(
  image: Uint8Array,
  cfg: TileConfig,
): Promise<TiledImage> {
  const sharpMod = await import(/* @vite-ignore */ "sharp");
  const sharp = sharpMod.default;

  const meta = await sharp(Buffer.from(image)).metadata();
  const srcWidth = meta.width ?? 0;
  const srcHeight = meta.height ?? 0;
  if (srcWidth === 0 || srcHeight === 0) {
    throw new Error("ColSmol tiler: image has no dimensions");
  }

  const g = computeTileGeometry(srcWidth, srcHeight, cfg);
  const side = cfg.tileSize;

  // One anisotropic resize to an exact whole number of tiles. `fill` is
  // deliberate: aspect ratio is NOT preserved, matching the processor.
  const resized = await sharp(Buffer.from(image))
    .resize(g.scaledWidth, g.scaledHeight, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();

  const tiles: Float32Array[] = [];
  const rowStride = g.scaledWidth * 3;

  for (let row = 0; row < g.rows; row++) {
    for (let col = 0; col < g.cols; col++) {
      // Crop from the already-decoded buffer rather than re-invoking sharp per
      // tile: 13 extract() round-trips per frame is a lot of encode/decode.
      const tile = Buffer.allocUnsafe(side * side * 3);
      for (let y = 0; y < side; y++) {
        const srcOff = (row * side + y) * rowStride + col * side * 3;
        resized.copy(tile, y * side * 3, srcOff, srcOff + side * 3);
      }
      tiles.push(toChw(tile, side));
    }
  }

  if (g.hasGlobalTile) {
    const global = await sharp(Buffer.from(image))
      .resize(side, side, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
    tiles.push(toChw(global, side));
  }

  return { tiles, width: srcWidth, height: srcHeight };
}
