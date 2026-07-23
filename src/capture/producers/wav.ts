/**
 * encodeWav — wrap raw little-endian PCM in a minimal canonical WAV container.
 * Pure and synchronous so the audio-chunking path is unit-testable without
 * spawning ffmpeg. Only the 44-byte PCM ("fmt "/"data") header is emitted.
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
