# The Agent Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an agent three new read-only MCP tools — find a habit by situation, look at one step's screen, and get the steps as data — and make the catalogue say what B and C added.

**Architecture:** Everything decidable is a pure module under `app/src/main/mcp/`, driven by the injected `ExperienceReader`, so the root vitest suite exercises all of it with no Electron, no store and no model. The reader gains exactly two methods (`embed`, `momentAt`); the service gains three reads. `test/mcp.readonly.test.ts` must stay green **untouched** — if it needs an edit, the change is wrong.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, NodeNext — `.js` on every relative import), vitest, the `deskrag` barrel (aliased to `src/index.ts` in `vitest.config.ts`), Electron for the app half only.

**Spec:** `docs/superpowers/specs/2026-08-23-habit-agent-surface-design.md`

## Global Constraints

- **Every tool name must match `/^(search|get|list)_/`.** `test/mcp.readonly.test.ts` asserts it. The retrieval tool is `search_habits`, never `find_habit`.
- **The `ExperienceReader` interface body must not match `/record\(|delete|remove|start|stop|arm|execute|write|put|set/i`.** No word boundaries. So no parameter named `inputs` (contains `put`), and no inline return type containing `startedAt` (contains `start`) — declare named interfaces outside the body.
- **The `ServiceReads` interface body must not match `/\bclose\b|\bdelete|\bremove|startRecording|stopRecording|reindex|\bopen\(/i`.**
- **NO SCORE anywhere in tool output.** No ratio, percentage, cosine, RRF value or confidence. Rank and named lanes only.
- **No recorded slot VALUE may ever appear in `steps.json`**, and `showSamples` is not consulted. Slot names only.
- **`RANKING_MIN_HABITS = 5` ships unswept** and must be commented as such, naming C2's and C3's three floors.
- **Every refusal and every skipped lane states its reason** (the `StageSpec.skipReason` rule). A required `reason: string` on the skipped arm of a union, never optional, never an enum.
- **The gate is three unpiped commands**, run whole: `npm test`; `npm run typecheck`; `npm run build && npm --prefix app run typecheck`. Never pipe through `tail` — you get `tail`'s exit code and a hidden failure.
- New files go in `app/src/main/mcp/`, because `test/mcp.readonly.test.ts` `readdirSync`s that directory and so guards a file the day it lands.

---

## File Structure

| file | responsibility |
| --- | --- |
| `app/src/main/mcp/habit-search.ts` | **new** — the documents, the tokenizer, BM25, cosine, the fusion, the corpus disclosure, the rendered ranking |
| `app/src/main/mcp/habit-step.ts` | **new** — resolving `habitId` + `step` + `way` to one step, and rendering it |
| `app/src/main/mcp/habit-steps-json.ts` | **new** — the `steps.json` projection |
| `app/src/main/mcp/habit-text.ts` | export `habitLines`; add the apps / ways / fork / dropped / edited disclosures |
| `app/src/main/mcp/tools.ts` | three `ToolDef`s, `TOOLS`, `SERVER_INSTRUCTIONS` |
| `app/src/main/mcp/reader.ts` | `embed`, `momentAt`, `StepMoment`, `RegionView`, three `ServiceReads` members |
| `app/src/main/deskrag-service.ts` | `embedTexts`, `frameRegions` |
| `app/src/shared/types.ts` | `HabitStepDTO.actions[].slot?`, `HabitStepDTO.liftWarnings` |
| `app/src/main/habit-marks.ts` | `toStep` carries the slot NAME and `liftWarnings` |
| `scripts/mcp-probe.mjs` | eleven tools over the wire |

---

### Task 1: The catalogue says what B and C added

`list_habits` was written when a habit was a title, a description and a step list. It now has more to disclose, and an agent choosing between habits should not have to fetch each file to learn it. This task also **exports `habitLines`**, because Task 4 renders search results from the same function — the `way-fork.ts` precedent ("one entry point, so both formatters read one fork").

**Files:**
- Modify: `app/src/main/mcp/habit-text.ts`
- Test: `test/mcp.tools.test.ts` (the existing `describe("list_habits")` block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function habitLines(s: HabitDTO, others: ReadonlyMap<string, HabitDTO>): string[]` — the per-habit block, first element unindented, the rest indented two spaces.

- [ ] **Step 1: Write the failing tests**

Add to `test/mcp.tools.test.ts`, inside the existing `describe("list_habits", ...)`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mcp.tools.test.ts`
Expected: FAIL — five failures, each an assertion that a substring is missing.

- [ ] **Step 3: Rename `lines` to `habitLines`, export it, and add the disclosures**

In `app/src/main/mcp/habit-text.ts`, change the declaration:

```ts
/**
 * One habit's block in the catalogue, and the same block a search result draws.
 *
 * EXPORTED so `habit-search.ts` renders from this function rather than a second
 * copy of it — the `wayFork` rule. A disclosure added here appears in both
 * surfaces or in neither, which is the only way the two can be made unable to
 * disagree.
 */
export function habitLines(s: HabitDTO, others: ReadonlyMap<string, HabitDTO>): string[] {
```

Immediately after the existing `if (s.description !== "") out.push(...)` line, add:

```ts
  // Concrete situational anchoring, and the cheapest disclosure on this list: an
  // agent deciding whether a habit is relevant asks "is this about the app I am
  // in?" before it asks anything else.
  if (s.apps.length > 0) out.push(`  passes through: ${s.apps.join(" → ")}`);
```

Immediately after the existing `out.push(\`  ${bits.join(" · ")}\`)` line, add:

```ts
  // The recordings disagreed. An agent that follows a multi-way file top to
  // bottom performs two procedures in sequence, which is why the record prints
  // "follow one of them, not all of them in sequence" — said here too, because
  // the catalogue is where the agent decides whether to fetch.
  if (s.ways.length > 1) {
    out.push(
      `  ${s.ways.length} WAYS recorded — the recordings did not take the same path. ` +
        `Follow ONE way, not all of them; \`get_habit_step\` needs a way letter.`,
    );
  }
  if (s.fork !== null) {
    // The withheld reason VERBATIM. `Verdict.withheld.reason` is a required
    // string precisely so it can be printed rather than summarised.
    out.push(
      s.fork.verdict.kind === "named"
        ? `  ${s.fork.verdict.text}`
        : `  No way is established as better: ${s.fork.verdict.reason}`,
    );
  }
  const dropped = s.droppedEarly.reduce((n, d) => n + d.count, 0);
  if (dropped > 0) {
    out.push(
      `  STARTED AND DROPPED — ${dropped} recording(s) began this work and stopped partway. ` +
        `They walked a different route and are NOT counted in the recordings above.`,
    );
  }
  // Who is speaking in the file. `prose: llm` in the bits above says a model
  // wrote it; this says a person has since taken it over.
  if (s.edited) out.push("  Hand-edited — the prose is the user's own words, not a model's.");
```

Then update the one call site at the bottom of `renderHabitList`:

```ts
  const body = kept.map((s) => habitLines(s, byId).join("\n")).join("\n\n");
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/mcp.tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate**

Run each of these, whole and unpiped:
```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/mcp/habit-text.ts test/mcp.tools.test.ts
git commit -m "feat(mcp): the catalogue says what B and C added

apps, the way count, the fork verdict (its withheld reason verbatim),
recordings that started and dropped, and whether a person has taken the
prose over. An agent chooses from this list, so a disclosure that only
appears in the fetched file is a disclosure it never reads.

\`lines\` becomes exported \`habitLines\` so the search results Task 4 adds
render from the same function -- a disclosure lands in both surfaces or
in neither.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The two lanes, the fusion, and the corpus disclosure

The whole of `search_habits`' logic, with no reader and no tool — the dense lane arrives as a parameter, so every branch is reachable from the root suite without a model.

**Files:**
- Create: `app/src/main/mcp/habit-search.ts`
- Test: `test/mcp.habit-search.test.ts`

**Interfaces:**
- Consumes: `habitLines(s: HabitDTO, others: ReadonlyMap<string, HabitDTO>): string[]` and `renderHabitList(habits: HabitsDTO, noGraph: string): string` from `./habit-text.js`; `reciprocalRankFusion(lists: readonly RankedList[], k?: number): FusedItem[]` and `DEFAULT_RRF_K` from `deskrag`.
- Produces:
  - `export const RANKING_MIN_HABITS = 5`
  - `export interface HabitDoc { id: string; dense: string; lexical: string }`
  - `export function habitDocs(habits: readonly HabitDTO[]): HabitDoc[]`
  - `export function tokenize(text: string): string[]`
  - `export function bm25Ranking(docs: readonly HabitDoc[], query: string): string[]`
  - `export function cosine(a: Float32Array, b: Float32Array): number`
  - `export function denseRanking(ids: readonly string[], docVectors: readonly Float32Array[], queryVector: Float32Array): string[]`
  - `export type DenseLane = { kind: "ranked"; ids: string[] } | { kind: "skipped"; reason: string }`
  - `export interface HabitSearchInput { habits: HabitsDTO; query: string; limit: number; dense: DenseLane; noGraph: string }`
  - `export function renderHabitSearch(input: HabitSearchInput): string`

- [ ] **Step 1: Write the failing test**

Create `test/mcp.habit-search.test.ts`:

```ts
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
      "open", "the", "bug", "report", "14", "textedit", "doc",
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
    const out = render(corpus([habit(), habit({ id: "B2", slug: "b2" })]), "bug report", ranked([habit().id, "B2"]));
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
    const out = render(corpus([habit({ markdown: "calculator sum" })]), "calculator", skipped("no text model is downloaded"));
    expect(out).toMatch(/prose lane was skipped: no text model is downloaded/);
    expect(out).toMatch(/exact terms #1/);
    expect(out).not.toMatch(/prose #/);
  });

  it("says which emptiness it is when the skipped lane leaves nothing", () => {
    const out = render(corpus([habit({ markdown: "calculator sum" })]), "zzzz", skipped("no text model is downloaded"));
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/mcp.habit-search.test.ts`
Expected: FAIL — `Cannot find module '../app/src/main/mcp/habit-search.js'`.

- [ ] **Step 3: Write `habit-search.ts`**

Create `app/src/main/mcp/habit-search.ts`:

```ts
/**
 * `search_habits` — one habit for a situation, out of a corpus an agent should
 * not have to read whole.
 *
 * TWO LANES, fused by RANK, which is Tier 1's architecture at a smaller scale
 * and is chosen for the reason Tier 1 measured: on a default install the
 * lexical lane is the only route from a query to an exact term.
 *
 * The DENSE lane reads the AUTHORED half — title, description, prose, apps —
 * and not the whole file, for two measured reasons. Both pinned text models
 * truncate hard at 2,048 tokens against a ~1,583-token median composite, so
 * embedding the file is one long habit away from a document whose tail was
 * never seen. And a duplicate pair's RECORD blocks are byte-identical by
 * construction (`habit-text.ts` says so: both are re-rendered from the same
 * live route, which is what made them duplicates), so a vector over the record
 * cannot separate two habits the app already knows are two descriptions of one
 * procedure.
 *
 * The LEXICAL lane reads the whole markdown, which is where the exact terms the
 * dense lane dropped actually live — a button label, a URL, an app.
 *
 * Pure: no MCP SDK, no Electron, no store, no model. The dense lane arrives as
 * a parameter, so every branch below is reachable from the root suite.
 *
 * NO SCORE. Output is a rank plus which lanes a habit appeared in and where —
 * the `FrameEvidence` precedent, and the rule `search_experience` already
 * follows. A fused RRF value is not a confidence and is not comparable between
 * queries; an agent handed one reports a percentage to a user.
 */

import type { HabitDTO, HabitsDTO } from "@shared/types";
import { DEFAULT_RRF_K, reciprocalRankFusion, type RankedList } from "deskrag";
import { habitLines, renderHabitList } from "./habit-text.js";

/**
 * Below this many kept habits, the ranking is disclosed as barely a ranking.
 *
 * UNSWEPT, and it ships that way deliberately — the store it was written
 * against holds ONE kept habit, so only the `1 kept` branch can run on real
 * data. It joins the three floors C2 and C3 already ship unswept
 * (`RHYTHM_MIN_WALKS`/`RHYTHM_MIN_DAYS`, `FADE_MULTIPLE`/`FADE_FLOOR_MS`,
 * `FORK_VERDICT_MIN_WALKS`). C2's own spec prediction was falsified within six
 * days when the library grew; treat this number with the same suspicion.
 */
export const RANKING_MIN_HABITS = 5;

/** The two documents one habit contributes, one per lane. */
export interface HabitDoc {
  id: string;
  /** The AUTHORED half — what the dense lane embeds. */
  dense: string;
  /** The whole rendered file — what the lexical lane indexes. */
  lexical: string;
}

export function habitDocs(habits: readonly HabitDTO[]): HabitDoc[] {
  return habits.map((h) => ({
    id: h.id,
    dense: [h.title, h.description, h.body, h.apps.join(" ")]
      .filter((s) => s.trim() !== "")
      .join("\n\n"),
    lexical: h.markdown,
  }));
}

/** Lowercase alphanumeric runs. Single characters are dropped as noise. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

const K1 = 1.2;
const B = 0.75;

/**
 * BM25 over the whole markdown, in memory, best first.
 *
 * IN MEMORY and not an FTS table: habits are `AUTHORED_TABLES`, and a derived
 * table beside them would make "can a purge remake it?" a question with two
 * answers, for a corpus of tens of documents.
 *
 * Documents with NO query term are OMITTED, and that is the point — this lane's
 * membership is a signal, where the dense lane's is not.
 */
export function bm25Ranking(docs: readonly HabitDoc[], query: string): string[] {
  const terms = tokenize(query);
  if (terms.length === 0 || docs.length === 0) return [];

  const toks = docs.map((d) => tokenize(d.lexical));
  const total = toks.reduce((n, t) => n + t.length, 0);
  const avg = total === 0 ? 1 : total / toks.length;

  const df = new Map<string, number>();
  for (const t of toks) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);

  const scored = docs.map((d, i) => {
    const own = toks[i] ?? [];
    const tf = new Map<string, number>();
    for (const term of own) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const n = df.get(term) ?? 0;
      // Lucene's always-positive idf. Textbook BM25 is
      // log((N - n + 0.5) / (n + 0.5)), which goes NEGATIVE once a term appears
      // in more than half the documents — over a corpus of ten habits that is
      // any word two of them share, and a MATCH would subtract.
      const idf = Math.log(1 + (toks.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * own.length) / avg)));
    }
    return { id: d.id, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .map((s) => s.id);
}

/** 0 rather than NaN against a zero vector — an unembeddable habit is not a match. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Every id, closest first. This lane ranks everything, so its MEMBERSHIP says nothing — its rank does. */
export function denseRanking(
  ids: readonly string[],
  docVectors: readonly Float32Array[],
  queryVector: Float32Array,
): string[] {
  return ids
    .map((id, i) => ({ id, score: cosine(queryVector, docVectors[i] ?? new Float32Array(0)) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .map((s) => s.id);
}

/**
 * The dense lane, or the reason there isn't one.
 *
 * `reason` is REQUIRED on the skipped arm — the `Verdict.withheld` and
 * `StageSpec.skipReason` rule. A quietly lexical-only ranking is
 * indistinguishable from a working one.
 */
export type DenseLane = { kind: "ranked"; ids: string[] } | { kind: "skipped"; reason: string };

export interface HabitSearchInput {
  habits: HabitsDTO;
  query: string;
  limit: number;
  dense: DenseLane;
  /** `tools.ts`'s NO_GRAPH, passed in so the two cannot drift. */
  noGraph: string;
}

const LANE_PROSE = "prose";
const LANE_TERMS = "exact terms";

/** What "best first" is worth here, said once per response rather than implied by a number. */
function corpusNote(n: number): string {
  const relative =
    'Ranking is RELATIVE to this corpus: there is no score here, and the best match of any ' +
    'query comes first however weak it is. "matched in" names the lanes each habit appeared ' +
    "in, and its rank within that lane.";
  if (n === 1) {
    return (
      "There is 1 kept habit, so it is the only candidate below. Nothing was ranked against " +
      `it — this is not a match. ${relative}`
    );
  }
  if (n < RANKING_MIN_HABITS) {
    return (
      `Ranked among ${n} kept habits. A corpus this small ranks nearly everything, so read ` +
      `the disclosures on each before relying on the order. ${relative}`
    );
  }
  return `${n} kept habits, best first. ${relative}`;
}

/** Recurring routes nobody kept. Counted, never ranked: a proposal has no prose to match. */
function unkeptNote(habits: HabitsDTO): string {
  const repeated = habits.proposals.filter((p) => p.count > 1).length;
  if (repeated === 0) return "";
  return (
    `\n\n${repeated} recorded route${repeated === 1 ? " is" : "s are"} walked more than once ` +
    `but not kept as a habit, so ${repeated === 1 ? "it has" : "they have"} no prose and ` +
    `cannot be searched here. \`list_habits\` names ${repeated === 1 ? "it" : "them"}.`
  );
}

export function renderHabitSearch(input: HabitSearchInput): string {
  const kept = input.habits.habits.filter((h) => h.state !== "dismissed");
  // The three distinct emptinesses, reused rather than restated — "no graph",
  // "a graph with no routes" and "routes nobody kept" have different remedies.
  if (kept.length === 0) return renderHabitList(input.habits, input.noGraph);

  const docs = habitDocs(kept);
  const lexical = bm25Ranking(docs, input.query);

  const lanes: RankedList[] = [];
  if (lexical.length > 0) lanes.push({ key: LANE_TERMS, ids: lexical });
  if (input.dense.kind === "ranked" && input.dense.ids.length > 0) {
    lanes.push({ key: LANE_PROSE, ids: input.dense.ids });
  }

  const skipNote =
    input.dense.kind === "skipped"
      ? `The prose lane was skipped: ${input.dense.reason}. Only exact terms were matched.`
      : "";

  if (lanes.length === 0) {
    return (
      `No kept habit contains any of those terms` +
      (skipNote === "" ? "." : `, and ${skipNote.charAt(0).toLowerCase()}${skipNote.slice(1)}`) +
      ` \`list_habits\` prints all ${kept.length}.` +
      unkeptNote(input.habits)
    );
  }

  const byId = new Map(input.habits.habits.map((h) => [h.id, h]));
  const fused = reciprocalRankFusion(lanes, DEFAULT_RRF_K).slice(0, input.limit);

  const blocks = fused.map((item, i) => {
    const h = byId.get(item.id);
    if (h === undefined) return `${i + 1}. ${item.id}`;
    const block = habitLines(h, byId);
    const matched = [LANE_PROSE, LANE_TERMS]
      .filter((key) => item.ranks[key] !== undefined)
      .map((key) => `${key} #${item.ranks[key]}`)
      .join(", ");
    return [`${i + 1}. ${block[0] ?? h.title}`, ...block.slice(1), `  matched in: ${matched}`].join(
      "\n",
    );
  });

  const head = [corpusNote(kept.length), skipNote].filter((s) => s !== "").join("\n\n");
  return `${head}\n\n${blocks.join("\n\n")}${unkeptNote(input.habits)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/mcp.habit-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```
Expected: all green. `test/mcp.readonly.test.ts` must be green **without being edited** — the new file lives in `app/src/main/mcp/`, so its guard already covers it.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/mcp/habit-search.ts test/mcp.habit-search.test.ts
git commit -m "feat(mcp): two lanes over the habit corpus, and the corpus said first

Dense over the AUTHORED half, lexical over the whole file, fused by rank
at DEFAULT_RRF_K. The split is measured, not preferred: both pinned text
models truncate at 2048 against a ~1,583-token median composite, and a
duplicate pair's records are byte-identical by construction, so a vector
over the record cannot separate two habits the app already calls
duplicates. Exact terms live in the record, which is why the lexical lane
reads it.

BM25 uses Lucene's always-positive idf. The textbook form goes negative
past df > N/2 -- over ten habits that is any word two of them share, and
a MATCH would subtract.

The corpus is disclosed BEFORE the ranking, which is what lets this ship
against a one-habit store: at 1 it says outright that nothing was ranked.
RANKING_MIN_HABITS = 5 is UNSWEPT and says so, joining C2's two floors
and C3's one.

No score. Rank per lane, and the skipped lane states its reason.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The reader seam

Two reader methods and three service reads. Small, but it is the task where the guard's regex bites, so it is its own reviewable unit.

**Files:**
- Modify: `app/src/main/mcp/reader.ts`
- Modify: `app/src/main/deskrag-service.ts`
- Test: `test/mcp.readonly.test.ts` (one added assertion), `test/mcp.tools.test.ts` (`fakeReader`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, on `ExperienceReader`:
  - `embed(texts: string[], role: "document" | "query"): Promise<Float32Array[] | null>`
  - `momentAt(sessionId: string, atSec: number): StepMoment | null`
  - `export interface RegionView { role: string | null; label: string | null; bbox: { x: number; y: number; w: number; h: number } }`
  - `export interface StepMoment { frameId: string; offsetSec: number; after: boolean; regions: RegionView[] }`

  On `ServiceReads`:
  - `embedTexts(texts: string[], role: "document" | "query"): Promise<Float32Array[]>`
  - `sessionDetail(sessionId: string): SessionDetailDTO | null`
  - `frameRegions(frameId: string): RegionRow[]`

- [ ] **Step 1: Write the failing test**

Add to `test/mcp.readonly.test.ts`, inside `describe("the reader's interfaces are the read-only contract", ...)`:

```ts
  it("declares the two methods the habit tools read through", () => {
    // Named, because their ABSENCE is what a future refactor would produce and
    // the tools would then fail at runtime rather than at typecheck.
    const src = read("reader.ts");
    const iface = /export interface ExperienceReader \{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(iface!).toMatch(/\bembed\(/);
    expect(iface!).toMatch(/\bmomentAt\(/);
  });

  it("names the embedder's parameter something other than `inputs`", () => {
    // `EmbeddingProvider.embed(inputs: string[])` cannot be mirrored verbatim:
    // the guard above has no word boundaries, so `inPUTs` matches `put` and the
    // whole interface fails. Likewise no inline `startedAt`, which matches
    // `start`. This asserts the trap stays sprung rather than silently loosened.
    const src = read("reader.ts");
    const iface = /export interface ExperienceReader \{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(iface!).not.toMatch(/inputs/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/mcp.readonly.test.ts`
Expected: FAIL — `embed(` and `momentAt(` are not in the interface.

- [ ] **Step 3: Widen the reader and the service**

In `app/src/main/mcp/reader.ts`, add above `export interface ExperienceReader`:

```ts
/**
 * One labelled box on a step's keyframe.
 *
 * A DEDICATED type rather than `HighlightDTO`: a highlight is QUERY-relative and
 * carries a `strength`, and there is no query here. Every box below draws solid.
 */
export interface RegionView {
  role: string | null;
  label: string | null;
  bbox: { x: number; y: number; w: number; h: number };
}

/**
 * The keyframe chosen for a step, and what was on it.
 *
 * DECLARED OUT HERE, not inline in the interface below. `test/mcp.readonly.test.ts`
 * matches the interface BODY against `/…|start|…/i` with no word boundaries, so a
 * field named `startedAt` written inline would fail the read-only guard for a
 * reason that has nothing to do with reading or writing.
 */
export interface StepMoment {
  frameId: string;
  /** LANE seconds, the axis every cross-screen jump is expressed in. */
  offsetSec: number;
  /**
   * True when the step's second preceded the recording's first keyframe and the
   * EARLIEST was taken instead. The pick is otherwise at-or-before.
   */
  after: boolean;
  regions: RegionView[];
}
```

Add to the `ExperienceReader` interface body, after `habits(): HabitsDTO;`:

```ts
  /**
   * Embed for the habit search's dense lane, or null when no text model is ready.
   *
   * NULL rather than a throw, so the caller branches on a value and can say the
   * lane was skipped and why. The parameter is `texts` and NOT `inputs` —
   * `inPUTs` matches the read-only guard's `put`.
   */
  embed(texts: string[], role: "document" | "query"): Promise<Float32Array[] | null>;
  /**
   * The keyframe at or before a lane second, with its labelled regions.
   *
   * At-or-before because a step is an EDGE: its actions want the screen as it
   * was when they began, which is the rule `regionsAt` follows. Null when the
   * recording has no keyframes at all.
   */
  momentAt(sessionId: string, atSec: number): StepMoment | null;
```

Add to the `ServiceReads` interface body:

```ts
  embedTexts(texts: string[], role: "document" | "query"): Promise<Float32Array[]>;
  sessionDetail(sessionId: string): SessionDetailDTO | null;
  frameRegions(frameId: string): RegionRow[];
```

Extend the type imports at the top of `reader.ts`:

```ts
import type {
  FlowsDTO,
  HighlightDTO,
  ResultDetailDTO,
  SearchResultDTO,
  SessionDetailDTO,
  SessionSummaryDTO,
  HabitsDTO,
} from "@shared/types";
import type { BlobRow, RegionRow, SegmentRow, SegmentSummaryRow } from "deskrag";
```

Add to `ServiceExperienceReader`:

```ts
  async embed(texts: string[], role: "document" | "query"): Promise<Float32Array[] | null> {
    // The model is a download and the ONNX host may not be up. Both are ordinary
    // states, not crashes: the caller turns a null into a stated skip, where a
    // thrown error would reach the agent as a failed request with no remedy.
    try {
      return await this.service.embedTexts(texts, role);
    } catch {
      return null;
    }
  }

  momentAt(sessionId: string, atSec: number): StepMoment | null {
    const detail = this.service.sessionDetail(sessionId);
    if (detail === null || detail.keyframes.length === 0) return null;
    // Scanned rather than assumed sorted — order-independent, and the cost is
    // one pass over a list the Library already draws in full.
    let pick: (typeof detail.keyframes)[number] | null = null;
    let earliest = detail.keyframes[0]!;
    for (const k of detail.keyframes) {
      if (k.offsetSec < earliest.offsetSec) earliest = k;
      if (k.offsetSec <= atSec + 1e-6 && (pick === null || k.offsetSec > pick.offsetSec)) pick = k;
    }
    const chosen = pick ?? earliest;
    return {
      frameId: chosen.frameId,
      offsetSec: chosen.offsetSec,
      after: pick === null,
      regions: this.service.frameRegions(chosen.frameId).map((r) => ({
        role: r.role,
        label: r.label,
        bbox: { x: r.x, y: r.y, w: r.w, h: r.h },
      })),
    };
  }
```

In `app/src/main/deskrag-service.ts`, add two methods beside `frameBlobId` (around line 1674):

```ts
  /**
   * Embed arbitrary text with the configured text model.
   *
   * Builds providers per call, exactly as `searchDetached` does — the ONNX
   * session is cached by `this.onnx`, and a cached provider would go stale the
   * moment the model setting changed. Throws when no model is available; the
   * MCP reader turns that into a stated skip.
   */
  async embedTexts(texts: string[], role: "document" | "query"): Promise<Float32Array[]> {
    const prov = await this.buildProviders();
    return prov.textEmbedder.embed(texts, { role });
  }

  /** Every proposed region on one frame. A read; the highlighter is not involved. */
  frameRegions(frameId: string): RegionRow[] {
    return this.store.getRegionsByFrame(frameId);
  }
```

Import `RegionRow` as a type in `deskrag-service.ts` if it is not already imported from `deskrag`.

Finally, in `test/mcp.tools.test.ts`, add the two methods to `fakeReader`'s defaults, right after `flows: () => flows(),`:

```ts
    embed: async () => null,
    momentAt: () => null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/mcp.readonly.test.ts test/mcp.tools.test.ts`
Expected: PASS. If the read-only guard fails on the interface body, a new name matched `record(`/`delete`/`remove`/`start`/`stop`/`arm`/`execute`/`write`/`put`/`set` — rename it; do not edit the guard.

- [ ] **Step 5: Run the gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/mcp/reader.ts app/src/main/deskrag-service.ts test/mcp.readonly.test.ts test/mcp.tools.test.ts
git commit -m "feat(mcp): the reader learns to embed and to find a step's screen

Two methods, and both were shaped by the guard rather than by taste.
\`embed\` takes \`texts\` and not \`inputs\` because the read-only assertion
runs over the interface BODY with no word boundaries, so inPUTs matches
\`put\`; StepMoment is declared outside the interface for the same reason,
since an inline \`startedAt\` matches \`start\`. Both traps now have their
own assertion so they stay sprung.

\`embed\` returns null rather than throwing: an absent model is an ordinary
state that has to reach the agent as a stated skip, not a failed request.

\`momentAt\` picks the keyframe AT OR BEFORE the step's second -- a step is
an edge, and its actions want the screen as it was when they began, which
is the rule regionsAt follows. When the second precedes the first
keyframe it takes the earliest and says so.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `search_habits`

**Files:**
- Modify: `app/src/main/mcp/tools.ts`
- Test: `test/mcp.tools.test.ts`

**Interfaces:**
- Consumes: `renderHabitSearch`, `habitDocs`, `denseRanking`, `type DenseLane` from `./habit-search.js`; `reader.embed(texts, role)` from Task 3.
- Produces: a tool named `search_habits` in `TOOLS`.

- [ ] **Step 1: Write the failing test**

Add to `test/mcp.tools.test.ts`. First update the surface assertion:

```ts
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
```

That assertion will not pass until Task 6. Until then it is the plan's own tracking of where the surface is going; run the new `search_habits` describe block on its own in steps 2 and 4 of this task.

Then add:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/mcp.tools.test.ts -t "search_habits"`
Expected: FAIL — `No such tool: search_habits`.

- [ ] **Step 3: Add the tool**

In `app/src/main/mcp/tools.ts`, add the import:

```ts
import {
  denseRanking,
  habitDocs,
  renderHabitSearch,
  type DenseLane,
} from "./habit-search.js";
```

Add the tool, after `listHabitsTool`:

```ts
const searchHabitsTool: ToolDef = {
  name: "search_habits",
  title: "Find a kept habit for a situation",
  description:
    "Find the kept habits that best fit a situation, described in your own words. Use this " +
    "before repeating work the user may already have a recorded procedure for — it is the " +
    "cheap way in, where list_habits makes you read the whole catalogue. Two lanes are " +
    "matched: the habit's own description and prose, and the exact terms in its recorded " +
    "steps. There is no score; the reply names which lanes each habit appeared in and how " +
    "many habits it was ranked among.",
  inputSchema: {
    type: "object",
    properties: {
      situation: {
        type: "string",
        description: "What you are about to do, in your own words.",
      },
      limit: { type: "number", description: "How many to return. Default 8, max 50." },
    },
    required: ["situation"],
    additionalProperties: false,
  },
  async run(reader, args) {
    const situation = str(args, "situation");
    if (situation === null) {
      return fail("`situation` is required and must be a non-empty string.");
    }
    const habits = reader.habits();
    const kept = habits.habits.filter((h) => h.state !== "dismissed");
    const docs = habitDocs(kept);

    let dense: DenseLane = { kind: "skipped", reason: "there are no habits to embed" };
    if (docs.length > 0) {
      // One call for the documents and the query together, so both go through
      // the same session — and the ROLE differs, because nomic and
      // EmbeddingGemma are both asymmetric and degrade quietly without their
      // task prefixes.
      const docVectors = await reader.embed(
        docs.map((d) => d.dense),
        "document",
      );
      const queryVectors = await reader.embed([situation], "query");
      const queryVector = queryVectors?.[0];
      if (docVectors === null || queryVectors === null || queryVector === undefined) {
        dense = {
          kind: "skipped",
          reason:
            "no local text model answered — open DeskRAG → Settings → Providers and check the text model has downloaded",
        };
      } else if (docVectors.length !== docs.length) {
        // Fewer vectors than documents would mis-pair habit to vector by
        // position, and every rank past the gap would name the wrong habit.
        dense = {
          kind: "skipped",
          reason: `the text model returned ${docVectors.length} vectors for ${docs.length} habits`,
        };
      } else {
        dense = {
          kind: "ranked",
          ids: denseRanking(
            docs.map((d) => d.id),
            docVectors,
            queryVector,
          ),
        };
      }
    }

    return text(
      renderHabitSearch({
        habits,
        query: situation,
        limit: limitOf(args),
        dense,
        noGraph: NO_GRAPH,
      }),
    );
  },
};
```

Add `searchHabitsTool` to `TOOLS`, after `listHabitsTool`.

Update `SERVER_INSTRUCTIONS` — replace the `list_habits/get_habit` sentence with:

```
list_habits/get_habit return HABIT.md files the user has kept from their own recorded flows — \
use one when you are about to repeat something they have done before, and search_habits finds \
the right one from a description of your situation. get_habit_step shows what one step of a \
habit actually looked like on screen, and get_habit_steps returns its steps as JSON.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/mcp.tools.test.ts -t "search_habits"`
Expected: PASS. The "eleven read-only tools" assertion still fails; it is completed in Task 6.

- [ ] **Step 5: Run the gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```
Expected: `npm test` reports exactly one failure — the eleven-tools assertion, which Task 6 completes. Both typechecks green.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/mcp/tools.ts test/mcp.tools.test.ts
git commit -m "feat(mcp): search_habits, and the name the guard chose

Not find_habit: test/mcp.readonly.test.ts requires ^(search|get|list)_,
which is what makes an acting tool impossible to add by accident.
Widening the prefix rule for a nicer word would trade a structural
property for prose.

Documents and query embed with DIFFERENT roles -- nomic and
EmbeddingGemma are both asymmetric and degrade quietly without their task
prefixes. A vector count that disagrees with the document count SKIPS the
lane rather than pairing by position, because a silent mis-pairing names
the wrong habit at every rank past the gap.

The eleven-tools assertion is deliberately red until get_habit_step and
get_habit_steps land.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `get_habit_step` — one step, and what it looked like

**Files:**
- Create: `app/src/main/mcp/habit-step.ts`
- Modify: `app/src/main/mcp/tools.ts`
- Test: `test/mcp.habit-step.test.ts`

**Interfaces:**
- Consumes: `StepMoment`, `RegionView` from `./reader.js` (Task 3).
- Produces:
  - `export type StepAddress = { kind: "found"; wayLetter: string; step: HabitStepDTO; manyWays: boolean } | { kind: "error"; message: string }`
  - `export function resolveStep(habit: HabitDTO, step: number, way: string | null): StepAddress`
  - `export interface StepRenderInput { habit: HabitDTO; wayLetter: string; manyWays: boolean; step: HabitStepDTO; moment: StepMoment | null }`
  - `export function renderStep(input: StepRenderInput): string`

- [ ] **Step 1: Write the failing test**

Create `test/mcp.habit-step.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderStep, resolveStep } from "../app/src/main/mcp/habit-step.js";
import type { StepMoment } from "../app/src/main/mcp/reader.js";
import type { HabitDTO, HabitStepDTO, HabitWayDTO } from "@shared/types";

const EPOCH = 1_754_000_000_000;

const step = (over: Partial<HabitStepDTO> = {}): HabitStepDTO => ({
  index: 0,
  edgeId: "e0",
  from: "Calculator",
  to: "TextEdit",
  actions: [{ action: "click", target: 'Button "="' }],
  observations: 2,
  everyRecording: true,
  missing: false,
  liftWarnings: [],
  firstAt: { sessionId: "s1", startedAt: EPOCH, atSec: 22.157 },
  ...over,
});

const way = (letter: string, steps: HabitStepDTO[]): HabitWayDTO => ({
  letter,
  sessionIds: ["s1"],
  steps,
  totalsMs: [39_300],
});

const habit = (ways: HabitWayDTO[]): HabitDTO =>
  ({
    id: "01HABIT",
    state: "active",
    pinned: false,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    version: "0.1.0",
    history: [],
    duplicates: [],
    ways,
    fork: null,
    droppedEarly: [],
    apps: ["Calculator", "TextEdit"],
    slug: "add-up-and-note",
    title: "Add up and note the total",
    description: "",
    body: "",
    bodySource: "template",
    bodyModel: null,
    edited: false,
    showSamples: false,
    generateNote: null,
    markdown: "---\n---\n",
    binding: {
      state: "exact",
      routeKey: "Calculator → TextEdit",
      liveRouteKey: "Calculator → TextEdit",
      routeLabel: "Calculator → TextEdit",
      boundAt: EPOCH,
      boundSessionIds: ["s1"],
      overlap: 1,
      lostSessionIds: [],
      gainedSessionIds: [],
      recordings: 1,
      candidates: [],
      note: null,
      walks: [],
    },
  }) as HabitDTO;

const oneWay = habit([way("A", [step(), step({ index: 1, edgeId: "e1" })])]);
const twoWays = habit([way("A", [step()]), way("B", [step({ edgeId: "eB" })])]);

describe("resolveStep", () => {
  it("finds a step by its printed number when there is one way", () => {
    const r = resolveStep(oneWay, 2, null);
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.step.edgeId).toBe("e1");
    expect(r.wayLetter).toBe("A");
    expect(r.manyWays).toBe(false);
  });

  it("refuses a way letter when the recordings agreed", () => {
    const r = resolveStep(oneWay, 1, "B");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toMatch(/one recorded way/);
  });

  it("refuses to guess when there are several ways", () => {
    // Defaulting to A would answer about a different path than the agent read,
    // and the file it read prints the letters.
    const r = resolveStep(twoWays, 1, null);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toMatch(/`way` is required/);
    expect(r.message).toMatch(/A, B/);
  });

  it("names the letters it has when given one it does not", () => {
    const r = resolveStep(twoWays, 1, "Q");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toMatch(/No way Q/);
    expect(r.message).toMatch(/A, B/);
  });

  it("accepts a lowercase letter", () => {
    expect(resolveStep(twoWays, 1, "b").kind).toBe("found");
  });

  it("says how many steps a way has when the number is out of range", () => {
    const r = resolveStep(oneWay, 5, null);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toMatch(/has 2 steps/);
  });

  it("refuses an orphaned habit with the reason, not a stale snapshot", () => {
    const r = resolveStep(habit([]), 1, null);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toMatch(/no longer in the trace graph/);
  });
});

describe("renderStep", () => {
  const moment = (over: Partial<StepMoment> = {}): StepMoment => ({
    frameId: "f1",
    offsetSec: 22.0,
    after: false,
    regions: [
      { role: "Button", label: "=", bbox: { x: 10, y: 20, w: 30, h: 40 } },
      { role: "TextField", label: null, bbox: { x: 0, y: 0, w: 100, h: 20 } },
    ],
    ...over,
  });

  it("prints the step, its actions and where the evidence came from", () => {
    const out = renderStep({
      habit: oneWay,
      wayLetter: "A",
      manyWays: false,
      step: step(),
      moment: moment(),
    });
    expect(out).toMatch(/Step 1 of 2/);
    expect(out).toMatch(/Calculator → TextEdit/);
    expect(out).toMatch(/click.*Button "="/);
    expect(out).toMatch(/walked by 2 recordings/);
    expect(out).toMatch(/s1/);
  });

  it("names the way only when there is more than one", () => {
    expect(
      renderStep({ habit: twoWays, wayLetter: "B", manyWays: true, step: step(), moment: null }),
    ).toMatch(/Way B/);
    expect(
      renderStep({ habit: oneWay, wayLetter: "A", manyWays: false, step: step(), moment: null }),
    ).not.toMatch(/Way A/);
  });

  it("labels the regions and counts the unlabelled ones", () => {
    const out = renderStep({
      habit: oneWay,
      wayLetter: "A",
      manyWays: false,
      step: step(),
      moment: moment(),
    });
    expect(out).toMatch(/Button "="/);
    expect(out).toMatch(/1 further region/);
  });

  it("discloses a keyframe taken after the step rather than before it", () => {
    const out = renderStep({
      habit: oneWay,
      wayLetter: "A",
      manyWays: false,
      step: step(),
      moment: moment({ after: true, offsetSec: 25 }),
    });
    expect(out).toMatch(/AFTER/);
  });

  it("states the reason when a step has no moment to open", () => {
    const out = renderStep({
      habit: oneWay,
      wayLetter: "A",
      manyWays: false,
      step: step({ firstAt: null }),
      moment: null,
    });
    expect(out).toMatch(/carries no recording sources/);
  });

  it("states the reason when the recording has no keyframe", () => {
    const out = renderStep({
      habit: oneWay,
      wayLetter: "A",
      manyWays: false,
      step: step(),
      moment: null,
    });
    expect(out).toMatch(/no keyframe/);
  });

  it("says a step not every recording took is exactly that", () => {
    const out = renderStep({
      habit: oneWay,
      wayLetter: "A",
      manyWays: false,
      step: step({ everyRecording: false, observations: 1 }),
      moment: null,
    });
    expect(out).toMatch(/Not every recording took this step/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/mcp.habit-step.test.ts`
Expected: FAIL — `Cannot find module '../app/src/main/mcp/habit-step.js'`. It will also fail to typecheck `liftWarnings` on `HabitStepDTO`; Step 3 adds that field.

- [ ] **Step 3: Widen `HabitStepDTO`, then write `habit-step.ts`**

First, in `app/src/shared/types.ts`, inside `HabitStepDTO`, change the actions field and add `liftWarnings`:

```ts
  /**
   * The recorded actions.
   *
   * The slot's NAME travels; its SAMPLES never do. `habit-marks.ts` states the
   * rule: whether the rendered FILE prints recorded values is a per-habit
   * toggle, and a DTO has no toggle — so it carries no values at all. A name is
   * not a value, and the record prints names unconditionally.
   */
  actions: { action: string; target: string; slot?: { name: string } }[];
  /** What lifting could not do here, e.g. a dropped wait. */
  liftWarnings: string[];
```

In `app/src/main/habit-marks.ts`, update `toStep`:

```ts
    actions: step.actions.map((a) => ({
      action: a.action,
      target: a.target,
      // `exactOptionalPropertyTypes` — a conditional spread, never `slot: undefined`.
      ...(a.slot !== undefined ? { slot: { name: a.slot.name } } : {}),
    })),
    liftWarnings: [...step.liftWarnings],
```

Then create `app/src/main/mcp/habit-step.ts`:

```ts
/**
 * `get_habit_step` — one step of a habit, and what was on screen when it ran.
 *
 * An agent following a HABIT.md and stuck at step 4 has nowhere to look: the
 * file says `Calculator — no state → TextEdit — Untitled` and nothing shows
 * what that was. This is the look.
 *
 * ADDRESSED THE WAY THE FILE PRINTS IT. `recordedBlocks` numbers steps 1., 2., …
 * with no letter when the recordings agreed, and restarts numbering under
 * `### Way A` / `### Way B` when they did not. So `step` is 1-based and `way` is
 * a letter — and the letter is REQUIRED once there is more than one way, because
 * defaulting to A would answer about a different path than the agent just read.
 *
 * Pure: no store, no image bytes. `tools.ts` fetches the keyframe.
 */

import type { HabitDTO, HabitStepDTO } from "@shared/types";
import type { StepMoment } from "./reader.js";

export type StepAddress =
  | { kind: "found"; wayLetter: string; step: HabitStepDTO; manyWays: boolean }
  | { kind: "error"; message: string };

const letters = (habit: HabitDTO): string => habit.ways.map((w) => w.letter).join(", ");

export function resolveStep(habit: HabitDTO, step: number, way: string | null): StepAddress {
  if (habit.ways.length === 0) {
    // An orphaned habit's steps exist only as a stored copy inside the rendered
    // markdown. Answering from that copy would present unverified steps as
    // current, so this refuses and says which situation it is.
    return {
      kind: "error",
      message:
        `Habit ${habit.id} has no live steps: the route it was written from is no longer in ` +
        "the trace graph, so nothing can be looked up against a recording. `get_habit` still " +
        "returns the file, whose steps are a stored copy that has not been re-checked.",
    };
  }

  const manyWays = habit.ways.length > 1;
  let chosen = habit.ways[0]!;
  if (way !== null) {
    if (!manyWays) {
      return {
        kind: "error",
        message:
          `Habit ${habit.id} has one recorded way, so it takes no \`way\` letter — the file ` +
          "prints its steps unlettered. Omit `way`.",
      };
    }
    const found = habit.ways.find((w) => w.letter.toLowerCase() === way.toLowerCase());
    if (found === undefined) {
      return { kind: "error", message: `No way ${way} on habit ${habit.id}. It has: ${letters(habit)}.` };
    }
    chosen = found;
  } else if (manyWays) {
    return {
      kind: "error",
      message:
        `\`way\` is required: habit ${habit.id} has ${habit.ways.length} recorded ways ` +
        `(${letters(habit)}) and they are different procedures, not one procedure with ` +
        "options. Pick the way whose steps you are following.",
    };
  }

  const found = chosen.steps[step - 1];
  if (found === undefined) {
    return {
      kind: "error",
      message:
        `No step ${step}${manyWays ? ` on way ${chosen.letter}` : ""}: it has ` +
        `${chosen.steps.length} step${chosen.steps.length === 1 ? "" : "s"}, numbered from 1.`,
    };
  }
  return { kind: "found", wayLetter: chosen.letter, step: found, manyWays };
}

const stamp = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

export interface StepRenderInput {
  habit: HabitDTO;
  wayLetter: string;
  manyWays: boolean;
  step: HabitStepDTO;
  /** Null when the step has no sources, or the recording has no keyframes. */
  moment: StepMoment | null;
}

export function renderStep(input: StepRenderInput): string {
  const { habit, step, moment } = input;
  const way = habit.ways.find((w) => w.letter === input.wayLetter);
  const total = way?.steps.length ?? 0;
  const out: string[] = [];

  out.push(
    `${habit.slug === "" ? habit.title : habit.slug} — Step ${step.index + 1} of ${total}` +
      (input.manyWays ? `, Way ${input.wayLetter}` : ""),
  );
  out.push("");

  if (step.missing) {
    out.push(
      `This step's edge \`${step.edgeId}\` is not in the trace graph — an index defect. It is ` +
        "carried rather than dropped, because omitting it would make the procedure read as " +
        "shorter than it was.",
    );
    return out.join("\n");
  }

  out.push(`${step.from} → ${step.to}`);
  if (step.actions.length === 0) {
    out.push("  (no actions recorded on this edge)");
  }
  for (const a of step.actions) {
    const target = a.target === "—" || a.target === "" ? "" : ` — ${a.target}`;
    const slot = a.slot === undefined ? "" : ` (slot \`${a.slot.name}\`; recorded values are not carried here)`;
    out.push(`  \`${a.action}\`${target}${slot}`);
  }
  for (const w of step.liftWarnings) out.push(`  NOTE: ${w}`);
  out.push("");

  out.push(
    step.observations === 1 ? "Walked once." : `Walked by ${step.observations} recordings.`,
  );
  if (!step.everyRecording) {
    // The honest replacement for a success rate: TraceEdge.outcomes is {0,0} on
    // every graph on disk, so "this step sometimes failed" has no data behind it.
    out.push(
      "Not every recording took this step — fewer recordings walked it than walked the whole route.",
    );
  }

  if (step.firstAt === null) {
    out.push(
      "This step carries no recording sources, so there is no moment to open. A graph lifted " +
        "before provenance was captured has none, and deleting a recording removes its sources.",
    );
    return out.join("\n");
  }

  out.push(
    `First walked at ${stamp(step.firstAt.atSec)} into recording ${step.firstAt.sessionId}.`,
  );

  if (moment === null) {
    out.push(
      "That recording has no keyframe, so there is nothing to show — Screen capture was off, " +
        "or the recording predates keyframe capture.",
    );
    return out.join("\n");
  }

  out.push("");
  out.push(
    moment.after
      ? `The screenshot below is the recording's FIRST keyframe, at ${stamp(moment.offsetSec)} — ` +
          "AFTER this step began, because the step starts before the video's first frame."
      : `The screenshot below is the screen at ${stamp(moment.offsetSec)}, the last keyframe at ` +
          "or before this step began.",
  );

  const labelled = moment.regions.filter((r) => r.label !== null && r.label !== "");
  if (labelled.length > 0) {
    out.push("");
    out.push("On screen (from the accessibility tree, at this moment):");
    for (const r of labelled) {
      out.push(
        `  ${r.role ?? "element"} "${r.label}" at ${Math.round(r.bbox.x)},${Math.round(r.bbox.y)} ` +
          `${Math.round(r.bbox.w)}×${Math.round(r.bbox.h)}`,
      );
    }
  }
  const unlabelled = moment.regions.length - labelled.length;
  if (unlabelled > 0) {
    out.push(
      `  …and ${unlabelled} further region${unlabelled === 1 ? "" : "s"} with no label.`,
    );
  }
  out.push("");
  out.push(`frameId: ${moment.frameId}  — pass to get_moment for this frame on its own`);
  return out.join("\n");
}
```

- [ ] **Step 4: Add the tool**

In `app/src/main/mcp/tools.ts`, add the import and the tool:

```ts
import { renderStep, resolveStep } from "./habit-step.js";
```

```ts
const getHabitStepTool: ToolDef = {
  name: "get_habit_step",
  title: "Look at one step of a habit",
  description:
    "One step of a kept habit, as text plus the screenshot of what was on screen when it ran " +
    "and the accessibility labels visible at that moment. Use it when you are following a " +
    "HABIT.md and a step does not tell you enough. `step` is the number the file prints, " +
    "counting from 1; `way` is the letter, and is required for a habit whose recordings took " +
    "different paths.",
  inputSchema: {
    type: "object",
    properties: {
      habitId: { type: "string", description: "A habit id from list_habits or search_habits." },
      step: { type: "number", description: "The step number the file prints, from 1." },
      way: { type: "string", description: "The way letter, e.g. \"A\". Required for a multi-way habit." },
    },
    required: ["habitId", "step"],
    additionalProperties: false,
  },
  async run(reader, args) {
    const habitId = str(args, "habitId");
    if (habitId === null) return fail("`habitId` is required and must be a non-empty string.");
    const stepNo = args["step"];
    if (typeof stepNo !== "number" || !Number.isFinite(stepNo) || stepNo < 1) {
      return fail("`step` is required and must be a number of 1 or more.");
    }
    const habit = findHabit(reader.habits(), habitId);
    if (habit === undefined) {
      return fail(`No habit ${habitId}. Habit ids come from list_habits.`);
    }
    const found = resolveStep(habit, Math.floor(stepNo), str(args, "way"));
    if (found.kind === "error") return fail(found.message);

    const at = found.step.firstAt;
    const moment = at === null ? null : reader.momentAt(at.sessionId, at.atSec);
    const body = renderStep({
      habit,
      wayLetter: found.wayLetter,
      manyWays: found.manyWays,
      step: found.step,
      moment,
    });
    if (moment === null) return text(body);

    const image = await reader.frameImage(moment.frameId);
    if (image === null) return text(body);
    return {
      content: [
        { type: "text", text: body },
        { type: "image", data: image.base64, mimeType: image.mimeType },
      ],
    };
  },
};
```

Add `getHabitStepTool` to `TOOLS`, after `searchHabitsTool`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/mcp.habit-step.test.ts`
Expected: PASS.

Then add to `test/mcp.tools.test.ts`, so the tool is exercised through `callTool` too:

```ts
describe("get_habit_step", () => {
  it("refuses a habit with no live route, and says which situation it is", async () => {
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit()] }),
      "get_habit_step",
      { habitId: habit().id, step: 1 },
    );
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/no longer in the trace graph/);
  });

  it("returns the step and its keyframe as an image", async () => {
    const ways = [
      {
        letter: "A",
        sessionIds: ["s1"],
        totalsMs: [39_300],
        steps: [
          {
            index: 0,
            edgeId: "e0",
            from: "Calculator",
            to: "TextEdit",
            actions: [{ action: "click", target: 'Button "="' }],
            observations: 2,
            everyRecording: true,
            missing: false,
            liftWarnings: [],
            firstAt: { sessionId: "s1", startedAt: EPOCH, atSec: 22.157 },
          },
        ],
      },
    ];
    const reader = fakeReader({
      habits: () => ({ ...noHabits(), habits: [habit({ ways })] }),
      momentAt: () => ({
        frameId: "f1",
        offsetSec: 22,
        after: false,
        regions: [{ role: "Button", label: "=", bbox: { x: 1, y: 2, w: 3, h: 4 } }],
      }),
    });
    const out = await callTool(reader, "get_habit_step", { habitId: habit().id, step: 1 });
    expect(out.isError).toBeUndefined();
    expect(textOf(out)).toMatch(/Calculator → TextEdit/);
    expect(out.content.some((c) => c.type === "image")).toBe(true);
  });

  it("requires a step number of 1 or more", async () => {
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit()] }),
      "get_habit_step",
      { habitId: habit().id, step: 0 },
    );
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/must be a number of 1 or more/);
  });
});
```

Run: `npx vitest run test/mcp.tools.test.ts -t "get_habit_step"`
Expected: PASS.

- [ ] **Step 6: Run the gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```
Expected: one remaining failure, the eleven-tools assertion. Both typechecks green.

- [ ] **Step 7: Commit**

```bash
git add app/src/shared/types.ts app/src/main/habit-marks.ts app/src/main/mcp/habit-step.ts app/src/main/mcp/tools.ts test/mcp.habit-step.test.ts test/mcp.tools.test.ts
git commit -m "feat(mcp): get_habit_step, so a stuck agent has somewhere to look

Addressed the way the file prints it: 1-based, and the way letter is
REQUIRED once there is more than one way. Defaulting to A would answer
about a different path than the agent just read, and the file it read
prints the letters.

The keyframe is the last one AT OR BEFORE the step's second, because a
step is an edge and its actions want the screen as it was when they
began -- the regionsAt rule. A step that begins before the video's first
frame gets the earliest keyframe and the reply says AFTER.

Six distinct refusals, each stating its own situation: orphaned, a letter
where none is taken, no letter where one is needed, an unknown letter, a
number out of range, and a step with no sources. A single \"not found\"
would send an agent to the wrong remedy.

HabitStepDTO gains the slot NAME and liftWarnings. Never the samples --
habit-marks.ts's rule holds: a DTO has no toggle, so it carries no values.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `get_habit_steps` — the `steps.json` sibling

**Files:**
- Create: `app/src/main/mcp/habit-steps-json.ts`
- Modify: `app/src/main/mcp/tools.ts`
- Test: `test/mcp.habit-steps-json.test.ts`, `test/mcp.tools.test.ts`

**Interfaces:**
- Consumes: `HabitDTO`, `FlowsDTO` from `@shared/types`.
- Produces: `export function habitStepsJson(habit: HabitDTO, flows: FlowsDTO | null): string | { error: string }`

- [ ] **Step 1: Write the failing test**

Create `test/mcp.habit-steps-json.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { habitStepsJson } from "../app/src/main/mcp/habit-steps-json.js";
import type { FlowsDTO, HabitDTO, HabitWayDTO } from "@shared/types";

const EPOCH = 1_754_000_000_000;
const SECRET = "hunter2-do-not-leak";

const ways: HabitWayDTO[] = [
  {
    letter: "A",
    sessionIds: ["s1"],
    totalsMs: [39_300],
    steps: [
      {
        index: 0,
        edgeId: "e0",
        from: "Calculator",
        to: "TextEdit",
        actions: [
          { action: "click", target: 'Button "="' },
          { action: "type", target: "slot textarea", slot: { name: "textarea" } },
        ],
        observations: 2,
        everyRecording: true,
        missing: false,
        liftWarnings: ["a wait was dropped"],
        firstAt: { sessionId: "s1", startedAt: EPOCH, atSec: 22.157 },
      },
      {
        index: 1,
        edgeId: "gone",
        from: "TextEdit",
        to: "TextEdit",
        actions: [],
        observations: 1,
        everyRecording: false,
        missing: true,
        liftWarnings: [],
        firstAt: null,
      },
    ],
  },
];

const habit = (over: Partial<HabitDTO> = {}): HabitDTO =>
  ({
    id: "01HABIT",
    state: "active",
    pinned: false,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    version: "0.1.4",
    history: [],
    duplicates: [],
    ways,
    fork: null,
    droppedEarly: [],
    apps: ["Calculator", "TextEdit"],
    slug: "add-up-and-note",
    title: "Add up and note the total",
    description: "",
    // The record only prints values with showSamples on, so a leak would most
    // plausibly arrive through the rendered markdown.
    body: "",
    bodySource: "template",
    bodyModel: null,
    edited: false,
    showSamples: true,
    generateNote: null,
    markdown: `---\n---\n\nsamples: ${SECRET}\n`,
    binding: {
      state: "exact",
      routeKey: "Calculator → TextEdit",
      liveRouteKey: "Calculator → TextEdit",
      routeLabel: "Calculator → TextEdit",
      boundAt: EPOCH,
      boundSessionIds: ["s1"],
      overlap: 1,
      lostSessionIds: [],
      gainedSessionIds: [],
      recordings: 1,
      candidates: [],
      note: null,
      walks: [],
    },
    ...over,
  }) as HabitDTO;

const flows = (): FlowsDTO => ({
  graph: {
    id: "g",
    entry: "n0",
    nodes: [
      { id: "n0", label: "Calculator", chip: "n0", observations: 2, predicates: ["app is Calculator"], locatable: true, intervene: "none", rank: 0, sources: [] },
      { id: "n1", label: "TextEdit", chip: "n1", observations: 1, predicates: ["app is TextEdit", 'window titled "Untitled"'], locatable: true, intervene: "none", rank: 1, sources: [] },
    ],
    edges: [
      { id: "e0", from: "n0", to: "n1", actions: [], back: false, provenance: "recorded", observations: 2, sources: [] },
    ],
    slots: [],
  },
  excludedApps: [],
  routes: [],
});

const parse = (habitArg: HabitDTO, flowsArg: FlowsDTO | null): Record<string, unknown> => {
  const out = habitStepsJson(habitArg, flowsArg);
  if (typeof out !== "string") throw new Error(`expected JSON, got: ${out.error}`);
  return JSON.parse(out) as Record<string, unknown>;
};

describe("habitStepsJson", () => {
  it("is valid JSON carrying the habit's identity and its ways", () => {
    const doc = parse(habit(), flows());
    expect(doc["habitId"]).toBe("01HABIT");
    expect(doc["slug"]).toBe("add-up-and-note");
    expect(doc["version"]).toBe("0.1.4");
    expect(doc["routeKey"]).toBe("Calculator → TextEdit");
    expect(Array.isArray(doc["ways"])).toBe(true);
  });

  it("carries the destination state's predicates for a live edge", () => {
    const doc = parse(habit(), flows());
    const step = (doc["ways"] as { steps: Record<string, unknown>[] }[])[0]!.steps[0]!;
    expect(step["toNodeId"]).toBe("n1");
    expect(step["arrivesWhen"]).toEqual(["app is TextEdit", 'window titled "Untitled"']);
    expect(step["locatable"]).toBe(true);
  });

  it("states the absence of predicates rather than faking them from a label", () => {
    const doc = parse(habit(), flows());
    const step = (doc["ways"] as { steps: Record<string, unknown>[] }[])[0]!.steps[1]!;
    expect(step["arrivesWhen"]).toBeNull();
    expect(step["arrivesWhenAbsent"]).toMatch(/not in the trace graph/);
  });

  it("says the same when there is no graph at all", () => {
    const doc = parse(habit(), null);
    const step = (doc["ways"] as { steps: Record<string, unknown>[] }[])[0]!.steps[0]!;
    expect(step["arrivesWhen"]).toBeNull();
    expect(step["arrivesWhenAbsent"]).toMatch(/no trace graph/);
  });

  it("carries the slot NAME and the lift warnings", () => {
    const doc = parse(habit(), flows());
    const step = (doc["ways"] as { steps: Record<string, unknown>[] }[])[0]!.steps[0]!;
    expect(step["actions"]).toEqual([
      { action: "click", target: 'Button "="' },
      { action: "type", target: "slot textarea", slot: "textarea" },
    ]);
    expect(step["liftWarnings"]).toEqual(["a wait was dropped"]);
  });

  it("leaks NO recorded value, even with showSamples on", () => {
    // The strong form. `habit-marks.ts` drops the samples one level down
    // because a DTO has no toggle; this asserts nothing put them back, and
    // that the whole rendered markdown never reaches the payload.
    const out = habitStepsJson(habit({ showSamples: true }), flows());
    expect(typeof out).toBe("string");
    expect(out as string).not.toContain(SECRET);
  });

  it("refuses an orphaned habit with its reason", () => {
    const out = habitStepsJson(habit({ ways: [] }), flows());
    expect(typeof out).not.toBe("string");
    expect((out as { error: string }).error).toMatch(/no longer in the trace graph/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/mcp.habit-steps-json.test.ts`
Expected: FAIL — `Cannot find module '../app/src/main/mcp/habit-steps-json.js'`.

- [ ] **Step 3: Write `habit-steps-json.ts`**

```ts
/**
 * `steps.json` — a habit's steps as data, to sit beside a pasted HABIT.md.
 *
 * Progressive disclosure, the SKILL.md convention: metadata (`list_habits`),
 * then body (`get_habit`), then bundled files (this). Agents parse prose badly,
 * and the record is prose because prose is right for the thing a person keeps.
 *
 * NO RECORDED VALUE APPEARS HERE, and `showSamples` is not consulted. That is
 * stricter than honouring the toggle, and the reason is `habit-marks.ts`'s rule
 * one level down: whether the rendered FILE prints values is a per-habit toggle,
 * and a payload has no toggle, so it carries none at all. A file a person
 * deliberately turned values on for is not a JSON body handed to a background
 * process over a socket. The slot NAME travels; the samples do not exist here.
 *
 * `arrivesWhen` is the destination node's PREDICATES, which is what "anchor"
 * means at this seam — there is none on the DTO layer, and a node's predicates
 * are its whole identity, so they answer "how do I know I have arrived".
 * `locatable: false` is the matching disclosure: such a node is satisfied by
 * every observation in its application and cannot say which state this is.
 */

import type { FlowsDTO, HabitDTO, HabitStepDTO } from "@shared/types";

interface StepJson {
  index: number;
  edgeId: string;
  from: string;
  to: string;
  toNodeId: string | null;
  actions: { action: string; target: string; slot?: string }[];
  observations: number;
  everyRecording: boolean;
  missing: boolean;
  liftWarnings: string[];
  firstAt: { sessionId: string; atSec: number } | null;
  /** The destination state's predicates, or null with a stated reason. */
  arrivesWhen: string[] | null;
  arrivesWhenAbsent?: string;
  locatable: boolean | null;
}

const NO_GRAPH_REASON =
  "there is no trace graph on this machine, so no state could be resolved for this step";
const NO_EDGE_REASON =
  "this step's edge is not in the trace graph, so its destination state is unknown — the label above is the stored copy";

function toStepJson(step: HabitStepDTO, flows: FlowsDTO | null): StepJson {
  const edge = flows?.graph.edges.find((e) => e.id === step.edgeId);
  const node = edge === undefined ? undefined : flows?.graph.nodes.find((n) => n.id === edge.to);
  const base: StepJson = {
    index: step.index,
    edgeId: step.edgeId,
    from: step.from,
    to: step.to,
    toNodeId: node?.id ?? null,
    actions: step.actions.map((a) => ({
      action: a.action,
      target: a.target,
      // `exactOptionalPropertyTypes`: a conditional spread, never `slot: undefined`.
      ...(a.slot !== undefined ? { slot: a.slot.name } : {}),
    })),
    observations: step.observations,
    everyRecording: step.everyRecording,
    missing: step.missing,
    liftWarnings: [...step.liftWarnings],
    firstAt:
      step.firstAt === null ? null : { sessionId: step.firstAt.sessionId, atSec: step.firstAt.atSec },
    arrivesWhen: node === undefined ? null : [...node.predicates],
    locatable: node?.locatable ?? null,
  };
  if (node === undefined) {
    base.arrivesWhenAbsent = flows === null ? NO_GRAPH_REASON : NO_EDGE_REASON;
  }
  return base;
}

/** The document, or the reason there isn't one. */
export function habitStepsJson(habit: HabitDTO, flows: FlowsDTO | null): string | { error: string } {
  if (habit.ways.length === 0) {
    return {
      error:
        `Habit ${habit.id} has no live steps: the route it was written from is no longer in ` +
        "the trace graph. `get_habit` still returns the file, whose steps are a stored copy " +
        "that has not been re-checked against any recording.",
    };
  }
  return JSON.stringify(
    {
      habitId: habit.id,
      slug: habit.slug,
      title: habit.title,
      version: habit.version,
      routeKey: habit.binding.routeKey,
      apps: [...habit.apps],
      note:
        "Recorded steps, generated from the user's own recordings. Slot NAMES only — no " +
        "recorded keystroke value appears in this file. `arrivesWhen` is the state each step " +
        "arrives in; when it is null, `arrivesWhenAbsent` says why.",
      ways: habit.ways.map((w) => ({
        letter: w.letter,
        recordings: w.sessionIds.length,
        steps: w.steps.map((s) => toStepJson(s, flows)),
      })),
    },
    null,
    2,
  );
}
```

- [ ] **Step 4: Add the tool and complete the surface**

In `app/src/main/mcp/tools.ts`:

```ts
import { habitStepsJson } from "./habit-steps-json.js";
```

```ts
const getHabitStepsTool: ToolDef = {
  name: "get_habit_steps",
  title: "Get a habit's steps as JSON",
  description:
    "A kept habit's recorded steps as JSON, to write as `steps.json` beside the HABIT.md that " +
    "`get_habit` returns. Carries each step's edge, actions and targets, the state it arrives " +
    "in and whether that state can be recognised at all. Slot names only — no recorded " +
    "keystroke value is ever included.",
  inputSchema: {
    type: "object",
    properties: { habitId: { type: "string", description: "A habit id from list_habits." } },
    required: ["habitId"],
    additionalProperties: false,
  },
  async run(reader, args) {
    const habitId = str(args, "habitId");
    if (habitId === null) return fail("`habitId` is required and must be a non-empty string.");
    const habit = findHabit(reader.habits(), habitId);
    if (habit === undefined) {
      return fail(`No habit ${habitId}. Habit ids come from list_habits.`);
    }
    const doc = habitStepsJson(habit, reader.flows());
    // RAW JSON with no preamble, for `get_habit`'s reason: the value of this
    // tool is that its output IS a file, and a sentence in front of the `{`
    // corrupts a paste to disk.
    return typeof doc === "string" ? text(doc) : fail(doc.error);
  },
};
```

Add `getHabitStepsTool` to `TOOLS`, after `getHabitStepTool`.

Add to `test/mcp.tools.test.ts`:

```ts
describe("get_habit_steps", () => {
  it("returns raw JSON with no preamble", async () => {
    const ways = [
      {
        letter: "A",
        sessionIds: ["s1"],
        totalsMs: [1000],
        steps: [
          {
            index: 0,
            edgeId: "e0",
            from: "Calculator",
            to: "TextEdit",
            actions: [{ action: "click", target: 'Button "="' }],
            observations: 2,
            everyRecording: true,
            missing: false,
            liftWarnings: [],
            firstAt: { sessionId: "s1", startedAt: EPOCH, atSec: 1 },
          },
        ],
      },
    ];
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit({ ways })] }),
      "get_habit_steps",
      { habitId: habit().id },
    );
    expect(out.isError).toBeUndefined();
    const body = textOf(out);
    expect(body.startsWith("{")).toBe(true);
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it("refuses an orphaned habit rather than answering from a stale copy", async () => {
    const out = await callTool(
      withHabits({ ...noHabits(), habits: [habit()] }),
      "get_habit_steps",
      { habitId: habit().id },
    );
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/no longer in the trace graph/);
  });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/mcp.habit-steps-json.test.ts test/mcp.tools.test.ts`
Expected: PASS, including the eleven-tools assertion added in Task 4.

- [ ] **Step 6: Run the gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```
Expected: **all green, with no failures at all.** `test/mcp.readonly.test.ts` must still be unedited.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/mcp/habit-steps-json.ts app/src/main/mcp/tools.ts test/mcp.habit-steps-json.test.ts test/mcp.tools.test.ts
git commit -m "feat(mcp): get_habit_steps, the steps.json sibling

Progressive disclosure, the SKILL.md convention: metadata, then body,
then bundled files. Raw JSON with no preamble, for get_habit's reason --
the value is that the output IS a file.

arrivesWhen is the destination node's PREDICATES, which is what anchor
means at this seam: there is none on the DTO layer, and a node's
predicates are its whole identity. locatable:false is the matching
disclosure -- such a node is satisfied by every observation in its
application and cannot say which state this is. When the edge is missing
or there is no graph, arrivesWhen is null and arrivesWhenAbsent says
which of the two it is, rather than faking predicates from a label.

No recorded value, and showSamples is not consulted. The test asserts the
strong form: with samples ON, the payload does not contain them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Eleven tools over a real socket, and the docs

The suite drives a FAKE reader. This is the only place these three tools meet a real store, and it is the check CLAUDE.md's "validate against a real recording" rule exists for.

**Files:**
- Modify: `scripts/mcp-probe.mjs`
- Modify: `CLAUDE.md`
- Modify: `docs/mcp.md` — the USER-FACING tool doc, whose heading reads "The eight tools"
- Modify: `docs/internals/app-main.md:82` and `:93`
- Modify: `docs/todo.md`

**Interfaces:**
- Consumes: the eleven tools from Tasks 4–6.
- Produces: nothing further.

- [ ] **Step 1: Extend the probe**

In `scripts/mcp-probe.mjs`, update the header comment's "six tools" to "eleven tools". Then insert, after the existing `get_habit` block and before the activity-log block:

```js
  // The three tools sub-project D added. This is the ONLY place they meet a
  // real store: the suite drives a fake reader, so a one-habit corpus, an
  // orphaned binding and a route with four ways are all things only this sees.
  console.log("\n=== search_habits ===");
  const situation = process.env.MCP_PROBE_SITUATION ?? "add some numbers and write them down";
  const found = textOf(await call(url, "search_habits", { situation, limit: 3 }));
  console.log(head(found, 20));
  // The disclosure is the whole reason this tool can ship against this store.
  const corpusDisclosed = /kept habit/.test(found);
  console.log(`corpus disclosed before the ranking: ${corpusDisclosed}`);
  // No score, ever. A decimal with two or more places is the shape of one.
  console.log(`no score printed: ${!/\d\.\d{2,}/.test(found)}`);

  console.log("\n=== get_habit_step ===");
  if (habitId) {
    // The MULTI-WAY refusal, which the real store CAN reach: the kept habit
    // binds to a route with four ways, so omitting `way` must be refused with
    // the letters named rather than silently answered about way A.
    const bare = await call(url, "get_habit_step", { habitId, step: 1 });
    const bareText = textOf(bare);
    console.log(head(bareText, 8));
    const many = /`way` is required/.test(bareText);
    console.log(`multi-way refusal reached: ${many}`);
    const step = await call(url, "get_habit_step", {
      habitId,
      step: 1,
      ...(many ? { way: "A" } : {}),
    });
    const image = (step?.result?.content ?? []).find((c) => c.type === "image");
    console.log(head(textOf(step), 16));
    console.log(
      image
        ? `[image ${image.mimeType}, ${Math.round((image.data.length * 3) / 4 / 1024)} kB]`
        : "[no image — the step has no moment, or the recording has no keyframe]",
    );
  } else {
    console.log("(no habit kept — nothing to step through)");
  }

  console.log("\n=== get_habit_steps ===");
  if (habitId) {
    const raw = textOf(await call(url, "get_habit_steps", { habitId }));
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* left null; reported below */
    }
    console.log(`parses as JSON: ${parsed !== null}`);
    if (parsed) {
      const steps = (parsed.ways ?? []).flatMap((w) => w.steps ?? []);
      const resolved = steps.filter((s) => Array.isArray(s.arrivesWhen)).length;
      console.log(
        `${parsed.ways.length} way(s), ${steps.length} step(s), ` +
          `${resolved} with a resolved destination state`,
      );
      // The strong guarantee, checked against the file rather than the fixture.
      console.log(`slot values absent: ${!/"samples"/.test(raw)}`);
    }
    console.log(head(raw, 24));
  } else {
    console.log("(no habit kept)");
  }
```

- [ ] **Step 2: Run the probe against the real store**

Quit any running dev instance first, then run:
```bash
npm run probe:mcp
```
Expected: the three new sections print. Specifically expect `corpus disclosed before the ranking: true`, `no score printed: true`, `multi-way refusal reached: true` (the kept habit binds to `Calculator → TextEdit`, which has four ways), `parses as JSON: true` and `slot values absent: true`.

**If `multi-way refusal reached` is false**, the store has changed since this plan was written — check with `npm run probe:fork` whether the kept habit's route still has more than one way, and record what you find rather than editing the expectation.

- [ ] **Step 3: Update CLAUDE.md**

In the commands block, change the `probe:mcp` description from "call all eight MCP tools" to:

```
npm run probe:mcp             # drive the real app and call all eleven MCP tools over a real
                              # socket, plus the three guard checks. The ONLY place the tools
                              # meet a real store — the app-side integration test uses a fake
                              # reader. Read-only; every tool it calls is a read. It also
                              # checks the three habit-agent guarantees that only real data
                              # can reach: search_habits discloses the corpus and prints no
                              # score, get_habit_step REFUSES a multi-way habit with no `way`
                              # (the one kept habit binds to a four-way route), and
                              # get_habit_steps carries no slot values.
```

In the `docs/internals/app-main.md` bullet list, replace the MCP bullet with:

```
- **The MCP endpoint is READ-ONLY BY CONSTRUCTION**, guarded by `test/mcp.readonly.test.ts`. **The Host check is what closes DNS rebinding** — the Origin check cannot. There is deliberately no token, and it shows no score. **Eleven tools, and the guard's `^(search|get|list)_` rule NAMED one of them**: `find_habit` could not ship, because widening that prefix to admit `find_` would trade a structural property for a word. The guard also reads the `ExperienceReader` body with NO word boundaries, so `embed(inputs)` fails on `put` and an inline `startedAt` fails on `start` — the reader takes `texts` and declares its return types outside the interface. **`search_habits` discloses the corpus BEFORE the ranking** (`RANKING_MIN_HABITS = 5`, unswept), and **`steps.json` carries no recorded slot value at all**, `showSamples` unconsulted — `habit-marks.ts`'s rule, that a payload has no toggle so it carries no values.
```

- [ ] **Step 4: Update the tool lists that name a count**

Two files say "eight" in prose and will now be wrong. Both are load-bearing: `docs/mcp.md` is what a user reads to connect an agent.

**`docs/internals/app-main.md:82`** — the bullet begins "Eight tools — …" and ends "— hosted by the app over stateless Streamable HTTP". Replace that opening run with:

```
Eleven tools — `search_experience`, `get_moment` (the keyframe as an MCP image block),
`list_recordings`, `get_recording_outline`, `list_flows`, `get_flow`, `list_habits`,
`get_habit`, `search_habits`, `get_habit_step`, `get_habit_steps` — hosted by the app
```

**`docs/internals/app-main.md:93`** — the "Confirmed on a real store (2026-08-13)" line stays exactly as it is. It is a dated measurement of thirteen recordings, and editing it would turn a record into a claim. Add a second line after it instead:

```
  - **Re-confirmed 2026-08-23 at eleven tools**, on a store of 8 recordings, 5 routes and ONE
    kept habit. That corpus is the point rather than a limitation: it is the case
    `search_habits` was designed around, and `probe:mcp` checks the disclosure fires — the
    reply says the one habit is the only candidate rather than presenting it as a match.
    `get_habit_step`'s multi-way refusal is reachable here too, because the kept habit binds
    to `Calculator → TextEdit`, which `probe:fork` reads at four ways.
```

**`docs/mcp.md`** — change the heading `## The eight tools` to `## The eleven tools`, then add three sections immediately after the existing `### \`list_habits\` and \`get_habit\`` section (before `## Read-only, by construction`). The outer fence below is FOUR backticks because the content contains a three-backtick block of its own — copy the inside, not the fence:

````markdown
### `search_habits`

The catalogue is a chooser, and a composite habit runs to roughly 1,500 tokens, so
an agent that reads `list_habits` to find one habit reads all of them.
`search_habits` takes a situation in the agent's own words and ranks the kept
habits against it.

Two lanes are matched and fused by rank. The **prose** lane compares meaning
against what a person or model wrote — the title, the description, the body, and
the applications the route passes through. The **exact terms** lane matches
against the whole file, which is where a button label, a URL or an app name
actually lives. The reply names which lanes each habit appeared in and where:

```
matched in: prose #1, exact terms #3
```

There is no score, for `search_experience`'s reason. What replaces it is the
**corpus**, stated before the ranking rather than after it. With one kept habit
the reply says so outright — that habit is the only candidate, and nothing was
ranked against it. Below five it warns that a corpus that small ranks nearly
everything. An agent handed an order with no idea how many things were ordered
will present the first as authoritative.

If no local text model has downloaded, the prose lane is **skipped and says so**,
and the ranking is exact terms alone. A quietly lexical-only answer is
indistinguishable from a working one.

### `get_habit_step`

An agent following a HABIT.md and stuck partway has nowhere to look: the file
says `Calculator — no state → TextEdit — Untitled` and nothing shows what that
was. This returns one step with the screenshot of what was on screen when it ran,
plus the accessibility labels visible at that moment.

`step` is the number the file prints, counting from 1. `way` is the letter —
**required** for a habit whose recordings took different paths, because those are
different procedures rather than one procedure with options, and guessing would
answer about a path you did not read.

The screenshot is the last keyframe **at or before** the step began: a step is a
transition, and its actions want the screen as it was when they started. If the
step began before the recording's video did, the earliest keyframe is returned
and the reply says it is *after* the step rather than before it.

### `get_habit_steps`

The same recorded steps as JSON, to write as `steps.json` beside the HABIT.md
that `get_habit` returns — metadata, then the body, then the bundled file. Raw
JSON with no preamble, for the same reason `get_habit` has none.

Each step carries its edge, its actions and targets, how many recordings walked
it, when it was first walked, and **`arrivesWhen`** — the state the step arrives
in, as the conditions that identify it. That is the answer to "how do I know I
have got there". When it is `null`, `arrivesWhenAbsent` says why, and
`locatable: false` says a state can be confirmed but not recognised beyond its
application.

**No recorded keystroke value appears in this file, ever.** A slot travels as its
name and nothing else, and the per-habit "show recorded values" toggle is not
consulted — a file you deliberately turned values on for is not the same as a
payload handed to a background process over a socket.
````

- [ ] **Step 5: Record what shipped in `docs/todo.md`**

Append a new entry, and update the sub-project C umbrella entry's tail (which currently ends "NOT DONE, still C3 … and D"):

```
- HABIT INSIGHT, SUB-PROJECT D — SHIPPED 2026-08-23 (`design/habit-agent-surface`).
  Eleven MCP tools. `search_habits` fuses a dense lane over the AUTHORED half
  (title, description, prose, apps) with a BM25 lane over the whole markdown,
  and states the corpus BEFORE the ranking — which is the only reason it can
  ship against a store holding ONE kept habit. `get_habit_step` returns a step's
  keyframe (at-or-before, the `regionsAt` rule) with the AX labels on it, and
  REQUIRES the way letter once a habit has more than one. `get_habit_steps` is
  the steps.json sibling, carrying each step's destination PREDICATES as the
  anchor and slot NAMES only.
  THE NAME WAS DECIDED BY THE GUARD: `find_habit` could not ship, because
  `test/mcp.readonly.test.ts` requires `^(search|get|list)_` and that prefix rule
  is what makes an acting tool impossible to add by accident. The same guard
  reads the reader interface with NO word boundaries — `embed(inputs)` fails on
  `put`, an inline `startedAt` fails on `start` — and both traps now have their
  own assertion.
  ONE MORE UNSWEPT FLOOR: `RANKING_MIN_HABITS = 5`, joining C2's two and C3's
  one. Only the `1 kept` branch can run on real data; the other three are
  fixture-tested.
  NOT IN SCOPE AND STILL ISN'T: outcome reporting. `TraceEdge.outcomes` is
  {0,0} forever, and the only thing that could fill it is an agent reporting
  back, which is a WRITE.
```

- [ ] **Step 6: Run the gate**

```bash
npm test
npm run typecheck
npm run build && npm --prefix app run typecheck
```
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add scripts/mcp-probe.mjs CLAUDE.md docs/mcp.md docs/internals/app-main.md docs/todo.md
git commit -m "probe(mcp): eleven tools against the real store, and what D shipped

The suite drives a FAKE reader, so a one-habit corpus and a four-way
kept habit are things only this sees. It checks the three guarantees that
need real data: the corpus is disclosed before the ranking, no score is
printed, and get_habit_step REFUSES a multi-way habit with no \`way\` --
reachable here because the kept habit binds to Calculator -> TextEdit,
which probe:fork reads at four ways.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review notes for the executor

Three things in this plan are deliberate and will look like mistakes:

1. **The eleven-tools assertion is red from Task 4 to Task 6.** It is written early on purpose so the surface's destination is visible while it is being built. Tasks 4 and 5 say to expect exactly that one failure; anything else is a real failure.
2. **`test/mcp.readonly.test.ts` gains assertions but is never loosened.** If a new name trips its regex, rename the code. Editing the guard is the one move this plan forbids.
3. **`habit-search.ts` imports a runtime value from `deskrag`.** That is fine and precedented: `graph-view.ts` already does it, and `vitest.config.ts` aliases `deskrag` to `src/index.ts`, so the root suite reaches it with no build.
