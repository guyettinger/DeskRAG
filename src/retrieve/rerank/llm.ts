/**
 * LLM reranker (Tier 4) via Claude. Uses the official @anthropic-ai/sdk with a
 * structured-output schema so the model returns a clean ranked id list. Default
 * model claude-opus-4-8. Requires ANTHROPIC_API_KEY. Not run in CI — the tested
 * Tier-4 path uses FakeReranker.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Reranker, RerankCandidate } from "./types.js";

export interface LLMRerankerOptions {
  model?: string;
  apiKey?: string;
  maxTokens?: number;
}

const SYSTEM =
  "You re-rank recalled desktop-activity moments by how well each matches the " +
  "user's query. Consider the described UI and task. Return the candidate ids " +
  "ordered best match first. Include every id exactly once.";

export class LLMReranker implements Reranker {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: LLMRerankerOptions = {}) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? "claude-opus-4-8";
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  async rerank(query: string, candidates: RerankCandidate[]): Promise<string[]> {
    if (candidates.length === 0) return [];
    const list = candidates.map((c) => `id=${c.id}: ${c.text}`).join("\n");
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM,
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { ranking: { type: "array", items: { type: "string" } } },
            required: ["ranking"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        { role: "user", content: `Query: ${query}\n\nCandidates:\n${list}` },
      ],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let ranking: string[] = [];
    try {
      ranking = (JSON.parse(text) as { ranking?: string[] }).ranking ?? [];
    } catch {
      return candidates.map((c) => c.id); // fall back to input order
    }
    // Keep only known ids, then append any the model omitted (stable).
    const known = new Set(candidates.map((c) => c.id));
    const seen = new Set<string>();
    const ordered = ranking.filter((id) => known.has(id) && !seen.has(id) && seen.add(id));
    for (const c of candidates) if (!seen.has(c.id)) ordered.push(c.id);
    return ordered;
  }
}
