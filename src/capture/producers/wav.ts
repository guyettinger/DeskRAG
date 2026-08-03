/**
 * encodeWav — wrap raw little-endian PCM in a minimal canonical WAV container.
 * Pure and synchronous so the audio-chunking path is unit-testable without
 * spawning ffmpeg. Only the 44-byte PCM ("fmt "/"data") header is emitted.
 *
 * wavPeaks is its inverse and lives here for that reason: the header layout
 * must not be described in two places. Two readers of one format is a standing
 * drift hazard — it is exactly how `ax-dump` and `ax-exec` came to disagree
 * about a single element, which was enough to stop replay verifying.
 */

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export function encodeWav(pcm: Uint8Array, fmt: WavFormat): Uint8Array {
  const { sampleRate, channels, bitsPerSample } = fmt;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0)
    throw new Error(`invalid sampleRate ${sampleRate}`);
  if (!Number.isInteger(channels) || channels <= 0)
    throw new Error(`invalid channels ${channels}`);
  if (bitsPerSample !== 8 && bitsPerSample !== 16 && bitsPerSample !== 32)
    throw new Error(`invalid bitsPerSample ${bitsPerSample}`);

  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);

  const writeAscii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };

  writeAscii(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length, true); // file size - 8
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  dv.setUint32(16, 16, true); // PCM fmt chunk size
  dv.setUint16(20, 1, true); // audio format: 1 = PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

export interface WavPeaks {
  /** Max absolute amplitude per bucket, 0–1. Length is exactly `buckets`. */
  peaks: number[];
  sampleRate: number;
  channels: number;
  /** MEASURED FROM THE BYTES PRESENT, not from the declared chunk size. */
  durationSec: number;
}

/**
 * Peak envelope of a 16-bit PCM WAV — the exact inverse of {@link encodeWav}.
 * Pure and synchronous; loads nothing.
 *
 * Returns null for anything that is not 16-bit PCM and for a file with no
 * readable frames, so a caller can distinguish "cannot read this" from "read it
 * and it was silent" — a distinction anything drawing an envelope depends on.
 *
 * A `data` chunk declaring more bytes than the file holds is TRUNCATED to what
 * is there, and `durationSec` reports the real length. A killed recorder leaves
 * exactly that, and the missing tail must surface as absent coverage rather
 * than as an envelope stretched over time that was never recorded.
 */
export function wavPeaks(wav: Uint8Array, buckets: number): WavPeaks | null {
  if (buckets <= 0 || wav.length < 12) return null;
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (o: number): string =>
    String.fromCharCode(wav[o]!, wav[o + 1]!, wav[o + 2]!, wav[o + 3]!);
  if (ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return null;

  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  let data: { start: number; length: number } | null = null;

  // Walk the chunk list rather than assuming the canonical 44-byte header:
  // encodeWav emits exactly that, but ffmpeg and other writers interleave
  // LIST/fact chunks ahead of `data`, and tolerating them costs ten lines.
  for (let o = 12; o + 8 <= wav.length; ) {
    const id = ascii(o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= wav.length) {
      if (dv.getUint16(body, true) !== 1) return null; // 1 = uncompressed PCM
      fmt = {
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      data = { start: body, length: Math.max(0, Math.min(size, wav.length - body)) };
      break;
    }
    o = body + size + (size % 2); // RIFF chunks are word-aligned
  }

  if (!fmt || !data) return null;
  if (fmt.bits !== 16 || fmt.channels <= 0 || fmt.sampleRate <= 0) return null;

  const frameBytes = 2 * fmt.channels;
  const frames = Math.floor(data.length / frameBytes);
  if (frames <= 0) return null;

  // Every sample is read — no striding. At 16 kHz a thirty-minute recording is
  // 28.8M samples, which is tens of milliseconds, and a stride can miss the
  // very peak the envelope exists to show.
  const peaks = new Array<number>(buckets).fill(0);
  for (let f = 0; f < frames; f++) {
    const b = Math.min(buckets - 1, Math.floor((f / frames) * buckets));
    // Channel 0 only: every audio blob this repo writes is mono, and a
    // single-channel peak is what an envelope draws.
    const a = Math.abs(dv.getInt16(data.start + f * frameBytes, true)) / 32768;
    if (a > peaks[b]!) peaks[b] = a;
  }

  return {
    peaks,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    durationSec: frames / fmt.sampleRate,
  };
}
