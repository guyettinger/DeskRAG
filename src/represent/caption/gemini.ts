/**
 * Google Gemini VLM caption provider (generateContent with inline image data).
 * Uses fetch, consistent with the Gemini embedder. Requires GEMINI_API_KEY (or
 * GOOGLE_API_KEY). Default model gemini-2.5-flash (fast, vision-capable).
 */

import type { CaptionProvider } from "../../embed/types.js";
import { CAPTION_SYSTEM, captionPrompt } from "./prompt.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiCaptionOptions {
  model?: string;
  apiKey?: string;
  mimeType?: string;
}

export class GeminiCaptionProvider implements CaptionProvider {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly mimeType: string;

  constructor(opts: GeminiCaptionOptions = {}) {
    const key = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY not set");
    this.apiKey = key;
    this.model = opts.model ?? "gemini-2.5-flash";
    this.mimeType = opts.mimeType ?? "image/png";
  }

  async caption(frames: Uint8Array[], context?: string): Promise<string> {
    const parts: unknown[] = frames.map((f) => ({
      inline_data: { mime_type: this.mimeType, data: Buffer.from(f).toString("base64") },
    }));
    parts.push({ text: `${CAPTION_SYSTEM}\n\n${captionPrompt(context)}` });

    const res = await fetch(
      `${BASE}/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] }),
      },
    );
    if (!res.ok) throw new Error(`Gemini caption failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return (
      json.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join(" ")
        .trim() ?? ""
    );
  }
}
