/**
 * ImageDownscaler — shrinks a stored keyframe on its way to the captioner, and
 * nothing else. A real implementation decodes and re-encodes the image, which
 * pulls in a codec, so it is a pluggable adapter exactly like `RegionCropper`;
 * tests inject a counting stub, and absence means the full-size bytes go
 * through unchanged.
 *
 * WHY THIS EXISTS AS A SEPARATE CAP. The stored keyframe's width is
 * `imageMaxWidth`, and that setting belongs to the IMAGE MODEL: ColModernVBERT's
 * preprocessor upscales below 2048px and match quality degrades with no visible
 * error, which is why the app banners the user to raise it to 2560. The captioner
 * wants the opposite, and both are right — measured on real keyframes with the
 * configured VLM, one caption cost 4113 prompt tokens and 154-224s at 2560px
 * against 1389 tokens and 91-107s at 1280px, while both replies still read the
 * calculator expression that was the entire retrievable content of the segment.
 * So this is a second cap rather than a lower first one: shrinking what is
 * STORED would quietly cost visual search its resolution to buy the captioner
 * its speed.
 *
 * It is never applied to what is persisted — only to the bytes handed to the
 * model — so a caption stage re-run at a different width costs a re-caption and
 * nothing else.
 */

export type ImageDownscaler = (image: Uint8Array) => Promise<Uint8Array>;
