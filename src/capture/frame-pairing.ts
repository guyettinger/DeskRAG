/**
 * Pairing of the sampling branch's parallel outputs.
 *
 * ffmpeg emits the grayscale hash frames, the MJPEG keyframes and the PTS
 * stream on three separate pipes, and they are index-aligned ONLY because all
 * three sit downstream of one `mpdecimate` — frame N of each is the same frame.
 * Node still receives them independently, so a tuple is complete only once
 * every stream has delivered its N-th item.
 *
 * Extracted from the producer because the producer spawns a process and cannot
 * be unit-tested; this rule can. Same split as FrameChunker and
 * JpegStreamSplitter.
 */

export interface PairedSample {
  gray: Uint8Array;
  /**
   * ffmpeg's presentation timestamp in ms — the frame's CAPTURE time.
   *
   * `null` when the graph carries no timestamp output, which happens only under
   * a caller-supplied `ffmpegArgs` override. The caller then falls back to
   * arrival time; waiting for a stream that will never arrive would emit no
   * frames at all.
   */
  ptsMs: number | null;
  jpeg?: Uint8Array;
}

/**
 * Shift every complete tuple off the queues and return them.
 *
 * Pass `null` for a stream the graph does not produce (`pts` under an
 * `ffmpegArgs` override, `jpeg` when `storeImages` is false) — absent is not
 * the same as empty, which means "expected but not yet arrived" and must block.
 */
export function drainPairs(
  gray: Uint8Array[],
  pts: number[] | null,
  jpeg: Uint8Array[] | null,
): PairedSample[] {
  const out: PairedSample[] = [];
  while (
    gray.length > 0 &&
    (pts === null || pts.length > 0) &&
    (jpeg === null || jpeg.length > 0)
  ) {
    const sample: PairedSample = {
      gray: gray.shift()!,
      ptsMs: pts === null ? null : pts.shift()!,
    };
    if (jpeg !== null) sample.jpeg = jpeg.shift()!;
    out.push(sample);
  }
  return out;
}
