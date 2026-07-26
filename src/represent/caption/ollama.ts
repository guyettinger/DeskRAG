/**
 * Local VLM captioning through Ollama's /api/chat, which accepts base64 images.
 *
 * Barrel-safe: plain fetch, no native module, so this DOES export from the
 * package barrel alongside the Anthropic and Gemini captioners.
 *
 * Best-effort by contract: a caption failure means one view lacks a vector for
 * one segment, which reconcileAndReembed can fill in later. It must never fail
 * the represent pass, so every error path returns "".
 */

import type { CaptionProvider } from "../../embed/types.js";
import { CAPTION_SYSTEM, captionPrompt } from "./prompt.js";

export interface OllamaCaptionOptions {
  host?: string;
  model?: string;
  /** Injected fetch (tests). */
  fetchImpl?: typeof globalThis.fetch;
}

interface TagsResponse {
  models?: { name?: string; capabilities?: string[] }[];
}

/**
 * Locally-resident, vision-capable model names.
 *
 * Deliberately sourced from /api/tags rather than a hardcoded list: Ollama's
 * LIBRARY now includes cloud-hosted models (gemini-3-flash-preview, the kimi-k2
 * family), and offering one in a "local" settings dropdown would route
 * screenshots off the machine invisibly. /api/tags returns only what is pulled
 * to disk, so a cloud model cannot appear here — the guard is structural, not
 * a matter of user care.
 */
export async function listVisionModels(
  host: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[]> {
  try {
    const res = await fetchImpl(`${host}/api/tags`);
    if (!res.ok) return [];
    const json = (await res.json()) as TagsResponse;
    return (json.models ?? [])
      .filter((m) => Array.isArray(m.capabilities) && m.capabilities.includes("vision"))
      .map((m) => m.name ?? "")
      .filter((n) => n.length > 0);
  } catch {
    return [];
  }
}

export class OllamaCaptionProvider implements CaptionProvider {
  private readonly host: string;
  private readonly model: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OllamaCaptionOptions = {}) {
    this.host = opts.host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
    this.model = opts.model ?? "qwen3-vl:4b";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async caption(frames: Uint8Array[], context?: string): Promise<string> {
    if (frames.length === 0) return "";
    try {
      const res = await this.fetchImpl(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: "system", content: CAPTION_SYSTEM },
            {
              role: "user",
              content: captionPrompt(context),
              images: frames.map((f) => Buffer.from(f).toString("base64")),
            },
          ],
        }),
      });
      if (!res.ok) return "";
      const json = (await res.json()) as { message?: { content?: string } };
      return (json.message?.content ?? "").trim();
    } catch {
      return ""; // daemon down, model deleted, malformed response
    }
  }
}
