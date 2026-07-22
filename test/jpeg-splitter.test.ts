import { describe, expect, it } from "vitest";
import { JpegStreamSplitter } from "../src/capture/jpeg-splitter.js";

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const frame = (payload: number[]) => Uint8Array.from([...SOI, ...payload, ...EOI]);

describe("JpegStreamSplitter", () => {
  it("extracts a complete frame and drops leading garbage", () => {
    const s = new JpegStreamSplitter();
    const f = frame([1, 2, 3]);
    const out = s.push(Uint8Array.from([0x00, 0x11, ...f]));
    expect(out).toEqual([f]);
    expect(s.pending).toBe(0);
  });

  it("extracts two back-to-back frames", () => {
    const s = new JpegStreamSplitter();
    const a = frame([1, 2]);
    const b = frame([9, 8, 7]);
    expect(s.push(Uint8Array.from([...a, ...b]))).toEqual([a, b]);
  });

  it("reassembles a frame split across chunk boundaries", () => {
    const s = new JpegStreamSplitter();
    const f = frame([4, 5, 6, 7]);
    const mid = Math.floor(f.length / 2);
    expect(s.push(f.subarray(0, mid))).toEqual([]); // incomplete
    expect(s.pending).toBeGreaterThan(0);
    expect(s.push(f.subarray(mid))).toEqual([f]);
  });

  it("retains a trailing lone 0xFF that begins a split SOI", () => {
    const s = new JpegStreamSplitter();
    expect(s.push(Uint8Array.from([0x00, 0xff]))).toEqual([]); // possible SOI start
    expect(s.pending).toBe(1);
    const rest = Uint8Array.from([0xd8, 1, 2, ...EOI]); // completes SOI + frame
    expect(s.push(rest)).toEqual([Uint8Array.from([...SOI, 1, 2, ...EOI])]);
  });
});
