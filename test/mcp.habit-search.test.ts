import { describe, expect, it } from "vitest";
import {
  RANKING_MIN_HABITS,
  bm25Ranking,
  cosine,
  denseRanking,
  habitDocs,
  renderHabitSearch,
  tokenize,
  type DenseLane,
} from "../app/src/main/mcp/habit-search.js";
import type { HabitDTO, HabitProposalDTO, HabitsDTO } from "@shared/types";

const EPOCH = 1_754_000_000_000;

const habit = (over: Partial<HabitDTO> = {}): HabitDTO => ({
  id: "01HABITAAAAAAAAAAAAAAAAAAA",
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
  slots: [],
  timings: null,
  runs: [],
  cautions: [],
  apps: [],
  slug: "file-a-bug-report",
  title: "File a bug report",
  description: "Use when filing a GitHub issue.",
  body: "Open the repository and press the new issue button.",
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
    boundSessionIds: ["s1", "s2"],
    overlap: 2,
    lostSessionIds: [],
    gainedSessionIds: [],
    recordings: 2,
    candidates: [],
    note: null,
    walks: [],
  },
  ...over,
});

const corpus = (habits: HabitDTO[], over: Partial<HabitsDTO> = {}): HabitsDTO => ({
  habits,
  proposals: [],
  domain: null,
  graphPresent: true,
  prose: { available: false, model: null },
  ...over,
});

/** Every field, because `HabitProposalDTO` has twelve and an `as` cast would hide a rename. */
const proposal = (over: Partial<HabitProposalDTO> = {}): HabitProposalDTO => ({
  routeKey: "r1",
  name: null,
  label: "A → B",
  count: 4,
  steps: 2,
  stepSummary: "2 steps",
  variants: 0,
  nameObservations: 0,
  sessionIds: ["s1", "s2"],
  walks: [],
  apps: [],
  preview: "",
  ...over,
});

const NO_GRAPH = "no graph here";
const ranked = (ids: string[]): DenseLane => ({ kind: "ranked", ids });
const skipped = (reason: string): DenseLane => ({ kind: "skipped", reason });

const render = (habits: HabitsDTO, query: string, dense: DenseLane): string =>
  renderHabitSearch({ habits, query, limit: 8, dense, noGraph: NO_GRAPH });

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics and drops single characters", () => {
    expect(tokenize("Open the Bug-Report #14, a TextEdit doc")).toEqual([
      "open",
      "the",
      "bug",
      "report",
      "14",
      "textedit",
      "doc",
    ]);
  });

  it("returns nothing for punctuation alone", () => {
    expect(tokenize("--- ,. ---")).toEqual([]);
  });
});

describe("bm25Ranking", () => {
  const docs = [
    { id: "a", dense: "", lexical: "calculator sum total calculator" },
    { id: "b", dense: "", lexical: "textedit paste the total" },
    { id: "c", dense: "", lexical: "chrome github issue" },
  ];

  it("ranks the document that carries the query terms first", () => {
    expect(bm25Ranking(docs, "calculator")[0]).toBe("a");
    expect(bm25Ranking(docs, "github issue")[0]).toBe("c");
  });

  it("omits documents with no term in common — membership is the signal", () => {
    // A lane that contains everything says nothing by containing something.
    expect(bm25Ranking(docs, "github")).toEqual(["c"]);
  });

  it("never scores a shared term negatively", () => {
    // Textbook BM25's idf goes NEGATIVE past df > N/2, so over a corpus of
    // three a term in two documents would SUBTRACT. "total" is in a and b.
    const out = bm25Ranking(docs, "total");
    expect(out).toHaveLength(2);
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  it("returns nothing for an empty query or an empty corpus", () => {
    expect(bm25Ranking(docs, "   ")).toEqual([]);
    expect(bm25Ranking([], "calculator")).toEqual([]);
  });
});

describe("cosine and denseRanking", () => {
  it("is 1 for identical directions and 0 for orthogonal ones", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([2, 0]))).toBeCloseTo(1, 6);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 3]))).toBeCloseTo(0, 6);
  });

  it("is 0 rather than NaN against a zero vector", () => {
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });

  it("orders every id, closest first", () => {
    const out = denseRanking(
      ["a", "b", "c"],
      [new Float32Array([0, 1]), new Float32Array([1, 0]), new Float32Array([0.7, 0.7])],
      new Float32Array([1, 0]),
    );
    expect(out).toEqual(["b", "c", "a"]);
  });
});

describe("habitDocs", () => {
  it("puts the AUTHORED half in the dense document and the whole file in the lexical one", () => {
    const [doc] = habitDocs([habit({ apps: ["Ghostty", "Google Chrome"] })]);
    expect(doc!.dense).toContain("File a bug report");
    expect(doc!.dense).toContain("Use when filing a GitHub issue.");
    expect(doc!.dense).toContain("press the new issue button");
    expect(doc!.dense).toContain("Ghostty");
    // NOT the record: two duplicate habits have byte-identical records, so a
    // dense lane over one cannot separate them.
    expect(doc!.dense).not.toContain("---\nname:");
    expect(doc!.lexical).toBe(habit().markdown);
  });
});

describe("renderHabitSearch", () => {
  it("reuses list_habits' three empty states when nothing is kept", () => {
    expect(render(corpus([], { graphPresent: false }), "anything", ranked([]))).toBe(NO_GRAPH);
    expect(render(corpus([]), "anything", ranked([]))).toMatch(/carries no provenance/);
  });

  it("says outright that one habit is the only candidate, not a match", () => {
    const out = render(corpus([habit()]), "bug", ranked([habit().id]));
    expect(out).toMatch(/only candidate/);
    expect(out).toMatch(/Nothing was ranked against it/);
  });

  it("warns that a corpus below the floor ranks nearly everything", () => {
    const three = [habit(), habit({ id: "B2", slug: "b2" }), habit({ id: "C3", slug: "c3" })];
    const out = render(corpus(three), "bug", ranked(["B2", "C3", habit().id]));
    expect(out).toMatch(/3 kept habits/);
    expect(out).toMatch(/ranks nearly everything/);
  });

  it("drops the small-corpus warning at the floor", () => {
    const many = Array.from({ length: RANKING_MIN_HABITS }, (_, i) =>
      habit({ id: `H${i}`, slug: `h${i}` }),
    );
    const out = render(corpus(many), "bug", ranked(many.map((h) => h.id)));
    expect(out).not.toMatch(/ranks nearly everything/);
    expect(out).toMatch(/best first/);
  });

  it("prints NO score, only a rank per lane", () => {
    const out = render(
      corpus([habit(), habit({ id: "B2", slug: "b2" })]),
      "bug report",
      ranked([habit().id, "B2"]),
    );
    expect(out).toMatch(/matched in: /);
    expect(out).toMatch(/prose #1/);
    // No decimal anywhere: a fused RRF value is not a confidence and is not
    // comparable between queries.
    expect(out).not.toMatch(/\d\.\d{2,}/);
  });

  it("names the lanes a habit appeared in, and omits a lane it did not", () => {
    const a = habit({ markdown: "calculator sum" });
    const b = habit({ id: "B2", slug: "b2", markdown: "chrome github" });
    const out = render(corpus([a, b]), "calculator", ranked([a.id, "B2"]));
    // Anchored on the newline: a corpus note mentioning "2 kept habits" must not
    // be mistaken for the start of the second block.
    const first = out.slice(out.indexOf("\n1. "), out.indexOf("\n2. "));
    expect(first).toMatch(/exact terms #1/);
    const second = out.slice(out.indexOf("\n2. "));
    expect(second).toMatch(/prose #2/);
    expect(second).not.toMatch(/exact terms/);
  });

  it("falls back to the lexical lane alone and says the prose lane was skipped", () => {
    const out = render(
      corpus([habit({ markdown: "calculator sum" })]),
      "calculator",
      skipped("no text model is downloaded"),
    );
    expect(out).toMatch(/prose lane was skipped: no text model is downloaded/);
    expect(out).toMatch(/exact terms #1/);
    expect(out).not.toMatch(/prose #/);
  });

  it("says which emptiness it is when the skipped lane leaves nothing", () => {
    const out = render(
      corpus([habit({ markdown: "calculator sum" })]),
      "zzzz",
      skipped("no text model is downloaded"),
    );
    expect(out).toMatch(/No kept habit contains any of those terms/);
    expect(out).toMatch(/no text model is downloaded/);
    // The remedy, which a bare empty list cannot give.
    expect(out).toMatch(/list_habits/);
  });

  it("honours the limit", () => {
    const many = Array.from({ length: 6 }, (_, i) => habit({ id: `H${i}`, slug: `h${i}` }));
    const out = renderHabitSearch({
      habits: corpus(many),
      query: "bug",
      limit: 2,
      dense: ranked(many.map((h) => h.id)),
      noGraph: NO_GRAPH,
    });
    expect(out).toMatch(/^1\. /m);
    expect(out).toMatch(/^2\. /m);
    expect(out).not.toMatch(/^3\. /m);
  });

  it("counts recurring routes nobody kept, because silence reads as none", () => {
    const out = renderHabitSearch({
      habits: corpus([habit()], {
        proposals: [
          proposal({ routeKey: "r1", label: "A → B", count: 4, steps: 2, stepSummary: "2 steps" }),
          proposal({ routeKey: "r2", label: "C → D", count: 1, steps: 1, stepSummary: "1 step" }),
        ],
      }),
      query: "bug",
      limit: 8,
      dense: ranked([habit().id]),
      noGraph: NO_GRAPH,
    });
    // One repeated route. The single-walk one is an observation, not a habit.
    expect(out).toMatch(/1 recorded route .*not kept/);
  });
});
