import { describe, expect, it } from "vitest";
import { OllamaTextEmbedding } from "../src/embed/ollama.js";
import { VoyageTextEmbedding, VoyageImageEmbedding } from "../src/embed/voyage.js";
import { GeminiEmbedding } from "../src/embed/gemini.js";
import { AnthropicCaptionProvider } from "../src/represent/caption/anthropic.js";
import { LLMReranker } from "../src/retrieve/rerank/llm.js";

/**
 * Live provider smoke tests. Each skips cleanly unless its credential/daemon is
 * present, so the default suite stays offline and deterministic. Run with e.g.
 *   OLLAMA_SMOKE=1 VOYAGE_API_KEY=... GEMINI_API_KEY=... npx vitest run test/live.smoke.test.ts
 */

const hasGemini = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

describe.skipIf(process.env.OLLAMA_SMOKE !== "1")("Ollama (local)", () => {
  it("embeds text at its declared dimensionality", async () => {
    const p = new OllamaTextEmbedding();
    const [v] = await p.embed(["hello world"]);
    expect(v!.length).toBe(p.dimensions);
  });
});

describe.skipIf(!process.env.VOYAGE_API_KEY)("Voyage (remote)", () => {
  it("embeds text (voyage-3) and images (voyage-multimodal-3, shared space)", async () => {
    const text = new VoyageTextEmbedding();
    const [tv] = await text.embed(["a login screen"]);
    expect(tv!.length).toBe(text.dimensions);

    const image = new VoyageImageEmbedding();
    expect(image.sharedTextSpace).toBe(true);
    const [iv] = await image.embedImages([tinyPng()]);
    expect(iv!.length).toBe(image.dimensions);
  });
});

describe.skipIf(!hasGemini)("Gemini (remote)", () => {
  it("one provider backs both text and image in a shared 3072-dim space", async () => {
    const g = new GeminiEmbedding();
    expect(g.dimensions).toBe(3072);
    expect(g.sharedTextSpace).toBe(true);
    const [tv] = await g.embed(["a save dialog"]);
    expect(tv!.length).toBe(g.dimensions);
    const [iv] = await g.embedImages([tinyPng()]);
    expect(iv!.length).toBe(g.dimensions);
  });
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic (Claude) VLM + rerank", () => {
  it("captions a screenshot", async () => {
    const cap = new AnthropicCaptionProvider();
    const text = await cap.caption([tinyPng()], "42 clicks, typed in Slack");
    expect(text.length).toBeGreaterThan(0);
  });

  it("reranks candidates best-first", async () => {
    const order = await new LLMReranker().rerank("the save dialog", [
      { id: "a", text: "an address bar in a browser" },
      { id: "b", text: "a Save As file dialog is open" },
    ]);
    expect(order).toContain("a");
    expect(order).toContain("b");
    expect(order[0]).toBe("b");
  });
});

/** Smallest valid 1x1 PNG. */
function tinyPng(): Uint8Array {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
}
