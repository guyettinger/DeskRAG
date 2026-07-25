import { describe, expect, it } from "vitest";
import {
  OllamaCaptionProvider,
  listVisionModels,
} from "../src/represent/caption/ollama.js";

type FetchImpl = typeof globalThis.fetch;

const ok = (body: unknown): FetchImpl =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as FetchImpl;

describe("OllamaCaptionProvider", () => {
  it("posts base64 images to /api/chat and returns the message content", async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ message: { content: "  a login screen  " } }), {
        status: 200,
      });
    }) as unknown as FetchImpl;

    const p = new OllamaCaptionProvider({
      host: "http://h:1",
      model: "qwen3-vl:4b",
      fetchImpl,
    });
    const out = await p.caption([Uint8Array.from([1, 2, 3])], "context");

    expect(out).toBe("a login screen");
    expect(seen!.url).toBe("http://h:1/api/chat");
    expect(seen!.body.model).toBe("qwen3-vl:4b");
    expect(seen!.body.stream).toBe(false);
    const messages = seen!.body.messages as { role: string; images?: string[] }[];
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.images).toEqual([Buffer.from([1, 2, 3]).toString("base64")]);
  });

  it("returns empty string when the daemon is down, rather than throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as FetchImpl;
    expect(await new OllamaCaptionProvider({ fetchImpl }).caption([Uint8Array.from([1])])).toBe("");
  });

  it("returns empty string on a non-200, e.g. a deleted model", async () => {
    const fetchImpl = (async () => new Response("model not found", { status: 404 })) as FetchImpl;
    expect(await new OllamaCaptionProvider({ fetchImpl }).caption([Uint8Array.from([1])])).toBe("");
  });

  it("returns empty string on a malformed response body", async () => {
    const fetchImpl = (async () => new Response("not json", { status: 200 })) as FetchImpl;
    expect(await new OllamaCaptionProvider({ fetchImpl }).caption([Uint8Array.from([1])])).toBe("");
  });

  it("returns empty string for no frames without calling the daemon", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as FetchImpl;
    expect(await new OllamaCaptionProvider({ fetchImpl }).caption([])).toBe("");
    expect(called).toBe(false);
  });
});

describe("listVisionModels", () => {
  it("returns only locally-resident vision-capable models", async () => {
    const fetchImpl = ok({
      models: [
        { name: "nomic-embed-text:latest", capabilities: ["embedding"] },
        { name: "qwen3-vl:4b", capabilities: ["completion", "vision"] },
        { name: "llama3:8b", capabilities: ["completion"] },
        { name: "minicpm-v4.6:latest", capabilities: ["vision"] },
      ],
    });
    expect(await listVisionModels("http://h:1", fetchImpl)).toEqual([
      "qwen3-vl:4b",
      "minicpm-v4.6:latest",
    ]);
  });

  it("returns [] when the daemon is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as FetchImpl;
    expect(await listVisionModels("http://h:1", fetchImpl)).toEqual([]);
  });

  it("tolerates entries with no capabilities array", async () => {
    expect(await listVisionModels("http://h:1", ok({ models: [{ name: "mystery" }] }))).toEqual([]);
  });

  it("tolerates an empty or missing models list", async () => {
    expect(await listVisionModels("http://h:1", ok({}))).toEqual([]);
  });
});
