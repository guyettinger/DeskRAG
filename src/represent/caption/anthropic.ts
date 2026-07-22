/**
 * Anthropic (Claude) VLM caption provider. Uses the official @anthropic-ai/sdk
 * (the mandated path for Anthropic calls), default model claude-opus-4-8. Vision
 * via base64 image content blocks; thinking is left off (captioning is a simple
 * task) and a terse system prompt keeps the output to a caption. Requires
 * ANTHROPIC_API_KEY (the SDK resolves it from the env).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CaptionProvider } from "../../embed/types.js";
import { CAPTION_SYSTEM, captionPrompt } from "./prompt.js";

export interface AnthropicCaptionOptions {
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  mediaType?: "image/png" | "image/jpeg" | "image/webp";
}

export class AnthropicCaptionProvider implements CaptionProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly mediaType: "image/png" | "image/jpeg" | "image/webp";

  constructor(opts: AnthropicCaptionOptions = {}) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? "claude-opus-4-8";
    this.maxTokens = opts.maxTokens ?? 300;
    this.mediaType = opts.mediaType ?? "image/png";
  }

  async caption(frames: Uint8Array[], context?: string): Promise<string> {
    const content: Anthropic.ContentBlockParam[] = frames.map((f) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: this.mediaType,
        data: Buffer.from(f).toString("base64"),
      },
    }));
    content.push({ type: "text", text: captionPrompt(context) });

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: CAPTION_SYSTEM,
      messages: [{ role: "user", content }],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
  }
}
