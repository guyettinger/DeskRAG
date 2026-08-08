/**
 * Reads a device-base timestamp out of ffmpeg's `ametadata=mode=print` output.
 *
 * The audio branch cannot use `mkvtimestamp_v2` the way the screen branch does:
 * that muxer rejects audio streams outright ("Output file does not contain any
 * stream"). `ashowinfo` reports the same number but only through the LOG, which
 * would mean raising `-loglevel` to `info` — and the producer routes stderr
 * straight to the user, so every ordinary ffmpeg line would arrive as an error.
 * `ametadata` writes to its own fd instead, leaving the log level alone.
 *
 * It needs a key to print: `mode=print` emits nothing for a frame carrying no
 * metadata, so the producer adds one first. The line looks like
 * `frame:0    pts:0       pts_time:3483322.542625`.
 *
 * With `-copyts` that `pts_time` is on the capture device's timebase — measured
 * against a real microphone, a first pts of 3483322543ms against a monotonic
 * reading of 3483322610ms taken 67ms later.
 *
 * Only the FIRST value matters: it anchors the stream, and every timestamp
 * after it is derived from the byte count, which is exact. The byte count was
 * never the problem — the ANCHOR was, because it used to be the moment the
 * first bytes arrived rather than the moment they were captured.
 */
export function firstPtsTimeMs(text: string): number | null {
  const m = /pts_time:(-?\d+(?:\.\d+)?)/.exec(text);
  if (m === null) return null;
  const sec = Number(m[1]);
  return Number.isFinite(sec) ? sec * 1000 : null;
}
