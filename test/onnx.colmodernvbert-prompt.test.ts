import { describe, expect, it } from "vitest";
import { computeTileGeometry, expectedTokenCount } from "../src/embed/onnx/geometry.js";
import {
  MV_TOK,
  QUERY_BUFFER_TOKENS,
  buildImagePrompt,
  buildQueryPrompt,
  imageTokenPositions,
  stripWrapper,
  tileMarker,
} from "../src/embed/onnx/colmodernvbert-prompt.js";

/**
 * Ground truth measured against the real tokenizer
 * (scripts/dev/dump-colmodernvbert-tokens.ts, encoding the exact string fastembed's
 * colmodernvbert.py builds): a 1280x800 frame is 884 tokens, 832 of them
 * <image>. Every structural assertion below is read off that encoding, not off
 * ColSmol's — the template between the special tokens is identical, but this
 * tokenizer wraps the whole sequence in [CLS] … [SEP] and ColSmol's does not.
 */
const G = computeTileGeometry(1280, 800);

describe("tileMarker", () => {
  it("matches the measured ids", () => {
    expect(tileMarker(1, 1)).toBe(50369);
    expect(tileMarker(1, 4)).toBe(50372);
    expect(tileMarker(2, 1)).toBe(50375); // +6, not +4 — six columns per row
    expect(tileMarker(3, 4)).toBe(50384);
  });
});

describe("buildImagePrompt", () => {
  const ids = buildImagePrompt(G);
  // [CLS] + the 10 tokens of "<|begin_of_text|>User:", which is ordinary text
  // here: <|begin_of_text|> is not in this vocab.
  const HEAD = 1 + MV_TOK.prefix.length;

  it("produces the measured total length", () => {
    expect(ids.length).toBe(884);
  });

  it("produces the measured image-token count", () => {
    expect(ids.filter((t) => t === MV_TOK.image).length).toBe(832);
    expect(ids.filter((t) => t === MV_TOK.image).length).toBe(expectedTokenCount(G));
  });

  it("opens with [CLS] then the visual prompt prefix", () => {
    expect(ids[0]).toBe(MV_TOK.cls);
    expect(ids.slice(1, HEAD)).toEqual([...MV_TOK.prefix]);
  });

  it("wraps each tile as fake + marker + 64 image tokens", () => {
    expect(ids[HEAD]).toBe(MV_TOK.fake);
    expect(ids[HEAD + 1]).toBe(tileMarker(1, 1));
    expect(ids.slice(HEAD + 2, HEAD + 66).every((t) => t === MV_TOK.image)).toBe(true);
    expect(ids[HEAD + 66]).toBe(MV_TOK.fake);
    expect(ids[HEAD + 67]).toBe(tileMarker(1, 2));
  });

  it("separates rows with a newline and the LAST row with a double newline", () => {
    // The last row's "\n" and the global block's leading "\n" are adjacent in
    // the string, so BPE merges them into one token — 535, not 187 twice.
    const afterRow1 = HEAD + 4 * 66;
    expect(ids[afterRow1]).toBe(MV_TOK.newline);
    const afterRow2 = afterRow1 + 1 + 4 * 66;
    expect(ids[afterRow2]).toBe(MV_TOK.newline);
    const afterRow3 = afterRow2 + 1 + 4 * 66;
    expect(ids[afterRow3]).toBe(MV_TOK.doubleNewline);
  });

  it("places the global tile after the grid", () => {
    const afterGrid = HEAD + 3 * (4 * 66 + 1);
    expect(ids[afterGrid]).toBe(MV_TOK.fake);
    expect(ids[afterGrid + 1]).toBe(MV_TOK.globalImg);
    expect(ids.slice(afterGrid + 2, afterGrid + 66).every((t) => t === MV_TOK.image)).toBe(true);
  });

  it("closes with the instruction tail and [SEP]", () => {
    expect(ids.slice(-12)).toEqual([
      MV_TOK.fake,
      ...MV_TOK.describe,
      MV_TOK.endOfUtterance,
      ...MV_TOK.assistant,
      MV_TOK.sep,
    ]);
  });

  it("emits exactly one image token per patch the geometry predicts", () => {
    for (const [w, h] of [
      [1280, 800],
      [2560, 1600],
      [1512, 982],
      [512, 512],
    ] as const) {
      const g = computeTileGeometry(w, h);
      expect(imageTokenPositions(buildImagePrompt(g)).length).toBe(expectedTokenCount(g));
    }
  });

  it("wraps every grid tile in fake + marker, in row-major order", () => {
    // The marker block is contiguous and bounded — <end_of_utterance>, <fake>
    // and <image> all sit ABOVE it, so "id >= row1col1" alone catches them too.
    const lastMarker = tileMarker(6, 6);
    const markers = ids.filter((id) => id >= MV_TOK.row1col1 && id <= lastMarker);
    const expected: number[] = [];
    for (let r = 1; r <= G.rows; r++) {
      for (let c = 1; c <= G.cols; c++) expected.push(tileMarker(r, c));
    }
    expect(markers.slice(0, expected.length)).toEqual(expected);
  });
});

describe("imageTokenPositions", () => {
  it("returns one position per image token, in order", () => {
    const pos = imageTokenPositions(buildImagePrompt(G));
    expect(pos.length).toBe(832);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
  });

  it("first position is the first image token, right after the first marker", () => {
    expect(imageTokenPositions(buildImagePrompt(G))[0]).toBe(1 + MV_TOK.prefix.length + 2);
  });

  it("returns [] when there are no image tokens", () => {
    expect(imageTokenPositions(buildQueryPrompt([66, 8351, 4645]))).toEqual([]);
  });
});

describe("buildQueryPrompt", () => {
  it("matches the measured query for 'a terminal showing a build error'", () => {
    // measured: [CLS] + [66,8351,4645,247,1973,2228] + 10 x <end_of_utterance> + [SEP]
    expect(buildQueryPrompt([66, 8351, 4645, 247, 1973, 2228])).toEqual([
      MV_TOK.cls,
      66,
      8351,
      4645,
      247,
      1973,
      2228,
      ...Array<number>(10).fill(MV_TOK.endOfUtterance),
      MV_TOK.sep,
    ]);
  });

  it("appends exactly ten buffer tokens, whatever the query length", () => {
    expect(QUERY_BUFFER_TOKENS).toBe(10);
    for (const n of [1, 3, 20]) {
      const q = Array.from({ length: n }, (_, i) => i + 100);
      const out = buildQueryPrompt(q);
      expect(out.length).toBe(n + QUERY_BUFFER_TOKENS + 2);
      expect(out.filter((t) => t === MV_TOK.endOfUtterance).length).toBe(QUERY_BUFFER_TOKENS);
    }
  });

  it("puts the buffer INSIDE the wrapper — [SEP] stays last", () => {
    const out = buildQueryPrompt([104]);
    expect(out[out.length - 1]).toBe(MV_TOK.sep);
    expect(out[out.length - 2]).toBe(MV_TOK.endOfUtterance);
  });

  it("is the same whether the caller passes wrapped or bare ids", () => {
    // The tokenizer's own encode already adds [CLS]/[SEP]; passing that through
    // must not double-wrap or bury the buffer behind a [SEP].
    expect(buildQueryPrompt([MV_TOK.cls, 104, MV_TOK.sep])).toEqual(buildQueryPrompt([104]));
  });
});

describe("stripWrapper", () => {
  it("removes a leading [CLS] and a trailing [SEP]", () => {
    expect(stripWrapper([MV_TOK.cls, 1, 2, MV_TOK.sep])).toEqual([1, 2]);
  });

  it("leaves bare ids alone", () => {
    expect(stripWrapper([1, 2])).toEqual([1, 2]);
  });

  it("does not strip a [SEP] that is not last, or a [CLS] that is not first", () => {
    expect(stripWrapper([1, MV_TOK.sep, 2])).toEqual([1, MV_TOK.sep, 2]);
    expect(stripWrapper([1, MV_TOK.cls, 2])).toEqual([1, MV_TOK.cls, 2]);
  });
});
