/**
 * Composing over a local Ollama chat model.
 *
 * Barrel-safe: plain `fetch`, no native module, no subprocess.
 *
 * Failure policy: THROWS. A composed level is recoverable — the composer
 * catches and takes the structural path — but this adapter must not decide
 * that, and must never return a guessed partition, which would be
 * indistinguishable from a real one downstream. Same split as
 * `OllamaTextEmbedding.embed` throwing where `OllamaCaptionProvider.caption`
 * returns "".
 */

import {
  COMPOSE_SYSTEM,
  composePrompt,
  parseComposeResponse,
} from "../represent/compose/prompt.js";
import type { ChildSummary, ComposeGroup } from "../represent/compose/types.js";
import { listModels, postJson, resolveOllamaHost } from "./ollama-client.js";
import type { ComposeContext, SummaryProvider } from "./summary.js";

export interface OllamaSummaryOptions {
  model: string;
  host?: string;
  fetchImpl?: typeof globalThis.fetch;
}

interface ChatResponse {
  message?: { content?: string; thinking?: string };
}

export class OllamaSummaryProvider implements SummaryProvider {
  readonly id = "ollama";
  readonly model: string;
  private readonly host: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OllamaSummaryOptions) {
    this.model = opts.model;
    this.host = resolveOllamaHost(opts.host);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async compose(
    children: readonly ChildSummary[],
    ctx: ComposeContext,
  ): Promise<ComposeGroup[]> {
    const res = await postJson<ChatResponse>(
      this.host,
      "/api/chat",
      {
        model: this.model,
        stream: false,
        // A request, not a guarantee — parseComposeResponse still digs the
        // object out of whatever actually comes back.
        format: "json",
        // We want a partition, not a monologue. MEASURED on qwen3-vl:4b: a
        // 30-step prompt with thinking on never returned at all, where the same
        // request with it off answered in 1.4s.
        think: false,
        messages: [
          { role: "system", content: COMPOSE_SYSTEM },
          { role: "user", content: composePrompt(children, ctx.level) },
        ],
      },
      this.fetchImpl,
    );

    // BOTH channels, content first.
    //
    // A thinking model routes its structured answer into `thinking` and leaves
    // `content` EMPTY — measured on qwen3-vl:4b, which does this even with
    // `think: false`, because Ollama applies the JSON format constraint to
    // whichever channel the model writes. Reading only `content` makes this
    // adapter silently incompatible with every thinking model, and silently is
    // the operative word: the composer would just take the structural path
    // forever and nothing would say why.
    //
    // This cannot widen what is accepted — the partition is validated
    // downstream either way, and the malformed replies these models do produce
    // (`"partition": 2` where `"start"` belongs) are still rejected wholesale.
    const msg = res.message;
    // Indices are BLOCK-RELATIVE here: the composer slices before calling, so
    // the model only ever sees 0..n-1 and the caller shifts them back.
    const groups =
      parseComposeResponse(msg?.content ?? "", children.length, 0) ??
      parseComposeResponse(msg?.thinking ?? "", children.length, 0);
    if (groups === undefined) {
      const seen = (msg?.content ?? "") || (msg?.thinking ?? "");
      throw new Error(`Ollama compose returned an unparseable partition: ${seen.slice(0, 200)}`);
    }
    return groups;
  }
}

/**
 * Chat-capable models resident on THIS machine, for the Settings picker.
 *
 * Sourced from /api/tags via `listModels`, never a hardcoded name: Ollama's
 * library includes cloud-hosted models, and offering one in a local picker
 * would route a user's recorded activity off the machine.
 */
export async function listSummaryModels(host?: string): Promise<string[]> {
  return listModels(resolveOllamaHost(host), { capability: "completion" });
}
