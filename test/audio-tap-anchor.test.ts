import { describe, expect, it } from "vitest";
import { parseAudioTapAnchor } from "../src/capture/audio-tap-anchor.js";

/**
 * The anchor is the only thing standing between computer audio and
 * arrival-stamped audio, so this parser GUESSES AT NOTHING. Every malformed
 * shape throws rather than degrading to a default — the `parseDeviceClock`
 * contract, for the same reason: a producer that quietly invents an anchor puts
 * a whole recording's audio on a different clock from its frames and events,
 * and nothing downstream can tell.
 */
describe("parseAudioTapAnchor", () => {
  const good =
    '{"v":1,"anchorMs":4579263022.479916,"byteOffset":0,' +
    '"sampleRate":16000,"channels":1,"format":"s16le"}';

  it("reads the contract the sidecar emits", () => {
    expect(parseAudioTapAnchor(good)).toEqual({
      version: 1,
      anchorMs: 4579263022.479916,
      byteOffset: 0,
      sampleRate: 16000,
      channels: 1,
      format: "s16le",
    });
  });

  it("keeps the byte offset, which is what makes a second anchor meaningful", () => {
    const line = good.replace('"byteOffset":0', '"byteOffset":320000');
    expect(parseAudioTapAnchor(line).byteOffset).toBe(320000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseAudioTapAnchor(`  ${good}\n`).anchorMs).toBeCloseTo(4579263022.48, 1);
  });

  for (const [name, line] of [
    ["an empty line", ""],
    ["whitespace only", "   \n"],
    ["usage text from a stale binary", "usage: audio-tap [--sample-rate N]"],
    ["a bare log line", "[audio-tap] capturing at 16000 Hz mono s16le"],
    ["a JSON array", "[1,2,3]"],
    ["JSON null", "null"],
    ["a missing anchorMs", '{"v":1,"byteOffset":0,"sampleRate":16000,"channels":1,"format":"s16le"}'],
    ["a string anchorMs", '{"v":1,"anchorMs":"nope","byteOffset":0,"sampleRate":16000,"channels":1,"format":"s16le"}'],
    ["a NaN anchorMs", '{"v":1,"anchorMs":null,"byteOffset":0,"sampleRate":16000,"channels":1,"format":"s16le"}'],
    ["a missing format", '{"v":1,"anchorMs":1,"byteOffset":0,"sampleRate":16000,"channels":1}'],
  ] as const) {
    it(`throws on ${name}`, () => {
      expect(() => parseAudioTapAnchor(line)).toThrow();
    });
  }

  it("names what it saw, so a stale binary is diagnosable", () => {
    expect(() => parseAudioTapAnchor("usage: audio-tap")).toThrow(/usage: audio-tap/);
  });
});
