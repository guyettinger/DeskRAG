/**
 * SharpRegionCropper — the real RegionCropper, backed by sharp (libvips). Decodes
 * the stored keyframe image, extracts the region bbox, and re-encodes the crop for
 * embedding.
 *
 * Coordinate spaces: region bboxes come from the proposer in FRAME coordinates
 * (frame.width x frame.height), but the stored image may be downscaled (the
 * producer's imageMaxWidth). We read the image's actual pixel dims from sharp and
 * map the bbox frame->image before extracting. If frame dims are non-positive
 * (unknown), the bbox is assumed to already be in image space (scale 1).
 *
 * Not exported from the package barrel, so importing the package never loads
 * libvips — import it directly from this path when you want real cropping.
 */

import sharp from "sharp";
import type { Box } from "./geometry.js";
import type { RegionCropper } from "./cropper.js";

export interface SharpCropperOptions {
  /** Output encoding for the crop (default jpeg). */
  format?: "jpeg" | "png" | "webp";
  /** Encoder quality for lossy formats (default 80). */
  quality?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

export class SharpRegionCropper implements RegionCropper {
  private readonly format: "jpeg" | "png" | "webp";
  private readonly quality: number;

  constructor(opts: SharpCropperOptions = {}) {
    this.format = opts.format ?? "jpeg";
    this.quality = opts.quality ?? 80;
  }

  async crop(image: Uint8Array, frameW: number, frameH: number, box: Box): Promise<Uint8Array> {
    const meta = await sharp(image).metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;
    if (imgW <= 0 || imgH <= 0) throw new Error("SharpRegionCropper: could not read image dimensions");

    // Map bbox from frame space to image space (scale 1 when frame dims unknown).
    const sx = frameW > 0 ? imgW / frameW : 1;
    const sy = frameH > 0 ? imgH / frameH : 1;
    const left = clamp(Math.round(box.x * sx), 0, imgW - 1);
    const top = clamp(Math.round(box.y * sy), 0, imgH - 1);
    const width = clamp(Math.round(box.w * sx), 1, imgW - left);
    const height = clamp(Math.round(box.h * sy), 1, imgH - top);

    const pipeline = sharp(image).extract({ left, top, width, height });
    const encoded =
      this.format === "png"
        ? pipeline.png()
        : this.format === "webp"
          ? pipeline.webp({ quality: this.quality })
          : pipeline.jpeg({ quality: this.quality });
    return new Uint8Array(await encoded.toBuffer());
  }
}
