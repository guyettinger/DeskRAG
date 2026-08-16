import { describe, expect, it } from "vitest";
import { TEXT_PROFILES, textProfile } from "../src/embed/text-profiles.js";

/**
 * A profile is the whole of what the adapter needs to know about a text model.
 * These assertions pin the parts that fail SILENTLY when wrong: a colon in a
 * model id corrupts the four-part namespace, and a dimension that disagrees with
 * the graph mints a Lance table whose width is a lie.
 */
describe("TEXT_PROFILES", () => {
  it("keys every profile by its own model id", () => {
    for (const [key, p] of Object.entries(TEXT_PROFILES)) {
      expect(p.model).toBe(key);
    }
  });

  it("uses model ids with no colon, which the namespace splits on", () => {
    for (const p of Object.values(TEXT_PROFILES)) {
      expect(p.model).not.toContain(":");
    }
  });

  it("declares nomic as a pooling model that requires token_type_ids", () => {
    const p = textProfile("nomic-embed-text-v1.5");
    expect(p.output).toBe("last_hidden_state");
    expect(p.tokenTypeIds).toBe(true);
    expect(p.dimensions).toBe(768);
    expect(p.maxTokens).toBe(2048);
    expect(p.prefixes.document).toBe("search_document: ");
    expect(p.prefixes.query).toBe("search_query: ");
  });

  /**
   * The export bakes pooling, both Dense heads and normalization into the graph
   * and emits `sentence_embedding`. Mean-pooling `last_hidden_state` here would
   * return the PRE-Dense representation — plausible vectors, wrong space, no
   * error. Gemma3 also has no segment embeddings, so token_type_ids is absent.
   */
  it("declares embeddinggemma as a graph-pooled model with no token_type_ids", () => {
    const p = textProfile("embeddinggemma-300m");
    expect(p.output).toBe("sentence_embedding");
    expect(p.tokenTypeIds).toBe(false);
    expect(p.dimensions).toBe(768);
    // max_position_embeddings in the export's config.json, not nomic's 8192.
    expect(p.maxTokens).toBe(2048);
    expect(p.prefixes.query).toBe("task: search result | query: ");
    expect(p.prefixes.document).toBe("title: none | text: ");
  });

  it("throws by name on an unknown model rather than defaulting to one", () => {
    expect(() => textProfile("gpt-4")).toThrow(/gpt-4/);
  });
});
