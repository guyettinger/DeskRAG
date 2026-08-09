import { describe, expect, it } from "vitest";
import { OllamaSummaryProvider, listSummaryModels } from "../src/embed/ollama-summary.js";
import type { ChildSummary } from "../src/represent/compose/types.js";

const kids: ChildSummary[] = [
  {
    index: 0,
    text: "clicked 7",
    app: "Calculator",
    url: null,
    startSec: 0,
    endSec: 1,
    barrier: false,
  },
  {
    index: 1,
    text: "clicked +",
    app: "Calculator",
    url: null,
    startSec: 1,
    endSec: 2,
    barrier: false,
  },
];

function fakeFetch(body: unknown, ok = true): typeof globalThis.fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as unknown as typeof globalThis.fetch;
}

describe("OllamaSummaryProvider", () => {
  it("parses a well-formed reply into groups", async () => {
    const p = new OllamaSummaryProvider({
      model: "qwen3:8b",
      fetchImpl: fakeFetch({
        message: { content: '{"groups":[{"start":0,"end":2,"summary":"added numbers"}]}' },
      }),
    });
    expect(await p.compose(kids, { level: 1 })).toEqual([
      { start: 0, end: 2, summary: "added numbers" },
    ]);
  });

  it("THROWS on an unparseable reply — the composer decides what that means", async () => {
    const p = new OllamaSummaryProvider({
      model: "qwen3:8b",
      fetchImpl: fakeFetch({ message: { content: "I cannot help with that." } }),
    });
    await expect(p.compose(kids, { level: 1 })).rejects.toThrow(/unparseable/i);
  });

  it("throws on an empty reply rather than returning no groups", async () => {
    const p = new OllamaSummaryProvider({
      model: "qwen3:8b",
      fetchImpl: fakeFetch({}),
    });
    await expect(p.compose(kids, { level: 1 })).rejects.toThrow(/unparseable/i);
  });

  it("throws on a non-2xx, rather than returning a guess", async () => {
    const p = new OllamaSummaryProvider({
      model: "qwen3:8b",
      fetchImpl: fakeFetch({ error: "model not found" }, false),
    });
    await expect(p.compose(kids, { level: 1 })).rejects.toThrow();
  });

  it("reports its namespace parts", () => {
    const p = new OllamaSummaryProvider({ model: "qwen3:8b" });
    expect(p.id).toBe("ollama");
    expect(p.model).toBe("qwen3:8b");
  });
});

describe("listSummaryModels", () => {
  it("returns [] when the daemon is unreachable, so a picker renders empty", async () => {
    // No daemon on this port in the suite; listModels swallows and returns [].
    expect(await listSummaryModels("http://127.0.0.1:1")).toEqual([]);
  });
});
