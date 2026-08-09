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
        message: { content: '{"groups":[{"start":0,"summary":"added numbers"}]}' },
      }),
    });
    expect(await p.compose(kids, { kind: "task" })).toEqual([
      { start: 0, end: 2, summary: "added numbers" },
    ]);
  });

  it("reads the THINKING channel when content is empty", async () => {
    // Measured on qwen3-vl:4b: a thinking model routes its structured answer
    // into `thinking` and leaves `content` empty, even with think:false.
    // Reading only `content` would make this adapter silently incompatible
    // with every such model.
    const p = new OllamaSummaryProvider({
      model: "qwen3-vl:4b",
      fetchImpl: fakeFetch({
        message: {
          content: "",
          thinking: '{"groups":[{"start":0,"summary":"added numbers"}]}',
        },
      }),
    });
    expect(await p.compose(kids, { kind: "task" })).toEqual([
      { start: 0, end: 2, summary: "added numbers" },
    ]);
  });

  it("prefers content over thinking when both parse", async () => {
    const p = new OllamaSummaryProvider({
      model: "qwen3:8b",
      fetchImpl: fakeFetch({
        message: {
          content: '{"groups":[{"start":0,"summary":"the answer"}]}',
          thinking: '{"groups":[{"start":0,"summary":"a draft"}]}',
        },
      }),
    });
    expect((await p.compose(kids, { kind: "task" }))[0]!.summary).toBe("the answer");
  });

  it("still rejects a malformed partition found in thinking", async () => {
    // The real failure these models produce: `"partition"` where `"start"`
    // belongs. Reading a second channel must not widen what is accepted.
    const p = new OllamaSummaryProvider({
      model: "qwen3-vl:4b",
      fetchImpl: fakeFetch({
        message: {
          content: "",
          thinking: '{"groups":[{"start":0,"summary":"a"},{"partition":1}]}',
        },
      }),
    });
    await expect(p.compose(kids, { kind: "task" })).rejects.toThrow(/unparseable/i);
  });

  it("asks for no monologue — a partition is not a reasoning task", async () => {
    let body: unknown;
    const capturing = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: '{"groups":[{"start":0,"summary":"x"}]}' },
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    await new OllamaSummaryProvider({ model: "m", fetchImpl: capturing }).compose(kids, {
      kind: "task",
    });
    // Measured: a 30-step prompt with thinking ON never returned at all.
    expect((body as { think: boolean }).think).toBe(false);
  });

  it("THROWS on an unparseable reply — the composer decides what that means", async () => {
    const p = new OllamaSummaryProvider({
      model: "qwen3:8b",
      fetchImpl: fakeFetch({ message: { content: "I cannot help with that." } }),
    });
    await expect(p.compose(kids, { kind: "task" })).rejects.toThrow(/unparseable/i);
  });

  it("throws on an empty reply rather than returning no groups", async () => {
    const p = new OllamaSummaryProvider({
      model: "qwen3:8b",
      fetchImpl: fakeFetch({}),
    });
    await expect(p.compose(kids, { kind: "task" })).rejects.toThrow(/unparseable/i);
  });

  it("throws on a non-2xx, rather than returning a guess", async () => {
    const p = new OllamaSummaryProvider({
      model: "qwen3:8b",
      fetchImpl: fakeFetch({ error: "model not found" }, false),
    });
    await expect(p.compose(kids, { kind: "task" })).rejects.toThrow();
  });

  it("sends the PHASE prompt for a process, not the task one", async () => {
    let body: unknown;
    const capturing = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: '{"groups":[{"start":0,"summary":"x"}]}' },
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    await new OllamaSummaryProvider({ model: "m", fetchImpl: capturing }).compose(kids, {
      kind: "process",
    });
    const sys = (body as { messages: { content: string }[] }).messages[0]!.content;
    expect(sys).toMatch(/phase/i);
  });

  it("sends a DIFFERENT system prompt for each kind", async () => {
    const seen: string[] = [];
    const capturing = (async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).messages[0].content);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: '{"groups":[{"start":0,"summary":"x"}]}' },
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const p = new OllamaSummaryProvider({ model: "m", fetchImpl: capturing });
    for (const kind of ["task", "process", "session"] as const) {
      await p.compose(kids, { kind });
    }
    expect(new Set(seen).size).toBe(3);
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
