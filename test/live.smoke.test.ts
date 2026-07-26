import { describe, expect, it } from "vitest";
import { OllamaTextEmbedding } from "../src/embed/ollama.js";

/**
 * Live provider smoke test. Skips cleanly unless the local daemon is present, so
 * the default suite stays offline and deterministic. Run with:
 *   OLLAMA_SMOKE=1 npx vitest run test/live.smoke.test.ts
 *
 * Ollama is the only provider reachable over a socket, and that socket is
 * localhost. The ONNX providers have their own real-weights smoke in
 * test/onnx.smoke.test.ts.
 */

describe.skipIf(process.env.OLLAMA_SMOKE !== "1")("Ollama (local daemon)", () => {
  it("embeds text at its declared dimensionality", async () => {
    const p = new OllamaTextEmbedding();
    const [v] = await p.embed(["hello world"]);
    expect(v!.length).toBe(p.dimensions);
  });
});
