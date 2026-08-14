/**
 * ColSmol prompt construction.
 *
 * ColPali-family models do not take pixels alone: image patches are embedded as
 * placeholder tokens inside a templated text sequence, and the model's output
 * covers that whole sequence. Feeding a differently-shaped prompt yields vectors
 * that are plausible but wrong — similarity scores stay in a believable range
 * while retrieval quietly degrades. So this is built from token IDS measured
 * from ColIdefics3Processor (scripts/dump-colsmol-processor.py), not by
 * re-tokenizing a reconstructed string, which could drift.
 *
 * Pure and weight-free, so it is exhaustively testable.
 *
 * Verified shape for 1280x800 (4x3 grid + global):
 *   3 prefix + 3 rows x (4 cols x 66 + 1 separator) + 66 global + 10 tail = 874
 *   of which 13 x 64 = 832 are image tokens.
 */

import type { TileGeometry } from "./geometry.js";

/** Token ids, measured — not guessed. */
export const TOK = {
  imStart: 1,
  user: 11126,
  colon: 42,
  /** Wraps every tile marker. */
  fake: 49189,
  globalImg: 49152,
  /** <row_1_col_1>; ids advance by 1 per column and by ROW_STRIDE per row. */
  row1col1: 49153,
  image: 49190,
  newline: 198,
  doubleNewline: 1116,
  /** "Describe the image." */
  describe: [37964, 260, 2443, 30] as const,
  endOfUtterance: 49279,
  /** "Assistant:" */
  assistant: [9519, 9531, 42] as const,
} as const;

/** <row_r_col_c> ids are laid out with six columns per row, whatever the grid. */
const ROW_STRIDE = 6;
/** Queries are padded with this many <end_of_utterance> tokens, always. */
export const QUERY_BUFFER_TOKENS = 10;

/** Marker id for a 1-based (row, col) tile position. */
export function tileMarker(row: number, col: number): number {
  return TOK.row1col1 + (row - 1) * ROW_STRIDE + (col - 1);
}

/**
 * The full `input_ids` for embedding one image, matching ColIdefics3Processor.
 *
 * Layout: prefix, then each grid row (each tile = fake + marker + 64 image
 * tokens) separated by a newline — a double newline after the LAST row — then
 * the global tile, then the instruction tail.
 */
export function buildImagePrompt(g: TileGeometry): number[] {
  const ids: number[] = [TOK.imStart, TOK.user, TOK.colon];

  for (let row = 1; row <= g.rows; row++) {
    for (let col = 1; col <= g.cols; col++) {
      ids.push(TOK.fake, tileMarker(row, col));
      for (let i = 0; i < g.tokensPerTile; i++) ids.push(TOK.image);
    }
    ids.push(row === g.rows ? TOK.doubleNewline : TOK.newline);
  }

  if (g.hasGlobalTile) {
    ids.push(TOK.fake, TOK.globalImg);
    for (let i = 0; i < g.tokensPerTile; i++) ids.push(TOK.image);
  }

  ids.push(TOK.fake, ...TOK.describe, TOK.endOfUtterance, TOK.newline, ...TOK.assistant);
  return ids;
}

/**
 * Query `input_ids`: the tokenized query followed by a fixed run of
 * <end_of_utterance> buffer tokens. There is no chat-template prefix on this
 * branch — measured, and initially surprising.
 */
export function buildQueryPrompt(queryTokenIds: number[]): number[] {
  const ids = [...queryTokenIds];
  for (let i = 0; i < QUERY_BUFFER_TOKENS; i++) ids.push(TOK.endOfUtterance);
  return ids;
}

/**
 * Positions in `buildQueryPrompt(queryTokenIds)` that hold the user's OWN words.
 *
 * This tokenizer's prompt has NO [CLS]/[SEP] wrapper — the query's tokens start
 * at 0 and the buffer run is appended after them. Same contract as the
 * ColModernVBERT module's function of this name; the layouts differ, which is
 * exactly why each module states its own.
 *
 * Scoring uses every vector, buffer slots included. Highlighting uses only
 * these: a buffer vector's best-matching patch answers nothing the user typed.
 */
export function queryContentPositions(queryTokenIds: number[]): number[] {
  return Array.from({ length: queryTokenIds.length }, (_, i) => i);
}

/**
 * Sequence positions holding an image token, in order.
 *
 * The model emits one vector per sequence position, most of which are text. The
 * n-th entry here is the n-th image patch, which is what makes
 * `patchIndexToBox` applicable to the selected vectors.
 */
export function imageTokenPositions(ids: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === TOK.image) out.push(i);
  }
  return out;
}
