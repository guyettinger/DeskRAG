import { describe, expect, it } from "vitest";
import {
  MULTIVECTOR_VIEWS,
  RETIRED_MODELS,
  RETIRED_VIEWS,
  VIEWS,
  namespaceFor,
  parseNamespace,
  type NamespacedProvider,
} from "../src/embed/types.js";
import {
  FakeEmbeddingProvider,
  FakeMultiVectorProvider,
} from "../src/embed/fake.js";

const nomic: NamespacedProvider = {
  id: "onnx",
  model: "nomic-embed-text-v1.5",
  dimensions: 768,
};

describe("namespaceFor", () => {
  it("builds view:provider:model:dims", () => {
    expect(namespaceFor("caption", nomic)).toBe(
      "caption:onnx:nomic-embed-text-v1.5:768",
    );
  });

  it("distinguishes different views, models, and dims (the discipline)", () => {
    const ns = new Set([
      namespaceFor("caption", nomic),
      namespaceFor("digest", nomic),
      namespaceFor("caption", { ...nomic, model: "nomic-embed-text-v1" }),
      namespaceFor("caption", { ...nomic, dimensions: 256 }),
      namespaceFor("caption", { ...nomic, id: "ollama" }),
    ]);
    expect(ns.size).toBe(5); // all five are distinct spaces
  });

  it("rejects ids/models containing the ':' separator", () => {
    expect(() => namespaceFor("caption", { ...nomic, id: "a:b" })).toThrow();
    expect(() => namespaceFor("caption", { ...nomic, model: "x:y" })).toThrow();
  });

  it("rejects non-positive/non-integer dimensions", () => {
    expect(() => namespaceFor("caption", { ...nomic, dimensions: 0 })).toThrow();
    expect(() => namespaceFor("caption", { ...nomic, dimensions: 1.5 })).toThrow();
  });

  it("round-trips through parseNamespace", () => {
    const ns = namespaceFor("caption", nomic);
    expect(parseNamespace(ns)).toEqual({
      view: "caption",
      providerId: "onnx",
      model: "nomic-embed-text-v1.5",
      dimensions: 768,
    });
  });

  it("parseNamespace rejects malformed / unknown-view strings", () => {
    expect(() => parseNamespace("a:b:c")).toThrow();
    expect(() => parseNamespace("bogus:onnx:m:768")).toThrow();
  });

  /**
   * A RETIRED view is rejected here, and that is safe only because opening a
   * store does not parse: `DualStore` reads the `view` COLUMN, and the sole
   * caller of `parseNamespace` is `ensureTable`, on a namespace being
   * registered. A store carried over from the single-vector build still HOLDS
   * these rows — `purgeRetiredSpaces` drops them before anything walks the
   * registry, and throwing on open is what took down a whole re-index once.
   */
  it("treats the retired single-vector image views as unknown", () => {
    for (const view of RETIRED_VIEWS) {
      expect(VIEWS as readonly string[]).not.toContain(view);
      expect(() => parseNamespace(`${view}:onnx:m:768`)).toThrow();
    }
    expect(RETIRED_VIEWS).toEqual(["frame_image", "region_image"]);
    expect(RETIRED_MODELS).toContain("colsmol-256m");
  });
});

describe("multivector views", () => {
  it("registers frame_patches as a known view", () => {
    expect(VIEWS).toContain("frame_patches");
    expect(parseNamespace("frame_patches:onnx:colmodernvbert-250m:128").view).toBe(
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
      "summary",
      "app_caption",
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
