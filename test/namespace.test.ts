import { describe, expect, it } from "vitest";
import {
  namespaceFor,
  parseNamespace,
  type NamespacedProvider,
} from "../src/embed/types.js";

const gemini: NamespacedProvider = {
  id: "gemini",
  model: "gemini-embedding-2",
  dimensions: 3072,
};

describe("namespaceFor", () => {
  it("builds view:provider:model:dims", () => {
    expect(namespaceFor("caption", gemini)).toBe(
      "caption:gemini:gemini-embedding-2:3072",
    );
  });

  it("distinguishes different views, models, and dims (the discipline)", () => {
    const ns = new Set([
      namespaceFor("caption", gemini),
      namespaceFor("digest", gemini),
      namespaceFor("caption", { ...gemini, model: "gemini-embedding-001" }),
      namespaceFor("caption", { ...gemini, dimensions: 768 }),
      namespaceFor("caption", { ...gemini, id: "voyage" }),
    ]);
    expect(ns.size).toBe(5); // all five are distinct spaces
  });

  it("rejects ids/models containing the ':' separator", () => {
    expect(() => namespaceFor("caption", { ...gemini, id: "a:b" })).toThrow();
    expect(() => namespaceFor("caption", { ...gemini, model: "x:y" })).toThrow();
  });

  it("rejects non-positive/non-integer dimensions", () => {
    expect(() => namespaceFor("caption", { ...gemini, dimensions: 0 })).toThrow();
    expect(() => namespaceFor("caption", { ...gemini, dimensions: 1.5 })).toThrow();
  });

  it("round-trips through parseNamespace", () => {
    const ns = namespaceFor("region_image", gemini);
    expect(parseNamespace(ns)).toEqual({
      view: "region_image",
      providerId: "gemini",
      model: "gemini-embedding-2",
      dimensions: 3072,
    });
  });

  it("parseNamespace rejects malformed / unknown-view strings", () => {
    expect(() => parseNamespace("a:b:c")).toThrow();
    expect(() => parseNamespace("bogus:gemini:m:3072")).toThrow();
  });
});
