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
  message?: { content?: string };
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
        messages: [
          { role: "system", content: COMPOSE_SYSTEM },
          { role: "user", content: composePrompt(children, ctx.level) },
        ],
      },
      this.fetchImpl,
    );

    const content = res.message?.content ?? "";
    // Indices are BLOCK-RELATIVE here: the composer slices before calling, so
    // the model only ever sees 0..n-1 and the caller shifts them back.
    const groups = parseComposeResponse(content, 0);
    if (groups === undefined) {
      throw new Error(
        `Ollama compose returned an unparseable partition: ${content.slice(0, 200)}`,
      );
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
