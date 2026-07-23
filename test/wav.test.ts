import { describe, expect, it } from "vitest";
import { encodeWav } from "../src/capture/producers/wav.js";

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
