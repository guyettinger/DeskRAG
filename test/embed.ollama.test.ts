import { describe, expect, it } from "vitest";
import { OllamaTextEmbedding } from "../src/embed/ollama.js";
import { listModels, resolveOllamaHost } from "../src/embed/ollama-client.js";

type FetchImpl = typeof globalThis.fetch;

const ok = (body: unknown): FetchImpl =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as FetchImpl;

describe("resolveOllamaHost", () => {
  it("prefers an explicit host over the environment", () => {
    expect(resolveOllamaHost("http://explicit:1")).toBe("http://explicit:1");
  });

  it("falls back to OLLAMA_HOST, then to the documented default", () => {
    const prev = process.env.OLLAMA_HOST;
    try {
      process.env.OLLAMA_HOST = "http://from-env:2";
      expect(resolveOllamaHost()).toBe("http://from-env:2");
      delete process.env.OLLAMA_HOST;
      expect(resolveOllamaHost()).toBe("http://localhost:11434");
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = prev;
    }
  });
});

describe("OllamaTextEmbedding", () => {
  it("posts the batch to /api/embed and returns one vector per input", async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({ embeddings: [[1, 2, 3], [4, 5, 6]] }),
        { status: 200 },
      );
    }) as unknown as FetchImpl;

    const p = new OllamaTextEmbedding({ host: "http://h:1", fetchImpl });
    const out = await p.embed(["a", "b"]);

    expect(seen!.url).toBe("http://h:1/api/embed");
    expect(seen!.body).toEqual({ model: "nomic-embed-text", input: ["a", "b"] });
    expect(out.map((v) => Array.from(v))).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  it("returns [] for no inputs without calling the daemon", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as FetchImpl;
    expect(await new OllamaTextEmbedding({ fetchImpl }).embed([])).toEqual([]);
    expect(called).toBe(false);
  });

  it("THROWS on a non-200 — a missing vector must not look like a clean write", async () => {
    const fetchImpl = (async () =>
      new Response("model not found", { status: 404 })) as FetchImpl;
    await expect(
      new OllamaTextEmbedding({ fetchImpl }).embed(["a"]),
    ).rejects.toThrow(/404/);
  });

  it("throws when the daemon is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as FetchImpl;
    await expect(
      new OllamaTextEmbedding({ fetchImpl }).embed(["a"]),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("namespaces by its declared id/model/dimensions", () => {
    const p = new OllamaTextEmbedding({ model: "mxbai-embed-large", dimensions: 1024 });
    expect([p.id, p.model, p.dimensions]).toEqual(["ollama", "mxbai-embed-large", 1024]);
  });
});

describe("listModels", () => {
  it("returns every resident model when no capability is asked for", async () => {
    const fetchImpl = ok({
      models: [
        { name: "nomic-embed-text:latest", capabilities: ["embedding"] },
        { name: "qwen3-vl:4b", capabilities: ["completion", "vision"] },
      ],
    });
    expect(await listModels("http://h:1", {}, fetchImpl)).toEqual([
      "nomic-embed-text:latest",
      "qwen3-vl:4b",
    ]);
  });

  it("filters by capability", async () => {
    const fetchImpl = ok({
      models: [
        { name: "nomic-embed-text:latest", capabilities: ["embedding"] },
        { name: "qwen3-vl:4b", capabilities: ["completion", "vision"] },
      ],
    });
    expect(await listModels("http://h:1", { capability: "embedding" }, fetchImpl)).toEqual([
      "nomic-embed-text:latest",
    ]);
  });

  it("returns [] on a non-200 rather than throwing — a picker renders empty", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as FetchImpl;
    expect(await listModels("http://h:1", {}, fetchImpl)).toEqual([]);
  });
});
