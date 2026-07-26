/**
 * Local VLM captioning through Ollama's /api/chat, which accepts base64 images.
 *
 * Barrel-safe: plain fetch, no native module, so this DOES export from the
 * package barrel.
 *
 * Best-effort by contract: a caption failure means one view lacks a vector for
 * one segment, which reconcileAndReembed can fill in later. It must never fail
 * the represent pass, so every error path returns "" — the opposite of
 * OllamaTextEmbedding, which throws. That asymmetry is why the shared client
 * raises and each adapter decides.
 */

import { listModels, postJson, resolveOllamaHost } from "../../embed/ollama-client.js";
import type { CaptionProvider } from "../../embed/types.js";
import { CAPTION_SYSTEM, captionPrompt } from "./prompt.js";

export interface OllamaCaptionOptions {
  host?: string;
  model?: string;
  /** Injected fetch (tests). */
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Locally-resident, vision-capable model names — what the app's model picker
 * must use. See `listModels` for why a hardcoded list is unsafe now that
 * Ollama's library includes cloud-hosted models.
 */
export async function listVisionModels(
  host: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[]> {
  return listModels(host, { capability: "vision" }, fetchImpl);
}

export class OllamaCaptionProvider implements CaptionProvider {
  private readonly host: string;
  private readonly model: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OllamaCaptionOptions = {}) {
    this.host = resolveOllamaHost(opts.host);
    this.model = opts.model ?? "qwen3-vl:4b";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async caption(frames: Uint8Array[], context?: string): Promise<string> {
    if (frames.length === 0) return "";
    try {
      const json = await postJson<{ message?: { content?: string } }>(
        this.host,
        "/api/chat",
        {
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
        },
        this.fetchImpl,
      );
      return (json.message?.content ?? "").trim();
    } catch {
      return ""; // daemon down, model deleted, malformed response
    }
  }
}
