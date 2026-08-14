/**
 * ColModernVBERT prompt construction.
 *
 * Same shape as colsmol-prompt.ts and for the same reason — a ColPali-family
 * model embeds patches as placeholder tokens inside a templated sequence, and a
 * differently-shaped prompt yields vectors that are plausible but wrong, with
 * similarity scores staying in a believable range. The TOKEN IDS differ because
 * this is a ModernBERT tokenizer, not SmolLM2's, so they are measured with
 * scripts/dump-colmodernvbert-tokens.mjs rather than shared with that module.
 *
 * Template, from Qdrant's ONNX wrapper (fastembed colmodernvbert.py):
 *   "<|begin_of_text|>User:" + <image-block> + "Describe the image."
 *   + <end_of_utterance> + "\nAssistant:"
 * where <image-block> is, per grid row, each tile as
 *   <fake_token_around_image><row_r_col_c> + 64x<image>
 * then "\n" after each row, then
 *   "\n<fake_token_around_image><global-img>" + 64x<image>
 *   + <fake_token_around_image>
 *
 * THREE things about this tokenizer are not readable off a token table, and all
 * three were measured against the real one by encoding exactly the string
 * fastembed builds:
 *
 *   1. A TemplateProcessing post-processor wraps EVERY encode in [CLS] … [SEP].
 *      ColSmol's tokenizer has no such processor, so although the template
 *      between the special tokens is identical, both ends of the sequence
 *      differ. This is also why `buildQueryPrompt` puts the buffer tokens INSIDE
 *      the wrapper: fastembed augments the query STRING and then encodes, so the
 *      buffer lands before [SEP], never after it.
 *   2. `<|begin_of_text|>` IS NOT IN THIS VOCAB. It survives as ordinary
 *      byte-level BPE text — ten tokens, not one — so the prefix cannot be
 *      carried over from ColSmol's single `imStart`.
 *   3. The last grid row's "\n" and the global block's leading "\n" are ADJACENT
 *      in the string, so BPE merges them into ONE token (535), exactly the trap
 *      colsmol-prompt.ts records as `doubleNewline`. Emitting 187 twice would
 *      make an 885-token sequence where the real one is 884.
 *
 * Pure and weight-free, so it is exhaustively testable. The real-weights smoke
 * test re-encodes fastembed's string and compares it to `buildImagePrompt`
 * verbatim, which is what catches drift in any of the constants below.
 *
 * Verified shape for 1280x800 (4x3 grid + global):
 *   1 [CLS] + 10 prefix + 3 rows x (4 cols x 66 + 1 separator) + 67 global
 *   + 10 tail + 1 [SEP] = 884, of which 13 x 64 = 832 are image tokens.
 */

import type { TileGeometry } from "./geometry.js";

/** Token ids, measured from the real tokenizer — not guessed. */
export const MV_TOK = {
  /** TemplateProcessing wraps every encode in these. */
  cls: 50281,
  sep: 50282,
  /** "<|begin_of_text|>User:" — plain text to this vocab, hence ten tokens. */
  prefix: [29, 93, 2043, 64, 1171, 64, 1156, 49651, 6989, 27] as const,
  /** Wraps every tile marker. */
  fake: 50406,
  globalImg: 50368,
  /** <row_1_col_1>; ids advance by 1 per column and by ROW_STRIDE per row. */
  row1col1: 50369,
  image: 50407,
  newline: 187,
  doubleNewline: 535,
  /** "Describe the image." */
  describe: [4476, 19268, 253, 2460, 15] as const,
  endOfUtterance: 50405,
  /** "\nAssistant:" */
  assistant: [187, 6717, 5567, 27] as const,
} as const;

/** <row_r_col_c> ids are laid out with six columns per row, whatever the grid. */
const ROW_STRIDE = 6;

/** Queries are padded with this many <end_of_utterance> tokens, always. */
export const QUERY_BUFFER_TOKENS = 10;

/** Marker id for a 1-based (row, col) tile position. */
export function tileMarker(row: number, col: number): number {
  return MV_TOK.row1col1 + (row - 1) * ROW_STRIDE + (col - 1);
}

/**
 * Drop the [CLS] … [SEP] the tokenizer's post-processor adds, so a caller can
 * hand `tok.encode(text).ids` straight to `buildQueryPrompt` without the buffer
 * tokens ending up on the far side of the [SEP]. Only strips at the ends, so an
 * id that merely appears mid-sequence is left alone.
 */
export function stripWrapper(ids: number[]): number[] {
  let start = 0;
  let end = ids.length;
  if (ids[start] === MV_TOK.cls) start++;
  if (end > start && ids[end - 1] === MV_TOK.sep) end--;
  return ids.slice(start, end);
}

/**
 * The full `input_ids` for embedding one image.
 *
 * Layout: [CLS], prefix, then each grid row (each tile = fake + marker + 64
 * image tokens) separated by a newline — a double newline after the LAST row,
 * because it abuts the global block's own leading newline — then the global
 * tile, then the instruction tail and [SEP].
 */
export function buildImagePrompt(g: TileGeometry): number[] {
  const ids: number[] = [MV_TOK.cls, ...MV_TOK.prefix];

  for (let row = 1; row <= g.rows; row++) {
    for (let col = 1; col <= g.cols; col++) {
      ids.push(MV_TOK.fake, tileMarker(row, col));
      for (let i = 0; i < g.tokensPerTile; i++) ids.push(MV_TOK.image);
    }
    ids.push(row === g.rows ? MV_TOK.doubleNewline : MV_TOK.newline);
  }

  if (g.hasGlobalTile) {
    ids.push(MV_TOK.fake, MV_TOK.globalImg);
    for (let i = 0; i < g.tokensPerTile; i++) ids.push(MV_TOK.image);
  }

  ids.push(
    MV_TOK.fake,
    ...MV_TOK.describe,
    MV_TOK.endOfUtterance,
    ...MV_TOK.assistant,
    MV_TOK.sep,
  );
  return ids;
}

/**
 * Query `input_ids`: the tokenized query then a fixed run of <end_of_utterance>
 * buffer tokens, all inside the [CLS] … [SEP] wrapper. There is no chat-template
 * prefix on this branch — measured, and the same on ColSmol.
 */
export function buildQueryPrompt(queryTokenIds: number[]): number[] {
  const ids = [MV_TOK.cls, ...stripWrapper(queryTokenIds)];
  for (let i = 0; i < QUERY_BUFFER_TOKENS; i++) ids.push(MV_TOK.endOfUtterance);
  ids.push(MV_TOK.sep);
  return ids;
}

/**
 * Positions in `buildQueryPrompt(queryTokenIds)` that hold the user's OWN words.
 *
 * Derived from the layout rather than by filtering ids, so a query that happens
 * to contain a special id is still reported honestly: content is everything
 * between the [CLS] and the buffer run, which is exactly what buildQueryPrompt
 * puts there.
 *
 * Scoring uses every vector — the buffer slots are the learned expansion slots
 * late interaction relies on. HIGHLIGHTING uses only these, because a buffer or
 * wrapper vector's best-matching patch is not an answer to anything the user
 * typed. Measured: for "probe mcp", 12 of 15 vectors are wrapper or buffer, and
 * [CLS] alone scored 0.992 against a patch of blank document space.
 */
export function queryContentPositions(queryTokenIds: number[]): number[] {
  const n = stripWrapper(queryTokenIds).length;
  // Position 0 is the [CLS] buildQueryPrompt prepends.
  return Array.from({ length: n }, (_, i) => i + 1);
}

/**
 * Sequence positions holding an image token, in order.
 *
 * The model emits one vector per sequence position, most of which are text. The
 * n-th entry here is the n-th image patch, which is what makes `patchIndexToBox`
 * applicable to the selected vectors.
 */
export function imageTokenPositions(ids: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === MV_TOK.image) out.push(i);
  }
  return out;
}
