import { describe, expect, it } from "vitest";
import { encodeWav, wavPeaks } from "../src/capture/producers/wav.js";

const ascii = (bytes: Uint8Array, off: number, len: number): string =>
  String.fromCharCode(...bytes.subarray(off, off + len));

describe("encodeWav", () => {
  it("wraps PCM in a canonical 44-byte WAV header with correct fields", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = encodeWav(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 16 });
    expect(wav.length).toBe(44 + pcm.length);

    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(ascii(wav, 36, 4)).toBe("data");

    const dv = new DataView(wav.buffer);
    expect(dv.getUint32(4, true)).toBe(36 + pcm.length); // RIFF size
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(1); // mono
    expect(dv.getUint32(24, true)).toBe(16000); // sample rate
    expect(dv.getUint32(28, true)).toBe(16000 * 2); // byte rate
    expect(dv.getUint16(32, true)).toBe(2); // block align
    expect(dv.getUint16(34, true)).toBe(16); // bits
    expect(dv.getUint32(40, true)).toBe(pcm.length); // data size
    // Payload preserved verbatim.
    expect([...wav.subarray(44)]).toEqual([...pcm]);
  });

  it("rejects invalid formats", () => {
    const pcm = new Uint8Array(4);
    expect(() => encodeWav(pcm, { sampleRate: 0, channels: 1, bitsPerSample: 16 })).toThrow();
    expect(() => encodeWav(pcm, { sampleRate: 16000, channels: 0, bitsPerSample: 16 })).toThrow();
    expect(() => encodeWav(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 12 })).toThrow();
  });
});

/** PCM whose quarters ramp in amplitude. Signs alternate so the peak is a
 *  genuine max of |s| rather than a DC offset. */
function rampPcm(amps: number[], framesPer: number): Uint8Array {
  const pcm = new Uint8Array(amps.length * framesPer * 2);
  const dv = new DataView(pcm.buffer);
  amps.forEach((a, q) => {
    for (let i = 0; i < framesPer; i++) {
      dv.setInt16((q * framesPer + i) * 2, i % 2 === 0 ? a : -a, true);
    }
  });
  return pcm;
}

const FMT = { sampleRate: 16000, channels: 1, bitsPerSample: 16 } as const;

describe("wavPeaks", () => {
  it("recovers the envelope encodeWav wrote", () => {
    const wav = encodeWav(rampPcm([0, 8192, 16384, 32767], 400), FMT);
    const out = wavPeaks(wav, 4);
    expect(out).not.toBeNull();
    expect(out!.peaks.map((p) => Math.round(p * 100))).toEqual([0, 25, 50, 100]);
    expect(out!.sampleRate).toBe(16000);
    expect(out!.channels).toBe(1);
    expect(out!.durationSec).toBeCloseTo(1600 / 16000, 5);
  });

  it("reports duration from the BYTES PRESENT, not the declared size", () => {
    // A killed recorder leaves exactly this: a header promising more than the
    // file holds. The measured duration is what makes the missing tail read as
    // a coverage gap instead of a stretched envelope.
    const wav = encodeWav(rampPcm([32767], 1600), FMT);
    const truncated = wav.slice(0, 44 + 1600); // half the declared data chunk
    const out = wavPeaks(truncated, 2);
    expect(out).not.toBeNull();
    expect(out!.durationSec).toBeCloseTo(800 / 16000, 5);
  });

  it("returns null for a format it cannot read, so the caller can say why", () => {
    expect(wavPeaks(encodeWav(new Uint8Array(64), { ...FMT, bitsPerSample: 8 }), 4)).toBeNull();
    expect(wavPeaks(new Uint8Array([1, 2, 3]), 4)).toBeNull();
    expect(wavPeaks(encodeWav(new Uint8Array(0), FMT), 4)).toBeNull();
  });
});
