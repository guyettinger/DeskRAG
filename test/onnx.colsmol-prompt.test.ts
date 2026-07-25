import { describe, expect, it } from "vitest";
import { computeTileGeometry, expectedTokenCount } from "../src/embed/onnx/geometry.js";
import {
  QUERY_BUFFER_TOKENS,
  TOK,
  buildImagePrompt,
  buildQueryPrompt,
  imageTokenPositions,
  tileMarker,
} from "../src/embed/onnx/colsmol-prompt.js";

/**
 * Ground truth measured from ColIdefics3Processor for a 1280x800 frame
 * (scripts/dump-colsmol-processor.py): 874 tokens, 832 of them <image>.
 * The run structure is asserted below in full.
 */
const G = computeTileGeometry(1280, 800);

describe("tileMarker", () => {
  it("matches the measured ids", () => {
    expect(tileMarker(1, 1)).toBe(49153);
    expect(tileMarker(1, 4)).toBe(49156);
    expect(tileMarker(2, 1)).toBe(49159); // +6, not +4 — six columns per row
    expect(tileMarker(3, 4)).toBe(49168);
  });
});

describe("buildImagePrompt", () => {
  const ids = buildImagePrompt(G);

  it("produces the measured total length", () => {
    expect(ids.length).toBe(874);
  });

  it("produces the measured image-token count", () => {
    expect(ids.filter((t) => t === TOK.image).length).toBe(832);
    expect(ids.filter((t) => t === TOK.image).length).toBe(expectedTokenCount(G));
  });

  it("opens with <|im_start|>User:", () => {
    expect(ids.slice(0, 3)).toEqual([TOK.imStart, TOK.user, TOK.colon]);
  });

  it("wraps each tile as fake + marker + 64 image tokens", () => {
    expect(ids[3]).toBe(TOK.fake);
    expect(ids[4]).toBe(tileMarker(1, 1));
    expect(ids.slice(5, 69).every((t) => t === TOK.image)).toBe(true);
    expect(ids[69]).toBe(TOK.fake);
    expect(ids[70]).toBe(tileMarker(1, 2));
  });

  it("separates rows with a newline and the LAST row with a double newline", () => {
    // row 1 = 4 tiles x 66 tokens, starting at index 3
    const afterRow1 = 3 + 4 * 66;
    expect(ids[afterRow1]).toBe(TOK.newline);
    const afterRow2 = afterRow1 + 1 + 4 * 66;
    expect(ids[afterRow2]).toBe(TOK.newline);
    const afterRow3 = afterRow2 + 1 + 4 * 66;
    expect(ids[afterRow3]).toBe(TOK.doubleNewline);
  });

  it("places the global tile after the grid", () => {
    const afterGrid = 3 + 3 * (4 * 66 + 1);
    expect(ids[afterGrid]).toBe(TOK.fake);
    expect(ids[afterGrid + 1]).toBe(TOK.globalImg);
    expect(ids.slice(afterGrid + 2, afterGrid + 66).every((t) => t === TOK.image)).toBe(true);
  });

  it("closes with the instruction tail", () => {
    expect(ids.slice(-10)).toEqual([
      TOK.fake,
      ...TOK.describe,
      TOK.endOfUtterance,
      TOK.newline,
      ...TOK.assistant,
    ]);
  });

  it("scales to a different grid — 512x512 is 4x4 + global = 17 tiles", () => {
    const g = computeTileGeometry(512, 512);
    const s = buildImagePrompt(g);
    expect(s.filter((t) => t === TOK.image).length).toBe(17 * 64);
    expect(s.filter((t) => t === TOK.image).length).toBe(expectedTokenCount(g));
  });
});

describe("imageTokenPositions", () => {
  it("returns one position per image token, in order", () => {
    const ids = buildImagePrompt(G);
    const pos = imageTokenPositions(ids);
    expect(pos.length).toBe(832);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
    expect(pos.every((p) => ids[p] === TOK.image)).toBe(true);
  });

  it("first position is the first image token, right after the first marker", () => {
    const ids = buildImagePrompt(G);
    expect(imageTokenPositions(ids)[0]).toBe(5);
  });

  it("returns [] when there are no image tokens", () => {
    expect(imageTokenPositions(buildQueryPrompt([81, 17389, 910]))).toEqual([]);
  });
});

describe("buildQueryPrompt", () => {
  it("matches the measured query for 'a login form'", () => {
    // measured: [81, 17389, 910] + 10 x <end_of_utterance>
    expect(buildQueryPrompt([81, 17389, 910])).toEqual([
      81,
      17389,
      910,
      ...Array<number>(10).fill(TOK.endOfUtterance),
    ]);
  });

  it("always appends exactly the buffer, whatever the query length", () => {
    for (const n of [1, 3, 20]) {
      const q = Array.from({ length: n }, (_, i) => i + 100);
      const out = buildQueryPrompt(q);
      expect(out.length).toBe(n + QUERY_BUFFER_TOKENS);
      expect(out.filter((t) => t === TOK.endOfUtterance).length).toBe(QUERY_BUFFER_TOKENS);
    }
  });

  it("adds no chat-template prefix — the query branch has none", () => {
    expect(buildQueryPrompt([104])[0]).toBe(104);
  });
});
