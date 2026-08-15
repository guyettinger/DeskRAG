import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS, TOOLS, callTool, toolByName } from "../app/src/main/mcp/tools.js";
import type { ExperienceReader } from "../app/src/main/mcp/reader.js";
import { buildOutline } from "../app/src/main/mcp/outline.js";
import type { FlowsDTO, ResultDetailDTO, SearchResultDTO } from "@shared/types";

const EPOCH = 1_754_000_000_000; // 2025-07-31T22:13:20Z

function emptySearch(over: Partial<SearchResultDTO> = {}): SearchResultDTO {
  return { frames: [], ...over };
}

function oneHit(): SearchResultDTO {
  return {
    frames: [
      {
        frameId: "f1",
        score: 0.83,
        sessionId: "s1",
        tMono: 21_909,
        offsetSec: 20.109,
        wallClock: EPOCH + 21_909,
        width: 2560,
        height: 1440,
        segmentDigest: 'clicked "=" in Calculator',
        segmentCaption: null,
        segmentTranscript: null,
        taskSummary: "Add numbers from 1 to 6",
        app: "Calculator",
        appTone: "app-3",
        sessionSpanSec: 39.7,
        evidence: {
          frame: 0,
          region: 0.5,
          segment: 1,
          lanes: [
            { key: "digest", rank: 1 },
            { key: "region_label", rank: 2, count: 2 },
          ],
        },
        thumbUrl: "deskrag://frame/b1",
        highlightCount: 2,
      },
    ],
  };
}

const detail = (over: Partial<ResultDetailDTO> = {}): ResultDetailDTO => ({
  frameId: "f1",
  imageUrl: "deskrag://frame/b1",
  width: 2560,
  height: 1440,
  tMono: 21_909,
  offsetSec: 20.109,
  wallClock: EPOCH + 21_909,
  session: { id: "s1", startedAt: EPOCH },
  segment: {
    id: "seg1",
    granularity: "action",
    digest: 'clicked "=" in Calculator',
    caption: "the Calculator app showing 21",
    transcript: null,
  },
  taskSummary: "Add numbers from 1 to 6",
  ax: [
    { role: "Button", label: "=", x: 10, y: 20, w: 30, h: 40 },
    { role: "TextField", label: "21", x: 0, y: 0, w: 100, h: 20 },
  ],
  highlights: [],
  ...over,
});

const flows = (): FlowsDTO => ({
  graph: {
    id: "g",
    entry: "n0",
    nodes: [
      { id: "n0", label: "Calculator", chip: "n0", observations: 2, predicates: [], locatable: true, intervene: "none", rank: 0, sources: [] },
      { id: "n1", label: "TextEdit", chip: "n1", observations: 1, predicates: [], locatable: true, intervene: "none", rank: 1, sources: [] },
    ],
    edges: [
      {
        id: "e0",
        from: "n0",
        to: "n1",
        actions: [{ action: "click", target: 'Button "="' }],
        back: false,
        provenance: "recorded",
        observations: 2,
        sources: [{ sessionId: "s1", startedAt: EPOCH, atSec: 1, throughSec: 3 }],
      },
    ],
    slots: [],
  },
  routes: [
    {
      id: "e0",
      count: 2,
      label: "Calculator → TextEdit",
      name: "Add up and note the total",
      nameObservations: 2,
      nodeIds: ["n0", "n1"],
      edgeIds: ["e0"],
      sessionIds: ["s1", "s2"],
    },
  ],
});

function fakeReader(over: Partial<ExperienceReader> = {}): ExperienceReader {
  return {
    search: async () => oneHit(),
    moment: () => detail(),
    frameImage: async () => ({ base64: "AAAA", mimeType: "image/jpeg" }),
    recordings: () => [
      {
        id: "s1",
        startedAt: EPOCH,
        endedAt: EPOCH + 31_200,
        durationMs: 31_200,
        frameCount: 109,
        segmentCount: 165,
        eventCount: 673,
        sizeBytes: 24_100_000,
        hasVideo: true,
        posterUrl: "deskrag://frame/b1",
        purpose: "Add some numbers, then write them down",
        purposeSource: "llm",
      },
    ],
    outline: () =>
      buildOutline({
        segments: [
          { id: "root", granularity: "session", tMonoStart: 0, tMonoEnd: 8000, digest: null, caption: null },
          { id: "a1", granularity: "action", tMonoStart: 0, tMonoEnd: 8000, digest: "clicked Add", caption: null },
        ],
        summaries: new Map([["root", { text: "Add some numbers", source: "llm" }]]),
        children: new Map([["root", ["a1"]]]),
        laneOrigin: 0,
      }),
    flows: () => flows(),
    ...over,
  };
}

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

describe("the tool surface", () => {
  it("exposes exactly the six read-only tools", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "get_flow",
      "get_moment",
      "get_recording_outline",
      "list_flows",
      "list_recordings",
      "search_experience",
    ]);
  });

  it("offers nothing that records, deletes, reindexes or acts", () => {
    // The read-only promise, asserted against the surface an agent can see —
    // `test/mcp.readonly.test.ts` asserts the same thing against the source.
    // Keyed on the VERB, since `list_recordings` legitimately contains "record":
    // what makes a tool safe is what it does, not what it mentions.
    for (const t of TOOLS) {
      expect(t.name, t.name).toMatch(/^(search|get|list)_/);
      expect(t.name, t.name).not.toMatch(
        /^(start|stop|delete|remove|reindex|replay|arm|click|type|press|execute|run|open|set|update)_/,
      );
    }
  });

  it("gives every tool a description and an object schema", () => {
    for (const t of TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(30);
      expect(t.inputSchema.type, t.name).toBe("object");
    }
  });

  it("tells the agent this is the user's own recorded activity", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/record/i);
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(100);
  });

  it("reports an unknown tool as an error rather than throwing", async () => {
    const r = await callTool(fakeReader(), "no_such_tool", {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/no_such_tool/);
  });
});

describe("search_experience", () => {
  it("renders a hit with its time, its task and the frame id to follow up on", async () => {
    const r = await callTool(fakeReader(), "search_experience", { query: "calculator" });
    const text = textOf(r);
    expect(r.isError).toBeFalsy();
    expect(text).toMatch(/Add numbers from 1 to 6/);
    expect(text).toMatch(/clicked "=" in Calculator/);
    expect(text).toMatch(/f1/);
    // Wall clock, not t_mono: an agent reasons in "yesterday", not in
    // milliseconds from a session epoch.
    expect(text).toMatch(/2025-07-31/);
  });

  /**
   * The score is max-normalized across the result set, so the best hit of any
   * query sits at the ceiling — `1.000` on a default install — however weak it
   * is. An agent handed that number reports "100% confidence" to a user, which
   * is the same class of failure as the empty-result branches below.
   */
  it("never shows the score, and says the ranking is relative", async () => {
    const text = textOf(await callTool(fakeReader(), "search_experience", { query: "calculator" }));
    expect(text).not.toMatch(/score/i);
    expect(text).not.toMatch(/0\.830/);
    expect(text).toMatch(/RELATIVE to this result set/);
  });

  it("names the ranked lists a hit appeared in, in the reader's words", async () => {
    const text = textOf(await callTool(fakeReader(), "search_experience", { query: "calculator" }));
    // The retriever's own key is `digest`/`region_label`; an agent is told what
    // those MEAN, and the count comes along for the region lane.
    expect(text).toMatch(/Matched in: what happened, on-screen label ×2/);
    expect(text).not.toMatch(/region_label/);
  });

  it("says a frame recalled with its segment appeared in no list of its own", async () => {
    const reader = fakeReader({
      search: async () => ({
        frames: [{ ...oneHit().frames[0]!, evidence: { frame: 0, region: 0, segment: 0, lanes: [] } }],
      }),
    });
    const text = textOf(await callTool(reader, "search_experience", { query: "x" }));
    expect(text).toMatch(/no list of its own — recalled with its segment/);
  });

  /**
   * Frames sharing a segment with no region match are equal on every signal the
   * retriever has. Presenting an arbitrary order as "best first" would invite an
   * agent to treat the first one as the answer.
   */
  it("drops 'best first' when every hit scored identically", async () => {
    const one = oneHit().frames[0]!;
    const reader = fakeReader({
      search: async () => ({
        frames: [
          { ...one, frameId: "a", score: 0.5 },
          { ...one, frameId: "b", score: 0.5 },
        ],
      }),
    });
    const text = textOf(await callTool(reader, "search_experience", { query: "x" }));
    expect(text).toMatch(/matched EQUALLY/);
    expect(text).toMatch(/order below is arbitrary/);
    expect(text).not.toMatch(/best first/);
  });

  it("carries the caption and the transcript, not only the digest", async () => {
    const reader = fakeReader({
      search: async () => ({
        frames: [
          {
            ...oneHit().frames[0]!,
            segmentCaption: "The Calculator shows 21",
            segmentTranscript: "there we go",
          },
        ],
      }),
    });
    const text = textOf(await callTool(reader, "search_experience", { query: "x" }));
    expect(text).toMatch(/On screen: The Calculator shows 21/);
    expect(text).toMatch(/Said: there we go/);
    expect(text).toMatch(/What happened: clicked "=" in Calculator/);
  });

  it("requires a non-empty query", async () => {
    for (const args of [{}, { query: "" }, { query: "   " }, { query: 7 }]) {
      const r = await callTool(fakeReader(), "search_experience", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
  });

  it("honours limit, clamping it into range", async () => {
    const many: SearchResultDTO = {
      frames: Array.from({ length: 30 }, (_, i) => ({ ...oneHit().frames[0]!, frameId: `f${i}` })),
    };
    const reader = fakeReader({ search: async () => many });
    const three = textOf(await callTool(reader, "search_experience", { query: "x", limit: 3 }));
    expect(three.match(/frameId/g)?.length).toBe(3);
    // 0 and negatives are not "no results" — they are a caller mistake, and
    // returning nothing would look like an empty index. They fall back to the
    // default rather than being honoured.
    const zero = textOf(await callTool(reader, "search_experience", { query: "x", limit: 0 }));
    expect(zero.match(/frameId/g)?.length).toBe(8);
    // Above the ceiling clamps rather than erroring.
    const huge = textOf(await callTool(reader, "search_experience", { query: "x", limit: 999 }));
    expect(huge.match(/frameId/g)?.length).toBe(30);
  });

  it("explains a total miss caused by a PROVIDER change, not by absence", async () => {
    // Namespaces diverge by design and there is no migration path, so prior
    // recordings can sit in a space the current provider never queries. An
    // agent handed a bare empty list would report "you never did this".
    const reader = fakeReader({
      search: async () => emptySearch({ indexedUnderDifferentProvider: true }),
    });
    const text = textOf(await callTool(reader, "search_experience", { query: "x" }));
    expect(text).toMatch(/different .*provider|provider .*chang/i);
    expect(text).not.toMatch(/^No matches\.$/);
  });

  it("explains segments matching with no frames — an index defect with a remedy", async () => {
    const reader = fakeReader({
      search: async () => emptySearch({ segmentsMatchedButNoFrames: 4 }),
    });
    const text = textOf(await callTool(reader, "search_experience", { query: "x" }));
    expect(text).toMatch(/4/);
    expect(text).toMatch(/re-?index/i);
  });

  it("says plainly when nothing matched and nothing is wrong", async () => {
    const reader = fakeReader({ search: async () => emptySearch() });
    expect(textOf(await callTool(reader, "search_experience", { query: "x" }))).toMatch(
      /no matches/i,
    );
  });
});

describe("get_moment", () => {
  it("returns the screen as an image block alongside the text", async () => {
    const r = await callTool(fakeReader(), "get_moment", { frameId: "f1" });
    const image = r.content.find((c) => c.type === "image");
    expect(image).toMatchObject({ mimeType: "image/jpeg", data: "AAAA" });
    expect(textOf(r)).toMatch(/the Calculator app showing 21/);
    expect(textOf(r)).toMatch(/Button "="/);
  });

  it("omits the image when asked to", async () => {
    const r = await callTool(fakeReader(), "get_moment", { frameId: "f1", includeImage: false });
    expect(r.content.some((c) => c.type === "image")).toBe(false);
    expect(textOf(r)).toMatch(/Calculator/);
  });

  it("still answers in text when the frame has no keyframe blob", async () => {
    // A frame row with no blob is a real state, not an error: the text is still
    // the useful half.
    const r = await callTool(fakeReader({ frameImage: async () => null }), "get_moment", {
      frameId: "f1",
    });
    expect(r.isError).toBeFalsy();
    expect(r.content.some((c) => c.type === "image")).toBe(false);
    expect(textOf(r)).toMatch(/no stored keyframe/i);
  });

  it("errors on an unknown frame", async () => {
    const r = await callTool(fakeReader({ moment: () => null }), "get_moment", { frameId: "zz" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/zz/);
  });
});

describe("list_recordings", () => {
  it("carries the purpose AND its source", async () => {
    const text = textOf(await callTool(fakeReader(), "list_recordings", {}));
    expect(text).toMatch(/Add some numbers, then write them down/);
    // `llm` vs `template` travels with the text everywhere else in this app.
    expect(text).toMatch(/llm/);
    expect(text).toMatch(/s1/);
  });

  it("says so when there are no recordings", async () => {
    const text = textOf(await callTool(fakeReader({ recordings: () => [] }), "list_recordings", {}));
    expect(text).toMatch(/no recordings/i);
  });

  it("does not assert a purpose for an unindexed recording", async () => {
    const reader = fakeReader({
      recordings: () => [
        {
          id: "s9",
          startedAt: EPOCH,
          endedAt: EPOCH + 1000,
          durationMs: 1000,
          frameCount: 0,
          segmentCount: 0,
          eventCount: 3,
          sizeBytes: 0,
          hasVideo: false,
          posterUrl: null,
          purpose: null,
          purposeSource: null,
        },
      ],
    });
    const text = textOf(await callTool(reader, "list_recordings", {}));
    expect(text).toMatch(/not .*indexed|no purpose/i);
  });
});

describe("get_recording_outline", () => {
  it("renders the ladder", async () => {
    const text = textOf(await callTool(fakeReader(), "get_recording_outline", { sessionId: "s1" }));
    expect(text).toMatch(/SESSION/);
    expect(text).toMatch(/Add some numbers/);
    expect(text).toMatch(/ACTION/);
  });

  it("errors on an unknown recording rather than reporting an empty one", async () => {
    // "No such recording" and "a recording with no hierarchy" are different
    // answers and only one of them is the agent's mistake.
    const r = await callTool(fakeReader({ outline: () => null }), "get_recording_outline", {
      sessionId: "nope",
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/nope/);
  });

  it("requires a sessionId", async () => {
    expect((await callTool(fakeReader(), "get_recording_outline", {})).isError).toBe(true);
  });
});

describe("list_flows / get_flow", () => {
  it("lists routes with their ids so get_flow can follow", async () => {
    const text = textOf(await callTool(fakeReader(), "list_flows", {}));
    expect(text).toMatch(/Add up and note the total/);
    expect(text).toMatch(/e0/);
  });

  it("renders one route's steps", async () => {
    const text = textOf(await callTool(fakeReader(), "get_flow", { routeId: "e0" }));
    expect(text).toMatch(/Step 1/);
    expect(text).toMatch(/Button "="/);
  });

  it("errors on an unknown route id", async () => {
    const r = await callTool(fakeReader(), "get_flow", { routeId: "ghost" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/ghost/);
  });

  it("explains a missing graph instead of failing opaquely", async () => {
    const reader = fakeReader({ flows: () => null });
    const list = textOf(await callTool(reader, "list_flows", {}));
    expect(list).toMatch(/no trace graph/i);
    const one = await callTool(reader, "get_flow", { routeId: "e0" });
    expect(one.isError).toBe(true);
  });
});

describe("failure handling", () => {
  it("turns a reader throw into a tool error, never an unhandled rejection", async () => {
    // Ollama being down is an ordinary state here; it must reach the agent as a
    // message it can act on rather than killing the request.
    const reader = fakeReader({
      search: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      },
    });
    const r = await callTool(reader, "search_experience", { query: "x" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/ECONNREFUSED/);
  });
});

describe("toolByName", () => {
  it("finds a tool and returns undefined otherwise", () => {
    expect(toolByName("get_flow")?.name).toBe("get_flow");
    expect(toolByName("nope")).toBeUndefined();
  });
});
