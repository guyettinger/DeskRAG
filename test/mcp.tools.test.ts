import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS, TOOLS, callTool, toolByName } from "../app/src/main/mcp/tools.js";
import type { ExperienceReader } from "../app/src/main/mcp/reader.js";
import { buildOutline } from "../app/src/main/mcp/outline.js";
import type {
  FlowsDTO,
  ResultDetailDTO,
  SearchResultDTO,
  HabitDTO,
  HabitProposalDTO,
  HabitsDTO,
} from "@shared/types";

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
  app: "Calculator",
  appTone: "app-3",
  sessionSpanSec: 39.7,
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
  excludedApps: [],
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
      variants: [],
      walks: [
        { sessionId: "s1", edgeIds: ["e0"], atSec: 0, throughSec: 0 },
        { sessionId: "s2", edgeIds: ["e0"], atSec: 0, throughSec: 0 },
      ],
    },
  ],
});

const noHabits = (): HabitsDTO => ({
  habits: [],
  proposals: [],
  domain: null,
  graphPresent: true,
  prose: { available: false, model: null },
});

function fakeReader(over: Partial<ExperienceReader> = {}): ExperienceReader {
  return {
    habits: () => noHabits(),
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
    embed: async () => null,
    momentAt: () => null,
    ...over,
  };
}

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

describe("the tool surface", () => {
  it("exposes exactly the eleven read-only tools", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "get_flow",
      "get_habit",
      "get_habit_step",
      "get_habit_steps",
      "get_moment",
      "get_recording_outline",
      "list_flows",
      "list_habits",
      "list_recordings",
      "search_experience",
      "search_habits",
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
    // "Speech", not "Said": segment.transcript merges every audio blob in the
    // window, and with computer audio that can include a video's narration.
    expect(text).toMatch(/Speech: there we go/);
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

/**
 * The habit catalogue and the file.
 *
 * `list_habits` is a chooser: an agent decides from it whether to fetch, so the
 * two disclosures that would change that decision — one observation, and steps
 * that have not been re-checked — are in the LIST, not only in the file.
 *
 * `get_habit` returns the HABIT.md raw. That is the whole point of it.
 */

const habit = (over: Partial<HabitDTO> = {}): HabitDTO => ({
  id: "01K3W8QF5T3M2Q7V6N0X4C1B8D",
  state: "active",
  pinned: false,
  createdAt: EPOCH,
  updatedAt: EPOCH,
  version: "0.1.0",
  history: [],
  duplicates: [],
  ways: [],
  fork: null,
  droppedEarly: [],
  apps: [],
  slug: "file-a-bug-report",
  title: "File a bug report",
  description: "Use when filing a GitHub issue on a repo you already have open.",
  body: "prose",
  bodySource: "llm",
  bodyModel: "ollama qwen3:4b",
  edited: false,
  showSamples: false,
  generateNote: null,
  markdown: "---\nname: file-a-bug-report\n---\n\n# File a bug report\n",
  binding: {
    state: "exact",
    routeKey: "Ghostty → Google Chrome",
    liveRouteKey: "Ghostty → Google Chrome",
    routeLabel: "Ghostty → Google Chrome",
    boundAt: EPOCH,
    boundSessionIds: ["s1", "s2", "s3", "s4"],
    overlap: 4,
    lostSessionIds: [],
    gainedSessionIds: [],
    recordings: 4,
    candidates: [],
    note: null,
    walks: [],
  },
  ...over,
});

const withHabits = (s: HabitsDTO): ExperienceReader => fakeReader({ habits: () => s });

describe("list_habits", () => {
  it("lists a kept habit with its id, evidence and route", async () => {
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit()] }),
      "list_habits",
      {},
    );
    const text = out.content[0]!.text!;
    expect(text).toMatch(/file-a-bug-report/);
    expect(text).toMatch(/id: 01K3W8QF5T3M2Q7V6N0X4C1B8D/);
    expect(text).toMatch(/4 recordings · prose: llm/);
    expect(text).toMatch(/route: Ghostty → Google Chrome/);
  });

  it("says RECORDED ONCE in the list, where the decision to fetch is made", async () => {
    const one = habit({
      binding: { ...habit().binding, recordings: 1, boundSessionIds: ["s1"] },
    });
    const out = await callTool(withHabits({ ...noHabits(), habits: [one] }), "list_habits", {});
    expect(out.content[0]!.text).toMatch(/RECORDED ONCE — kept from a single observation/);
  });

  it("prints the version, so an agent that cached this file can see it moved", async () => {
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit({ version: "0.1.7" })] }),
      "list_habits",
      {},
    );
    expect(out.content[0]!.text).toMatch(/v0\.1\.7/);
  });

  // Two files describing one procedure. An agent that fetches both and finds
  // them near-identical cannot tell whether that is a duplicate or two genuinely
  // different ways of doing the same work — so the LIST says which.
  it("discloses that another habit describes the same route", async () => {
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit({ duplicates: ["01OTHERHABITID"] })] }),
      "list_habits",
      {},
    );
    expect(out.content[0]!.text).toMatch(/ALSO DESCRIBED BY — 01OTHERHABITID/);
    expect(out.content[0]!.text).toMatch(/nobody has merged them/);
  });

  it("says ORPHANED, and that the steps have not been re-checked", async () => {
    const orphan = habit({ binding: { ...habit().binding, state: "orphaned", recordings: 0 } });
    const out = await callTool(withHabits({ ...noHabits(), habits: [orphan] }), "list_habits", {});
    expect(out.content[0]!.text).toMatch(/ORPHANED/);
    expect(out.content[0]!.text).toMatch(/have not been re-checked/);
  });

  it("hides a dismissal — a suppressed proposal is not a habit", async () => {
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit({ state: "dismissed" })] }),
      "list_habits",
      {},
    );
    expect(out.content[0]!.text).not.toMatch(/file-a-bug-report/);
  });

  it("names the applications the route passes through", async () => {
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit({ apps: ["Calculator", "TextEdit"] })] }),
      "list_habits",
      {},
    );
    expect(textOf(out)).toContain("passes through: Calculator → TextEdit");
  });

  it("discloses that the recordings did not take the same path", async () => {
    const ways = [
      { letter: "A", sessionIds: ["s1"], steps: [], totalsMs: [39_300] },
      { letter: "B", sessionIds: ["s2"], steps: [], totalsMs: [24_000] },
    ];
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit({ ways })] }),
      "list_habits",
      {},
    );
    expect(textOf(out)).toContain("2 WAYS recorded");
  });

  it("prints a named fork verdict, and a withheld one's reason verbatim", async () => {
    const named = await callTool(
      withHabits({
        ...noHabits(),
        habits: [habit({ fork: { rows: [], verdict: { kind: "named", text: "Way B is faster." } } })],
      }),
      "list_habits",
      {},
    );
    expect(textOf(named)).toContain("Way B is faster.");

    const withheld = await callTool(
      withHabits({
        ...noHabits(),
        habits: [
          habit({
            fork: { rows: [], verdict: { kind: "withheld", reason: "fewer than 2 timed recordings" } },
          }),
        ],
      }),
      "list_habits",
      {},
    );
    // The REASON, verbatim. A withheld verdict that says only "withheld" is the
    // failure `StageSpec.skipReason` exists to prevent.
    expect(textOf(withheld)).toContain("fewer than 2 timed recordings");
  });

  it("discloses recordings that started this work and dropped it", async () => {
    const out = await callTool(
      withHabits({
        ...noHabits(),
        habits: [habit({ droppedEarly: [{ places: ["Calculator"], count: 2 }] })],
      }),
      "list_habits",
      {},
    );
    expect(textOf(out)).toContain("STARTED AND DROPPED — 2 recording(s)");
  });

  it("says when the prose is the user's own words", async () => {
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit({ edited: true })] }),
      "list_habits",
      {},
    );
    expect(textOf(out)).toContain("Hand-edited");
    const clean = await callTool(withHabits({ ...noHabits(), habits: [habit()] }), "list_habits", {});
    expect(textOf(clean)).not.toContain("Hand-edited");
  });

  // THREE empty states, never one — the `search_experience` rule. Each names a
  // different remedy, and an agent handed a bare empty list reports the wrong one.
  it("distinguishes no graph from no routes from nothing kept", async () => {
    const noGraph = await callTool(
      withHabits({ ...noHabits(), graphPresent: false }),
      "list_habits",
      {},
    );
    expect(noGraph.content[0]!.text).toMatch(/No trace graph has been built/);

    const noRoutes = await callTool(withHabits(noHabits()), "list_habits", {});
    expect(noRoutes.content[0]!.text).toMatch(/carries no provenance/);
    expect(noRoutes.content[0]!.text).toMatch(/Rebuild trace graph/);

    const nothingKept = await callTool(
      withHabits({
        ...noHabits(),
        proposals: [
          {
            routeKey: "A → B",
            name: null,
            label: "A → B",
            count: 2,
            steps: 3,
            stepSummary: "2 steps",
            variants: 0,
            nameObservations: 0,
            sessionIds: ["s1", "s2"],
            walks: [],
            apps: [],
            preview: "",
          },
        ],
      }),
      "list_habits",
      {},
    );
    // Naming the number is the actionable half.
    expect(nothingKept.content[0]!.text).toMatch(/1 route it could propose from/);
    expect(nothingKept.content[0]!.text).toMatch(/list_flows/);
  });

  // Recurrence is the only evidence a proposal carries, and before this the
  // catalogue stopped reporting it entirely the moment one habit was kept.
  describe("candidates nobody has kept", () => {
    const proposal = (over: Partial<HabitProposalDTO> = {}): HabitProposalDTO => ({
      routeKey: "A → B",
      name: null,
      label: "A → B",
      count: 2,
      steps: 3,
      stepSummary: "2 steps",
      variants: 0,
      nameObservations: 0,
      sessionIds: ["s1", "s2"],
      walks: [],
      apps: [],
      preview: "PREVIEW-SHOULD-NEVER-APPEAR",
      ...over,
    });

    it("names a repeated route with its count, beside the kept habits", async () => {
      const out = await callTool(
        withHabits({
          ...noHabits(),
          habits: [habit()],
          proposals: [proposal({ name: "File a bug", count: 4, sessionIds: ["a", "b", "c", "d"] })],
        }),
        "list_habits",
        {},
      );
      const text = out.content[0]!.text!;
      // The kept habit is still the answer; the candidate is context after it.
      expect(text).toMatch(/NOT YET KEPT/);
      expect(text).toMatch(/×4 {2}File a bug/);
      expect(text.indexOf("NOT YET KEPT")).toBeGreaterThan(text.indexOf("id: "));
      // A whole rendered record would dwarf the catalogue.
      expect(text).not.toContain("PREVIEW-SHOULD-NEVER-APPEAR");
    });

    it("COUNTS a once-walked route and refuses to name it", async () => {
      const out = await callTool(
        withHabits({
          ...noHabits(),
          habits: [habit()],
          proposals: [proposal({ name: "Walked once", count: 1, sessionIds: ["a"] })],
        }),
        "list_habits",
        {},
      );
      const text = out.content[0]!.text!;
      expect(text).not.toContain("Walked once");
      expect(text).toMatch(/1 further route was walked once each and is not listed/);
      // A single walk is never presented as a candidate.
      expect(text).not.toMatch(/NOT YET KEPT/);
    });

    it("says nothing at all when every route is claimed", async () => {
      const out = await callTool(
        withHabits({ ...noHabits(), habits: [habit()], proposals: [] }),
        "list_habits",
        {},
      );
      expect(out.content[0]!.text).not.toMatch(/NOT YET KEPT|not listed/);
    });
  });
});

describe("get_habit", () => {
  it("returns the HABIT.md RAW, with no preamble before the frontmatter", async () => {
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit()] }),
      "get_habit",
      { habitId: habit().id },
    );
    // The value of this tool is that its output IS a file: a friendly sentence
    // in front of the `---` corrupts a paste-to-disk.
    expect(out.content).toHaveLength(1);
    expect(out.content[0]!.text).toBe(habit().markdown);
    expect(out.content[0]!.text!.startsWith("---")).toBe(true);
  });

  it("names the remedy for an unknown id", async () => {
    const out = await callTool(withHabits(noHabits()), "get_habit", { habitId: "nope" });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/Habit ids come from list_habits/);
  });

  it("requires a habitId", async () => {
    const out = await callTool(withHabits(noHabits()), "get_habit", {});
    expect(out.isError).toBe(true);
  });

  it("will not serve a dismissed row", async () => {
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit({ state: "dismissed" })] }),
      "get_habit",
      { habitId: habit().id },
    );
    expect(out.isError).toBe(true);
  });
});

const ID_A = "01JQ3WVX9K2M7N5P8R4T6Y0ZAA";
const ID_B = "01JQ3WVX9K2M7N5P8R4T6Y0ZBB";

/** Two ACTIVE habits on one live route — what `duplicateHabits` pairs. */
const twoOnOneRoute = (): HabitsDTO => ({
  ...noHabits(),
  habits: [
    habit({
      id: ID_A,
      slug: "compute-sum-paste",
      title: "Compute a sum and paste it",
      description: "Use when you need to add up a column and paste the result.",
      duplicates: [ID_B],
    }),
    habit({
      id: ID_B,
      slug: "total-and-note",
      title: "Total and note",
      description: "Use when you need to total a column and drop it into a note.",
      duplicates: [ID_A],
    }),
  ],
});

/** The one habit's entry in the catalogue — entries are separated by a blank line. */
const entryFor = (text: string, slug: string): string =>
  text.split("\n\n").find((chunk) => chunk.startsWith(slug))!;

describe("the duplicates differentiator", () => {
  it("names the other habit's slug and quotes what it says", async () => {
    // Two habits on one route have BYTE-IDENTICAL records: the record is
    // re-rendered from the same live route either way. So the only thing that
    // can differ is prose, and an agent handed two ULIDs has nothing to choose
    // with — the resolution-ambiguity failure named in the skill-retrieval work.
    const out = await callTool(withHabits(twoOnOneRoute()), "list_habits", {});
    const text = out.content[0]!.text!;
    expect(text).toMatch(/ALSO DESCRIBED BY — compute-sum-paste \(/);
    expect(text).toMatch(/The recorded steps are identical/);
    expect(text).toMatch(/differ only in how they are described/);
    expect(text).toMatch(/That one says: "Use when you need to total a column/);
  });

  it("keeps the id as well as the slug, because get_habit takes the id", async () => {
    const out = await callTool(withHabits(twoOnOneRoute()), "list_habits", {});
    expect(out.content[0]!.text).toMatch(/\(01[0-9A-HJKMNP-TV-Z]+\)/);
  });

  it("degrades to the plain sentence when the other description is empty", async () => {
    const h = twoOnOneRoute();
    h.habits[1]!.description = "";
    const out = await callTool(withHabits(h), "list_habits", {});
    // Scoped to the entry whose OTHER habit lost its description. The catalogue
    // renders both, and the second still has something to quote.
    const entry = entryFor(out.content[0]!.text!, "compute-sum-paste");
    expect(entry).toMatch(/answer to the same recorded route; nobody has merged them/);
    expect(entry).not.toMatch(/That one says/);
  });

  it("degrades to the plain sentence when the other habit is not in the set", async () => {
    // A lookup that cannot fail is a lookup that will.
    const h = twoOnOneRoute();
    h.habits = [h.habits[0]!];
    const out = await callTool(withHabits(h), "list_habits", {});
    expect(out.content[0]!.text).toMatch(/nobody has merged them/);
  });
});

describe("search_habits", () => {
  const vec = (xs: number[]): Float32Array => new Float32Array(xs);

  it("requires a non-empty situation", async () => {
    const out = await callTool(withHabits({ ...noHabits(), habits: [habit()] }), "search_habits", {});
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/`situation` is required/);
  });

  it("ranks with both lanes when a model answers", async () => {
    const reader = fakeReader({
      habits: () => ({ ...noHabits(), habits: [habit()] }),
      // One document, one query: identical direction, so the dense lane ranks it #1.
      embed: async (texts) => texts.map(() => vec([1, 0])),
    });
    const out = await callTool(reader, "search_habits", { situation: "file a bug" });
    expect(out.isError).toBeUndefined();
    expect(textOf(out)).toMatch(/prose #1/);
  });

  it("says the prose lane was skipped when no model answers", async () => {
    const reader = fakeReader({
      habits: () => ({ ...noHabits(), habits: [habit({ markdown: "file a bug report" })] }),
      embed: async () => null,
    });
    const out = await callTool(reader, "search_habits", { situation: "bug report" });
    expect(textOf(out)).toMatch(/prose lane was skipped/);
    expect(textOf(out)).toMatch(/exact terms #1/);
  });

  it("skips the dense lane rather than failing when the embedder returns the wrong count", async () => {
    // A provider that answers with fewer vectors than documents would silently
    // mis-pair habit to vector — every rank after the gap would name the wrong
    // habit. Refusing the lane is the only honest response.
    const reader = fakeReader({
      habits: () => ({
        ...noHabits(),
        habits: [habit({ markdown: "bug" }), habit({ id: "B2", slug: "b2", markdown: "bug" })],
      }),
      embed: async () => [vec([1, 0])],
    });
    const out = await callTool(reader, "search_habits", { situation: "bug" });
    expect(out.isError).toBeUndefined();
    expect(textOf(out)).toMatch(/prose lane was skipped/);
  });

  it("shows no score", async () => {
    const reader = fakeReader({
      habits: () => ({ ...noHabits(), habits: [habit()] }),
      embed: async (texts) => texts.map(() => vec([1, 0])),
    });
    expect(textOf(await callTool(reader, "search_habits", { situation: "bug" }))).not.toMatch(
      /\d\.\d{2,}/,
    );
  });
});
