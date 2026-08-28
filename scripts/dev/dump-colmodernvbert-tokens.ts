/**
 * Print ColModernVBERT's special-token ids from the real tokenizer.
 *
 * The prompt builder hardcodes these so it stays pure and weight-free; this is
 * how they are MEASURED rather than guessed, and test/onnx.smoke.test.ts
 * re-derives them against the same tokenizer to catch drift.
 *
 * It also encodes the WHOLE prompt string fastembed builds
 * (late_interaction_multimodal/colmodernvbert.py), because three things about
 * this tokenizer cannot be read off a token table:
 *
 *   1. A TemplateProcessing post-processor wraps every encode in [CLS] … [SEP].
 *      ColSmol's tokenizer has no such processor, so the prompt builders differ
 *      at both ends even though the template in between is identical.
 *   2. `<|begin_of_text|>` is NOT in this vocab (ModernBERT, not SmolLM2), so the
 *      prefix is ordinary byte-level BPE text and its ids must be measured.
 *   3. The last grid row's "\n" and the global tile's leading "\n" are ADJACENT
 *      in the string, so they form one "\n\n" run that BPE may merge into a
 *      single token — the same trap colsmol-prompt.ts's `doubleNewline` records.
 *
 *   npm run dev:dump-tokens -- <modelsDir>/colmodernvbert-250m
 */
import { join } from "node:path";
import { loadTokenizer, defaultConfigPath } from "../../src/embed/onnx/tokenizer.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: npm run dev:dump-tokens -- <modelDir>");
  process.exit(1);
}
const tokenizerPath = join(dir, "tokenizer.json");
const tok = await loadTokenizer(tokenizerPath, defaultConfigPath(tokenizerPath));
const enc = (s: string): number[] => tok.encode(s).ids;

console.log("=== single tokens (as encoded, INCLUDING [CLS]/[SEP] wrapper) ===");
const singles = [
  "<|begin_of_text|>",
  "<fake_token_around_image>",
  "<global-img>",
  "<image>",
  "<end_of_utterance>",
  "[CLS]",
  "[SEP]",
];
for (const s of singles) console.log(`${s.padEnd(28)} ${JSON.stringify(enc(s))}`);

console.log("\n=== row/col markers (read the stride off these) ===");
for (const r of [1, 2]) {
  for (const c of [1, 2, 3]) {
    console.log(`<row_${r}_col_${c}>`.padEnd(28) + JSON.stringify(enc(`<row_${r}_col_${c}>`)));
  }
}

console.log("\n=== text runs (each is a separate run between special tokens) ===");
for (const s of ["<|begin_of_text|>User:", "Describe the image.", "\nAssistant:", "\n", "\n\n"]) {
  console.log(`${JSON.stringify(s).padEnd(28)} ${JSON.stringify(enc(s))}`);
}

// The ground truth: fastembed's own string, built the same way, encoded whole.
const IMAGE_SEQ_LEN = 64;
const VISUAL_PROMPT_PREFIX =
  "<|begin_of_text|>User:<image>Describe the image.<end_of_utterance>\nAssistant:";

function splitImageString(rows: number, cols: number): string {
  let s = "";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      s += "<fake_token_around_image>" + `<row_${r + 1}_col_${c + 1}>` + "<image>".repeat(IMAGE_SEQ_LEN);
    }
    s += "\n";
  }
  s +=
    "\n<fake_token_around_image>" +
    "<global-img>" +
    "<image>".repeat(IMAGE_SEQ_LEN) +
    "<fake_token_around_image>";
  return s;
}

console.log("\n=== full image prompt, fastembed-equivalent, 4x3 grid ===");
const full = enc(VISUAL_PROMPT_PREFIX.replace("<image>", splitImageString(3, 4)));
const IMAGE_ID = enc("<image>").filter((id) => id >= 50368)[0] ?? -1;
console.log(`length ${full.length}, image tokens ${full.filter((i: number) => i === IMAGE_ID).length}`);
console.log("head 12:", JSON.stringify(full.slice(0, 12)));
// Everything after the last <image>, which is the whole instruction tail.
const lastImage = full.lastIndexOf(IMAGE_ID);
console.log("tail after last <image>:", JSON.stringify(full.slice(lastImage + 1)));
// The run separating one row's last <image> from the next row's fake token.
const rowLen = 4 * (2 + IMAGE_SEQ_LEN);
console.log("after row 1:", JSON.stringify(full.slice(1 + 5 + rowLen - 1, 1 + 5 + rowLen + 3)));

console.log("\n=== full query prompt, fastembed-equivalent ===");
console.log(JSON.stringify(enc("a terminal showing a build error" + "<end_of_utterance>".repeat(10))));
