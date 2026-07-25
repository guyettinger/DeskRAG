import { describe, expect, it } from "vitest";
import {
  MULTIVECTOR_VIEWS,
  VIEWS,
  namespaceFor,
  parseNamespace,
  type NamespacedProvider,
} from "../src/embed/types.js";
import {
  FakeEmbeddingProvider,
  FakeMultiVectorProvider,
} from "../src/embed/fake.js";

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

describe("multivector views", () => {
  it("registers frame_patches as a known view", () => {
    expect(VIEWS).toContain("frame_patches");
    expect(parseNamespace("frame_patches:onnx:colsmol-256m:128").view).toBe(
      "frame_patches",
    );
  });

  it("marks only frame_patches as multivector", () => {
    expect(MULTIVECTOR_VIEWS.has("frame_patches")).toBe(true);
    for (const v of [
      "digest",
      "caption",
      "transcript",
      "behavior",
      "frame_image",
      "region_image",
    ] as const) {
      expect(MULTIVECTOR_VIEWS.has(v)).toBe(false);
    }
  });

  it("namespaces a multivector provider by its per-vector width", () => {
    const p = new FakeMultiVectorProvider(128, 4);
    expect(namespaceFor("frame_patches", p)).toBe(
      "frame_patches:fake:fake-mv:128",
    );
  });
});

describe("embed roles", () => {
  it("accepts an optional role without changing output for providers that ignore it", async () => {
    const f = new FakeEmbeddingProvider({ dimensions: 8 });
    const [a] = await f.embed(["hello"]);
    const [b] = await f.embed(["hello"], { role: "query" });
    expect(Array.from(a!)).toEqual(Array.from(b!));
  });
});
