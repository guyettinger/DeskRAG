/**
 * Loading a HuggingFace tokenizer off disk — the one job every ONNX text-side
 * adapter shares (text embedding, cross-encoder rerank, late-interaction prompts).
 *
 * NOT in the package barrel: the import is dynamic, but this module exists to
 * serve adapters that load native code, and it has no standalone use.
 *
 * `@huggingface/tokenizers` takes PARSED JSON in its constructor and encodes
 * synchronously — there is no `fromFile`, which is why every caller ends up
 * reading two files and calling JSON.parse. It is preferred over
 * `@huggingface/transformers`, which depends on a CVE-era `sharp` that conflicts
 * with this repo's pin (see CLAUDE.md).
 *
 * What is deliberately NOT here: the encode call itself. Each adapter needs a
 * different shape — a single sequence, a query/document PAIR with token_type_ids
 * for the cross-encoder, or a late-interaction prompt — and that difference is the whole
 * of what distinguishes them. This module stops at handing back the tokenizer.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * tokenizer_config.json as a sibling of tokenizer.json — the layout every model
 * in `app/src/main/models.ts` downloads.
 */
export function defaultConfigPath(tokenizerPath: string): string {
  return join(dirname(tokenizerPath), "tokenizer_config.json");
}

/**
 * tokenizer_config.json is OPTIONAL: an absent or unreadable one degrades to
 * `{}` (the library's defaults) rather than failing the load, because for most
 * models it only carries chat templates and special-token aliases that the
 * encode path here does not use.
 */
export async function loadTokenizer(
  tokenizerPath: string,
  configPath: string = defaultConfigPath(tokenizerPath),
) {
  const { Tokenizer } = await import(/* @vite-ignore */ "@huggingface/tokenizers");
  const [tokJson, cfgJson] = await Promise.all([
    readFile(tokenizerPath, "utf8"),
    readFile(configPath, "utf8").catch(() => "{}"),
  ]);
  return new Tokenizer(
    JSON.parse(tokJson) as object,
    JSON.parse(cfgJson) as object,
  );
}
