import { describe, expect, it } from "vitest";
import { TimestampLineSplitter } from "../src/capture/timestamp-splitter.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("TimestampLineSplitter", () => {
  it("skips the mkvtimestamp_v2 header and yields whole values", () => {
    const s = new TimestampLineSplitter();
    expect(s.push(enc("# timecode format v2\n0\n1000\n2000\n"))).toEqual([0, 1000, 2000]);
  });

  it("buffers a value split across a chunk boundary", () => {
    // The whole point: a chunk boundary lands mid-number, and "10" then "00"
    // parsed independently yields 10 and 0 — two plausible, wrong timestamps.
    const s = new TimestampLineSplitter();
    expect(s.push(enc("# timecode format v2\n10"))).toEqual([]);
    expect(s.push(enc("00\n"))).toEqual([1000]);
  });

  it("holds a trailing partial line until its newline arrives", () => {
    const s = new TimestampLineSplitter();
    expect(s.push(enc("# timecode format v2\n0\n15"))).toEqual([0]);
    expect(s.pending).toBeGreaterThan(0);
    expect(s.push(enc("00\n3000\n"))).toEqual([1500, 3000]);
    expect(s.pending).toBe(0);
  });

  it("ignores blank lines and yields nothing for an empty chunk", () => {
    const s = new TimestampLineSplitter();
    expect(s.push(enc("# timecode format v2\n\n0\n\n500\n"))).toEqual([0, 500]);
    expect(s.push(enc(""))).toEqual([]);
  });
});
