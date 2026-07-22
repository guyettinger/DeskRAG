import { describe, expect, it } from "vitest";
import { FrameChunker } from "../src/capture/frame-chunker.js";

describe("FrameChunker", () => {
  it("reassembles fixed-size frames across arbitrary chunk boundaries", () => {
    const c = new FrameChunker(4);
    expect(c.push(Uint8Array.from([1, 2]))).toEqual([]); // partial
    expect(c.pending).toBe(2);

    const out = c.push(Uint8Array.from([3, 4, 5, 6, 7])); // completes one, 3 left over
    expect(out).toEqual([Uint8Array.from([1, 2, 3, 4])]);
    expect(c.pending).toBe(3);

    expect(c.push(Uint8Array.from([8]))).toEqual([Uint8Array.from([5, 6, 7, 8])]);
    expect(c.pending).toBe(0);
  });

  it("emits multiple frames from one large chunk", () => {
    const c = new FrameChunker(2);
    expect(c.push(Uint8Array.from([1, 2, 3, 4, 5]))).toEqual([
      Uint8Array.from([1, 2]),
      Uint8Array.from([3, 4]),
    ]);
    expect(c.pending).toBe(1);
  });

  it("rejects a non-positive frame size", () => {
    expect(() => new FrameChunker(0)).toThrow();
  });
});
