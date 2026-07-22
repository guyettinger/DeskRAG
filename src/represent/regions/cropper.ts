/**
 * RegionCropper — extracts the pixels of one region from a frame's encoded image,
 * returning bytes to embed. A real implementation decodes the image (sharp/jimp),
 * crops the bbox, and re-encodes — that pulls in an image codec, so it's a
 * pluggable adapter (like the native capture producers). Tests inject a
 * deterministic cropper so the region pipeline is verifiable without a codec.
 */

import type { Box } from "./geometry.js";

export interface RegionCropper {
  crop(image: Uint8Array, frameW: number, frameH: number, box: Box): Promise<Uint8Array>;
}
